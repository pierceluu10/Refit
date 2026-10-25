import { splitRows } from '../scripts/benchmark-harness.mjs';
import { assertResults } from '../scripts/benchmark-results.mjs';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { runPipeline } from './run.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError, type Repository } from './types.ts';
import { proposalReviewReason, scanReviewReason } from './workflow.ts';

// Refit adapters accept at most 100 operations; Stripe exposes far more, so each repository
// gets the operations its own traced calls use.
const MAX_ADAPTER_OPERATIONS = 100;

export interface StripeOperation {
  resource: string;
  method: string;
  schema: string;
  operationId?: string;
}

function camel(value: string) {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function responseSchema(spec: Record<string, unknown>, path: string, operation: string) {
  const paths = spec.paths;
  if (!isObject(paths) || !isObject(paths[path])) return undefined;
  const entry = (paths[path] as Record<string, unknown>)[operation];
  if (!isObject(entry) || !isObject(entry.responses)) return undefined;
  const ok = (entry.responses as Record<string, unknown>)['200'];
  const json = isObject(ok) && isObject(ok.content) ? ok.content['application/json'] : undefined;
  const schema = isObject(json) ? json.schema : undefined;
  // `customers.retrieve` returns `anyOf: [customer, deleted_customer]`; keep each referenced object.
  const options = isObject(schema) && Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  const schemas = options
    .map((option) => (isObject(option) ? option.$ref : undefined))
    .filter(
      (reference): reference is string =>
        typeof reference === 'string' && reference.startsWith('#/components/schemas/'),
    )
    .map((reference) => reference.slice('#/components/schemas/'.length));
  return schemas.length
    ? {
        schemas,
        operationId: typeof entry.operationId === 'string' ? entry.operationId : undefined,
      }
    : undefined;
}

// Maps stripe-node methods to the object schemas they return, using the x-stripeOperations
// metadata in Stripe's SDK spec (spec3.sdk.json). Only operations whose 200 response is that
// same schema in the application's own (before) contract are kept.
export function stripeOperations(
  sdkSpec: Record<string, unknown>,
  beforeSpec: Record<string, unknown>,
): StripeOperation[] {
  const schemas = isObject(sdkSpec.components) ? sdkSpec.components.schemas : undefined;
  if (!isObject(schemas)) return [];
  const operations = new Map<string, StripeOperation>();
  for (const [schema, definition] of Object.entries(schemas)) {
    const declared = isObject(definition) ? definition['x-stripeOperations'] : undefined;
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      if (!isObject(entry) || entry.method_on !== 'service') continue;
      const { path, operation, method_name: name } = entry;
      if (typeof path !== 'string' || typeof operation !== 'string' || typeof name !== 'string')
        continue;
      const response = responseSchema(beforeSpec, path, operation);
      if (!response?.schemas.includes(schema)) continue;
      const segments = path.split('/').slice(2);
      const parameter = segments.findIndex((segment) => segment.startsWith('{'));
      const resource = (parameter < 0 ? segments : segments.slice(0, parameter))
        .map(camel)
        .join('.');
      // stripe-node exposes HTTP DELETE as `del`.
      const method = name === 'delete' ? 'del' : camel(name);
      const trailing = parameter < 0 ? [] : segments.slice(parameter + 1);
      // Nested sub-resources (`/customers/{id}/cash_balance`) use other SDK method names; keep
      // only the object path itself and single actions such as `/payment_intents/{id}/cancel`.
      if (trailing.length > 1 || (trailing.length === 1 && camel(trailing[0]) !== method)) continue;
      const key = `${resource}.${method}`;
      if (resource && !operations.has(key))
        operations.set(key, {
          resource,
          method,
          schema,
          ...(response.operationId ? { operationId: response.operationId } : {}),
        });
    }
  }
  return [...operations.values()];
}

export function repositoryAdapter(repository: Repository, operations: StripeOperation[]) {
  const called = new Set(
    analyzeRepository(repository, [], STRIPE).sdkCalls.map(
      (call) => `${call.resource}.${call.method}`,
    ),
  );
  const used = operations.filter((operation) =>
    called.has(`${operation.resource}.${operation.method}`),
  );
  // The built-in `stripe` id is reserved, so the generated adapter uses its own id for the
  // same package, constructor and API-version option.
  const adapter: ProviderAdapter = {
    ...STRIPE,
    id: 'stripe-full',
    operations: used.slice(0, MAX_ADAPTER_OPERATIONS),
  };
  return { adapter, calledMethods: called.size, mappedMethods: used.length };
}

export const PUBLISH_BASE = 'refit-base';

// One row per affected repository: outcome, pull request and the reason it stopped. The results
// are checked against their schema first; infrastructure errors are listed, not counted.
export function summaryTable(entries: Record<string, unknown>[]) {
  const { predates } = assertResults('stripe-results', entries, { allowPredating: true });
  const { results, infrastructure } = splitRows('stripe-results', entries);
  const rows = results.map((entry) => {
    const workflow = entry.workflow as Record<string, unknown> | undefined;
    const publication = entry.publication as Record<string, unknown> | undefined;
    const affected = Boolean((entry.fullAdapter as { confirmed?: number } | undefined)?.confirmed);
    const outcome = publication?.url
      ? 'pull request'
      : String(workflow?.status ?? (affected ? 'affected' : 'not affected'));
    // A published row needs no stop reason; the workflow's own reason predates publication.
    const reason = String(
      publication?.url ? '' : (publication?.error ?? workflow?.error ?? workflow?.reason ?? ''),
    )
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '/')
      .slice(0, 140);
    return { repo: String(entry.repo), affected, outcome, url: publication?.url, reason };
  });
  const affected = rows.filter((row) => row.affected);
  const count = (outcome: string) => affected.filter((row) => row.outcome === outcome).length;
  const outcomes = [...new Set(affected.map((row) => row.outcome))].sort();
  return [
    '# Stripe benchmark summary',
    '',
    `Repositories: ${rows.length}. Affected: ${affected.length}. Pull requests: ${count('pull request')}.`,
    ...(predates.length
      ? [
          '',
          `These results predate ${predates.join(', ')}; rows were classified from their fields.`,
        ]
      : []),
    '',
    '| Outcome | Repositories |',
    '|---|---|',
    ...outcomes.map((outcome) => `| ${outcome} | ${count(outcome)} |`),
    '',
    '| Repository | Outcome | Pull request | Reason |',
    '|---|---|---|---|',
    ...affected.map(
      (row) =>
        `| ${row.repo} | ${row.outcome} | ${row.url ? `[link](${String(row.url)})` : ''} | ${row.reason} |`,
    ),
    '',
    ...(infrastructure.length
      ? [
          `Infrastructure errors, not counted above: ${infrastructure.length}. Rerun them with --resume.`,
          '',
          '| Repository | Kind | Message |',
          '|---|---|---|',
          ...infrastructure.map(
            (row) =>
              `| ${String(row.repo)} | ${row.infrastructure.kind} | ${row.infrastructure.message.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 140)} |`,
          ),
          '',
        ]
      : []),
  ].join('\n');
}

// Forks a benchmark repository into the organization, never touching the upstream repository,
// and points `refit-base` at the commit that was validated. Uses the operator's GITHUB_TOKEN;
// the pull request itself is published by the GitHub App.
export async function forkAtCommit(
  organization: string,
  repository: string,
  commit: string,
  githubToken: string | undefined,
  pollMs = 5000,
) {
  const token = githubToken?.trim();
  if (!token) throw new PipelineInputError('--publish needs GITHUB_TOKEN to create forks.');
  const github = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  // GitHub lets an organization hold several forks of one repository, so creating a fork again
  // would add `name-1`; reuse the organization's existing fork of the same name instead.
  const existing = await github('GET', `/repos/${organization}/${repository.split('/')[1]}`);
  const parent = existing.body.parent as { full_name?: string } | undefined;
  const forked =
    existing.status === 200 && parent?.full_name === repository
      ? existing
      : await github('POST', `/repos/${repository}/forks`, {
          organization,
          default_branch_only: true,
        });
  const name = forked.body.full_name;
  if (forked.status >= 300 || typeof name !== 'string' || !name.startsWith(`${organization}/`))
    throw new PipelineInputError(`Fork of ${repository} failed: HTTP ${forked.status}.`);
  // Forks are created asynchronously; wait until the validated commit is reachable.
  for (let attempt = 0; ; attempt++) {
    if ((await github('GET', `/repos/${name}/commits/${commit}`)).status === 200) break;
    if (attempt === 24) throw new PipelineInputError(`Fork ${name} does not contain ${commit}.`);
    await new Promise((done) => setTimeout(done, pollMs));
  }
  const created = await github('POST', `/repos/${name}/git/refs`, {
    ref: `refs/heads/${PUBLISH_BASE}`,
    sha: commit,
  });
  if (created.status !== 201) {
    const existing = await github('GET', `/repos/${name}/git/ref/heads/${PUBLISH_BASE}`);
    const target = existing.body.object as { sha?: string } | undefined;
    if (target?.sha !== commit)
      throw new PipelineInputError(`${name} already has ${PUBLISH_BASE} at another commit.`);
  }
  return name;
}

// The workflow's stops that need only its scan, decided on the scan `refit run` makes with the
// same inputs, so the benchmark starts `refit run` only for repositories that get past them. A
// scan that fails here returns undefined and is left to `refit run`, which records the error.
type ScanInputs = {
  repository: string;
  before: string;
  after: string;
  apiVersion: string;
  providerConfig: string;
  keepListedPaymentMethods?: boolean;
};

// The workflow's scan stage: why it stops, if it does, and the proposed patch.
export async function workflowScan(
  inputs: ScanInputs,
  aiPatch: boolean,
  leaveRequestParameters: boolean,
) {
  return runPipeline({ ...inputs, proposePatch: true, leaveRequestParameters }).then(
    (scan) => ({
      stop:
        scanReviewReason(scan, aiPatch, leaveRequestParameters) ??
        proposalReviewReason(scan, aiPatch),
      patch: scan.patch,
    }),
    (error: unknown) => ({
      stop: undefined,
      patch: undefined,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

export async function workflowScanStop(
  inputs: ScanInputs,
  aiPatch: boolean,
  leaveRequestParameters: boolean,
) {
  return (await workflowScan(inputs, aiPatch, leaveRequestParameters)).stop;
}

// Why a `refit run` child left no manifest: the harness time limit stopped it, a signal killed
// it, or it exited on its own, usually with its last stderr line saying why.
export function workflowExitReason(error: unknown, limitMs: number) {
  const { code, signal, killed, stderr, message } = error as {
    code?: number | string | null;
    signal?: string | null;
    killed?: boolean;
    stderr?: string;
    message?: string;
  };
  if (typeof code === 'string') return `refit run failed: ${message?.split('\n')[0]}`;
  if (killed)
    return `refit run was stopped with ${signal} at the ${limitMs / 60_000}-minute limit.`;
  const last = String(stderr ?? '')
    .trim()
    .split('\n')
    .at(-1);
  return `refit run ${signal ? `was killed by ${signal}` : `exited with code ${code}`}${last ? `: ${last}` : '.'}`;
}

import { splitRows } from '../scripts/benchmark-harness.mjs';
import { assertResults } from '../scripts/benchmark-results.mjs';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { runPipeline } from './run.ts';
import {
  declaredOperations,
  stripeSdkOperations,
  type StripeOperation,
} from './stripe-operations.ts';
import { PipelineInputError, type Repository } from './types.ts';
import {
  NO_USAGE_REASON,
  proposalReviewReason,
  scanReviewReason,
  versionBumpBlock,
} from './workflow.ts';
import { targetReached } from './migration-review.ts';

// Refit adapters accept at most 100 operations; Stripe exposes far more, so each repository
// gets the operations its own traced calls use.
const MAX_ADAPTER_OPERATIONS = 100;

// Maps stripe-node methods to the object schemas they return, using the x-stripeOperations
// metadata in the SDK spec for the application's own API version (spec3.sdk.json).
export function stripeOperations(
  sdkSpec: Record<string, unknown>,
  beforeSpec: Record<string, unknown>,
): StripeOperation[] {
  return stripeSdkOperations(declaredOperations(sdkSpec), beforeSpec);
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

const clean = (value: unknown) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '/')
    .slice(0, 140);

// The full contract diff on, through validation when the scan lets it run. It uses the benchmark's
// SDK-spec adapter; `customerMode` records the built-in adapter a hosted worker scans with.
// Rows from runs before production mode was recorded say so instead of guessing.
export function productionOutcome(entry: Record<string, unknown>) {
  const production = entry.production as { status?: string; reason?: string; error?: string };
  const scan = entry.productionMode as
    { status?: string; stop?: string | null; error?: string } | undefined;
  if (production?.status)
    return { outcome: production.status, reason: production.error ?? production.reason };
  if (!scan) return { outcome: 'not affected' };
  if (scan.error) return { outcome: 'error', reason: scan.error };
  if (scan.status !== 'affected') return { outcome: 'not affected' };
  if (!('stop' in scan)) return { outcome: 'not measured' };
  return scan.stop ? { outcome: 'needs-review', reason: scan.stop } : { outcome: 'affected' };
}

// One row per affected repository, production mode first: its outcome, the benchmark mode
// outcome (full contract diff off), pull request and the reason it stopped. The results are
// checked against their schema first; infrastructure errors are listed, not counted.
export function summaryTable(entries: Record<string, unknown>[]) {
  const { predates } = assertResults('stripe-results', entries, { allowPredating: true });
  const { results, infrastructure } = splitRows('stripe-results', entries);
  const rows = results.map((entry) => {
    const workflow = entry.workflow as Record<string, unknown> | undefined;
    const publication = entry.publication as Record<string, unknown> | undefined;
    const benchmarkAffected = Boolean(
      (entry.fullAdapter as { confirmed?: number } | undefined)?.confirmed,
    );
    const outcome = publication?.url
      ? 'pull request'
      : String(workflow?.status ?? (benchmarkAffected ? 'affected' : 'not affected'));
    // With the full diff on in the workflow itself, the customer's run is that same run.
    const production = workflow?.fullDiff === true ? { outcome } : productionOutcome(entry);
    // A published row needs no stop reason; the workflow's own reason predates publication.
    const benchmarkReason = publication?.url
      ? ''
      : (publication?.error ?? workflow?.error ?? workflow?.reason ?? '');
    return {
      repo: String(entry.repo),
      affected: benchmarkAffected || production.outcome !== 'not affected',
      production: production.outcome,
      outcome,
      url: publication?.url,
      reason: clean(
        production.outcome !== outcome && production.reason ? production.reason : benchmarkReason,
      ),
    };
  });
  const affected = rows.filter((row) => row.affected);
  const count = (key: 'production' | 'outcome', outcome: string) =>
    affected.filter((row) => row[key] === outcome).length;
  const outcomes = [...new Set(affected.flatMap((row) => [row.production, row.outcome]))].sort();
  return [
    '# Stripe benchmark summary',
    '',
    `Repositories: ${rows.length}. Affected in either mode: ${affected.length}. Production mode runs the full contract diff, as a hosted worker does, with the benchmark's SDK-spec adapter (customerMode records the built-in adapter's scan); benchmark mode turns the full diff off. Pull requests: ${count('outcome', 'pull request')}. Version bumps (every Stripe call traced, none affected; counted apart from migration fixes): ${count('outcome', 'version-bump')}.`,
    ...(predates.length
      ? [
          '',
          `These results predate ${predates.join(', ')}; rows were classified from their fields.`,
        ]
      : []),
    '',
    '| Outcome | Production | Benchmark |',
    '|---|---|---|',
    ...outcomes.map(
      (outcome) =>
        `| ${outcome} | ${count('production', outcome)} | ${count('outcome', outcome)} |`,
    ),
    '',
    '| Repository | Production | Benchmark | Pull request | Reason |',
    '|---|---|---|---|---|',
    ...affected.map(
      (row) =>
        `| ${row.repo} | ${row.production} | ${row.outcome} | ${row.url ? `[link](${String(row.url)})` : ''} | ${row.reason} |`,
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
              `| ${String(row.repo)} | ${row.infrastructure.kind} | ${clean(row.infrastructure.message)} |`,
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
  fullDiff?: boolean;
};

// The workflow's scan stage: why it stops, if it does, and the proposed patch. Where the scan finds
// no usage, `versionBump` says why runWorkflow opens no version bump, or `eligible` when it tries one.
export async function workflowScan(
  inputs: ScanInputs,
  aiPatch: boolean,
  leaveReviewedFindings: boolean,
) {
  try {
    const scan = await runPipeline({ ...inputs, proposePatch: true, leaveReviewedFindings });
    const stop = targetReached(scan)
      ? undefined
      : (scanReviewReason(scan, aiPatch, leaveReviewedFindings) ??
        proposalReviewReason(scan, aiPatch));
    if (!stop?.startsWith(NO_USAGE_REASON)) return { stop, patch: scan.patch };
    const block = await versionBumpBlock(scan, inputs.repository);
    return {
      stop: block ? `${stop} Refit opened no version bump: ${block}` : undefined,
      patch: scan.patch,
      versionBump: block ?? 'eligible',
    };
  } catch (error) {
    return {
      stop: undefined,
      patch: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

import { open, readFile } from 'node:fs/promises';
import type { ApiVersionEvidence, ApiVersionPolicy } from './api-version.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { META_SDK } from './deadline-exposure.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';
import {
  checkMetaGraphChanges,
  compareVersions,
  DEFAULT_META_GRAPH_CHANGES,
  type MetaGraphChanges,
} from './meta-graph-changes.ts';
import { loadMetaPlatformAlerts, planMetaGraphFixes } from './meta-graph-fixes.ts';
import { META_GRAPH_VERSION_RULE } from './meta-graph-moves.ts';
import { loadMetaGraphRules } from './meta-graph-rules.ts';
import type { ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { digest, META_GRAPH_CHANGELOG, parseObject } from './specifications.ts';
import { PipelineInputError, type Finding } from './types.ts';

// The Meta Graph API pipeline behind `refit run`. Meta publishes no machine-readable contract, so a
// run's contract is a Meta snapshot: a Graph API version and the reviewed change table, pinned by
// its hash. The `after` snapshot names the target; every pinned version older than it moves where
// the fix plan allows (meta-graph-fixes.ts), and every stop, product migration and alert is
// reported. The report carries every report field, with the OpenAPI-only ones empty, like
// Shopify's.

export const META_GRAPH: ProviderAdapter = {
  id: 'meta-graph',
  packageName: META_SDK,
  defaultImport: false,
  namedExport: null,
  operations: [],
};
export const META_GRAPH_SNAPSHOT_KIND = 'refit-meta-graph-snapshot';
const VERSION = /^v\d+\.\d+$/;
const CHANGELOG = META_GRAPH_CHANGELOG;
const SNAPSHOT_HEADER_BYTES = 512;
const SNAPSHOT_KIND = new RegExp(`"kind"\\s*:\\s*"${META_GRAPH_SNAPSHOT_KIND}"`);

export interface MetaGraphSnapshot {
  formatVersion: 1;
  kind: typeof META_GRAPH_SNAPSHOT_KIND;
  provider: 'meta-graph';
  version: string;
  url: string;
  hash: string;
  // The reviewed change table, as text.
  content: string;
}

// A snapshot of the committed change table at a Graph API version, for `refit run` contracts.
export async function metaGraphSnapshot(
  version: string,
  changes: string | URL = DEFAULT_META_GRAPH_CHANGES,
): Promise<MetaGraphSnapshot> {
  if (!VERSION.test(version)) throw new PipelineInputError('A Graph API version looks like v25.0.');
  const content = await readFile(changes, 'utf8');
  const table = changeTable(content, 'the change table');
  if (!table.versions.some((entry) => entry.version === version))
    throw new PipelineInputError(`${version} has no record in the Meta Graph API change table.`);
  return {
    formatVersion: 1,
    kind: META_GRAPH_SNAPSHOT_KIND,
    provider: 'meta-graph',
    version,
    url: CHANGELOG,
    hash: digest(content),
    content,
  };
}

function changeTable(content: string, label: string): MetaGraphChanges {
  const value = parseObject(content, label);
  const { errors } = checkMetaGraphChanges(value, new Date());
  if (errors.length)
    throw new PipelineInputError(
      `${label}: the Meta Graph API change table is invalid: ${errors.slice(0, 3).join(' ')}`,
    );
  return value as unknown as MetaGraphChanges;
}

// Reads only a snapshot's header, so other runs do not parse their contracts twice.
export async function isMetaGraphSnapshotFile(path: string) {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(SNAPSHOT_HEADER_BYTES),
      0,
      SNAPSHOT_HEADER_BYTES,
      0,
    );
    return SNAPSHOT_KIND.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

export function isMetaGraphSnapshot(snapshot: { document: Record<string, unknown> }) {
  return typeof snapshot.document.metaGraphChanges === 'string';
}

// A Meta snapshot as readSpecification returns it.
interface Snapshot {
  hash: string;
  document: { info: { version: string }; metaGraphChanges: string };
  provenance: { provider: string; revision: string; url: string };
}

const where = (file: string, line: number) => `${file}:${line}`;

export async function runMetaGraphPipeline(options: {
  repository: string;
  before: Snapshot;
  after: Snapshot;
  proposePatch?: boolean;
  apiVersionPolicy: ApiVersionPolicy;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const target = options.after.document.info.version;
  if (options.before.hash !== options.after.hash)
    throw new PipelineInputError(
      'Meta Graph runs need both snapshots taken from the same change table.',
    );
  const changes = changeTable(options.after.document.metaGraphChanges, 'the after snapshot');
  const repository = await readRepository(options.repository, META_SDK);
  const scan = await scanGraphCalls(options.repository, { repository });
  const plan = await planMetaGraphFixes(options.repository, target, {
    changes,
    registry: await loadDeadlineRegistry(undefined, now),
    rules: await loadMetaGraphRules(),
    alerts: await loadMetaPlatformAlerts(),
    now,
  });
  const { proposal } = plan;
  const findings: Finding[] = [];
  // Each moved request is migrated by the move; each stopped one is listed for review with every
  // reason, and so is each use of a product that needs a migration.
  for (const move of proposal.moves)
    for (const request of move.requests)
      findings.push({
        file: request.file,
        line: request.line,
        column: 1,
        changeId: META_GRAPH_VERSION_RULE,
        expression: `${request.method ?? 'request'} ${request.path ?? ''}`.trim(),
        confidence: 'confirmed',
        reason: `Moves from ${move.from} (${where(move.file, move.line)}) to ${move.to}; the reviewed changelogs of ${move.crossed.join(', ')} list nothing this request uses${move.rules.length ? `, after the documented rules ${move.rules.join(', ')}` : ''}.`,
      });
  for (const stop of proposal.stops) {
    // A pin already past the target needs nothing.
    if (stop.from && compareVersions(stop.from, target) > 0) continue;
    for (const request of stop.requests)
      findings.push({
        file: request.file,
        line: request.line,
        column: 1,
        changeId: `${META_GRAPH_VERSION_RULE}:review`,
        expression: `${request.method ?? 'request'} ${request.path ?? 'unknown path'}`,
        confidence: 'review',
        reason: `${stop.from ? `Stays on ${stop.from}${stop.file ? ` (${where(stop.file, stop.line!)})` : ''}` : 'Not moved'}: ${stop.reasons.join(' ')}`,
      });
  }
  for (const migration of plan.migrations)
    for (const use of migration.uses)
      findings.push({
        file: use.file,
        line: use.line,
        column: 1,
        changeId: `meta-graph-product:${migration.product}`,
        expression: use.evidence,
        confidence: 'review',
        reason: `${migration.plan.join(' ')} Sources: ${migration.sources.join(', ')}.`,
      });
  const review = findings.filter((finding) => finding.confidence === 'review');
  const alerts = plan.alerts.map(
    (alert) =>
      `Meta alert (${alert.effective ?? 'undated'}, ${alert.status}) at ${where(alert.file, alert.line)}, ${alert.matched}: ${alert.summary}${alert.replacement ? ` Replacement: ${alert.replacement.join(', ')}.` : ''} ${alert.source}`,
  );
  const live = scan.calls.filter((call) => call.use === 'live');
  const status = proposal.moves.length
    ? ('affected' as const)
    : review.length || live.length
      ? ('needs-review' as const)
      : ('no-provider-signal' as const);
  const pinned = [...new Set(live.flatMap((call) => (call.version ? [call.version] : [])))].sort();
  const apiVersion: ApiVersionEvidence = {
    application: pinned.length === 1 ? pinned[0] : null,
    before: options.before.document.info.version,
    after: target,
    applicability:
      pinned.length === 1 && pinned[0] === target
        ? 'matches-after'
        : pinned.length === 1 && pinned[0] === options.before.document.info.version
          ? 'matches-before'
          : 'unknown',
    reason: pinned.length
      ? `The code pins ${pinned.join(', ')}; each pin older than ${target} moves only where the fix plan allows.`
      : 'No pinned Graph API version was found.',
    policy: options.apiVersionPolicy,
    source: {
      status: 'not-configured',
      declarations: [],
      reason: 'Meta Graph pins are read by the request scan, one per place a version is written.',
    },
  };
  const firstStop = review[0]?.reason;
  const patch = !options.proposePatch
    ? {
        status: 'not-generated' as const,
        reason:
          'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
      }
    : !proposal.edits.length
      ? {
          status: 'not-generated' as const,
          reason: firstStop ?? `No request pins a Graph API version older than ${target}.`,
        }
      : {
          generator: 'deterministic' as const,
          summary: `Move ${proposal.moves.length} pinned Graph API ${proposal.moves.length === 1 ? 'version' : 'versions'} to ${target}. The reviewed changelogs crossed list nothing the moved requests use${proposal.moves.some((move) => move.rules.length) ? ', after the documented rules applied with them' : ''}.`,
          status: 'proposed' as const,
          edits: proposal.edits.length,
          rules: [...new Set(proposal.edits.map((edit) => edit.rule!).filter(Boolean))].sort(),
          unresolvedFindings: review.length,
          ...(review.length
            ? {
                unresolvedSites: review.map(({ file, line, changeId, expression, confidence }) => ({
                  file,
                  line,
                  changeId,
                  expression,
                  confidence,
                })),
              }
            : {}),
          diff: proposal.patch!,
          validation: 'not-run',
          ruleEdits: proposal.edits,
          warnings: [
            'Requests through WhatsApp, Messenger, the business SDK, project helpers or options built at runtime stay on their version; each is listed for review.',
            ...alerts,
            'Patch contains source code. Review it for sensitive content before sharing.',
          ],
        };
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: META_GRAPH.id,
    adapter: META_GRAPH,
    runId: digest(
      `${options.before.hash}:${options.before.document.info.version}:${target}:${repositoryHash}:meta-graph:${options.apiVersionPolicy}`,
    ),
    apiVersion,
    sourceResolution: { status: 'relative-only' as const, warnings: [] as string[] },
    status,
    snapshots: { before: options.before.hash, after: options.after.hash },
    provenance: { before: options.before.provenance, after: options.after.provenance },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    },
    changes: [],
    specificationDiff: {
      engine: 'meta-graph-change-table' as const,
      changes: changes.changes
        .filter(
          (change) =>
            compareVersions(change.version, options.before.document.info.version) > 0 &&
            compareVersions(change.version, target) <= 0,
        )
        .map((change) => ({ type: change.kind, description: change.summary })),
      coverage: `The reviewed Meta Graph API change table (${CHANGELOG}), pinned by hash. WhatsApp Business Platform and Messenger Platform changelogs are not in it.`,
    },
    imports: [],
    calls: [],
    sdkCalls: [],
    expandedFields: [] as string[],
    findings,
    providerDetected: scan.calls.length > 0,
    stripeDetected: false,
    skippedFiles: [] as string[],
    operationImpacts: [],
    operationChanges: [],
    metaGraph: {
      target,
      requests: live.length,
      pins: pinned,
      moves: proposal.moves,
      stops: proposal.stops,
      migrations: plan.migrations,
      alerts: plan.alerts,
    },
    warnings: [...repository.warnings, ...alerts],
    assessment: { status: 'not-requested' as const },
    coverage: {
      specification: `Reviewed Graph API changelogs up to ${target}, read from developers.facebook.com.`,
      code: 'Graph API requests to graph.facebook.com and graph.instagram.com through fetch, axios, axios instances, pass-through helpers and FB.api, with versions from URLs, constants, environment defaults and FB.init, and fields, metrics and parameters written literally or set step by step. Requests through other helpers, options built at runtime, the business SDK, WhatsApp and Messenger stop for review.',
      decision:
        'No finding is not proof of no impact: response reads, permissions, app review and behaviour the change table does not record stay outside this check.',
    },
    nextAction:
      status === 'affected'
        ? 'Review the version moves, then validate the patch in an isolated environment.'
        : 'Review the Graph API requests Refit could not move before deciding impact.',
    patch,
  };
}

import { open, readFile } from 'node:fs/promises';
import type { ApiVersionEvidence, ApiVersionPolicy } from './api-version.ts';
import { daysUntil, loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import { META_SDK } from './deadline-exposure.ts';
import type { AiOptions } from './ai-budget.ts';
import { reconstructGraphCalls, type GraphReconstruction } from './meta-graph-ai.ts';
import { scanGraphCalls, type GraphCall } from './meta-graph-calls.ts';
import {
  checkMetaGraphChanges,
  compareVersions,
  DEFAULT_META_GRAPH_CHANGES,
  type MetaGraphChange,
  type MetaGraphChanges,
} from './meta-graph-changes.ts';
import { loadMetaPlatformAlerts, planMetaGraphFixes } from './meta-graph-fixes.ts';
import {
  changesUsedBy,
  fieldNames,
  inEffect,
  META_GRAPH_VERSION_RULE,
  type VersionMoveStop,
} from './meta-graph-moves.ts';
import { changeText, contextText, handOffToAgent } from './meta-graph-agent.ts';
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

// Versions Meta no longer serves on the day of the run: those the deadline registry dates on or
// before it, and every version older than the oldest it lists, which retired earlier.
function retiredVersions(registry: DeadlineRegistry, now: Date) {
  const entries = registry.deadlines.filter((entry) => entry.provider === META_GRAPH.id);
  const listed = entries.flatMap((entry) => entry.versions).filter((v) => VERSION.test(v));
  const oldest = listed.sort(compareVersions)[0];
  const past = new Set(
    entries.filter((entry) => daysUntil(entry.date, now) <= 0).flatMap((entry) => entry.versions),
  );
  return (version: string) =>
    past.has(version) || (oldest !== undefined && compareVersions(version, oldest) < 0);
}

// Whether the table ties a change to the request itself, rather than matching it for caution: a
// field, metric, parameter or edge the request names, or a literal path it calls. A change on a
// node type written as a placeholder (`/{custom-audience-id}`) matches any opaque ID, and a field
// change counted against a GET's default fields may not reach the node read, so neither is
// definite.
function definiteUse(call: GraphCall, change: MetaGraphChange) {
  // A changed error code leaves the request valid; whether the code handles that error is not
  // traced.
  if (change.kind === 'error-changed') return false;
  if (change.kind.startsWith('field-')) return fieldNames(call.fields ?? []).has(change.name ?? '');
  if (change.path !== null) {
    const segments = change.path.split('/').filter(Boolean);
    return !(segments.length === 1 && segments[0].includes('{'));
  }
  return true;
}

// Why a request the patch leaves on its version is a real Meta problem, or undefined when its stop
// is caution only: its version is retired, it definitely uses a change between its version and the
// target, or a documented rule names something it sends.
function realStop(
  call: GraphCall | undefined,
  stop: VersionMoveStop,
  target: string,
  changes: MetaGraphChanges,
  retired: (version: string) => boolean,
  now: Date,
) {
  if (stop.from && retired(stop.from)) return 'retired' as const;
  if (stop.reasons.some((reason) => / rule .* documents /.test(reason))) return 'rule' as const;
  if (!call || !stop.from) return undefined;
  const crossed = changes.changes.filter(
    (change) =>
      change.version !== null &&
      compareVersions(change.version, stop.from!) > 0 &&
      compareVersions(change.version, target) <= 0 &&
      !inEffect(change, now),
  );
  return changesUsedBy(call, crossed).some((change) => definiteUse(call, change))
    ? ('change' as const)
    : undefined;
}

// A Meta snapshot as readSpecification returns it.
interface Snapshot {
  hash: string;
  document: { info: { version: string }; metaGraphChanges: string };
  provenance: { provider: string; revision: string; url: string };
}

const where = (file: string, line: number) => `${file}:${line}`;

// `refit run` proposes the patch in its scan and again in validation, on a copy of the same commit;
// both get the one agent run, so it is paid for once and the validated patch is the scanned one.
const agentRuns = new Map<string, ReturnType<typeof handOffToAgent>>();
function cachedAgent(key: string, run: () => ReturnType<typeof handOffToAgent>) {
  // An agent or workspace failure ends as the agent's `failed` outcome, never the run.
  if (!agentRuns.has(key))
    agentRuns.set(
      key,
      run().catch((error: unknown) => ({
        outcome: 'failed' as const,
        diff: '',
        errors: [
          `The agent fixer could not run: ${error instanceof Error ? error.message : String(error)}`,
        ],
        summary: '',
        costUsd: 0,
        patch: '',
      })),
    );
  return agentRuns.get(key)!;
}

export async function runMetaGraphPipeline(options: {
  repository: string;
  before: Snapshot;
  after: Snapshot;
  proposePatch?: boolean;
  apiVersionPolicy: ApiVersionPolicy;
  now?: Date;
  // AI reads the requests the scan cannot (meta-graph-ai.ts).
  aiPatch?: AiOptions;
  // Reconstructions already made for this commit, such as the benchmark scan's, reused instead.
  reconstructions?: GraphReconstruction[];
}) {
  const now = options.now ?? new Date();
  const target = options.after.document.info.version;
  if (options.before.hash !== options.after.hash)
    throw new PipelineInputError(
      'Meta Graph runs need both snapshots taken from the same change table.',
    );
  const changes = changeTable(options.after.document.metaGraphChanges, 'the after snapshot');
  const repository = await readRepository(options.repository, META_SDK);
  const unread = await scanGraphCalls(options.repository, { repository });
  const reconstructions =
    options.reconstructions ??
    (options.aiPatch
      ? await reconstructGraphCalls(repository.files, unread.calls, options.aiPatch)
      : []);
  const scan = await scanGraphCalls(options.repository, { repository, reconstructions });
  const registry = await loadDeadlineRegistry(undefined, now);
  const plan = await planMetaGraphFixes(options.repository, target, {
    changes,
    registry,
    alerts: await loadMetaPlatformAlerts(),
    now,
    reconstructions,
  });
  const { proposal } = plan;
  const findings: Finding[] = [];
  // Each moved request is migrated by the move. A request the patch leaves on its version is a
  // finding when Refit found a real Meta problem there (realStop); a stop that is caution only,
  // on a version Meta still serves, is listed as a note, since the patch neither touches nor
  // worsens that line (docs/PROOF-BASED-VALIDATION.md). Product migrations are findings.
  const retired = retiredVersions(registry, now);
  const cautions: string[] = [];
  for (const move of proposal.moves)
    for (const request of move.requests)
      findings.push({
        file: request.file,
        line: request.line,
        column: 1,
        changeId: META_GRAPH_VERSION_RULE,
        expression: `${request.method ?? 'request'} ${request.path ?? ''}`.trim(),
        confidence: 'confirmed',
        reason: `Moves from ${move.from} (${where(move.file, move.line)}) to ${move.to}; the reviewed changelogs of ${move.crossed.join(', ')} list nothing this request uses.`,
      });
  for (const stop of proposal.stops) {
    // A pin already past the target needs nothing.
    if (stop.from && compareVersions(stop.from, target) > 0) continue;
    for (const request of stop.requests) {
      const call = scan.calls.find(
        (item) => item.file === request.file && item.line === request.line,
      );
      const real = realStop(call, stop, target, changes, retired, now);
      if (!real) {
        cautions.push(
          `${where(request.file, request.line)} ${request.method ?? 'request'} ${request.path ?? 'unknown path'} stays on ${stop.from ?? 'its version'}: ${stop.reasons.join(' ')}`,
        );
        continue;
      }
      findings.push({
        file: request.file,
        line: request.line,
        column: 1,
        changeId: `${META_GRAPH_VERSION_RULE}:review`,
        expression: `${request.method ?? 'request'} ${request.path ?? 'unknown path'}`,
        confidence: 'review',
        reason: `${stop.from ? `Stays on ${stop.from}${stop.file ? ` (${where(stop.file, stop.line!)})` : ''}` : 'Not moved'}${real === 'retired' ? `, which Meta no longer serves` : ''}: ${stop.reasons.join(' ')}`,
      });
    }
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
  for (const use of plan.outOfCycle)
    findings.push({
      file: use.file,
      line: use.line,
      column: 1,
      changeId: `meta-graph-out-of-cycle:${use.change}`,
      expression: use.change,
      confidence: 'review',
      reason: `Affected on every Graph API version, whatever this request pins: ${use.summary}${use.replacement ? ` Documented replacement: ${use.replacement}.` : ''} ${use.source}`,
    });
  const review = findings.filter((finding) => finding.confidence === 'review');
  const alerts = plan.alerts.map(
    (alert) =>
      `Meta alert (${alert.effective ?? 'undated'}, ${alert.status}) at ${where(alert.file, alert.line)}, ${alert.matched}: ${alert.summary}${alert.replacement ? ` Replacement: ${alert.replacement.join(', ')}.` : ''} ${alert.source}`,
  );
  const live = scan.calls.filter((call) => call.use === 'live');
  const pinned = [...new Set(live.flatMap((call) => (call.version ? [call.version] : [])))].sort();
  const apiVersion: ApiVersionEvidence = {
    application: pinned.length === 1 ? pinned[0] : null,
    before: options.before.document.info.version,
    after: target,
    // Each pin is checked against the change table from its own version, not from one before
    // contract, so every version the code pins is the "before" of its own move.
    applicability: !pinned.length
      ? 'unknown'
      : pinned.every((version) => version === target)
        ? 'matches-after'
        : 'matches-before',
    reason: pinned.length
      ? `The code pins ${pinned.join(', ')}. Each pin older than ${target} is checked against the reviewed changelogs from its own version, and moves only where nothing its requests use changed.`
      : 'No pinned Graph API version was found.',
    policy: options.apiVersionPolicy,
    source: {
      status: 'not-configured',
      declarations: [],
      reason: 'Meta Graph pins are read by the request scan, one per place a version is written.',
    },
  };
  // The gut plan (docs/GUT-PLAN.md): no stop ends the repository. With AI on, every request the
  // moves leave behind, every finding and every note goes to the agent fixer at once, starting from
  // the moves' patch, and Meta's judges grade its tree (meta-graph-agent.ts). The scan's
  // reconstructions are finder and judge input only.
  const kept = reconstructions.filter((item) => item.status === 'kept');
  const reconstructionNotes = kept.map(
    (item) =>
      `${where(item.file, item.line)}: Refit could not read this request statically; AI (${item.model}) read ${item.requests!.map((request) => `${request.method} ${request.path}`).join(', ')}${item.version ? ` on ${item.version} (${where(item.pin!.file, item.pin!.line)})` : ''} from the code, and Refit checked that every name is written there and ran it through the change table. Check that this is what the code sends.`,
  );
  const handOff = proposal.stops.filter(
    (stop) => !(stop.from && compareVersions(stop.from, target) > 0),
  );
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  const agent =
    options.proposePatch && options.aiPatch && (handOff.length || review.length)
      ? await cachedAgent(`${repositoryHash}:${target}:${digest(proposal.patch ?? '')}`, () =>
          handOffToAgent({
            repository: options.repository,
            original: repository,
            target,
            changes,
            reconstructions: kept,
            patch: proposal.patch,
            change: changeText(scan.calls, changes, target, now),
            context: contextText({
              stops: handOff,
              findings: review.map(
                (finding) => `${where(finding.file, finding.line)}: ${finding.reason}`,
              ),
              notes: [...alerts, ...cautions, ...reconstructionNotes],
              headStart: proposal.moves.map(
                (move) => `${where(move.file, move.line)}: ${move.from} moved to ${move.to}`,
              ),
            }),
          }),
        )
      : undefined;
  const agentPatch =
    agent?.patch && (agent.outcome === 'passed' || agent.outcome === 'unproven')
      ? agent
      : undefined;
  const agentRecord = agent && {
    outcome: agent.outcome,
    summary: agent.summary,
    errors: agent.errors,
    costUsd: agent.costUsd,
  };
  const rules = [...new Set(proposal.edits.map((edit) => edit.rule!).filter(Boolean))].sort();
  const notes = [
    ...alerts,
    ...reconstructionNotes,
    ...cautions.map(
      (note) =>
        `Left on its version, with no Meta problem found there (not counted as unresolved): ${note}`,
    ),
    'Patch contains source code. Review it for sensitive content before sharing.',
  ];
  const agentSites = (agentPatch?.outcome === 'unproven' ? agentPatch.errors : []).flatMap(
    (error) => {
      const site = /^(.+?):(\d+): /.exec(error);
      return site
        ? [
            {
              file: site[1],
              line: Number(site[2]),
              changeId: `${META_GRAPH_VERSION_RULE}:agent`,
              expression: error.slice(site[0].length, site[0].length + 200),
              confidence: 'review' as const,
            },
          ]
        : [];
    },
  );
  const patch = !options.proposePatch
    ? {
        status: 'not-generated' as const,
        reason:
          'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
      }
    : agentPatch
      ? {
          // The codebase's label for an AI-written patch; the agent is Claude (agent-fix.ts).
          generator: 'openai' as const,
          summary: `Move the Meta Graph API requests to ${target}. ${agentPatch.outcome === 'passed' ? "Refit's Meta judges pass on the result." : "Refit's Meta judges still report problems, listed below."}`,
          status: 'proposed' as const,
          edits: (agentPatch.patch.match(/^diff --git /gm) ?? []).length,
          rules,
          unresolvedFindings: agentPatch.outcome === 'passed' ? 0 : agentPatch.errors.length,
          ...(agentSites.length ? { unresolvedSites: agentSites } : {}),
          diff: agentPatch.patch,
          validation: 'not-run',
          ruleEdits: proposal.edits,
          agent: agentRecord,
          warnings: [
            `An AI agent wrote this patch${proposal.edits.length ? ` on top of Refit's ${proposal.edits.length} deterministic ${proposal.edits.length === 1 ? 'edit' : 'edits'}` : ''}. What it says it changed: ${agentPatch.summary || 'no summary.'}`,
            ...(agentPatch.outcome === 'unproven'
              ? [`Refit's Meta judges still report: ${agentPatch.errors.join(' ')}`]
              : []),
            ...notes,
          ],
        }
      : !proposal.edits.length
        ? {
            status: 'not-generated' as const,
            reason: [
              review[0]?.reason ?? `No request pins a Graph API version older than ${target}.`,
              agent
                ? `The agent fixer ${agent.outcome === 'no-change' ? 'changed nothing' : 'did not produce a patch'}: ${agent.summary || agent.errors.join(' ')}`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
            ...(agentRecord ? { agent: agentRecord } : {}),
          }
        : {
            generator: 'deterministic' as const,
            summary: `Move ${proposal.moves.length} pinned Graph API ${proposal.moves.length === 1 ? 'version' : 'versions'} to ${target}. The reviewed changelogs crossed list nothing the moved requests use.`,
            status: 'proposed' as const,
            edits: proposal.edits.length,
            rules,
            unresolvedFindings: review.length,
            ...(review.length
              ? {
                  unresolvedSites: review.map(
                    ({ file, line, changeId, expression, confidence }) => ({
                      file,
                      line,
                      changeId,
                      expression,
                      confidence,
                    }),
                  ),
                }
              : {}),
            diff: proposal.patch!,
            validation: 'not-run',
            ruleEdits: proposal.edits,
            ...(agentRecord ? { agent: agentRecord } : {}),
            warnings: [
              'Requests through WhatsApp, Messenger, the business SDK, project helpers or options built at runtime stay on their version; each is listed for review.',
              ...(agent
                ? [
                    `The agent fixer did not improve on this patch (${agent.outcome}): ${agent.summary || agent.errors.join(' ')}`,
                  ]
                : []),
              ...notes,
            ],
          };
  const status =
    proposal.moves.length || agentPatch
      ? ('affected' as const)
      : review.length || live.length
        ? ('needs-review' as const)
        : ('no-provider-signal' as const);
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
            change.version !== null &&
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
      // Requests AI read from code the scan could not; the proof applies the kept ones.
      reconstructed: reconstructions,
    },
    warnings: [...repository.warnings, ...alerts],
    assessment: { status: 'not-requested' as const },
    coverage: {
      specification: `Reviewed Graph API changelogs up to ${target}, read from developers.facebook.com.`,
      code: 'Graph API requests to graph.facebook.com and graph.instagram.com through fetch, axios, axios instances, pass-through helpers and FB.api, with versions from URLs, constants, environment defaults and FB.init, and fields, metrics and parameters written literally or set step by step. Requests through other helpers, options built at runtime, the business SDK, WhatsApp and Messenger go to the agent fixer when AI is on, and are listed for review otherwise.',
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

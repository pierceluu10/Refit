import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findReviewSites } from './ai-review-sites.ts';
import {
  LANE_RULES,
  proposeAiSurfaceMigration,
  type AiSurfaceProposal,
} from './ai-surface-lane.ts';
import type { AiOptions } from './ai-budget.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import type { AiRuleTable } from './ai-rules.ts';
import {
  proposeAnthropicSdkMajor,
  proposeGeminiSdkSwap,
  proposeOpenAiSdkMajor,
  loadSurface,
  type SdkMajorProposal,
  type SdkRule,
} from './ai-sdk-majors.ts';
import { sdkMajorUpgrade, type Resolve } from './ai-sdk-upgrade.ts';
import type { ModelFixChecks } from './model-fixes.ts';
import { applySourceEdits, renderFileReplacements, renderPatch } from './patches.ts';
import { publicationConfiguration, publishFiles } from './publication.ts';
import { readRepository } from './repository.ts';
import {
  existingTypeErrors,
  MAX_BODY_CHARACTERS,
  NEEDS_REVIEW_PREFIX,
  NO_OP_CHECK,
  wrap,
} from './review.ts';
import { loadSdkProofTable, storedRequestProof } from './sdk-request-proofs.ts';
import { digest } from './specifications.ts';
import type { PackageUpgrade } from './stripe-package-upgrade.ts';
import { PipelineInputError } from './types.ts';
import { gateNote, type CheckGate } from './check-gate.ts';
import { validateSourcePatch } from './validation.ts';

// AI provider migrations (SDK majors first): proposes the documented rewrites and the package
// upgrade, validates them with the repository's approved checks in offline Docker and opens a
// draft pull request. A proposal with any stop, or without request-level proof, is [Needs review].

const execute = promisify(execFile);

export const OPTIONAL_UPGRADE = 'SDK upgrade available, not required (would change outputs)';

export interface AiMigrationProposal extends SdkMajorProposal {
  // Every blocking stop is an optional-upgrade stop: the code works as it is, and the upgrade
  // would change its outputs (decision A). Reported as its own category, not as a failure.
  optionalUpgrade?: boolean;
  upgrade: PackageUpgrade | null;
  // Why the package could not be moved; the code edits are then never proposed alone.
  upgradeRefusal: string | null;
  patch: string | null;
}

export async function proposeAiMigrations(
  directory: string,
  tables: AiRuleTable[],
  options: {
    image: string;
    before: string;
    resolve?: Resolve;
    release?: string;
    // One SDK per draft; without it the first SDK below its target major, OpenAI first.
    packageName?: string;
    // Off by default (decision A): see proposeAnthropicSdkMajor.
    removeSampling?: boolean;
    // The Git checkout `directory` was extracted from, at the same commit: preparation reads a
    // pnpm, Yarn or Bun project's committed lockfiles (and their history) from it.
    repository?: string;
  },
): Promise<AiMigrationProposal | null> {
  const proposal = await proposeSdkMajor(directory, tables, options.packageName, {
    removeSampling: options.removeSampling,
  });
  if (!proposal) return null;
  // Sites of the same provider that fail today for another reason (a shut-down API or beta) are
  // listed in the draft too, so an SDK upgrade never reads as making those calls work.
  for (const finding of await findReviewSites(directory, tables, [
    'api-surface',
    'beta-feature',
    'response-format',
  ]))
    if (finding.provider === proposal.provider && finding.breaking && !finding.test)
      proposal.stops.push({
        file: finding.file,
        line: finding.line,
        rule: finding.rule,
        reason: `${finding.summary}${finding.ambiguous ? ' The file imports two SDKs; the client is unclear.' : ''} The SDK upgrade does not change this.`,
        blocking: false,
      });
  const blocking = proposal.stops.filter((item) => item.blocking);
  if (blocking.length && blocking.every((item) => item.category === 'optional-upgrade'))
    return {
      ...proposal,
      optionalUpgrade: true,
      upgrade: null,
      upgradeRefusal: `${OPTIONAL_UPGRADE}: ${blocking.length} request${blocking.length === 1 ? '' : 's'} send sampling parameters that ${proposal.packageName} ${proposal.targetMajor} rejects; the code works on its current SDK.`,
      patch: null,
    };
  if (blocking.length)
    return {
      ...proposal,
      upgrade: null,
      upgradeRefusal: `${blocking.length} site${blocking.length === 1 ? '' : 's'} would break on ${proposal.packageName} ${proposal.targetMajor} and no documented mapping covers ${blocking.length === 1 ? 'it' : 'them'}, so Refit proposes no partial upgrade.`,
      patch: null,
    };
  const companions = proposal.rules.find((rule) => rule.family === 'companion-packages');
  const result = await sdkMajorUpgrade(directory, {
    packageName: proposal.packageName,
    targetMajor: proposal.targetMajor,
    resolution: { image: options.image, before: options.before, resolve: options.resolve },
    release: options.release,
    repository: options.repository,
    companions: (companions?.data.packages as string[] | undefined) ?? [],
    together: proposal.together,
    replaces: proposal.replaces,
  });
  if ('reason' in result)
    return { ...proposal, upgrade: null, upgradeRefusal: result.reason, patch: null };
  const repository = await readRepository(directory, proposal.packageName);
  // The SDK-major patch is the package move plus the code edits; neither ships without the other.
  const patch =
    renderPatch(repository, proposal.edits) +
    renderFileReplacements(repository, result.upgrade.files, `${proposal.packageName}-upgrade`);
  return { ...proposal, upgrade: result.upgrade, upgradeRefusal: null, patch };
}

export async function proposeSdkMajor(
  directory: string,
  tables: AiRuleTable[],
  packageName?: string,
  options: { removeSampling?: boolean } = {},
) {
  const proposers = [
    ['openai', proposeOpenAiSdkMajor],
    ['@anthropic-ai/sdk', proposeAnthropicSdkMajor],
    ['@google/genai', proposeGeminiSdkSwap],
  ] as const;
  const now = new Date();
  const registry = await loadDeadlineRegistry(undefined, now).catch(() => undefined);
  for (const [name, propose] of proposers) {
    if (packageName && packageName !== name) continue;
    const proposal = await propose(
      directory,
      tables,
      registry && { entries: registry.deadlines, now },
      options,
    );
    if (proposal) return proposal;
  }
  return null;
}

const code = (text: string) => `\`${text.replaceAll('`', "'")}\``;

export interface RequestProof {
  // `accepted`: the provider accepted the smallest request for each migrated call with Refit's
  // test key; `pending`: it was not attempted, with the reason (a missing key names itself).
  status: 'accepted' | 'rejected' | 'pending';
  reason: string;
  calls: { call: string; status: 'accepted' | 'rejected' | 'pending'; detail: string }[];
}

export function aiMigrationTitle(proposal: AiMigrationProposal, needsReview: boolean) {
  const to = proposal.upgrade?.to ?? `${proposal.targetMajor}.x`;
  return `${needsReview ? NEEDS_REVIEW_PREFIX : ''}fix(deps): ${proposal.replaces ? `replace ${proposal.replaces} with ${proposal.packageName} ${to}` : `upgrade ${proposal.packageName} to ${to}`} and migrate its calls`;
}

// Proof levels are reported separately: (a) code, (b) request, (c) output shape. A level without
// evidence says so; nothing here claims the new SDK behaves the same.
export function aiMigrationBody(options: {
  proposal: AiMigrationProposal;
  validation: {
    revision: string;
    image: string;
    command: string[];
    baselineCommand: string[];
    compareTypeErrors?: boolean;
    baseline: { status: string; exitCode: number | null; stdout: string; stderr: string };
    patched: { status: string; exitCode: number | null; stdout: string; stderr: string };
    gate?: CheckGate;
  };
  requestProof: RequestProof;
}) {
  const { proposal, validation, requestProof } = options;
  const noOp = validation.command.join(' ') === NO_OP_CHECK;
  const existing = existingTypeErrors(validation);
  const reasons = [
    ...(proposal.stops.length
      ? [
          `${proposal.stops.length} site${proposal.stops.length === 1 ? '' : 's'} could not be migrated by a documented mapping; see Left for review.`,
        ]
      : []),
    ...(requestProof.status !== 'accepted'
      ? [`No request-level proof: ${requestProof.reason}`]
      : []),
    ...(noOp ? ['No check exercises the changed code; the patch is untested.'] : []),
  ];
  const sources = new Map<string, SdkRule['source']>();
  for (const rule of proposal.rules) sources.set(rule.source.url, rule.source);
  const editRules = new Map<string, number>();
  for (const item of proposal.edits) editRules.set(item.rule, (editRules.get(item.rule) ?? 0) + 1);
  const render = (stopLimit: number) => {
    const lines = [
      ...(reasons.length
        ? [
            '## Why this needs review',
            '',
            "Refit opened this draft for review. **Don't merge until you have checked each item.**",
            '',
            ...reasons.map((reason) => `- ${reason}`),
            '',
          ]
        : []),
      `## ${proposal.replaces ? `${proposal.replaces} ${proposal.upgrade?.from ?? proposal.installed} → ${proposal.packageName}` : `${proposal.packageName} ${proposal.upgrade?.from ?? proposal.installed} →`} ${proposal.upgrade?.to ?? proposal.targetMajor}`,
      '',
      `Refit moved ${code(proposal.packageName)} to its current major and rewrote the calls whose shape changed, using only the mappings in the provider's own migration guides. **The new SDK can behave differently even where the code reads the same: outputs, defaults, errors and retries may differ. Please check the quality of the results before merging.**`,
      '',
      '| Rule | Edits | Source |',
      '|---|---|---|',
      ...[...editRules].map(([rule, count]) => {
        const source = proposal.rules.find((item) => item.rule === rule)?.source;
        return `| ${code(rule)} | ${count} | ${source ? `[guide](${source.url}), read ${source.capturedAt}` : 'package upgrade'} |`;
      }),
      '',
      ...(proposal.upgrade?.warning ? [proposal.upgrade.warning, ''] : []),
      '## Proof',
      '',
      `- **(a) Code:** the repository's approved checks ran on ${code(validation.revision.slice(0, 12))} in offline Docker (${code(validation.image)}). Baseline ${code(validation.baselineCommand.join(' '))}: ${validation.baseline.status}. Patched ${code(validation.command.join(' '))}: ${validation.patched.status}${existing ? `; the type check ${existing}` : ''}.`,
      ...gateNote(validation.gate).map((line) => `  ${line}`),
      `- **(b) Request:** ${requestProof.status === 'accepted' ? `the smallest request for each migrated call was accepted by the provider with Refit's own test key (${requestProof.calls.map((item) => code(item.call)).join(', ')}).` : `${requestProof.status}. ${requestProof.reason}`}`,
      `- **(c) Output shape:** ${requestProof.calls.length ? requestProof.calls.map((item) => `${code(item.call)} ${item.status}: ${item.detail}`).join('; ') : 'not checked, because no request was sent.'}`,
      '',
      '## Not Verified',
      '',
      "- The checks ran without network access; they show the code compiles and the repository's own tests pass, not that every request still succeeds.",
      '- Request-level proof uses a minimal request per call shape, not your prompts, models or data.',
      '',
      '## Reviewer Checklist',
      '',
      '- [ ] Run the changed calls against the provider and compare their answers with the old ones.',
      '- [ ] Check error handling around the changed calls; the new SDK raises different error types.',
      ...(proposal.stops.length ? ['- [ ] Decide each site under Left for review.'] : []),
      '',
      'Refit opened this as a draft and never merges it.',
    ];
    if (proposal.stops.length)
      lines.push(
        '',
        '## Left for review',
        '',
        'Refit did not change these, because no documented mapping covers them:',
        '',
        ...proposal.stops
          .slice(0, stopLimit)
          .map(
            (item) => `- ${code(`${item.file}:${item.line}`)} (${code(item.rule)}): ${item.reason}`,
          ),
        ...(proposal.stops.length > stopLimit
          ? [
              `- and ${proposal.stops.length - stopLimit} more; Refit records every site in its result.`,
            ]
          : []),
      );
    if (sources.size)
      lines.push(
        '',
        '## Sources',
        '',
        ...[...sources.values()].map((page) => `- ${page.url} (read ${page.capturedAt})`),
      );
    return `${lines.join('\n')}\n`;
  };
  return (
    [Infinity, 25, 10, 0].map(render).find((body) => body.length <= MAX_BODY_CHARACTERS) ??
    render(0)
  );
}

export function aiMigrationMessage(
  proposal: AiMigrationProposal,
  validation: { command: string[]; patched: { status: string } },
) {
  return `${[
    aiMigrationTitle(proposal, false),
    '',
    wrap(
      `Moves ${proposal.packageName} from ${proposal.upgrade?.from} to ${proposal.upgrade?.to} and applies ${proposal.edits.length} documented edit${proposal.edits.length === 1 ? '' : 's'}; ${proposal.stops.length} site${proposal.stops.length === 1 ? '' : 's'} left for review.`,
    ),
    '',
    wrap(`Checks: ${validation.command.join(' ')} ${validation.patched.status} in offline Docker.`),
    '',
    ...[...new Set(proposal.rules.map((rule) => rule.source.url))].map((url) => `Source: ${url}`),
  ].join('\n')}\n`;
}

export type AiMigrationStatus =
  | 'no-change'
  | 'upgrade-optional'
  | 'needs-review'
  | 'validation-failed'
  | 'validated'
  | 'draft-created'
  | 'existing-pr';

export async function runAiMigrations(options: {
  repository: string;
  tables: AiRuleTable[];
  checks: ModelFixChecks;
  // The request proof for the migrated calls; by default the stored refit-bench proofs.
  requestProof?: (proposal: AiMigrationProposal) => Promise<RequestProof>;
  publication?: ReturnType<typeof publicationConfiguration>;
  resolve?: Resolve;
  packageName?: string;
  removeSampling?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { stdout } = await execute('git', ['-C', options.repository, 'log', '-1', '--format=%cI']);
  const before = stdout.trim();
  let proposal: AiMigrationProposal | null = null;
  const validation = await validateSourcePatch({
    repository: options.repository,
    ...options.checks,
    signal: options.signal,
    onProgress: options.onProgress,
    propose: async (directory) => {
      proposal = await proposeAiMigrations(directory, options.tables, {
        repository: options.repository,
        image: options.checks.image,
        before,
        resolve: options.resolve,
        packageName: options.packageName,
        removeSampling: options.removeSampling,
      });
      return proposal?.patch ?? null;
    },
  });
  const found = proposal as AiMigrationProposal | null;
  const result = (
    status: AiMigrationStatus,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => ({
    status,
    reason,
    revision: validation.revision,
    patchHash: 'patchHash' in validation ? (validation.patchHash ?? null) : null,
    proposal: found,
    ...extra,
  });
  if (!found) return result('no-change', 'No AI SDK below its target major.');
  if (validation.status === 'no-patch')
    return found.optionalUpgrade
      ? result('upgrade-optional', found.upgradeRefusal ?? OPTIONAL_UPGRADE)
      : result('needs-review', `No patch: ${found.upgradeRefusal}`);
  if (validation.status !== 'passed')
    return result(
      'validation-failed',
      `Validation returned ${validation.status}; nothing is published.`,
    );
  const requestProof = options.requestProof
    ? await options.requestProof(found)
    : storedRequestProof(
        await loadSdkProofTable(),
        found.packageName,
        found.targetMajor,
        found.calls,
      );
  const needsReview =
    found.stops.length > 0 ||
    requestProof.status !== 'accepted' ||
    validation.command.join(' ') === NO_OP_CHECK;
  if (requestProof.status === 'rejected')
    return result(
      'validation-failed',
      `The provider rejected a migrated request: ${requestProof.reason}`,
      { requestProof },
    );
  if (!options.publication)
    return result('validated', 'Checks passed; draft publication is not enabled.', {
      requestProof,
      needsReview,
    });
  const checked = { ...validation, compareTypeErrors: options.checks.compareTypeErrors };
  const published = await publishFiles(options.publication, {
    revision: validation.revision,
    key: `ai-migrations:${validation.revision}:${digest(validation.diff)}`,
    files: validation.publicationFiles,
    title: aiMigrationTitle(found, needsReview),
    body: aiMigrationBody({ proposal: found, validation: checked, requestProof }),
    message: aiMigrationMessage(found, validation),
  });
  return result(published.status === 'created' ? 'draft-created' : 'existing-pr', published.url, {
    requestProof,
    needsReview,
    pullRequest: { url: published.url, number: published.number },
  });
}

// The AI lane for surfaces with no one-to-one mapping (pipeline/ai-surface-lane.ts): the SDK major
// upgrade first when one is due, then the AI's rewrite of the flagged calls on top. It is
// validated only when the repository's checks run real code and pass, every new call shape has
// an accepted request proof, and every flagged site moved; otherwise [Needs review] with the
// reason. AI runs only in GitHub Actions (refit-bench), never on a laptop.
export async function runAiSurfaceMigrations(options: {
  repository: string;
  tables: AiRuleTable[];
  checks: ModelFixChecks;
  ai: AiOptions;
  request?: Parameters<typeof proposeAiSurfaceMigration>[0]['request'];
  resolve?: Resolve;
  release?: string;
  environment?: NodeJS.ProcessEnv;
  publication?: ReturnType<typeof publicationConfiguration>;
  onProgress?: (message: string) => void;
}) {
  if ((options.environment ?? process.env).GITHUB_ACTIONS !== 'true')
    throw new PipelineInputError(
      "The AI surface lane runs only in GitHub Actions (refit-bench), with Refit's key and AI budget.",
    );
  const { stdout } = await execute('git', ['-C', options.repository, 'log', '-1', '--format=%cI']);
  const before = stdout.trim();
  const now = new Date();
  const registry = await loadDeadlineRegistry(undefined, now);
  const target = options.tables
    .flatMap((table) => table.rules)
    .find((rule) => rule.rule === 'openai-node-target-6')!;
  const surface = loadSurface({ ...target, source: undefined as never });
  let sdk: AiMigrationProposal | null = null;
  let lane: AiSurfaceProposal | null = null;
  let refusal: string | null = null;
  const validation = await validateSourcePatch({
    repository: options.repository,
    ...options.checks,
    onProgress: options.onProgress,
    propose: async (directory) => {
      sdk = await proposeAiMigrations(directory, options.tables, {
        repository: options.repository,
        image: options.checks.image,
        before,
        resolve: options.resolve,
        release: options.release,
        packageName: 'openai',
      });
      if (sdk && !sdk.patch) {
        refusal = sdk.upgradeRefusal;
        return null;
      }
      const original = await readRepository(directory, 'openai');
      const upgraded = {
        ...original,
        files: original.files.map((file) => ({
          ...file,
          content: applySourceEdits(
            file.content,
            (sdk?.edits ?? []).filter((item) => item.file === file.path),
          ),
        })),
      };
      lane = await proposeAiSurfaceMigration({
        repository: upgraded,
        directory,
        tables: options.tables,
        ai: options.ai,
        models: { entries: registry.deadlines, now },
        surface: surface?.methods ?? new Set(),
        request: options.request,
      });
      if (!lane?.edits.length) {
        refusal = lane?.stops.map((item) => item.reason).join(' ') || 'No flagged site to migrate.';
        return null;
      }
      const changed = new Map<string, string>();
      for (const file of upgraded.files) {
        const before = original.files.find((item) => item.path === file.path)!.content;
        if (file.content !== before) changed.set(file.path, file.content);
      }
      for (const item of lane.edits) changed.set(item.file, item.replacement);
      const files = [...changed].map(([path, after]) => ({
        path,
        before: original.files.find((item) => item.path === path)!.content,
        after,
      }));
      return renderFileReplacements(
        original,
        [...files, ...(sdk?.upgrade?.files ?? [])],
        'ai-surface-migration',
      );
    },
  });
  const found = lane as AiSurfaceProposal | null;
  const base = {
    revision: validation.revision,
    ai: found?.ai ?? null,
    lane: found,
    sdk: sdk as AiMigrationProposal | null,
  };
  if (validation.status === 'no-patch')
    return { ...base, status: 'needs-review' as const, reason: `No patch: ${refusal}` };
  if (validation.status !== 'passed')
    return {
      ...base,
      status: 'validation-failed' as const,
      reason: `Validation returned ${validation.status}; nothing is published.`,
    };
  const requestProof = storedRequestProof(await loadSdkProofTable(), 'openai', 6, found!.calls);
  const reasons = [
    ...(validation.command.join(' ') === NO_OP_CHECK ? ['No check runs the changed code.'] : []),
    ...(requestProof.status !== 'accepted' ? [`Request proof: ${requestProof.reason}`] : []),
    ...found!.stops.map((item) => `${item.file}:${item.line}: ${item.reason}`),
    // The flagged sites the lane migrated are no longer open review items.
    ...((sdk as AiMigrationProposal | null)?.stops ?? [])
      .filter(
        (item) =>
          !(LANE_RULES.has(item.rule) && found!.edits.some((edit) => edit.file === item.file)),
      )
      .map((item) => `${item.file}:${item.line}: ${item.reason}`),
  ];
  const needsReview = reasons.length > 0;
  if (!options.publication)
    return {
      ...base,
      status: needsReview ? ('needs-review' as const) : ('validated' as const),
      reason: needsReview ? reasons.join(' ') : 'Checks, request proof and output shape passed.',
      requestProof,
    };
  const published = await publishFiles(options.publication, {
    revision: validation.revision,
    key: `ai-surfaces:${validation.revision}:${digest(validation.diff)}`,
    files: validation.publicationFiles,
    title: `${needsReview ? NEEDS_REVIEW_PREFIX : ''}fix(openai): move shut-down Completions and Assistants calls to Responses`,
    body: aiSurfaceBody({ lane: found!, reasons, requestProof, validation }),
    message: `fix(openai): move shut-down Completions and Assistants calls to Responses\n\n${wrap(`AI-drafted (${found!.ai?.model}, ${found!.ai?.responseId}) under Refit's guards; ${found!.aiLines.reduce((sum, item) => sum + item.lines.length, 0)} AI-written lines.`)}\n`,
  });
  return {
    ...base,
    status: published.status === 'created' ? ('draft-created' as const) : ('existing-pr' as const),
    reason: published.url,
    requestProof,
    needsReview,
  };
}

export function aiSurfaceBody(options: {
  lane: AiSurfaceProposal;
  reasons: string[];
  requestProof: RequestProof;
  validation: {
    revision: string;
    image: string;
    command: string[];
    baseline: { status: string };
    patched: { status: string };
  };
}) {
  const { lane, reasons, requestProof, validation } = options;
  const lines = [
    ...(reasons.length
      ? [
          '## Why this needs review',
          '',
          "Refit opened this draft for review. **Don't merge until you have checked each item.**",
          '',
          ...reasons.map((reason) => `- ${reason}`),
          '',
        ]
      : []),
    '## Shut-down OpenAI APIs',
    '',
    "OpenAI shut down the Assistants API on 2026-08-26 and every legacy Completions model on 2026-09-28, so these calls fail today. OpenAI documents no one-to-one mapping to Responses, so **an AI model drafted this migration** from OpenAI's migration guides, and Refit kept it only because it passed every guard: only the flagged calls and their statements changed, the files parse, no legacy call remains, every new call exists in openai 6, and every model is the original or the replacement OpenAI names.",
    '',
    '**Outputs may differ: Responses and the replacement models answer differently from the old calls. Check the quality of the results before merging.**',
    '',
    `AI: ${lane.ai?.model ?? 'n/a'}, response ${lane.ai?.responseId ?? 'n/a'}${lane.ai?.costUsd != null ? `, $${lane.ai.costUsd.toFixed(4)}` : ''}.`,
    '',
    '### AI-written lines',
    '',
    ...lane.aiLines.map((item) => `- \`${item.file}\`: lines ${item.lines.join(', ')}`),
    '',
    ...(lane.notes.length
      ? ['### Notes from the migration', '', ...lane.notes.map((note) => `- ${note}`), '']
      : []),
    '## Proof',
    '',
    `- **(a) Code:** \`${validation.command.join(' ')}\` on \`${validation.revision.slice(0, 12)}\` in offline Docker (\`${validation.image}\`): baseline ${validation.baseline.status}, patched ${validation.patched.status}.`,
    `- **(b) Request:** ${requestProof.status}. ${requestProof.reason}`,
    `- **(c) Output shape:** ${requestProof.calls.map((item) => `\`${item.call}\` ${item.status}: ${item.detail}`).join('; ') || 'no call shape to check.'}`,
    '',
    'Refit opened this as a draft and never merges it.',
  ];
  return `${lines.join('\n')}\n`.slice(0, MAX_BODY_CHARACTERS);
}

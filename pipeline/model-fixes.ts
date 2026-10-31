import type { DeadlineRegistry } from './deadline-registry.ts';
import { modelAlerts, type ModelAlert } from './model-alerts.ts';
import { loadParameterChanges, type ParameterChangeTable } from './model-parameter-changes.ts';
import type { ModelParameterTable } from './model-parameters.ts';
import {
  EMPTY_REQUEST_PROOFS,
  loadRequestProofs,
  unavailableTargets,
  requestProof,
  type RequestProof,
  type RequestProofTable,
} from './model-request-proofs.ts';
import { digest } from './specifications.ts';
import {
  proposeModelReplacements,
  type ModelEnvironmentRead,
  type ModelReplacement,
  type ModelReplacementStop,
} from './model-retirements.ts';
import { publicationConfiguration, publishFiles } from './publication.ts';
import {
  existingTypeErrors,
  MAX_BODY_CHARACTERS,
  NEEDS_REVIEW_PREFIX,
  NO_OP_CHECK,
  NO_OP_REVIEW,
  wrap,
} from './review.ts';
import { gateNote, type CheckGate, type NamedCheck } from './check-gate.ts';
import { validateSourcePatch } from './validation.ts';

// The repository's approved checks, from its enrolled Refit configuration.
export interface ModelFixChecks {
  image: string;
  command: string[];
  baselineCommand?: string[];
  checkTimeoutSeconds?: number;
  prepareDependencies?: boolean;
  compareTypeErrors?: boolean;
  // Tests, build and type check as separate checks, decided by the shared gate (check-gate.ts).
  checks?: NamedCheck[];
}

export type ModelFixStatus =
  | 'no-change'
  | 'needs-review'
  | 'validation-failed'
  | 'validated'
  | 'draft-created'
  | 'existing-pr';

export interface ModelFixResult {
  status: ModelFixStatus;
  reason: string;
  revision: string | null;
  patchHash: string | null;
  // Identifies the replacements (file, model and replacement), independent of unrelated edits.
  fixKey: string | null;
  // True when this set of replacements was already handled and nothing ran.
  skipped: boolean;
  replacements: ModelReplacement[];
  stops: ModelReplacementStop[];
  pullRequest: { url: string; number: number } | null;
}

const MAX_LOG_CHARACTERS = 2000;

function tail(text: string) {
  return text.length > MAX_LOG_CHARACTERS ? `…${text.slice(-MAX_LOG_CHARACTERS)}` : text;
}

function code(text: string) {
  return `\`${text.replaceAll('`', "'")}\``;
}

function fixKey(replacements: ModelReplacement[]) {
  return digest(
    JSON.stringify(
      replacements
        .map((item) => [item.edited.file, item.from, item.to])
        .sort((a, b) => a.join('\0').localeCompare(b.join('\0'))),
    ),
  );
}

// A check that runs no code tests nothing, so its draft needs review (owner decision 1).
const noOpChecked = (validation: { command: string[] }) =>
  validation.command.join(' ') === NO_OP_CHECK;

// Each replacement target and call family with its request-level proof, or the exact reason it has
// none. A draft with any unproven target is `[Needs review]`.
export function requestEvidence(replacements: ModelReplacement[], proofs: RequestProofTable) {
  const seen = new Map<
    string,
    { provider: string; to: string; call: string; proof?: RequestProof; pending?: string }
  >();
  for (const item of replacements) {
    const found = requestProof(proofs, item.provider, item.to, item.call);
    const key = `${item.provider}\t${item.to}\t${'proof' in found ? found.proof.api : found.pending}`;
    if (!seen.has(key))
      seen.set(key, {
        provider: item.provider,
        to: item.to,
        call: item.call,
        ...('proof' in found ? { proof: found.proof } : { pending: found.pending }),
      });
  }
  return [...seen.values()];
}

// Each edited value that environment variables override where they are set, by where it is edited.
// The deployed value is outside the repository, so a draft with one is `[Needs review]`.
export function environmentOverrides(replacements: ModelReplacement[]) {
  const found = new Map<string, { at: string; variables: string[]; to: string }>();
  for (const item of replacements) {
    if (!item.env?.length) continue;
    const at = `${item.edited.file}:${item.edited.line}`;
    const known = found.get(at);
    found.set(at, {
      at,
      to: item.to,
      variables: [...new Set([...(known?.variables ?? []), ...item.env])].sort(),
    });
  }
  return [...found.values()];
}

// The draft pull request description: what changed and why, what was checked and what was not,
// and what stays for a person to review.
export function modelFixBody(options: {
  replacements: ModelReplacement[];
  stops: ModelReplacementStop[];
  registry: DeadlineRegistry;
  // Embedding, fine-tuned and configuration uses Refit found and never changes.
  alerts?: ModelAlert[];
  // Requests whose model only an environment variable sets, with no committed value.
  environment?: ModelEnvironmentRead[];
  proofs?: RequestProofTable;
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
}) {
  const { replacements, stops, validation } = options;
  const sources = new Map(options.registry.deadlines.map((entry) => [entry.id, entry]));
  const more = (count: number, where: string) =>
    count > 0 ? [`- and ${count} more; ${where}.`] : [];
  const noOp = noOpChecked(validation);
  const existing = existingTypeErrors(validation);
  const alerts = options.alerts ?? [];
  const evidence = requestEvidence(replacements, options.proofs ?? EMPTY_REQUEST_PROOFS);
  const unproven = evidence.filter((item) => item.pending);
  const overridden = environmentOverrides(replacements);
  const environment = options.environment ?? [];
  const render = (rowLimit: number, stopLimit: number) => {
    const lines = [
      ...(noOp || unproven.length || overridden.length
        ? [
            '## Why this needs review',
            '',
            "Refit opened this draft for review (owner decision 1). **Don't merge until you have checked each item.**",
            '',
            ...(noOp ? [`- ${NO_OP_REVIEW.reason} **Check:** ${NO_OP_REVIEW.check}`] : []),
            ...unproven.map(
              (item) =>
                `- No request-level proof for ${code(item.to)}: ${item.pending} **Check:** send one request to ${code(item.to)} with this call's parameters and confirm the provider accepts it.`,
            ),
            ...overridden.map(
              (item) =>
                `- ${code(item.at)} reads ${item.variables.map(code).join(' or ')} first, and where one is set it overrides the edited value; its value is outside the repository. **Check:** set ${item.variables.map(code).join(' and ')} to ${code(item.to)} wherever ${item.variables.length === 1 ? 'it is' : 'they are'} set, including hosting and CI secrets.`,
            ),
            '',
          ]
        : []),
      '## Retiring AI models',
      '',
      'Refit replaced model IDs that their provider retires, using the replacement in its reviewed deadline registry. Requests to a retired model fail.',
      '',
      '| Call | Changed at | Model | Retires | Source |',
      '|---|---|---|---|---|',
      ...replacements.slice(0, rowLimit).map((item) => {
        const entry = sources.get(item.deadline);
        return `| ${code(`${item.file}:${item.line}`)} ${code(item.call)} | ${code(`${item.edited.file}:${item.edited.line}`)} | ${code(item.from)} → ${code(item.to)} | ${item.date} | ${entry?.source ? `[provider page](${entry.source}), checked ${entry.checkedAt}` : 'registry'} |`;
      }),
      '',
      ...(replacements.length > rowLimit
        ? [
            `${replacements.length - rowLimit} more replacements are not listed to keep this description short; every one is in Files changed.`,
            '',
          ]
        : []),
    ];
    if (replacements.some((item) => item.via.length > 1))
      lines.push(
        'Where the registry replacement retires too, Refit followed the registry to a model that does not.',
        '',
      );
    const parameterEdits = replacements.flatMap((item) => item.parameters ?? []);
    if (parameterEdits.length)
      lines.push(
        '## Request parameters changed with the model',
        '',
        "The replacement renames or rejects these parameters, as the provider's page states; Refit changed them in the same request:",
        '',
        ...parameterEdits.map(
          (edit) =>
            `- ${code(`${edit.file}:${edit.line}`)} ${edit.action === 'rename' ? `${code(edit.name)} → ${code(edit.to ?? '')}` : `removed ${code(edit.name)}`} (${code(edit.change)}): ${edit.note}`,
        ),
        '',
      );
    lines.push(
      '## Outputs may differ',
      '',
      "The replacement is a different model, so answers, formatting, length, tool use and refusals can differ from the retired model's on the same prompt. Refit does not claim the change behaves the same. Check output quality on your own prompts before merging.",
      '',
    );
    if (evidence.length)
      lines.push(
        '## Request proof',
        '',
        'Refit sent the smallest request each replacement accepts with its own test key in refit-bench Actions, never yours. It shows the provider serves the model and its response parses; it does not show the model answers your prompts well.',
        '',
        ...evidence.map((item) =>
          item.proof
            ? `- ${code(item.to)} ${code(item.proof.api)}: accepted with ${item.proof.parameters.length ? item.proof.parameters.map(code).join(', ') : 'no other parameters'}; ${Object.keys(item.proof.checks).join(', ')} passed ([run](${item.proof.run}), ${item.proof.date}).`
            : `- ${code(item.to)}: not proven. ${item.pending}`,
        ),
        '',
      );
    lines.push(
      '## Checks',
      '',
      `Refit ran the repository's approved checks on ${code(validation.revision.slice(0, 12))} in offline Docker (${code(validation.image)}), before and after this change:`,
      '',
      `- Baseline ${code(validation.baselineCommand.join(' '))}: ${validation.baseline.status}`,
      `- Patched ${code(validation.command.join(' '))}: ${validation.patched.status}${existing ? `; the type check ${existing}` : ''}`,
      ...gateNote(validation.gate),
      '',
      '## Not Verified',
      '',
      '- A passing check is evidence about that command only. The checks ran without network access, so no request reached OpenAI or Anthropic, and they cannot show how the new model answers.',
      '- A replacement model can change answers, cost, rate limits and supported parameters.',
      '',
      '## Rollback',
      '',
      replacements.some((item) => item.parameters?.length)
        ? 'Revert this pull request. It changes only the model IDs in the table above and the request parameters listed with them: no dependency, configuration or environment variable.'
        : 'Revert this pull request. It changes only the model IDs in the table above: no dependency, configuration or environment variable.',
      '',
      '## Reviewer Checklist',
      '',
      '- [ ] Try each changed call against the provider and compare its answers.',
      noOp
        ? `- [ ] ${NO_OP_REVIEW.check}`
        : `- [ ] Confirm ${code(validation.command.join(' '))} exercises the changed calls.`,
      ...(stops.length ? ['- [ ] Decide each use under Left for review.'] : []),
      '',
      'Refit opened this as a draft and never merges it.',
    );
    if (stops.length)
      lines.push(
        '',
        '## Left for review',
        '',
        'Refit did not change these, because a swap could change the request:',
        '',
        ...stops
          .slice(0, stopLimit)
          .map(
            (item) =>
              `- ${code(`${item.at.file}:${item.at.line}`)} ${code(item.model)}: ${item.reason}`,
          ),
        ...more(stops.length - stopLimit, 'Refit records every use in its result'),
      );
    if (environment.length)
      lines.push(
        '',
        '## Set in the environment',
        '',
        'These requests read their model only from an environment variable that no committed file sets, so Refit cannot tell which model they send and changed nothing. If one names a retiring model, set it to its replacement:',
        '',
        ...environment
          .slice(0, stopLimit)
          .map(
            (item) =>
              `- ${code(`${item.file}:${item.line}`)} ${code(item.call)} reads ${code(item.variable)}`,
          ),
        ...more(environment.length - stopLimit, 'Refit records every one in its result'),
      );
    if (alerts.length)
      lines.push(
        '',
        '## Alert only',
        '',
        'Refit found these retiring models and never changes them automatically:',
        '',
        ...alerts
          .slice(0, stopLimit)
          .map(
            (item) =>
              `- ${code(`${item.file}:${item.line}`)} ${code(item.model)} (${item.kind}): ${item.reason}${item.quote ? ` The provider's page: "${item.quote}"` : ''}`,
          ),
        ...more(alerts.length - stopLimit, 'Refit records every alert in its result'),
      );
    if (validation.patched.status !== 'passed')
      lines.push(
        '',
        '```',
        tail(`${validation.patched.stdout}\n${validation.patched.stderr}`),
        '```',
      );
    return `${lines.join('\n')}\n`;
  };
  // Shorter lists until the body fits.
  return (
    [
      [Infinity, Infinity],
      [40, 25],
      [10, 10],
    ]
      .map(([rows, uses]) => render(rows, uses))
      .find((body) => body.length <= MAX_BODY_CHARACTERS) ?? render(0, 0)
  );
}

const modelFixTitle = (replacements: ModelReplacement[]) =>
  `fix: replace ${replacements.length} retiring AI model${replacements.length === 1 ? '' : 's'}`;

// The commit explains itself in `git log`: each edited line, the checks and the provider pages.
export function modelFixMessage(options: Parameters<typeof modelFixBody>[0]) {
  const { replacements, stops, validation } = options;
  const existing = existingTypeErrors(validation);
  const sources = new Map(options.registry.deadlines.map((entry) => [entry.id, entry.source]));
  const listed = replacements.slice(0, 25);
  return `${[
    modelFixTitle(replacements),
    '',
    ...listed.map((item) =>
      wrap(
        `- ${item.edited.file}:${item.edited.line}: ${item.from} -> ${item.to}, retires ${item.date}`,
        '  ',
      ),
    ),
    ...(replacements.length > listed.length
      ? [`- and ${replacements.length - listed.length} more; see the pull request.`]
      : []),
    '',
    wrap(
      existing
        ? `Checks: ${validation.command.join(' ')} ${existing}, in offline Docker; no request reached the provider.`
        : validation.baselineCommand.join(' ') === validation.command.join(' ')
          ? `Checks: ${validation.command.join(' ')} ${validation.baseline.status} on the original and ${validation.patched.status} on the patched code in offline Docker; no request reached the provider.`
          : `Checks: ${validation.baselineCommand.join(' ')} ${validation.baseline.status} on the original and ${validation.command.join(' ')} ${validation.patched.status} on the patched code in offline Docker; no request reached the provider.`,
    ),
    ...(stops.length
      ? [
          '',
          wrap(
            `Left for review: ${stops.length} use${stops.length === 1 ? '' : 's'}; see the pull request.`,
          ),
        ]
      : []),
    '',
    ...[...new Set(replacements.map((item) => sources.get(item.deadline)).filter(Boolean))].map(
      (url) => `Source: ${url}`,
    ),
  ].join('\n')}\n`;
}

// Replaces retiring OpenAI and Anthropic models in an enrolled repository without asking first:
// proposes the registry replacements, validates them with the repository's approved checks in
// offline Docker, and opens a draft pull request when they pass and publication is configured.
// Anything the rules cannot replace safely is listed, never edited.
export async function runModelFixes(options: {
  repository: string;
  registry: DeadlineRegistry;
  parameters?: ModelParameterTable;
  // Sourced parameter changes applied with each swap: the shipped table unless one is passed, and
  // none with `null` (owner decision, 2026-10-29).
  parameterChanges?: ParameterChangeTable | null;
  // Edit indirect model sources too (owner decision, 2026-10-29); `false` keeps direct sites only.
  indirect?: boolean;
  // Request-level proofs for replacement models; a draft with an unproven one is [Needs review].
  proofs?: RequestProofTable;
  now: Date;
  checks: ModelFixChecks;
  publication?: ReturnType<typeof publicationConfiguration>;
  // A set of replacements already handled: skipped when its pull request exists, or when it was
  // already checked at this revision. A closed pull request is not reopened for the same fixes.
  handled?: { revision: string | null; fixKey: string | null; pullRequest: number | null } | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ModelFixResult> {
  let proposal: Awaited<ReturnType<typeof proposeModelReplacements>> | undefined;
  let alerts: ModelAlert[] = [];
  const proofs = options.proofs ?? (await loadRequestProofs());
  const validation = await validateSourcePatch({
    repository: options.repository,
    ...options.checks,
    signal: options.signal,
    onProgress: options.onProgress,
    propose: async (directory) => {
      proposal = await proposeModelReplacements(directory, options.registry, options.now, {
        parameters: options.parameters,
        parameterChanges:
          options.parameterChanges === null
            ? undefined
            : (options.parameterChanges ?? (await loadParameterChanges())),
        indirect: options.indirect ?? true,
        unavailable: unavailableTargets(proofs),
      });
      alerts = (await modelAlerts(directory, options.registry, options.now)).alerts;
      return proposal.patch;
    },
    skip: (revision) => {
      const key = proposal && fixKey(proposal.replacements);
      return Boolean(
        key &&
        options.handled?.fixKey === key &&
        (options.handled.pullRequest !== null || options.handled.revision === revision),
      );
    },
  });
  const replacements = proposal?.replacements ?? [];
  const stops = proposal?.stops ?? [];
  const result = (
    status: ModelFixStatus,
    reason: string,
    pullRequest: ModelFixResult['pullRequest'] = null,
  ): ModelFixResult => ({
    status,
    reason,
    revision: validation.revision,
    patchHash: ('patchHash' in validation ? validation.patchHash : undefined) ?? null,
    fixKey: replacements.length ? fixKey(replacements) : null,
    skipped: validation.status === 'skipped',
    replacements,
    stops,
    pullRequest,
  });
  if (validation.status === 'no-patch')
    return result(
      stops.length ? 'needs-review' : 'no-change',
      stops.length
        ? `No model can be replaced safely; ${stops.length} use${stops.length === 1 ? '' : 's'} left for review.`
        : 'No traced call sends a retiring model.',
    );
  if (validation.status === 'skipped')
    return result(
      'no-change',
      'These replacements were already handled; their pull request or result stands.',
    );
  if (validation.status !== 'passed')
    return result(
      'validation-failed',
      `Validation returned ${validation.status}; publication was not attempted.${validation.baselineStop ? ` The baseline checks failed because ${validation.baselineStop.summary}. ${validation.baselineStop.action}` : ''}`,
    );
  if (!options.publication)
    return result(
      'validated',
      'Baseline and patched checks passed; draft publication is not enabled.',
    );
  const checked = { ...validation, compareTypeErrors: options.checks.compareTypeErrors };
  const review =
    noOpChecked(validation) ||
    requestEvidence(replacements, proofs).some((item) => item.pending) ||
    environmentOverrides(replacements).length > 0;
  const published = await publishFiles(options.publication, {
    revision: validation.revision,
    key: `model-fixes:${validation.revision}:${fixKey(replacements)}`,
    files: validation.publicationFiles,
    title: `${review ? NEEDS_REVIEW_PREFIX : ''}${modelFixTitle(replacements)}`,
    body: modelFixBody({
      replacements,
      stops,
      registry: options.registry,
      validation: checked,
      alerts,
      environment: proposal?.environment,
      proofs,
    }),
    message: modelFixMessage({
      replacements,
      stops,
      registry: options.registry,
      validation: checked,
    }),
  });
  return result(published.status === 'created' ? 'draft-created' : 'existing-pr', published.url, {
    url: published.url,
    number: published.number,
  });
}

import type { DeadlineRegistry } from './deadline-registry.ts';
import type { ModelParameterTable } from './model-parameters.ts';
import { digest } from './specifications.ts';
import {
  proposeModelReplacements,
  type ModelReplacement,
  type ModelReplacementStop,
} from './model-retirements.ts';
import { publicationConfiguration, publishFiles } from './publication.ts';
import {
  MAX_BODY_CHARACTERS,
  NEEDS_REVIEW_PREFIX,
  NO_OP_CHECK,
  NO_OP_REVIEW,
  wrap,
} from './review.ts';
import { validateSourcePatch } from './validation.ts';

// The repository's approved checks, from its enrolled Refit configuration.
export interface ModelFixChecks {
  image: string;
  command: string[];
  baselineCommand?: string[];
  prepareDependencies?: boolean;
  compareTypeErrors?: boolean;
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

// The draft pull request description: what changed and why, what was checked and what was not,
// and what stays for a person to review.
export function modelFixBody(options: {
  replacements: ModelReplacement[];
  stops: ModelReplacementStop[];
  registry: DeadlineRegistry;
  validation: {
    revision: string;
    image: string;
    command: string[];
    baselineCommand: string[];
    baseline: { status: string };
    patched: { status: string; stdout: string; stderr: string };
  };
}) {
  const { replacements, stops, validation } = options;
  const sources = new Map(options.registry.deadlines.map((entry) => [entry.id, entry]));
  const more = (count: number, where: string) =>
    count > 0 ? [`- and ${count} more; ${where}.`] : [];
  const noOp = noOpChecked(validation);
  const render = (rowLimit: number, stopLimit: number) => {
    const lines = [
      ...(noOp
        ? [
            '## Why this needs review',
            '',
            "Refit opened this draft for review (owner decision 1). **Don't merge until you have checked each item.**",
            '',
            `- ${NO_OP_REVIEW.reason} **Check:** ${NO_OP_REVIEW.check}`,
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
    lines.push(
      '## Checks',
      '',
      `Refit ran the repository's approved checks on ${code(validation.revision.slice(0, 12))} in offline Docker (${code(validation.image)}), before and after this change:`,
      '',
      `- Baseline ${code(validation.baselineCommand.join(' '))}: ${validation.baseline.status}`,
      `- Patched ${code(validation.command.join(' '))}: ${validation.patched.status}`,
      '',
      '## Not Verified',
      '',
      '- A passing check is evidence about that command only. The checks ran without network access, so no request reached OpenAI or Anthropic, and they cannot show how the new model answers.',
      '- A replacement model can change answers, cost, rate limits and supported parameters.',
      '',
      '## Rollback',
      '',
      'Revert this pull request. It changes only the model IDs in the table above: no dependency, configuration or environment variable.',
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
      validation.baselineCommand.join(' ') === validation.command.join(' ')
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
  const validation = await validateSourcePatch({
    repository: options.repository,
    ...options.checks,
    signal: options.signal,
    onProgress: options.onProgress,
    propose: async (directory) => {
      proposal = await proposeModelReplacements(directory, options.registry, options.now, {
        parameters: options.parameters,
      });
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
  const published = await publishFiles(options.publication, {
    revision: validation.revision,
    key: `model-fixes:${validation.revision}:${fixKey(replacements)}`,
    files: validation.publicationFiles,
    title: `${noOpChecked(validation) ? NEEDS_REVIEW_PREFIX : ''}${modelFixTitle(replacements)}`,
    body: modelFixBody({ replacements, stops, registry: options.registry, validation }),
    message: modelFixMessage({ replacements, stops, registry: options.registry, validation }),
  });
  return result(published.status === 'created' ? 'draft-created' : 'existing-pr', published.url, {
    url: published.url,
    number: published.number,
  });
}

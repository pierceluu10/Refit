import type { DeadlineRegistry } from './deadline-registry.ts';
import type { ModelParameterTable } from './model-parameters.ts';
import { digest } from './specifications.ts';
import {
  proposeModelReplacements,
  type ModelReplacement,
  type ModelReplacementStop,
} from './model-retirements.ts';
import { publicationConfiguration, publishFiles } from './publication.ts';
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
  const lines = [
    '## Retiring AI models',
    '',
    'Refit replaced model IDs that their provider retires, using the replacement in its reviewed deadline registry. Requests to a retired model fail.',
    '',
    '| Call | Changed at | Model | Retires | Source |',
    '|---|---|---|---|---|',
    ...replacements.map((item) => {
      const entry = sources.get(item.deadline);
      return `| ${code(`${item.file}:${item.line}`)} ${code(item.call)} | ${code(`${item.edited.file}:${item.edited.line}`)} | ${code(item.from)} → ${code(item.to)} | ${item.date} | ${entry?.source ? `[provider page](${entry.source}), checked ${entry.checkedAt}` : 'registry'} |`;
    }),
    '',
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
    'A passing check is evidence about that command only. The checks ran without network access, so no request reached OpenAI or Anthropic, and they cannot show how the new model answers.',
    '',
    '## Before merging',
    '',
    '- A replacement model can change answers, cost, rate limits and supported parameters. Try the changed calls against the provider.',
    '- Refit opened this as a draft and never merges it.',
  );
  if (stops.length)
    lines.push(
      '',
      '## Left for review',
      '',
      'Refit did not change these, because a swap could change the request:',
      '',
      ...stops.map(
        (item) =>
          `- ${code(`${item.at.file}:${item.at.line}`)} ${code(item.model)}: ${item.reason}`,
      ),
    );
  if (validation.patched.status !== 'passed')
    lines.push(
      '',
      '```',
      tail(`${validation.patched.stdout}\n${validation.patched.stderr}`),
      '```',
    );
  return `${lines.join('\n')}\n`;
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
    title: `fix: replace ${replacements.length} retiring AI model${replacements.length === 1 ? '' : 's'}`,
    body: modelFixBody({ replacements, stops, registry: options.registry, validation }),
    message: 'fix: replace retiring AI models',
  });
  return result(published.status === 'created' ? 'draft-created' : 'existing-pr', published.url, {
    url: published.url,
    number: published.number,
  });
}

// The harness system prompt, in the order set by "The harness system prompt" in APTITUDE-PLAN.md.
import type { MigrationTask, Recipe, ToolPack } from '../shared/types.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckComparison, CheckRun } from './types.ts';

// Bump whenever any prompt or message text below changes, so runs can be compared by version.
export const PROMPT_VERSION = 'harness-prompt/2026-11-01.2';

export type PromptInput = {
  task: MigrationTask;
  toolPack: ToolPack;
  recipes: Recipe[];
  tools: { name: string; description: string }[];
  budgetUsd: number;
  sandboxNote: string;
};

const quote = (text: string) =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const tail = (text: string, lines = 40) => text.trimEnd().split('\n').slice(-lines).join('\n');

function taskSection(task: MigrationTask): string {
  const { change } = task;
  const affects = [
    change.affects.operations?.length && `- Operations: ${change.affects.operations.join(', ')}`,
    change.affects.fields?.length && `- Fields: ${change.affects.fields.join(', ')}`,
    change.affects.versions?.length && `- Versions: ${change.affects.versions.join(', ')}`,
    change.affects.sdk && `- SDK: ${change.affects.sdk}`,
  ].filter(Boolean);

  const usages = task.usages.map((usage) => {
    const head = [`- ${usage.provider} via ${usage.via}`];
    if (usage.sdk) head.push(`SDK ${usage.sdk.name}@${usage.sdk.version}`);
    if (usage.pinnedVersion) {
      const pin = usage.pinnedVersion;
      head.push(`pinned version ${pin.value} at ${pin.file}:${pin.line}`);
    }
    const sites = usage.callSites.map((site) => {
      let line = `  - ${site.file}:${site.line} ${site.operation}`;
      if (site.fields?.length) line += ` fields: ${site.fields.join(', ')}`;
      if (site.notes) line += ` (${site.notes})`;
      return line;
    });
    return [head.join(', '), ...sites].join('\n');
  });

  const facts = [
    `- Repository: ${task.repo}`,
    `- Change: ${change.title}`,
    `- Kind: ${change.kind}`,
    `- Provider: ${change.provider}`,
    change.effectiveDate && `- Effective date: ${change.effectiveDate}`,
    task.deadline && `- Deadline: ${task.deadline}`,
  ].filter(Boolean);

  return [
    '## The task',
    facts.join('\n'),
    `Source: ${change.source.url}`,
    quote(change.source.quote),
    affects.length
      ? ['What it affects:', ...affects].join('\n')
      : 'What it affects: not specified.',
    [
      'Affected usage in this repo (from the inventory; read the code to confirm it and find anything it missed):',
      usages.length ? usages.join('\n') : '- None recorded. Search the repo yourself.',
    ].join('\n'),
  ].join('\n\n');
}

function workflowSection(task: MigrationTask, toolPack: ToolPack, recipes: Recipe[]): string {
  const parts = [
    '## Workflow',
    [
      '1. Understand how this repo uses the API: read the call sites above and anything around them.',
      '2. Read the provider docs for this change (fetch_url and the provider tools).',
      '3. Check memory for recipes from earlier runs.',
      '4. Plan the change.',
      '5. Edit the code.',
      '6. Run the checks and the provider validators.',
      '7. Iterate until they pass, or until you can explain why they cannot.',
      '8. Write the PR summary by calling `finish`.',
    ].join('\n'),
  ];

  const playbook = toolPack.playbooks[task.change.kind];
  if (playbook) {
    parts.push(
      `### Provider playbook: ${toolPack.provider} / ${task.change.kind}`,
      playbook.trim(),
    );
  }

  if (recipes.length) {
    parts.push(
      '### Recipes from memory (guidance, not rules)',
      'These worked on earlier runs. Use what fits this repo and ignore what does not.',
      ...recipes.map((recipe) =>
        [
          `#### ${recipe.id} (${recipe.provider} / ${recipe.kind}, verified on ${recipe.verifiedRepos} repos)`,
          `Preconditions: ${recipe.preconditions}`,
          `Steps: ${recipe.steps}`,
          `Pitfalls: ${recipe.pitfalls}`,
        ].join('\n'),
      ),
    );
  }

  return parts.join('\n\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const { task, toolPack, recipes, tools, budgetUsd, sandboxNote } = input;

  const sections = [
    [
      '## Role',
      'You are Aptitude, a senior engineer who migrates code when external APIs change. You always attempt the migration.',
    ].join('\n\n'),
    taskSection(task),
    workflowSection(task, toolPack, recipes),
    [
      '## Tools',
      tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`).join('\n'),
      `Sandbox: ${sandboxNote}`,
      'Tools only return information. You decide which ones to use, and none of them block you.',
    ].join('\n\n'),
    [
      '## Definition of done',
      [
        '- **verified**: the checks pass before and after your change, and the provider validators pass. Only NEW failures count. Failures that existed before your change are noted, not fixed, unless your change touches them.',
        '- **needs-review**: state exactly what is unproven, and any behaviour change.',
        '- A provider validator counts only if you called it: in `finish`, list the provider tools you ran by tool name. The harness grades them from its own record of those calls, not from your report.',
      ].join('\n'),
      "Always end by calling `finish`. If the code genuinely does not use the changed API, call `finish` with verdict 'not-affected' and explain why.",
    ].join('\n\n'),
    [
      '## Style',
      [
        '- Make the smallest correct change.',
        '- Keep behaviour the same unless the API change forces otherwise, and say so.',
        "- Don't reformat unrelated code. Don't upgrade unrelated dependencies.",
      ].join('\n'),
    ].join('\n\n'),
    [
      '## Hard limits',
      [
        '1. Untrusted repo code runs only in the sandbox. Use the provided tools to run anything.',
        `2. This run has a dollar cap of $${budgetUsd.toFixed(2)} for AI calls.`,
        '3. PRs only. Never push and never merge. The harness opens the PR; you just edit files.',
        '4. Never print or commit secrets.',
      ].join('\n'),
      'When unsure, try anyway and say so in the PR.',
    ].join('\n\n'),
  ];

  return sections.join('\n\n');
}

function checkLine(run: CheckRun): string {
  if (run.ok) return `- ${run.name} (\`${run.command}\`): pass`;
  const shown = run.failures.slice(0, 5).map((failure) => `  - ${failure}`);
  const more = run.failures.length > 5 ? [`  - ...and ${run.failures.length - 5} more`] : [];
  return [`- ${run.name} (\`${run.command}\`): fail`, ...shown, ...more].join('\n');
}

export function buildKickoffMessage(before: CheckRun[], installOutput?: string): string {
  const parts = ['Start the migration described in the system prompt.'];
  if (installOutput) {
    parts.push(
      'Dependency install output (tail):',
      '```text\n' + tail(redactSecrets(installOutput)) + '\n```',
    );
  }
  parts.push(
    before.length
      ? [
          'Baseline checks, run before any change. Failures here already existed; only new failures count against you:',
          ...before.map(checkLine),
        ].join('\n')
      : 'No baseline checks were run. Find and run the repo checks yourself if you can.',
  );
  return parts.join('\n\n');
}

export function buildRetryMessage(input: {
  comparisons: CheckComparison[];
  after: CheckRun[];
  hasReport: boolean;
  escalated: boolean;
}): string {
  const parts = ['The harness re-ran the checks after your changes.'];
  if (input.escalated)
    parts.push('You are now on a stronger model. Take a fresh look at the problem.');

  const failing = input.comparisons.filter((comparison) => comparison.newFailures.length);
  if (failing.length) {
    parts.push('New failures (pre-existing ones are left out):');
    for (const comparison of failing) {
      const run = input.after.find((candidate) => candidate.name === comparison.name);
      parts.push(
        [
          `### ${comparison.name} (before: ${comparison.before}, after: ${comparison.after})`,
          ...comparison.newFailures.map((failure) => `- ${failure}`),
          run?.output ? '```text\n' + tail(run.output) + '\n```' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    parts.push(
      'Fix these. If one cannot be fixed, explain why in your `finish` report and list it as unproven.',
    );
  } else {
    parts.push('There are no new failures.');
  }

  if (!input.hasReport) parts.push('You have not called `finish` yet. Call it with your report.');
  return parts.join('\n\n');
}

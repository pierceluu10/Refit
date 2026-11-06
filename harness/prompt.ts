// The harness system prompt, in the order set by "The harness system prompt" in REFIT-PLAN.md.
// API migrations (MigrationTask) and every other external change (ExternalTask) share one prompt;
// an ExternalTask adds the dependency, every place it is declared and the upgrade guidance.
import type { ExternalTask, Recipe, ToolPack } from '../shared/types.ts';
import { packageManagerBinary, type PackageManager } from './checks.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckComparison, CheckRun, HarnessTask, Runtime } from './types.ts';

// Bump whenever any prompt or message text below changes, so runs can be compared by version.
export const PROMPT_VERSION = 'harness-prompt/2026-11-06.2';

export type TaskWithNotes = HarnessTask;

export const isExternalTask = (task: HarnessTask): task is ExternalTask =>
  Array.isArray((task as Partial<ExternalTask>).dependencies) &&
  typeof (task as ExternalTask).change.dependency === 'string';

// The kinds where the code mostly stays and a version moves.
const UPGRADE_KINDS = new Set([
  'runtime-eol',
  'framework-major',
  'dependency-major',
  'security-fix',
  'container-image-eol',
  'ci-deprecation',
  'serverless-runtime',
  'k8s-version',
]);
export const isUpgrade = (task: HarnessTask) =>
  isExternalTask(task) && UPGRADE_KINDS.has(task.change.kind);

// The language runtime the checks should run on after the change, when the change moves one.
// A hint for the harness and the agent; the agent can run checks on any runtime it names.
export function targetRuntime(task: HarnessTask): Runtime | undefined {
  if (!isExternalTask(task) || !task.change.toVersion) return undefined;
  const { dependency, dependencyKind, toVersion } = task.change;
  if (!['runtime', 'container-image', 'infrastructure'].includes(dependencyKind)) return undefined;
  const name = /^(?:node|nodejs)\b/i.test(dependency)
    ? 'node'
    : /^python\b/i.test(dependency)
      ? 'python'
      : undefined;
  const version = /\d+(?:\.\d+)*/.exec(toVersion)?.[0];
  return name && version ? { name, version } : undefined;
}

// shortcut: memory's recipes carry more than shared/types.ts Recipe (its MemoryRecipe); read those
// fields here until the contract grows them.
type MemoryRecipe = Recipe & {
  diffSketch?: string;
  skill?: { status: string; prompt: string };
  failedRunIds?: string[]; // runs shown this recipe whose PR a human closed
};

// Proven skills first, then recipes with their diff sketches, each with how it has fared so far.
export function renderRecipes(recipes: Recipe[]): string {
  const fared = (recipe: MemoryRecipe) => {
    const closed = recipe.failedRunIds?.length ?? 0;
    const against = closed
      ? `; ${closed} later PR${closed === 1 ? '' : 's'} that used it closed by a human without merging`
      : '';
    return `${recipe.provider} / ${recipe.kind}, verified on ${recipe.verifiedRepos} repos${against}`;
  };
  const all = recipes as MemoryRecipe[];
  const isSkill = (recipe: MemoryRecipe) => recipe.skill?.status === 'active';
  return [
    ...all
      .filter(isSkill)
      .map(
        (recipe) => `#### Proven skill ${recipe.id} (${fared(recipe)})\n${recipe.skill?.prompt}`,
      ),
    ...all
      .filter((recipe) => !isSkill(recipe))
      .map((recipe) =>
        [
          `#### ${recipe.id} (${fared(recipe)})`,
          `Preconditions: ${recipe.preconditions}`,
          `Steps: ${recipe.steps}`,
          `Pitfalls: ${recipe.pitfalls}`,
          recipe.diffSketch ? '```diff\n' + recipe.diffSketch + '\n```' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  ].join('\n\n');
}

export type PromptInput = {
  task: TaskWithNotes;
  toolPack: ToolPack;
  recipes: Recipe[];
  tools: { name: string; description: string }[];
  budgetUsd: number;
  sandboxNote: string;
  upgradePlaybooks?: Record<string, string>; // F2's, by kind
};

const quote = (text: string) =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const tail = (text: string, lines = 40) => text.trimEnd().split('\n').slice(-lines).join('\n');

function taskSection(task: TaskWithNotes): string {
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

  const external = isExternalTask(task) ? task.change : undefined;
  const facts = [
    `- Repository: ${task.repo}`,
    `- Change: ${change.title}`,
    `- Kind: ${change.kind}`,
    `- Provider: ${change.provider}`,
    external && `- Dependency: ${external.dependency} (${external.dependencyKind})`,
    external?.fromVersions?.length && `- Affected versions: ${external.fromVersions.join(', ')}`,
    external?.toVersion && `- Recommended target: ${external.toVersion}`,
    external?.severity && `- Severity: ${external.severity}`,
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
      usages.length
        ? usages.join('\n')
        : '- None recorded. Find the usage yourself: search the repo for the SDK, its imports, API hosts and the affected operations.',
    ].join('\n'),
    isExternalTask(task) ? dependencySection(task) : '',
    task.notes ? `Notes from matching:\n${quote(task.notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function dependencySection(task: ExternalTask): string {
  const lines = task.dependencies.map((dep) => {
    const head = `- ${dep.name}${dep.version ? ` ${dep.version}` : ''} (${dep.kind}${dep.ecosystem ? `, ${dep.ecosystem}` : ''})${dep.notes ? `: ${dep.notes}` : ''}`;
    const declared = dep.declaredIn.map(
      (place) =>
        `  - declared in ${place.file}${place.line ? `:${place.line}` : ''}${place.text ? `: \`${place.text.trim()}\`` : ''}`,
    );
    const sites = (dep.callSites ?? []).map(
      (site) =>
        `  - used at ${site.file}:${site.line} ${site.operation}${site.notes ? ` (${site.notes})` : ''}`,
    );
    return [head, ...declared, ...sites].join('\n');
  });
  return [
    'Where the dependency is declared and used (from the inventory; it can miss places, so search too, and `bump_version` lists every place it can find):',
    lines.length ? lines.join('\n') : '- None recorded. Find every place yourself.',
  ].join('\n');
}

const UPGRADE_WORKFLOW = [
  '1. Find every place the dependency is declared or implied (the list above, `bump_version` without `apply`, `search`), and every call site its change touches.',
  '2. Read what changed between the current and the target version: the source above, release notes and migration guides (`fetch_url` and the upgrade tools).',
  '3. Check memory for recipes from earlier runs.',
  '4. Plan the smallest correct upgrade: the target version, the places to move together, and the code the breaking changes touch.',
  "5. Move the version in every place (`bump_version` with `apply`, or edit), and change dependencies with the repo's package manager (`upgrade_package`) so it rewrites the lockfile.",
  '6. Fix the code the new version breaks.',
  '7. Run the checks, on the new runtime when the runtime moves (`run_checks` with `runtime`), and any validators or proof tools that fit.',
  '8. Iterate until they pass, or until you can explain why they cannot.',
  '9. Write the PR summary by calling `finish`.',
].join('\n');

function workflowSection(
  task: HarnessTask,
  toolPack: ToolPack,
  recipes: Recipe[],
  upgradePlaybooks: Record<string, string>,
): string {
  if (isExternalTask(task) && task.change.kind !== 'model-retirement' && !isApiKind(task)) {
    const parts = ['## Workflow', UPGRADE_WORKFLOW];
    return [...parts, ...guidance(task, toolPack, recipes, upgradePlaybooks)].join('\n\n');
  }
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
  return [...parts, ...guidance(task, toolPack, recipes, upgradePlaybooks)].join('\n\n');
}

// MigrationKind values: an ExternalTask of one of these is an API change and gets the API workflow.
const API_KINDS = new Set([
  'api-version',
  'sdk-major',
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'rest-to-graphql',
  'auth-change',
  'webhook-payload',
  'product-shutdown',
  'pagination-or-limits',
]);
const isApiKind = (task: HarnessTask) => API_KINDS.has(task.change.kind);

function guidance(
  task: HarnessTask,
  toolPack: ToolPack,
  recipes: Recipe[],
  upgradePlaybooks: Record<string, string>,
): string[] {
  const parts: string[] = [];
  const kind = task.change.kind;
  const playbook = (toolPack.playbooks as Record<string, string | undefined>)[kind];
  if (playbook) {
    parts.push(`### Provider playbook: ${toolPack.provider} / ${kind}`, playbook.trim());
  }
  if (isExternalTask(task)) {
    const upgrade = upgradePlaybooks[kind];
    if (upgrade) parts.push(`### Upgrade playbook: ${kind}`, upgrade.trim());
  }
  if (recipes.length) {
    parts.push(
      '### Recipes from memory (guidance, not rules)',
      'These worked on earlier runs. Use what fits this repo and ignore what does not.',
      renderRecipes(recipes),
    );
  }
  return parts;
}

const ROLE_API =
  'You are Refit, a senior engineer who migrates code when external APIs change. You always attempt the migration.';
const ROLE_EXTERNAL =
  'You are Refit, a senior engineer who keeps software from falling behind: when something outside the code changes (a runtime reaches end of life, a framework or library ships a breaking major, an advisory needs a fix, a base image, CI action or AI model is retired, an API changes), you change the code to match. You always attempt the change.';

function upgradeDone(task: ExternalTask): string {
  const runtime = targetRuntime(task);
  return [
    '- **verified** for an upgrade: the checks pass before the change on the old version and after it on the new version, and any validators or proof tools you ran pass. Only NEW failures count.',
    runtime
      ? `- This change moves the ${runtime.name} runtime to ${runtime.version}. The harness runs the final checks on it when the sandbox can provide it; run them on it yourself with \`run_checks\` \`runtime\`. If it cannot be provided, list that as unproven.`
      : '',
    '- Every place the version is declared moves together. List any place you left on purpose, and why.',
    '- **needs-review**: state exactly what is unproven (for example a workflow file no check can run, or a runtime the sandbox could not provide), and every behaviour change the new version brings that this code may notice.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const { task, toolPack, recipes, tools, budgetUsd, sandboxNote } = input;
  const external = isExternalTask(task);

  const sections = [
    ['## Role', external ? ROLE_EXTERNAL : ROLE_API].join('\n\n'),
    taskSection(task),
    workflowSection(task, toolPack, recipes, input.upgradePlaybooks ?? {}),
    [
      '## Tools',
      tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`).join('\n'),
      `Sandbox: ${sandboxNote}`,
      'Real env files (`.env`, `.env.local` and the like) are deliberately absent from the sandbox. Read the templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) to learn which keys and services the app uses.',
      'Tools only return information. You decide which ones to use, and none of them block you.',
    ].join('\n\n'),
    [
      '## Definition of done',
      [
        '- **verified**: the checks pass before and after your change, and the provider validators pass. Only NEW failures count. Failures that existed before your change are noted, not fixed, unless your change touches them.',
        '- **needs-review**: state exactly what is unproven, and any behaviour change.',
        "- List as unproven what this run could have checked and didn't, or checked and couldn't prove. Leave out the standing limit that no run here makes live API calls: the sandbox has no credentials, and the PR says so on every run.",
        "- What your change may do differently that only a live call would show, such as a new model's output or a response's shape at a new API version, goes under behaviour changes, so the reviewer checks it.",
        '- A provider validator counts only if you called it: in `finish`, list the provider tools you ran by tool name. The harness grades them from its own record of those calls, not from your report.',
        isUpgrade(task) ? upgradeDone(task as ExternalTask) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      external
        ? "Always end by calling `finish`. If the code genuinely does not depend on what changed (for example it already runs a supported version), call `finish` with verdict 'not-affected' and explain why."
        : "Always end by calling `finish`. If the code genuinely does not use the changed API, call `finish` with verdict 'not-affected' and explain why.",
    ].join('\n\n'),
    [
      '## Style',
      [
        '- Make the smallest correct change.',
        external
          ? '- Keep behaviour the same unless the change forces otherwise, and say so.'
          : '- Keep behaviour the same unless the API change forces otherwise, and say so.',
        "- Don't reformat unrelated code. Don't upgrade unrelated dependencies.",
        "- When a dependency must change, change it with the repo's own package manager and release (the kickoff message names them) and let it rewrite the lockfile. Never edit a lockfile by hand or switch package managers.",
        '- Before you call `finish`, look at your change with `diff`: the lockfile should change only for the dependencies you moved, and no file should change by accident.',
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

// Names the release that wrote the lockfile, so a dependency change keeps its format and the diff stays small.
export function packageManagerNote(pm: PackageManager, version?: string): string | undefined {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return undefined;
  const bin = packageManagerBinary(pm, version);
  const add = `${bin} ${pm === 'npm' ? 'install' : 'add'} <package>@<version>`;
  return [
    `Package manager: ${pm}${version ? ` ${version}, the repo's own release (from its packageManager field or its lockfile format)` : ''}.`,
    `\`install\` runs it as \`${bin}\`. Make any dependency change with that same command, for example \`${add}\`, so the lockfile keeps its format and its diff holds only what you changed.`,
  ].join(' ');
}

export function buildKickoffMessage(
  before: CheckRun[],
  installOutput?: string,
  packageManager?: string,
  notes: string[] = [],
): string {
  const parts = ['Start the migration described in the system prompt.'];
  if (packageManager) parts.push(packageManager);
  parts.push(...notes);
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
      : "No checks were detected. Find the repo's tests, build or type check and register them with `run_checks` `add`, so they run on the original code and after your edit and count toward proof.",
  );
  if (before.some((run) => !run.ok)) {
    parts.push(
      "A check that already fails cannot prove your change. If one fails only because the sandbox lacks something the code reads at build or test time, such as an env var like `OPENAI_API_KEY` or a generated client like Prisma's, register a variant with `run_checks` `add` that supplies it with a placeholder, never a real secret (for example `OPENAI_API_KEY=placeholder npm run build`), so it passes on the original code and can prove your edit.",
    );
  }
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

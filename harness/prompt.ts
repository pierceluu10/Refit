// The harness system prompt, in the order set by "The harness system prompt" in APTITUDE-PLAN.md.
import type { MigrationTask, Recipe, ToolPack } from '../shared/types.ts';
import { packageManagerBinary, type PackageManager } from './checks.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckComparison, CheckRun } from './types.ts';

// Bump whenever any prompt or message text below changes, so runs can be compared by version.
export const PROMPT_VERSION = 'harness-prompt/2026-11-03.r3-5';

// The day the run happens, so the agent can tell a change in effect from a later one.
const today = () => new Date().toISOString().slice(0, 10);

// shortcut: `notes` is on MigrationTask in O1's branch only; drop this local type once that merges.
export type TaskWithNotes = MigrationTask & { notes?: string };

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
      ? `; ${closed} later run${closed === 1 ? '' : 's'} that used it did not verify or had its PR closed without merging`
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
      usages.length
        ? usages.join('\n')
        : '- None recorded. Find the usage yourself: search the repo for the SDK, its imports, API hosts and the affected operations.',
    ].join('\n'),
    task.notes ? `Notes from matching:\n${quote(task.notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
      "6. Write a small test that proves the change, inside the repo's existing test setup (its test folder, framework and naming, so its own test command runs it): for example, that the webhook now reads `items.data[0].current_period_end`, or that the request names the new model. When the repo has no test setup, put a plain node or python script under `.refit-proof/`: the harness runs it but keeps it out of the PR. Register it with `run_checks` `add` so the harness runs it on the original code and after your edit. Mock the provider; the sandbox has no credentials.",
      '7. Run the checks and the provider validators.',
      '8. Iterate until they pass, or until you can explain why they cannot.',
      '9. Write the PR summary by calling `finish`, naming your test in `proofTest`.',
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
      renderRecipes(recipes),
    );
  }

  return parts.join('\n\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const { task, toolPack, recipes, tools, budgetUsd, sandboxNote } = input;

  const sections = [
    [
      '## Role',
      "You are Aptitude, a senior engineer who migrates code when external APIs change. Every task ends in a real attempt: a migration, or a careful 'not affected' or 'nothing to change yet' verdict with its evidence. A well-supported 'not affected' is as good an outcome as a migration; never edit code just to have changed something.",
    ].join('\n\n'),
    taskSection(task),
    workflowSection(task, toolPack, recipes),
    [
      '## Tools',
      // Names only: each tool's description already reaches the model with its definition.
      `Your tools: ${tools.map((tool) => `\`${tool.name}\``).join(', ')}. Each one's description says what it does and when to use it.`,
      `Sandbox: ${sandboxNote}`,
      'Real env files (`.env`, `.env.local` and the like) are deliberately absent from the sandbox. Read the templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) to learn which keys and services the app uses.',
      'Tools only return information. You decide which ones to use, and none of them block you.',
    ].join('\n\n'),
    [
      '## Definition of done',
      [
        '- **verified**: the checks pass before and after your change, your test of the change passes (named in `finish` as `proofTest`), and the provider validators pass. Only NEW failures count. Failures that existed before your change are noted, not fixed, unless your change touches them.',
        "- Only when no test of the change can be written at all, say why in `noProofTestReason`. A test that is hard to write is not one that can't be.",
        "- Put your test where it can run here. Don't add it to a test file or suite that already fails before your change (a database or service the sandbox lacks): it fails for the same reason, and every new failure counts against your change.",
        '- **needs-review**: state exactly what is unproven, and any behaviour change.',
        "- List as unproven what this run could have checked and didn't, or checked and couldn't prove. Leave out the standing limit that no run here makes live API calls: the sandbox has no credentials, and the PR says so on every run.",
        "- What your change may do differently that only a live call would show, such as a new model's output or a response's shape at a new API version, goes under behaviour changes, so the reviewer checks it.",
        '- A provider validator counts only if you called it: in `finish`, list the provider tools you ran by tool name. The harness grades them from its own record of those calls, not from your report.',
      ].join('\n'),
      `Act on what breaks this code now or soon: a change already in effect, or one that takes effect within 90 days of today (${today()}). For a deprecation that takes effect later and breaks nothing before then, don't edit for it; name it in your finish summary as upcoming, with its date.`,
      "Always end by calling `finish`. If the code genuinely does not use the changed API, or nothing needs to change yet, call `finish` with verdict 'not-affected' and explain why.",
    ].join('\n\n'),
    [
      '## Style',
      [
        '- Make the smallest correct change.',
        '- Keep behaviour the same unless the API change forces otherwise, and say so.',
        "- A provider's recommendation is not a requirement. Don't remove or change a parameter, option or default the change doesn't force, even when the new version suggests it (dropping `payment_method_types` for dynamic payment methods is a product decision, not a migration). Mention such a suggestion in the PR summary instead.",
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
  prepared: string[] = [],
): string {
  const parts = ['Start the migration described in the system prompt.'];
  if (packageManager) parts.push(packageManager);
  if (prepared.length) {
    parts.push(
      ['The harness prepared the repo before the baseline:', ...prepared.map((l) => `- ${l}`)].join(
        '\n',
      ),
    );
  }
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

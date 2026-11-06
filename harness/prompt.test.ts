import { describe, expect, it } from 'vitest';
import type { ExternalTask, MigrationTask, Recipe, ToolPack } from '../shared/types.ts';
import {
  PROMPT_VERSION,
  UPGRADE_PLAYBOOKS,
  isExternalTask,
  targetRuntime,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
  packageManagerNote,
  renderRecipes,
} from './prompt.ts';
import type { CheckRun } from './types.ts';

// Illustrative fixture, not a real customer repo.
const task: MigrationTask = {
  id: 'task-1',
  repo: 'example/shop',
  priority: 1,
  deadline: '2027-01-01',
  change: {
    provider: 'stripe',
    id: 'stripe-2026-10',
    kind: 'field-renamed',
    title: 'Charge.source renamed to Charge.payment_source',
    effectiveDate: '2026-12-01',
    source: {
      url: 'https://example.com/changelog#source',
      quote: 'The source field is renamed.\nUse payment_source instead.',
    },
    affects: { operations: ['charges.create'], fields: ['source'], versions: ['2026-10-01'] },
  },
  usages: [
    {
      repo: 'example/shop',
      provider: 'stripe',
      via: 'sdk',
      sdk: { name: 'stripe', version: '14.0.0' },
      pinnedVersion: { value: '2025-01-01', file: 'src/stripe.ts', line: 3 },
      callSites: [
        {
          file: 'src/pay.ts',
          line: 42,
          operation: 'charges.create',
          fields: ['source'],
          notes: 'card flow',
        },
      ],
    },
  ],
};

const toolPack: ToolPack = {
  provider: 'stripe',
  tools: [],
  playbooks: { 'field-renamed': 'Look for the old field name in request params.' },
};

const recipes: Recipe[] = [
  {
    id: 'recipe-7',
    provider: 'stripe',
    kind: 'field-renamed',
    preconditions: 'Uses stripe-node',
    steps: 'Rename the param',
    pitfalls: 'Webhook handlers read the old name too',
    sourceRuns: ['run-1'],
    verifiedRepos: 3,
  },
];

const prompt = buildSystemPrompt({
  task,
  toolPack,
  recipes,
  tools: [
    { name: 'fetch_url', description: 'Fetch a docs page' },
    { name: 'finish', description: 'Report the result' },
  ],
  budgetUsd: 5,
  sandboxNote: 'Docker container, network off',
});

describe('buildSystemPrompt', () => {
  it('has a version', () => {
    expect(PROMPT_VERSION).toBe('harness-prompt/2026-11-06.1');
  });

  it('puts the sections in the plan order', () => {
    const headings = [
      '## Role',
      '## The task',
      '## Workflow',
      '## Tools',
      '## Definition of done',
      '## Style',
      '## Hard limits',
    ];
    const positions = headings.map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('includes the task, playbook, recipes, tools and budget', () => {
    expect(prompt).toContain('> The source field is renamed.\n> Use payment_source instead.');
    expect(prompt).toContain('https://example.com/changelog#source');
    expect(prompt).toContain('src/pay.ts:42 charges.create fields: source (card flow)');
    expect(prompt).toContain('SDK stripe@14.0.0');
    expect(prompt).toContain('pinned version 2025-01-01 at src/stripe.ts:3');
    expect(prompt).toContain('Deadline: 2027-01-01');
    expect(prompt).toContain('Look for the old field name in request params.');
    expect(prompt).toContain('guidance, not rules');
    expect(prompt).toContain('Webhook handlers read the old name too');
    expect(prompt).toContain('verified on 3 repos');
    expect(prompt).toContain('`fetch_url`: Fetch a docs page');
    expect(prompt).toContain('Docker container, network off');
    expect(prompt).toContain('$5.00');
    expect(prompt).toContain("'not-affected'");
  });

  it('shows match notes and asks the agent to find the usage when none is recorded', () => {
    const noted = buildSystemPrompt({
      task: { ...task, usages: [], notes: 'no usage map, read the repo yourself' },
      toolPack: { provider: 'stripe', tools: [], playbooks: {} },
      recipes: [],
      tools: [],
      budgetUsd: 5,
      sandboxNote: 'Local temp copy',
    });
    expect(noted).toContain('Notes from matching:\n> no usage map, read the repo yourself');
    expect(noted).toContain('- None recorded. Find the usage yourself');
    expect(prompt).not.toContain('Notes from matching');
  });

  it('says real env files are absent and points at the templates', () => {
    expect(prompt).toContain('Real env files');
    expect(prompt).toContain('.env.example');
  });

  it('states the four hard limits and nothing else', () => {
    const limits = prompt.slice(prompt.indexOf('## Hard limits'));
    expect(limits).toContain('only in the sandbox');
    expect(limits).toContain('dollar cap');
    expect(limits).toContain('Never push and never merge');
    expect(limits).toContain('Never print or commit secrets');
    expect(limits.match(/^\d\. /gm)).toHaveLength(4);
    expect(limits).toContain('When unsure, try anyway and say so in the PR.');
  });

  it('has no refusal language', () => {
    expect(prompt).not.toMatch(/declin|refus|skip if|do not attempt|give up|if unsure, stop/i);
  });

  it("shows memory's skills first, with recipes' diff sketches and closed PRs", () => {
    // Memory's recipes carry more fields than the shared Recipe type.
    const sketched = {
      ...recipes[0],
      diffSketch: '- source\n+ payment_source',
      failedRunIds: ['run-9'],
    };
    const skilled = {
      ...recipes[0],
      id: 'recipe-8',
      verifiedRepos: 4,
      skill: { status: 'active', prompt: 'Rename source everywhere, webhooks included.' },
    };
    const rendered = renderRecipes([sketched, skilled]);
    expect(
      rendered.startsWith(
        '#### Proven skill recipe-8 (stripe / field-renamed, verified on 4 repos)\n',
      ),
    ).toBe(true);
    expect(rendered).toContain('Rename source everywhere, webhooks included.');
    expect(rendered).toContain(
      '#### recipe-7 (stripe / field-renamed, verified on 3 repos; 1 later PR that used it closed by a human without merging)',
    );
    expect(rendered).toContain('```diff\n- source\n+ payment_source\n```');
  });

  it('omits the playbook and recipes when there are none', () => {
    const bare = buildSystemPrompt({
      task,
      toolPack: { ...toolPack, playbooks: {} },
      recipes: [],
      tools: [],
      budgetUsd: 1,
      sandboxNote: 'local',
    });
    expect(bare).not.toContain('Provider playbook');
    expect(bare).not.toContain('Recipes from memory');
  });
});

const run = (name: string, ok: boolean, failures: string[] = [], output = ''): CheckRun => ({
  name,
  command: `npm run ${name}`,
  ok,
  failures,
  output,
});

describe('buildKickoffMessage', () => {
  it('summarises the baseline checks', () => {
    const message = buildKickoffMessage(
      [run('typecheck', true), run('test', false, ['a.test.ts > adds', 'b.test.ts > subtracts'])],
      'added 12 packages',
    );
    expect(message).toContain('Start the migration');
    expect(message).toContain('typecheck (`npm run typecheck`): pass');
    expect(message).toContain('test (`npm run test`): fail');
    expect(message).toContain('a.test.ts > adds');
    expect(message).toContain('added 12 packages');
    expect(message).toContain('A check that already fails cannot prove your change.');
    expect(buildKickoffMessage([run('build', true)])).not.toContain('already fails');
  });

  it("names the repo's package manager release and the command for dependency changes", () => {
    const note = packageManagerNote('npm', '8');
    expect(note).toContain("Package manager: npm 8, the repo's own release");
    expect(note).toContain('`npx -y npm@8 install <package>@<version>`');
    expect(buildKickoffMessage([], undefined, note)).toContain(note);
    expect(packageManagerNote('pnpm', '8.15.9')).toContain('`corepack pnpm@8.15.9 add');
    expect(packageManagerNote('pip')).toBe(undefined);
  });
});

describe('buildRetryMessage', () => {
  it('lists only new failures and asks for finish', () => {
    const message = buildRetryMessage({
      comparisons: [
        {
          name: 'typecheck',
          before: 'pass',
          after: 'fail (1 failure)',
          newFailures: ['TS2339 pay.ts'],
        },
        { name: 'test', before: 'fail (1 failure)', after: 'fail (1 failure)', newFailures: [] },
      ],
      after: [
        run('typecheck', false, ['TS2339 pay.ts'], 'error TS2339: Property source does not exist'),
        run('test', false, ['old.test.ts > flaky'], 'old flaky output'),
      ],
      hasReport: false,
      escalated: true,
    });
    expect(message).toContain('TS2339 pay.ts');
    expect(message).toContain('Property source does not exist');
    expect(message).not.toContain('old.test.ts > flaky');
    expect(message).not.toContain('### test');
    expect(message).toContain('Call it with your report');
    expect(message).toContain('stronger model');
    expect(message).not.toMatch(/\bstop\b/i);
  });

  it('does not nag about finish once there is a report', () => {
    const message = buildRetryMessage({
      comparisons: [],
      after: [],
      hasReport: true,
      escalated: false,
    });
    expect(message).toContain('no new failures');
    expect(message).not.toContain('finish');
  });
});

// Illustrative upgrade task shaped like the demo-node-api sample repo, not a real customer.
const upgrade: ExternalTask = {
  id: 'upgrade-1',
  repo: 'example/demo-node-api',
  priority: 1,
  deadline: '2025-04-30',
  usages: [],
  change: {
    provider: 'nodejs',
    id: 'node-18-eol',
    kind: 'runtime-eol',
    title: 'Node.js 18 reaches end of life',
    effectiveDate: '2025-04-30',
    source: { url: 'https://example.com/node-release-schedule', quote: 'Node 18: end of life.' },
    affects: { versions: ['18'] },
    dependency: 'node',
    dependencyKind: 'runtime',
    fromVersions: ['18'],
    toVersion: '22',
    severity: 'deadline',
  },
  dependencies: [
    {
      repo: 'example/demo-node-api',
      kind: 'runtime',
      name: 'node',
      version: '18',
      declaredIn: [
        { file: 'package.json', line: 5, text: '"node": ">=18"' },
        { file: 'Dockerfile', line: 1, text: 'FROM node:18' },
      ],
    },
  ],
};

describe('buildSystemPrompt for upgrades', () => {
  const upgradePrompt = buildSystemPrompt({
    task: upgrade,
    toolPack: { provider: 'nodejs', tools: [], playbooks: {} },
    recipes: [],
    tools: [{ name: 'bump_version', description: 'Move a version' }],
    budgetUsd: 5,
    sandboxNote: 'local copy',
    upgradePlaybooks: { 'runtime-eol': 'Illustrative F2 playbook text.' },
  });

  it('tells the agent what changed, the target, and every declared place', () => {
    expect(upgradePrompt).toContain('keeps software from falling behind');
    expect(upgradePrompt).toContain('- Dependency: node (runtime)');
    expect(upgradePrompt).toContain('- Recommended target: 22');
    expect(upgradePrompt).toContain('- Severity: deadline');
    expect(upgradePrompt).toContain('- Deadline: 2025-04-30');
    expect(upgradePrompt).toContain('> Node 18: end of life.');
    expect(upgradePrompt).toContain('  - declared in package.json:5: `"node": ">=18"`');
    expect(upgradePrompt).toContain('  - declared in Dockerfile:1: `FROM node:18`');
  });

  it('gives the upgrade workflow, the playbooks and the upgrade definition of done', () => {
    expect(upgradePrompt).toContain('`bump_version` with `apply`');
    expect(upgradePrompt).toContain(
      '### Upgrade playbook: runtime-eol\n\nIllustrative F2 playbook text.',
    );
    expect(upgradePrompt).toContain(UPGRADE_PLAYBOOKS['runtime-eol']);
    expect(upgradePrompt).toContain('after it on the new version');
    expect(upgradePrompt).toContain('moves the node runtime to 22');
    expect(upgradePrompt).toContain("verdict 'not-affected'");
  });

  it('keeps the API prompt for API tasks', () => {
    expect(prompt).toContain('migrates code when external APIs change');
    expect(prompt).not.toContain('bump_version` with `apply');
  });

  it('has guidance for every upgrade kind O2 covers', () => {
    for (const kind of [
      'runtime-eol',
      'framework-major',
      'dependency-major',
      'security-fix',
      'container-image-eol',
      'ci-deprecation',
      'model-retirement',
    ]) {
      expect(UPGRADE_PLAYBOOKS[kind]).toBeTruthy();
    }
  });

  it('tells external tasks apart and finds the runtime the checks should run on', () => {
    expect(isExternalTask(upgrade)).toBe(true);
    expect(isExternalTask(task)).toBe(false);
    expect(targetRuntime(upgrade)).toEqual({ name: 'node', version: '22' });
    const image = {
      ...upgrade,
      change: {
        ...upgrade.change,
        kind: 'container-image-eol' as const,
        dependency: 'python:3.9-slim',
        dependencyKind: 'container-image' as const,
        toVersion: '3.12-slim',
      },
    };
    expect(targetRuntime(image)).toEqual({ name: 'python', version: '3.12' });
    const library = {
      ...upgrade,
      change: { ...upgrade.change, dependency: 'next', dependencyKind: 'framework' as const },
    };
    expect(targetRuntime(library)).toBeUndefined();
  });
});

describe('buildKickoffMessage notes', () => {
  it('adds the harness notes, such as the runtime the checks will run on', () => {
    const message = buildKickoffMessage([], undefined, undefined, ['After your change: node 22.']);
    expect(message).toContain('After your change: node 22.');
  });
});

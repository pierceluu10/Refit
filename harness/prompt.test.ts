import { describe, expect, it } from 'vitest';
import type { MigrationTask, Recipe, ToolPack } from '../shared/types.ts';
import {
  PROMPT_VERSION,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
  packageManagerNote,
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
    expect(PROMPT_VERSION).toBe('harness-prompt/2026-11-01.8');
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

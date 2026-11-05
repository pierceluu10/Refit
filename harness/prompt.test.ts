import { describe, expect, it } from 'vitest';
import type { MigrationTask, Recipe, ToolPack } from '../shared/types.ts';
import {
  PROMPT_VERSION,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
  packageManagerNote,
  renderRecipes,
} from './prompt.ts';
import { repoTask, type DeadApiEntry, type ScanResult } from './findings.ts';
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
    expect(PROMPT_VERSION).toBe('harness-prompt/2026-11-05.rebuild-5');
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
    expect(prompt).toContain('`fetch_url`, `finish`');
    expect(prompt).not.toContain('Fetch a docs page');
    expect(prompt).toContain('within 90 days of today');
    expect(prompt).toContain(
      "A well-supported 'not affected' is as good an outcome as a migration",
    );
    expect(prompt).toContain('`.refit-proof/`');
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
      '#### recipe-7 (stripe / field-renamed, verified on 3 repos; 1 later run that used it did not verify or had its PR closed without merging)',
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

describe('renderRecipes', () => {
  it('marks a recipe no merged PR backs yet', () => {
    const recipe = {
      id: 'r1',
      provider: 'openai',
      kind: 'other' as const,
      preconditions: '',
      steps: '',
      pitfalls: '',
      sourceRuns: [],
      verifiedRepos: 0,
      confidence: 'low' as const,
    };
    expect(renderRecipes([recipe])).toContain('low confidence: no merged PR backs it yet');
  });
});

describe('a repo session', () => {
  const entry = (id: string): DeadApiEntry => ({
    id,
    provider: 'anthropic',
    what: `${id} model`,
    diedOn: '2026-06-15',
    source: { url: 'https://example.com/deprecations', checkedOn: '2026-11-04' },
    lookFor: [id],
    matchers: [],
    replacement: 'claude-sonnet-5-5',
    requires: ['Drop `temperature`.'],
  });
  const scan = (file: string): ScanResult => ({
    findings: [{ entryId: 'AN-1', file, line: 7, matchClass: 'live', version: '0.30.0' }],
    unlistedProviders: [],
    clean: false,
  });
  const system = (task: MigrationTask) =>
    buildSystemPrompt({
      task,
      toolPack: { provider: 'anthropic', tools: [], playbooks: {} },
      recipes: [],
      tools: [{ name: 'finish', description: '' }],
      budgetUsd: 1,
      sandboxNote: 'Docker',
    });

  it('gives the session the fix rules', () => {
    const prompt = system(repoTask('acme/a', scan('a.py'), [entry('AN-1')]));
    for (const rule of [
      '"Out of scope" is not an answer',
      'No major upgrade unless a list entry requires it',
      'read it from config',
      'Change defaults and live paths, not only tests',
      'Replacements come from the list entry',
      "Don't edit an existing test just to make it pass",
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  it('keeps the system prompt the same across repos, so its cached prefix is shared', () => {
    const a = system(repoTask('acme/a', scan('a.py'), [entry('AN-1')]));
    const b = system(repoTask('other/b', scan('b.py'), [entry('AN-1')]));
    expect(a).toBe(b);
    expect(a).not.toContain('acme/a');
  });

  it('puts every entry and finding in the kickoff message', () => {
    const task = repoTask('acme/a', scan('src/a.py'), [entry('AN-1'), entry('AN-9')]);
    const kickoff = buildKickoffMessage([], undefined, undefined, [], task);
    expect(kickoff).toContain('acme/a');
    expect(kickoff).toContain('### AN-1: AN-1 model');
    expect(kickoff).toContain('src/a.py:7 (live, version 0.30.0)');
    expect(kickoff).toContain('Replacement: claude-sonnet-5-5');
    expect(kickoff).toContain('Drop `temperature`.');
    expect(kickoff).not.toContain('AN-9');
  });

  it('numbers each requirement once, so the session can answer for every one', () => {
    const task = repoTask('acme/a', scan('src/a.py'), [entry('AN-1')]);
    const second = { ...entry('AN-1'), id: 'AN-2', requires: ['Drop `temperature`.', 'New line.'] };
    const both = { ...task, entries: [...task.entries, second] };
    const kickoff = buildKickoffMessage([], undefined, undefined, [], both);
    expect(kickoff.match(/\[r1\] Drop `temperature`\./g)).toHaveLength(1);
    expect(kickoff).toContain('[r2] New line.');
  });

  it('names what the provider validator rejects', () => {
    const task = repoTask('acme/a', scan('src/a.py'), [entry('AN-1')]);
    const kickoff = buildKickoffMessage([], undefined, undefined, [], task, [
      'app/a.tsx: Field "productVariantUpdate" does not exist on type Mutation.',
    ]);
    expect(kickoff).toContain('Each is part of this fix');
    expect(kickoff).toContain('app/a.tsx: Field "productVariantUpdate"');
  });
});

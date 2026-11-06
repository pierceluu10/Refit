import { describe, expect, it } from 'vitest';
import type { DependencyUsage, ExternalChange } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import {
  baseName,
  buildExternalPrompt,
  companions,
  createExternalMatchAgent,
  EXTERNAL_SYSTEM_PROMPT,
  externalHints,
  NO_VERDICT,
} from './external-match.ts';
import type { AskModel } from './match.ts';

// Illustrative in-test data, not real advisories or repos.
const change = (id: string, extra: Partial<ExternalChange> = {}): ExternalChange => ({
  provider: 'example',
  id,
  kind: 'runtime-eol',
  dependencyKind: 'runtime',
  dependency: 'node',
  title: id,
  source: { url: 'https://example.com/eol', quote: '(illustrative)' },
  affects: {},
  ...extra,
});

const dep = (name: string, kind: DependencyUsage['kind'], version?: string): DependencyUsage => ({
  repo: 'acme/api',
  kind,
  name,
  version,
  declaredIn: [{ file: `${name}.txt`, line: 1 }],
});

const deps = [
  dep('node', 'runtime', '18'),
  dep('node:18-bookworm', 'container-image', '18-bookworm'),
  dep('actions/setup-node', 'ci', 'v4'),
  dep('express', 'framework', '4.18.2'),
];

const answering =
  (output: unknown): AskModel =>
  async () => ({ output, costUsd: 0.12 });
const agent = (output: unknown) =>
  createExternalMatchAgent({ ask: answering(output), budget: createBudget(5) });

const task = (changeId: string, extra: Record<string, unknown> = {}) => ({
  changeId,
  dependencyIndexes: [0],
  usageIndexes: [],
  callSites: [],
  reasoning: `reason ${changeId}`,
  impact: 'high',
  deadline: '',
  toVersion: '',
  alsoResolves: [],
  ...extra,
});

describe('the external match agent', () => {
  it('gives every change a verdict and hands a change with none to the harness', async () => {
    const changes = [change('a'), change('b'), change('c', { dependency: 'python' })];
    const result = await agent({
      tasks: [task('a', { dependencyIndexes: [0, 1, 2] }), task('ghost')],
      notAffected: [{ changeId: 'c', reasoning: 'no python in this repo' }],
    })({ repo: 'acme/api', changes, dependencies: deps, usages: [] });

    expect(result.costUsd).toBe(0.12);
    expect(result.tasks.map((t) => t.change.id)).toEqual(['a', 'b']);
    expect(result.tasks[0].dependencies.map((d) => d.name)).toEqual([
      'node',
      'node:18-bookworm',
      'actions/setup-node',
    ]);
    expect(result.tasks[1]).toMatchObject({ notes: NO_VERDICT, impact: 'unknown' });
    expect(result.notAffected).toEqual([{ changeId: 'c', reasoning: 'no python in this repo' }]);
  });

  it('keeps the task when a change is judged both ways: unsure means attempt', async () => {
    const result = await agent({
      tasks: [task('a')],
      notAffected: [{ changeId: 'a', reasoning: 'maybe not' }],
    })({ repo: 'acme/api', changes: [change('a')], dependencies: deps, usages: [] });
    expect(result.tasks).toHaveLength(1);
    expect(result.notAffected).toEqual([]);
  });

  it('merges changes that move the same dependency to the same target into one task', async () => {
    const changes = [
      change('runtime', { toVersion: '22' }),
      change('image', { toVersion: '22', dependencyKind: 'container-image' }),
      change('agent-merged'),
    ];
    const result = await agent({
      tasks: [task('runtime'), task('image', { dependencyIndexes: [1] }), task('x')],
      notAffected: [],
    })({
      repo: 'acme/api',
      changes: [...changes],
      dependencies: deps,
      usages: [],
    });
    const runtime = result.tasks.find((t) => t.change.id === 'runtime')!;
    expect(runtime.alsoResolves).toEqual([{ changeId: 'image', title: 'image' }]);
    expect(runtime.dependencies.map((d) => d.name)).toEqual(['node', 'node:18-bookworm']);
    expect(result.tasks.some((t) => t.change.id === 'image')).toBe(false);
    // agent-merged had no verdict, so it is still attempted.
    expect(result.tasks.some((t) => t.change.id === 'agent-merged')).toBe(true);
  });

  it("follows the agent's alsoResolves", async () => {
    const result = await agent({
      tasks: [task('a', { alsoResolves: ['b'] })],
      notAffected: [],
    })({ repo: 'acme/api', changes: [change('a'), change('b')], dependencies: deps, usages: [] });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].alsoResolves).toEqual([{ changeId: 'b', title: 'b' }]);
    expect(result.tasks[0].notes).toContain('Also resolves b');
  });

  it('ranks by deadline, then severity with security first, then impact', async () => {
    const changes = [
      change('late', { effectiveDate: '2027-06-01' }),
      change('notice', { severity: 'notice', dependency: 'a' }),
      change('security', { severity: 'security', dependency: 'b' }),
      change('soon', { effectiveDate: '2026-12-01', dependency: 'c' }),
      change('low-security', { severity: 'security', dependency: 'd' }),
    ];
    const result = await agent({
      tasks: [
        task('late'),
        task('notice', { impact: 'critical' }),
        task('low-security', { impact: 'low' }),
        task('security', { impact: 'critical' }),
        task('soon'),
      ],
      notAffected: [],
    })({ repo: 'acme/api', changes, dependencies: deps, usages: [] });
    expect(result.tasks.map((t) => [t.change.id, t.priority])).toEqual([
      ['soon', 1],
      ['late', 2],
      ['security', 3],
      ['low-security', 4],
      ['notice', 5],
    ]);
  });

  it('takes a target version from the agent when the change has none', async () => {
    const result = await agent({ tasks: [task('a', { toVersion: '22' })], notAffected: [] })({
      repo: 'acme/api',
      changes: [change('a')],
      dependencies: deps,
      usages: [],
    });
    expect(result.tasks[0].change.toVersion).toBe('22');
  });

  it('spends nothing on a repo with no changes', async () => {
    const ask: AskModel = async () => {
      throw new Error('should not be called');
    };
    const match = createExternalMatchAgent({ ask, budget: createBudget(1) });
    expect(await match({ repo: 'r', changes: [], dependencies: deps, usages: [] })).toEqual({
      tasks: [],
      notAffected: [],
      costUsd: 0,
    });
  });
});

describe('hints for the match agent', () => {
  it('normalises names across runtimes, images and actions', () => {
    expect(baseName('node:18-bookworm')).toBe('node');
    expect(baseName('docker.io/library/python:3.9-slim')).toBe('python');
    expect(baseName('actions/checkout@v3')).toBe('actions/checkout');
    expect(baseName('NodeJS')).toBe('node');
  });

  it('names the image and CI setup that move with a runtime', () => {
    expect(companions(deps[0], deps).map((d) => d.name)).toEqual([
      'node:18-bookworm',
      'actions/setup-node',
    ]);
  });

  it('reports version overlap and days to the deadline, as hints only', () => {
    const hints = externalHints(
      [
        change('eol', { fromVersions: ['18'], effectiveDate: '2026-11-16' }),
        change('other', { dependency: 'django' }),
      ],
      deps,
      new Date('2026-11-06T00:00:00Z'),
    );
    expect(hints[0]).toContain('effective in 10 day(s)');
    expect(hints[0]).toContain(
      'dependency 0 (node@18; version overlaps fromVersions; may move with 1, 2)',
    );
    expect(hints[1]).toContain('no name match found');
  });

  it('puts every change, dependency and the API changes in the prompt, and says hints can be wrong', () => {
    const prompt = buildExternalPrompt({
      repo: 'acme/api',
      changes: [change('eol')],
      dependencies: deps,
      usages: [],
      apiChanges: [
        {
          provider: 'stripe',
          id: 'stripe-x',
          kind: 'other',
          title: 'Stripe x',
          source: { url: 'u', quote: 'q' },
          affects: {},
        },
      ],
    });
    expect(prompt).toContain('"id": "eol"');
    expect(prompt).toContain('"name": "node:18-bookworm"');
    expect(prompt).toContain('- stripe-x: Stripe x');
    expect(prompt).toMatch(/may be wrong/);
    expect(EXTERNAL_SYSTEM_PROMPT).toContain('Unsure means attempt, not skip.');
  });
});

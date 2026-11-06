// Failure paths of the external half, the offline stand-ins, and the real-mode wiring with fakes at
// the edges. Illustrative data only.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DependencyUsage, ExternalChange, MigrationTask, RunRecord } from '../shared/types.ts';
import { createBudget } from './budget.ts';
import { formatReport, main } from './cli.ts';
import { createDeps } from './deps.ts';
import { createRunRepoJob, createScanRepo } from './index.ts';
import type { LoopDeps } from './loop.ts';
import { createMemoryQueue } from './queue.ts';
import { stubMatch } from './stubs.ts';
import {
  asMigrationTask,
  stubInventoryDependencies,
  stubMatchExternal,
  stubRunExternalTask,
} from './stubs-external.ts';

const harness = vi.hoisted(() => ({ tasks: [] as MigrationTask[] }));
vi.mock('../harness/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/index.ts')>()),
  runTask: async (task: MigrationTask, _dir: string, opts: { budgetUsd: number }) => {
    harness.tasks.push(task);
    return {
      taskId: task.id,
      outcome: 'needs-review',
      diff: 'diff --git a/.nvmrc b/.nvmrc\n',
      checks: [{ name: 'tests', before: 'pass', after: 'pass' }],
      costUsd: Math.min(0.4, opts.budgetUsd),
      transcriptPath: '',
    } satisfies RunRecord;
  },
}));

const change = (id: string, extra: Partial<ExternalChange> = {}): ExternalChange => ({
  provider: 'example',
  id,
  kind: 'runtime-eol',
  dependencyKind: 'runtime',
  dependency: 'node',
  fromVersions: ['18'],
  title: id,
  source: { url: 'https://example.com/eol', quote: '(illustrative)' },
  affects: {},
  ...extra,
});

const node: DependencyUsage = {
  repo: 'acme/api',
  kind: 'runtime',
  name: 'node',
  version: '18',
  declaredIn: [{ file: '.nvmrc', line: 1, text: '18' }],
};

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'refit-scan-'));
  harness.tasks = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

function fakeDeps(external: Partial<NonNullable<LoopDeps['external']>> = {}) {
  const recorded: { id: string; record: RunRecord }[] = [];
  const deps: Omit<LoopDeps, 'openPullRequest'> = {
    inventory: async () => [],
    watchers: {},
    watchAny: () => async () => [],
    match: stubMatch,
    runTask: async (task) => ({ ...(await stubRunExternalTask(task as never, '')) }),
    recordRun: async (task, record) => void recorded.push({ id: task.id, record }),
    queue: createMemoryQueue({ concurrency: 2, retries: 1, backoffMs: 1 }),
    external: {
      inventoryDependencies: async () => [node],
      watchDependency: async () => [change('node-18-eol')],
      match: stubMatchExternal,
      runExternalTask: stubRunExternalTask,
      ...external,
    },
  };
  return { deps, recorded };
}

describe('the external half when parts fail', () => {
  it('keeps changes open and says why when the external match keeps failing', async () => {
    const { deps, recorded } = fakeDeps({
      match: async () => {
        throw new Error('model unreachable');
      },
    });
    const { report, tasks } = await createScanRepo(deps)('acme/api', '/nonexistent');
    expect(tasks).toEqual([]);
    expect(report.items[0]).toMatchObject({
      status: 'open',
      reason: expect.stringContaining('not attempted: external match failed after retries'),
    });
    expect(report.errors.join('\n')).toContain('model unreachable');

    const records = await createRunRepoJob(deps)({
      repo: 'acme/api',
      dir: '/nonexistent',
      openPullRequest: async () => 'pr',
    });
    expect(records).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        note: expect.stringContaining('not attempted'),
      }),
    ]);
    expect(recorded).toHaveLength(1);
  });

  it('reports a failing watcher or inventory in the errors and keeps the rest', async () => {
    const { deps } = fakeDeps({
      inventorySurfaces: async () => {
        throw new Error('surfaces unreadable');
      },
      watchPlatforms: async () => {
        throw new Error('platform feed down');
      },
    });
    const { report, tasks } = await createScanRepo(deps)('acme/api', '/nonexistent');
    expect(tasks.map((t) => t.change.id)).toEqual(['node-18-eol']);
    expect(report.errors.join('\n')).toMatch(
      /surfaces unreadable[\s\S]*platform feed down|platform feed down[\s\S]*surfaces unreadable/,
    );
  });

  it('turns applicable rules into tasks through the same match', async () => {
    const rule = change('eaa-forms', {
      kind: 'regulation',
      dependencyKind: 'regulated-surface',
      dependency: 'signup form',
      fromVersions: undefined,
    });
    const surface: DependencyUsage = {
      repo: 'acme/api',
      kind: 'regulated-surface',
      name: 'signup form',
      declaredIn: [{ file: 'app/signup.tsx' }],
    };
    const obligationsToChanges = vi.fn(async () => [rule]);
    const { deps } = fakeDeps({
      inventorySurfaces: async () => [surface],
      watchRegulations: async () => [
        {
          id: 'eaa',
          rule: {
            name: 'European Accessibility Act',
            url: 'https://example.com',
            quote: '(illustrative)',
          },
          requirement: 'accessible forms',
          appliesTo: 'forms',
          inCode: 'labels on inputs',
          checkable: ['axe'],
          needsHuman: ['scope'],
        },
      ],
      obligationsToChanges,
    });
    const { tasks } = await createScanRepo(deps)('acme/api', '/nonexistent');
    expect(obligationsToChanges).toHaveBeenCalledWith('acme/api', [surface], expect.any(Array));
    expect(tasks.find((t) => t.change.id === 'eaa-forms')?.dependencies).toEqual([surface]);
  });

  it('leaves a change the API path already has to the API path', async () => {
    const { deps } = fakeDeps({
      watchDependency: async () => [change('same-id')],
    });
    deps.inventory = async () => [
      { repo: 'acme/api', provider: 'example', via: 'sdk', callSites: [] },
    ];
    deps.watchAny = () => async () => [
      {
        provider: 'example',
        id: 'same-id',
        kind: 'other',
        title: 'same-id',
        source: { url: 'u', quote: '(illustrative)' },
        affects: {},
      },
    ];
    const { report } = await createScanRepo(deps)('acme/api', '/nonexistent');
    expect(report.items.filter((i) => i.change.id === 'same-id')).toHaveLength(1);
    expect(report.items[0].change.dependencyKind).toBe('api');
  });
});

describe('the offline dependency inventory', () => {
  it('never opens env files', async () => {
    await writeFile(join(work, '.env'), 'model: "gpt-secret-model"\n');
    await mkdir(join(work, 'src'));
    await writeFile(join(work, 'src', 'a.js'), "const r = { model: 'gpt-4o' };\n");
    const deps = await stubInventoryDependencies()(work, 'acme/api');
    expect(deps.map((d) => d.name)).toEqual(['gpt-4o']);
    expect(deps[0].declaredIn[0]).toMatchObject({ file: 'src/a.js', line: 1 });
  });

  it('puts every declaration of an external task into the API-shaped notes', () => {
    const task = asMigrationTask({
      id: 'acme/api:node-18-eol',
      repo: 'acme/api',
      change: change('node-18-eol', { toVersion: '22' }),
      dependencies: [node],
      usages: [],
      priority: 1,
    });
    expect(task.change.kind).toBe('other');
    expect(task.notes).toContain('runtime-eol');
    expect(task.notes).toContain('- node@18: .nvmrc:1 (18)');
    expect(task.notes).toContain('to 22');
  });
});

describe('refit scan', () => {
  it('prints the table and writes the report', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = new URL('./fixtures/samples/demo-python-app', import.meta.url).pathname;
    const out = join(work, 'report.json');
    expect(await main(['scan', '--repo', repo, '--out', out])).toBe(0);
    const text = print.mock.calls.flat().join('\n');
    expect(text).toContain("What's behind in demo-python-app");
    expect(text).toContain('3.9 → 3.13');
    expect(text).toContain('flask-1-eol: stub matcher');
    const report = JSON.parse(await readFile(out, 'utf8'));
    expect(report.repo).toBe('demo-python-app');
    expect(report.items.length).toBeGreaterThan(0);
  });

  it('refuses --dry-run, which only `run` has', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['scan', '--repo', work, '--dry-run'])).toBe(2);
  });

  it('says so when nothing is open', () => {
    const text = formatReport({ repo: 'r', scannedAt: 't', items: [], costUsd: 0, errors: ['x'] });
    expect(text).toContain('nothing open');
    expect(text).toContain('error: x');
  });
});

describe('the real-mode wiring, with fakes at the edges', () => {
  it('reports unwatched dependencies honestly and attempts upgrades on the harness until O2 lands', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-a-real-key');
    const budget = createBudget(6);
    const deps = createDeps({
      budget,
      out: join(work, 'runs.jsonl'),
      reports: join(work, 'reports'),
      watchCache: join(work, 'watch'),
      log: () => {},
    });
    // No network: the API side and the external match are fakes; the harness is mocked above.
    deps.inventory = async () => [];
    deps.watchers = {};
    deps.match = stubMatch;
    deps.recordRun = async () => {};
    deps.external = {
      ...deps.external!,
      inventoryDependencies: async () => [node],
      match: async (input) => {
        expect(input.dependencies).toEqual([node]);
        return stubMatchExternal({ ...input, changes: [change('node-18-eol')] });
      },
    };
    const { report } = await createScanRepo(deps)('acme/api', work);
    // F1's watcher is not on this branch, so the dependency is reported unwatched, never invented.
    expect(report.errors.join('\n')).toContain(
      'not watched: providers/index.ts has no watchDependency yet',
    );

    deps.external.watchDependency = async () => [change('node-18-eol')];
    const records = await createRunRepoJob(
      deps,
      budget.capUsd,
    )({
      repo: 'acme/api',
      dir: work,
      openPullRequest: async (task) => `https://github.com/acme/api/pull/${task.change.id}`,
    });
    expect(records).toEqual([
      expect.objectContaining({
        outcome: 'needs-review',
        pr: 'https://github.com/acme/api/pull/node-18-eol',
      }),
    ]);
    expect(harness.tasks[0].notes).toContain('.nvmrc');
    // The harness run held its share of the one run budget and settled to what it spent.
    expect(budget.spentUsd()).toBeCloseTo(0.4);
    expect(budget.heldUsd()).toBe(0);
  });
});

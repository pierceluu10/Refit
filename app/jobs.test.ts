import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildList, type ProviderFile } from '../dead-apis/list.ts';
import { readQueue } from '../dead-apis/queue.ts';
import { scanDeadApis, type DeadScanReport, type FindingDetail } from '../inventory/dead-scan.ts';
import type {
  DeadApiEntry,
  Finding,
  FutureShutdown,
  OpenPullRequest,
  RunRecord,
} from '../shared/types.ts';
import { GitHubApiError } from './github.ts';
import { createJobRunner, type JobRunnerDeps } from './jobs.ts';
import { createFileQueue } from './queue.ts';
import { createTick, createTriggerStore, summarizeTriggers } from './triggers.ts';
import type { UnderstandJob } from './types.ts';
import { handleWebhook, type WebhookDeps } from './webhooks.ts';

const INSTALLATION = 70000001;
const REPO = 'aptitude-example-org/billing-api';
const REPOS = [REPO, 'aptitude-example-org/storefront', 'aptitude-example-org/ops-scripts'];
const DAY_ONE = '2026-11-05';
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const SECRET_TOKEN = `ghs_${'x'.repeat(36)}`;

const job = (reason: UnderstandJob['reason'], repo = REPO, sha?: string): UnderstandJob => ({
  kind: 'understand',
  installationId: INSTALLATION,
  repo,
  reason,
  ...(sha && { sha }),
});

const entry = (id: string): DeadApiEntry => ({
  id,
  provider: 'anthropic',
  what: 'old model',
  diedOn: '2026-01-01',
  source: { url: 'https://platform.claude.com/x', checkedOn: '2026-11-04' },
  lookFor: [id],
  matchers: [{ kind: 'string', value: `model-${id}` }],
  replacement: 'new-model',
  requires: [],
});

const shutdown = (overrides: Partial<FutureShutdown> = {}): FutureShutdown => ({
  id: 'AN-9.soon',
  provider: 'anthropic',
  what: 'dying model',
  diesOn: '2026-11-20',
  source: { url: 'https://platform.claude.com/x', checkedOn: '2026-11-04' },
  matchers: [{ kind: 'string', value: 'dying-model' }],
  ...overrides,
});

const listOf = (entries: DeadApiEntry[], future: FutureShutdown[] = []) => {
  const file: ProviderFile = {
    provider: 'anthropic',
    officialHosts: ['claude.com'],
    entries,
    future,
  };
  return buildList([file]);
};

const live = (entryId: string, file: string, line = 1): FindingDetail => ({
  entryId,
  file,
  line,
  matchClass: 'live',
  provider: 'anthropic',
  what: 'old model',
  reason: 'a live call',
  text: 'call()',
  withFix: true,
});

const report = (
  details: FindingDetail[] = [],
  overrides: Partial<DeadScanReport> = {},
): DeadScanReport => ({
  repo: REPO,
  today: DAY_ONE,
  listVersion: 'unused',
  findings: details,
  details,
  clean: details.length === 0,
  unlistedProviders: [],
  quiet: [],
  skipped: [],
  filesRead: 1,
  seconds: 0,
  ...overrides,
});

const RECORD: RunRecord = {
  taskId: 'illustrative-task',
  outcome: 'verified',
  diff: '',
  checks: [],
  costUsd: 1.5,
  transcriptPath: '',
};

let store: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = await mkdtemp(join(tmpdir(), 'aptitude-triggers-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(store, { recursive: true, force: true });
});

// The real runner, queue and store over a fake GitHub: `head` is the default branch as GitHub reports it
// and `clone` what a checkout gets, the same unless a test has a push land between the two.
function world(overrides: Partial<JobRunnerDeps> = {}) {
  const triggers = createTriggerStore(join(store, 'triggers'));
  const w = {
    triggers,
    today: DAY_ONE,
    list: listOf([entry('AN-1')]),
    head: new Map<string, string | undefined>(),
    clone: undefined as string | undefined,
    scanResult: report(),
    calls: { head: 0, checkout: 0, scan: 0, fix: 0 },
    dirs: [] as string[],
    rescans: [] as { findings: Finding[]; at: string }[],
    fix: async (): Promise<RunRecord[]> => [RECORD],
    records: () => triggers.records(),
    last: async () => (await triggers.records()).at(-1),
    decisions: async () =>
      (await triggers.records()).map((one) => `${one.repo} ${one.decision} ${one.why}`),
    run: undefined as unknown as (job: UnderstandJob) => Promise<void>,
  };
  w.run = createJobRunner({
    tokens: { token: async (id) => `token-${id}` },
    checkout: async (_token, _repo, dir) => {
      w.calls.checkout += 1;
      w.dirs.push(dir);
    },
    openPullRequestFor: () => (async () => 'https://github.com/example/pull/1') as OpenPullRequest,
    runRepoJob: async (input) => {
      w.calls.fix += 1;
      expect(existsSync(input.dir)).toBe(true);
      return w.fix();
    },
    headTree: async (_token, repo) => {
      w.calls.head += 1;
      return w.head.has(repo) ? w.head.get(repo) : TREE_A;
    },
    treeOfCheckout: async () => w.clone ?? (w.head.get(REPO) as string) ?? TREE_A,
    scan: async () => {
      w.calls.scan += 1;
      return w.scanResult;
    },
    loadList: () => w.list,
    triggers,
    now: () => new Date(`${w.today}T12:00:00Z`),
    rescan: async (_job, findings, at) => {
      w.rescans.push({ findings, at });
    },
    ...overrides,
  });
  return w;
}

describe('the skip rule', () => {
  it('skips an unchanged clean repo with one tree read and no download, and says so', async () => {
    const w = world();
    await w.run(job('install'));
    await w.run(job('clock'));
    expect(w.calls).toEqual({ head: 2, checkout: 1, scan: 1, fix: 0 });
    expect(await w.decisions()).toEqual([
      `${REPO} scanned first-scan`,
      `${REPO} skipped unchanged-clean`,
    ]);
    expect(await w.last()).toMatchObject({
      trigger: 'clock',
      clean: true,
      findings: 0,
      costUsd: 0,
    });
  });

  it('scans when the tree changed', async () => {
    const w = world();
    await w.run(job('install'));
    w.head.set(REPO, TREE_B);
    await w.run(job('push', REPO, 'c0ffee'));
    expect(w.calls.scan).toBe(2);
    expect(await w.last()).toMatchObject({
      trigger: 'push',
      sha: 'c0ffee',
      decision: 'scanned',
      why: 'tree-changed',
      treeSha: TREE_B,
    });
    expect((await w.triggers.state(REPO))?.treeSha).toBe(TREE_B);
  });

  it('deletes the checkout whether the scan worked or not', async () => {
    const w = world();
    await w.run(job('install'));
    const failing = world({
      scan: async () => {
        throw new Error('the scan broke');
      },
    });
    await expect(failing.run(job('install', REPOS[1]))).rejects.toThrow('the scan broke');
    expect([...w.dirs, ...failing.dirs].map((dir) => existsSync(dir))).toEqual([false, false]);
  });

  it('treats a repo with no commits as nothing to read, without inventing a clean scan', async () => {
    const w = world();
    w.head.set(REPO, undefined);
    await w.run(job('install'));
    expect(w.calls.checkout).toBe(0);
    expect(await w.last()).toMatchObject({ decision: 'skipped', why: 'empty-repo' });
    expect((await w.last())?.clean).toBeUndefined();
    expect(await w.triggers.state(REPO)).toBeUndefined();
    w.head.set(REPO, TREE_A);
    await w.run(job('push'));
    expect(await w.last()).toMatchObject({ decision: 'scanned', why: 'first-scan' });
  });
});

describe('telling evidence what a scan found', () => {
  const FOUND = [live('AN-1', 'src/a.ts')];

  it('hands over the findings of the one scan, then fixes', async () => {
    const order: string[] = [];
    const w = world({
      rescan: async () => {
        order.push(`rescan after ${w.calls.scan} scan, ${w.calls.fix} fix`);
      },
    });
    w.scanResult = report(FOUND);
    await w.run(job('install'));
    expect(order).toEqual(['rescan after 1 scan, 0 fix']);
    expect(w.calls).toMatchObject({ scan: 1, fix: 1 });
  });

  it('passes the report and a time from before the clone', async () => {
    let clock = Date.parse('2026-11-05T12:00:00Z');
    const before = new Date(clock).toISOString();
    const w = world({
      now: () => new Date(clock),
      checkout: async () => {
        clock += 60_000; // a merge can land during the clone, and mustn't count against itself
      },
    });
    w.scanResult = report(FOUND);
    await w.run(job('install'));
    expect(w.rescans).toEqual([{ findings: FOUND, at: before }]);
  });

  it('a failed hand-over never stops the fix, and its message is redacted', async () => {
    const w = world({
      rescan: async () => {
        throw new Error(`evidence store broke with ${SECRET_TOKEN}`);
      },
    });
    w.scanResult = report(FOUND);
    await w.run(job('install'));
    expect(w.calls.fix).toBe(1);
    expect(await w.last()).toMatchObject({ decision: 'scanned', fix: 'ran' });
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('evidence store broke');
    expect(logged).not.toContain(SECRET_TOKEN);
  });

  it('has nothing to look at on a skip, since nothing was downloaded', async () => {
    const w = world();
    await w.run(job('install'));
    await w.run(job('clock'));
    expect(w.calls.scan).toBe(1);
    expect(w.rescans).toHaveLength(1);
  });
});

describe('a list change', () => {
  async function installedWorld() {
    const w = world();
    const queue = await createFileQueue(join(store, 'queue.json'), w.run);
    const tick = createTick({
      listInstallations: async () => [INSTALLATION],
      tokens: { token: async () => 'token' },
      listRepos: async () => REPOS,
      queue,
    });
    const pass = async () => {
      await tick();
      await queue.idle();
    };
    await pass();
    expect(w.calls.scan).toBe(REPOS.length);
    await pass();
    expect(w.calls.scan).toBe(REPOS.length);
    return { w, pass };
  }

  it('rescans every installed repo when the list gains an entry', async () => {
    const { w, pass } = await installedWorld();
    w.list = listOf([entry('AN-1'), entry('AN-2')]);
    await pass();
    expect(w.calls.scan).toBe(REPOS.length * 2);
    expect((await w.records()).slice(-3).map((one) => [one.repo, one.why])).toEqual(
      REPOS.map((repo) => [repo, 'list-change']),
    );
    await pass();
    expect(w.calls.scan).toBe(REPOS.length * 2);
  });

  it('rescans every repo on the day a shutdown arrives, with nobody editing the list', async () => {
    const { w, pass } = await installedWorld();
    w.list = listOf([entry('AN-1')], [shutdown()]);
    await pass(); // the shutdown joining the file changes nothing a scan reads yet
    expect(w.calls.scan).toBe(REPOS.length);
    w.today = '2026-11-19';
    await pass();
    expect(w.calls.scan).toBe(REPOS.length);
    w.today = '2026-11-20';
    await pass();
    expect(w.calls.scan).toBe(REPOS.length * 2);
    expect((await w.last())?.why).toBe('shutdown-date');
    w.today = '2026-11-21';
    await pass();
    expect(w.calls.scan).toBe(REPOS.length * 2);
  });

  it('catches a shutdown date that passed while the clock was down', async () => {
    const { w, pass } = await installedWorld();
    w.list = listOf([entry('AN-1')], [shutdown()]);
    await pass();
    w.today = '2026-11-25';
    await pass();
    expect((await w.last())?.why).toBe('shutdown-date');
  });

  it("leaves a date the provider calls earliest possible alone, since it doesn't turn on by itself", async () => {
    const { w, pass } = await installedWorld();
    w.list = listOf([entry('AN-1')], [shutdown({ earliest: true })]);
    w.today = '2026-12-25';
    await pass();
    expect(w.calls.scan).toBe(REPOS.length);
  });

  it("doesn't rescan for a re-checked source date, though the list's own version moves", async () => {
    const { w, pass } = await installedWorld();
    const before = w.list.version;
    const rechecked = entry('AN-1');
    rechecked.source = { ...rechecked.source, checkedOn: '2026-11-05' };
    w.list = listOf([rechecked]);
    expect(w.list.version).not.toBe(before);
    await pass();
    expect(w.calls.scan).toBe(REPOS.length);
  });
});

describe('a repo that is not clean', () => {
  const dead = [live('AN-1', 'a.ts')];

  it('starts one fix, then stays reported as not clean with no download and no second fix', async () => {
    const w = world();
    w.scanResult = report(dead);
    await w.run(job('install'));
    expect(await w.last()).toMatchObject({ decision: 'scanned', fix: 'ran', costUsd: 1.5 });
    await w.run(job('clock'));
    await w.run(job('push', REPO, 'redelivered'));
    expect(w.calls).toMatchObject({ checkout: 1, fix: 1 });
    expect(await w.last()).toMatchObject({
      decision: 'skipped',
      why: 'unchanged-dirty',
      clean: false,
      findings: 1,
      costUsd: 0,
    });
    const [row] = summarizeTriggers(await w.records(), new Date(`${DAY_ONE}T13:00:00Z`));
    expect(row).toMatchObject({ status: 'not-clean', findings: 1, fix: 'ran', stale: false });
  });

  it("doesn't start another fix when an unrelated push only moves the finding's line", async () => {
    const w = world();
    w.scanResult = report(dead);
    await w.run(job('install'));
    w.head.set(REPO, TREE_B);
    w.scanResult = report([live('AN-1', 'a.ts', 40)]);
    await w.run(job('push'));
    expect(w.calls).toMatchObject({ scan: 2, fix: 1 });
    expect(await w.last()).toMatchObject({ clean: false, fix: 'already-attempted', findings: 1 });
  });

  it('fixes a new finding the list gains, with the tree unchanged', async () => {
    const w = world();
    w.scanResult = report(dead);
    await w.run(job('install'));
    w.list = listOf([entry('AN-1'), entry('AN-2')]);
    w.scanResult = report([...dead, live('AN-2', 'b.ts')]);
    await w.run(job('clock'));
    expect(w.calls.fix).toBe(2);
    expect(await w.last()).toMatchObject({ why: 'list-change', fix: 'ran', findings: 2 });
  });

  it('fixes again if the dead code comes back after a clean scan', async () => {
    const w = world();
    w.scanResult = report(dead);
    await w.run(job('install'));
    w.head.set(REPO, TREE_B);
    w.scanResult = report();
    await w.run(job('push'));
    expect(await w.last()).toMatchObject({ clean: true, findings: 0 });
    w.head.set(REPO, TREE_A);
    w.scanResult = report(dead);
    await w.run(job('push'));
    expect(w.calls.fix).toBe(2);
  });

  it('lets a person ask for another try with a manual rescan', async () => {
    const w = world();
    w.scanResult = report(dead);
    await w.run(job('install'));
    await w.run(job('manual'));
    expect(w.calls).toMatchObject({ checkout: 2, fix: 2 });
    expect(await w.last()).toMatchObject({ trigger: 'manual', why: 'manual', fix: 'ran' });
  });

  it('never sends a finding that is only unclear to a fix', async () => {
    const w = world();
    const unclear: FindingDetail = {
      ...live('AN-1', 'a.ts'),
      matchClass: 'unclear',
      withFix: false,
    };
    w.scanResult = report([unclear], { clean: false });
    await w.run(job('install'));
    expect(w.calls.fix).toBe(0);
    expect(await w.last()).toMatchObject({ clean: false, findings: 1 });
  });
});

describe('a failure', () => {
  const failures: [string, Partial<JobRunnerDeps>][] = [
    [
      'the tree read',
      {
        headTree: async () => {
          throw new GitHubApiError('GET', '/repos/x', 500);
        },
      },
    ],
    [
      'the checkout',
      {
        checkout: async () => {
          throw new Error('clone failed');
        },
      },
    ],
    [
      'reading the checkout',
      {
        treeOfCheckout: async () => {
          throw new Error('not a repo');
        },
      },
    ],
    [
      'the scan',
      {
        scan: async () => {
          throw new Error('scan failed');
        },
      },
    ],
    [
      'the list',
      {
        loadList: () => {
          throw new Error('bad list');
        },
      },
    ],
  ];

  it.each(failures)(
    'in %s records a failure and no scan, and the next trigger scans',
    async (_n, broken) => {
      const w = world(broken);
      await expect(w.run(job('install'))).rejects.toThrow();
      const record = await w.last();
      expect(record).toMatchObject({ decision: 'failed', why: 'error' });
      expect(record?.clean).toBeUndefined();
      expect(await w.triggers.state(REPO)).toBeUndefined();

      const healthy = world();
      await healthy.run(job('clock'));
      expect(await healthy.last()).toMatchObject({ decision: 'scanned', why: 'first-scan' });
    },
  );

  it("keeps a clean repo's old state when the scan of its new tree fails, so it's tried again", async () => {
    const w = world();
    await w.run(job('install'));
    w.head.set(REPO, TREE_B);
    const broken = world({
      scan: async () => {
        throw new Error('scan failed');
      },
    });
    broken.head.set(REPO, TREE_B);
    await expect(broken.run(job('push'))).rejects.toThrow('scan failed');
    expect((await w.triggers.state(REPO))?.treeSha).toBe(TREE_A);
    await w.run(job('clock'));
    expect(await w.last()).toMatchObject({ decision: 'scanned', why: 'tree-changed' });
  });

  it('keeps a secret out of the record', async () => {
    const w = world({
      checkout: async () => {
        throw new Error(`clone failed with ${SECRET_TOKEN}`);
      },
    });
    await expect(w.run(job('install'))).rejects.toThrow();
    expect(JSON.stringify(await w.records())).not.toContain(SECRET_TOKEN);
  });

  it('records a failed fix, keeps the scan, retries on a real change and not on a tick', async () => {
    const w = world();
    w.scanResult = report([live('AN-1', 'a.ts')]);
    w.fix = async () => {
      throw new Error(`no run records: ${SECRET_TOKEN}`);
    };
    await expect(w.run(job('install'))).rejects.toThrow('no run records');
    const failed = await w.last();
    expect(failed).toMatchObject({ decision: 'scanned', clean: false, fix: 'failed' });
    expect(failed?.error).not.toContain(SECRET_TOKEN);

    await w.run(job('clock'));
    expect(await w.last()).toMatchObject({ decision: 'skipped', why: 'unchanged-dirty' });
    expect(w.calls.fix).toBe(1);

    w.fix = async () => [RECORD];
    w.head.set(REPO, TREE_B);
    await w.run(job('push'));
    expect(w.calls.fix).toBe(2);
  });

  it.each(['failed', 'capped'] as const)(
    'in the AI check (%s) leaves the repo not clean, and repeats the scan until the check settles',
    async (outcome) => {
      const w = world();
      const unclear: FindingDetail = {
        ...live('AN-1', 'a.ts'),
        matchClass: 'unclear',
        withFix: false,
      };
      w.scanResult = report([unclear], {
        clean: false,
        check: { outcome, costUsd: 0, asked: 1 },
      });
      await w.run(job('install'));
      expect(await w.last()).toMatchObject({ decision: 'scanned', clean: false, findings: 1 });
      await w.run(job('clock'));
      expect(await w.last()).toMatchObject({ decision: 'scanned', why: 'check-retry' });

      w.scanResult = report([], { check: { outcome: 'checked', costUsd: 0.002, asked: 1 } });
      await w.run(job('clock'));
      expect(await w.last()).toMatchObject({ clean: true, costUsd: 0.002 });
      await w.run(job('clock'));
      expect(await w.last()).toMatchObject({ decision: 'skipped', why: 'unchanged-clean' });
    },
  );
});

describe('webhooks through the real queue', () => {
  const pushPayload = JSON.parse(
    readFileSync(new URL('fixtures/push.default-branch.json', import.meta.url), 'utf8'),
  ) as { after: string; repository: { full_name: string }; deleted?: boolean };
  const pushed = pushPayload.repository.full_name;

  const NO_EVIDENCE: WebhookDeps['evidence'] = {
    closed: async () => {},
    edited: async () => {},
    revertMerged: async () => {},
    pushed: async () => {},
  };

  function webhookDeps(
    queue: WebhookDeps['queue'],
    triggers: ReturnType<typeof createTriggerStore>,
  ): WebhookDeps {
    return {
      queue,
      forgetRepo: (forgotten) => triggers.forget(forgotten, new Date(`${DAY_ONE}T12:00:00Z`)),
      recordVerdict: async () => {},
      tokens: { token: async () => 'token' },
      listRepos: async () => REPOS,
      compareCommits: async () => [],
      evidence: NO_EVIDENCE,
      consent: { recordInstall: async () => {}, forget: async () => {} },
    };
  }
  const push = { ...pushPayload, deleted: false };

  it('scans once for a delivery that arrives twice, one after the other', async () => {
    const w = world();
    const queue = await createFileQueue(join(store, 'queue.json'), w.run, (merged) =>
      w.triggers.merged(merged, new Date()),
    );
    const deps = webhookDeps(queue, w.triggers);
    await handleWebhook('push', push, deps);
    await queue.idle();
    await handleWebhook('push', push, deps);
    await queue.idle();
    expect(w.calls.scan).toBe(1);
    expect(await w.decisions()).toEqual([
      `${pushed} scanned first-scan`,
      `${pushed} skipped unchanged-clean`,
    ]);
  });

  it('runs one fix when a redelivery lands during the first run, and records one merged into a wait', async () => {
    const w = world();
    w.scanResult = report([live('AN-1', 'a.ts')]);
    let release = () => {};
    w.fix = () =>
      new Promise((resolve) => {
        release = () => resolve([RECORD]);
      });
    const queue = await createFileQueue(join(store, 'queue.json'), w.run, (merged) =>
      w.triggers.merged(merged, new Date()),
    );
    const deps = webhookDeps(queue, w.triggers);
    await handleWebhook('push', push, deps);
    await vi.waitFor(() => expect(w.calls.fix).toBe(1));
    await handleWebhook('push', push, deps); // waits behind the running job
    await handleWebhook('push', push, deps); // that wait already covers it
    release();
    await queue.idle();
    expect(w.calls).toMatchObject({ checkout: 1, fix: 1 });
    expect(await w.decisions()).toEqual([
      `${pushed} merged job-already-waiting`,
      `${pushed} scanned first-scan`,
      `${pushed} skipped unchanged-dirty`,
    ]);
  });

  it('keeps the newer tree when an older push arrives after a newer one', async () => {
    const w = world();
    w.head.set(REPO, TREE_B);
    await w.run(job('push', REPO, 'newer-commit'));
    // GitHub's branch is still at the newer tree: the late webhook only names an older commit.
    await w.run(job('push', REPO, 'older-commit'));
    expect(w.calls.scan).toBe(1);
    expect(await w.last()).toMatchObject({
      sha: 'older-commit',
      decision: 'skipped',
      treeSha: TREE_B,
    });
    expect((await w.triggers.state(REPO))?.treeSha).toBe(TREE_B);
  });

  it('records the tree the scan really read when a push lands between the read and the clone', async () => {
    const w = world();
    w.head.set(REPO, TREE_A);
    w.clone = TREE_B;
    await w.run(job('push'));
    expect((await w.triggers.state(REPO))?.treeSha).toBe(TREE_B);
    expect((await w.last())?.treeSha).toBe(TREE_B);
    w.head.set(REPO, TREE_B);
    await w.run(job('push'));
    expect(w.calls.scan).toBe(1);
  });

  it('rescans when a force-push takes the branch back to an older tree', async () => {
    const w = world();
    w.head.set(REPO, TREE_B);
    await w.run(job('push'));
    w.head.set(REPO, TREE_A);
    await w.run(job('push'));
    expect(await w.last()).toMatchObject({ decision: 'scanned', why: 'tree-changed' });
    expect((await w.triggers.state(REPO))?.treeSha).toBe(TREE_A);
  });

  it('forgets a removed repo, so it reads as removed and a re-add starts over', async () => {
    const w = world();
    await w.run(job('install'));
    const queue = await createFileQueue(join(store, 'queue.json'), w.run);
    const removal = {
      action: 'removed',
      installation: { id: INSTALLATION },
      repositories_added: [],
      repositories_removed: [{ full_name: REPO }],
    };
    await handleWebhook('installation_repositories', removal, webhookDeps(queue, w.triggers));
    expect(await w.triggers.state(REPO)).toBeUndefined();
    const later = new Date('2026-12-30T00:00:00Z');
    expect(summarizeTriggers(await w.records(), later)[0]).toMatchObject({
      status: 'removed',
      stale: false,
    });
    await w.run(job('repos-added'));
    expect(await w.last()).toMatchObject({ decision: 'scanned', why: 'first-scan' });
  });
});

describe('unlisted providers, through the real scan and the real queue', () => {
  async function repoWithResend() {
    const dir = join(store, 'checkout');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { resend: '^4.0.0' } }, null, 2),
    );
    await writeFile(
      join(dir, 'a.ts'),
      "import { Resend } from 'resend';\nnew Resend(k).emails.send({});",
    );
    return dir;
  }

  it('reach the queue and keep showing on the skips that follow', async () => {
    const repoDir = await repoWithResend();
    const queueDir = join(store, 'proposed');
    const w = world({
      scan: async (_dir, repo) => {
        w.calls.scan += 1;
        return scanDeadApis(repoDir, repo, { today: DAY_ONE, storeDir: queueDir, list: w.list });
      },
    });
    await w.run(job('install'));
    const queued = await readQueue(queueDir);
    expect(queued.map((one) => [one.provider, one.repos])).toEqual([['resend', [REPO]]]);
    expect(await w.last()).toMatchObject({ clean: true, unlistedProviders: ['resend'] });

    await w.run(job('clock'));
    expect(await w.last()).toMatchObject({ decision: 'skipped', unlistedProviders: ['resend'] });
    const [row] = summarizeTriggers(await w.records(), new Date(`${DAY_ONE}T13:00:00Z`));
    expect(row.status).toBe('clean-unlisted-waiting');
    expect(w.calls.fix).toBe(0);
  });

  it("fail the job rather than pass as clean when they can't reach the queue", async () => {
    const repoDir = await repoWithResend();
    const notADir = join(store, 'a-file');
    await writeFile(notADir, 'in the way');
    const w = world({
      scan: (_dir, repo) =>
        scanDeadApis(repoDir, repo, { today: DAY_ONE, storeDir: notADir, list: w.list }),
    });
    await expect(w.run(job('install'))).rejects.toThrow();
    expect(await w.last()).toMatchObject({ decision: 'failed' });
    expect(await w.triggers.state(REPO)).toBeUndefined();
  });
});

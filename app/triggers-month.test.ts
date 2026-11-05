// P6's measure: a month of ticks over repos with nothing to do. The clock, webhook handler, queue, job
// runner, store, scan, AI check, budget ledger and GitHub client are all the real ones. Only the network,
// the clone and the model are fake, each one counted. This measures code paths, not a deployed system.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildList,
  inForceVersion,
  loadDeadApis,
  readProviderFiles,
  type DeadApiList,
} from '../dead-apis/list.ts';
import { utcDay } from '../dead-apis/proposals.ts';
import { readQueue } from '../dead-apis/queue.ts';
import { BudgetLedger } from '../inventory/budget.ts';
import { checkUnclear, CHECK_MODEL } from '../inventory/dead-check.ts';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import type { ModelClient, ModelRequest } from '../providers/core/model.ts';
import { treeOfCheckout } from './git.ts';
import {
  createInstallationTokens,
  GITHUB_API,
  headTree,
  listInstallationIds,
  listInstallationRepos,
} from './github.ts';
import { createJobRunner } from './jobs.ts';
import { createFileQueue } from './queue.ts';
import { createTick, createTriggerStore, summarizeTriggers } from './triggers.ts';
import { handleWebhook } from './webhooks.ts';

const APP_ID = '12345';
const INSTALLATION = 70000001;
const FIRST_DAY = Date.UTC(2026, 10, 5, 12);
const DAY_MS = 86_400_000;
const TICKS = 30;
const GAIN_ON_TICK = 15;
const TOKEN_LIFETIME_MS = 3_600_000;
const SIMULATION_CAP_USD = 5;
// A plausible Haiku call for one small batch. The call count is measured; these tokens are assumed.
const ASSUMED_CHECK_USAGE = { inputTokens: 2_000, outputTokens: 300 };
const FIXTURES = new URL('../inventory/fixtures/dead-scan/', import.meta.url).pathname;

const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ dependencies }, null, 2);

type QuietRepo = { name: string; fixture?: string; files?: Record<string, string> };

const REPOS: QuietRepo[] = [
  { name: 'sim/branded', fixture: 'alanagoyal__branded' },
  { name: 'sim/lumen', fixture: 'pretzelai__lumen' },
  { name: 'sim/no-apis', files: { 'a.ts': 'export const answer = 42;\n' } },
  {
    name: 'sim/unlisted',
    files: {
      'package.json': manifest({ resend: '^4.0.0' }),
      'a.ts': "import { Resend } from 'resend';\nnew Resend(k).emails.send({});\n",
    },
  },
  // The one kind of quiet repo that asks the model: a match only AI can rule out.
  { name: 'sim/unclear', files: { 'a.ts': "call({ model: 'gpt-4' });\n" } },
];
const NEEDS_AI = 'sim/unclear';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function writeRepo(root: string, repo: QuietRepo): Promise<string> {
  const dir = join(root, 'origin', repo.name);
  await mkdir(dir, { recursive: true });
  if (repo.fixture) await cp(join(FIXTURES, repo.fixture), dir, { recursive: true });
  for (const [file, text] of Object.entries(repo.files ?? {})) {
    await writeFile(join(dir, file), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@localhost');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function withGainedEntry(): DeadApiList {
  const files = readProviderFiles();
  const groq = files.find((file) => file.provider === 'groq');
  if (!groq) throw new Error('the simulation adds to the groq file, which has gone');
  groq.entries.push({
    ...groq.entries[0],
    id: 'GR-999.simulated',
    what: 'a model invented for this simulation',
    source: { ...groq.entries[0].source, checkedOn: '2026-11-20' },
    lookFor: ['simulated-dead-model'],
    matchers: [{ kind: 'string', value: 'simulated-dead-model' }],
    replacementIds: [],
  });
  return buildList(files);
}

describe('a month of ticks over quiet repos', () => {
  let root: string;
  const github = {
    installationList: 0,
    tokens: 0,
    repoList: 0,
    tree: new Map<string, number>(),
    total: () =>
      github.installationList +
      github.tokens +
      github.repoList +
      [...github.tree.values()].reduce((sum, count) => sum + count, 0),
  };
  const usage = { modelCalls: new Map<string, number>(), checkouts: new Map<string, number>() };
  let fixes = 0;
  let clock = FIRST_DAY;
  let list = loadDeadApis();
  let store: ReturnType<typeof createTriggerStore>;
  let queueDir: string;
  let ledger: BudgetLedger;
  const stdout = (text: string) => process.stdout.write(`${text}\n`);

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = await mkdtemp(join(tmpdir(), 'aptitude-month-'));
    queueDir = join(root, 'proposed');
    store = createTriggerStore(join(root, 'triggers'));
    ledger = new BudgetLedger({ capUsd: SIMULATION_CAP_USD });
    const origins = new Map<string, string>();
    for (const repo of REPOS) origins.set(repo.name, await writeRepo(root, repo));

    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const route = url.slice(GITHUB_API.length);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (route.startsWith('/app/installations?')) {
        github.installationList += 1;
        return json([{ id: INSTALLATION, suspended_at: null }]);
      }
      if (init?.method === 'POST' && route.endsWith('/access_tokens')) {
        github.tokens += 1;
        const expires_at = new Date(clock + TOKEN_LIFETIME_MS).toISOString();
        return json({ token: 'ghs_simulated', expires_at });
      }
      if (route.startsWith('/installation/repositories?')) {
        github.repoList += 1;
        return json({
          total_count: REPOS.length,
          repositories: REPOS.map((repo) => ({ full_name: repo.name })),
        });
      }
      const commit = /^\/repos\/(.+)\/commits\/HEAD$/.exec(route);
      if (commit) {
        const repo = commit[1];
        github.tree.set(repo, (github.tree.get(repo) ?? 0) + 1);
        const origin = origins.get(repo) as string;
        return json({ commit: { tree: { sha: git(origin, 'rev-parse', 'HEAD^{tree}') } } });
      }
      throw new Error(`the simulation has no route for ${route}`);
    }) as typeof fetch;

    const now = () => new Date(clock);
    const tokens = createInstallationTokens(APP_ID, keys.privateKey, fakeFetch, () => clock);

    const modelFor = (repo: string): ModelClient => ({
      model: CHECK_MODEL,
      complete: async (request: ModelRequest) => {
        usage.modelCalls.set(repo, (usage.modelCalls.get(repo) ?? 0) + 1);
        const asked = JSON.stringify(request.messages).split('<item id=').length - 1;
        const answers = Array.from({ length: asked }, (_, index) => ({
          id: index + 1,
          verdict: 'not',
          reason: 'a list nothing sends',
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(answers) }],
          stopReason: 'end_turn',
          usage: ASSUMED_CHECK_USAGE,
        };
      },
    });

    const run = createJobRunner({
      tokens,
      runRepoJob: async () => {
        fixes += 1;
        return [];
      },
      checkout: async (_token, repo, dir) => {
        usage.checkouts.set(repo, (usage.checkouts.get(repo) ?? 0) + 1);
        await cp(origins.get(repo) as string, dir, { recursive: true });
      },
      openPullRequestFor: () => async () => 'https://github.com/example/pull/1',
      headTree: (token, repo) => headTree(token, repo, fakeFetch),
      treeOfCheckout,
      scan: async (dir, repo) =>
        checkUnclear(
          await scanDeadApis(dir, repo, { today: utcDay(now()), list, storeDir: queueDir }),
          dir,
          { client: modelFor(repo), openLedger: async () => ledger },
        ),
      loadList: () => list,
      triggers: store,
      now,
      scannerVersion: 'illustrative-scanner',
      rescan: async () => {},
    });

    const queue = await createFileQueue(join(root, 'queue.json'), run, (job) =>
      store.merged(job, now()),
    );
    const listRepos = (token: string) => listInstallationRepos(token, fakeFetch);
    await handleWebhook(
      'installation',
      { action: 'created', installation: { id: INSTALLATION } },
      {
        queue,
        tokens,
        listRepos,
        forgetRepo: (job) => store.forget(job, now()),
        recordVerdict: async () => {},
        compareCommits: async () => [],
        evidence: {
          closed: async () => {},
          edited: async () => {},
          revertMerged: async () => {},
          pushed: async () => {},
        },
        consent: { recordInstall: async () => {}, forget: async () => {} },
      },
    );
    await queue.idle();

    const tick = createTick({
      listInstallations: () => listInstallationIds(APP_ID, keys.privateKey, fakeFetch, () => clock),
      tokens,
      listRepos,
      queue,
    });
    for (let day = 1; day <= TICKS; day++) {
      clock = FIRST_DAY + day * DAY_MS;
      if (day === GAIN_ON_TICK) list = withGainedEntry();
      await tick();
      await queue.idle();
    }
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  // Worked out apart from the runner: each day the in-force hash moves, every repo should rescan once.
  function expectedWaves() {
    const original = loadDeadApis();
    const gained = withGainedEntry();
    const versionOn = (day: number) =>
      inForceVersion(
        day >= GAIN_ON_TICK ? gained : original,
        utcDay(new Date(FIRST_DAY + day * DAY_MS)),
      );
    let waves = 0;
    for (let day = 1; day <= TICKS; day++) if (versionOn(day) !== versionOn(day - 1)) waves += 1;
    return waves;
  }

  it('reports the numbers', async () => {
    const records = await store.records();
    const perRepo = REPOS.map(({ name }) => {
      const own = records.filter((one) => one.repo === name);
      return {
        repo: name,
        scans: own.filter((one) => one.decision === 'scanned').length,
        skips: own.filter((one) => one.decision === 'skipped').length,
        checkouts: usage.checkouts.get(name) ?? 0,
        modelCalls: usage.modelCalls.get(name) ?? 0,
        usd: own.reduce((sum, one) => sum + one.costUsd, 0),
        treeCalls: github.tree.get(name) ?? 0,
      };
    });
    const logBytes = (await stat(join(root, 'triggers', 'log.jsonl'))).size;
    const skipSeconds = records.filter((one) => one.decision === 'skipped');
    const scanSeconds = records.filter((one) => one.decision === 'scanned');
    const mean = (rows: typeof records) =>
      rows.reduce((sum, one) => sum + one.seconds, 0) / rows.length;
    const whys = new Map<string, number>();
    for (const one of records) whys.set(one.why, (whys.get(one.why) ?? 0) + 1);

    stdout(`\nP6 month simulation: 1 install + ${TICKS} daily ticks, ${REPOS.length} repos`);
    stdout('Code paths with a fake network, clone and model. Not a deployed system.');
    stdout(
      'repo            scans skips checkouts modelCalls      $/month treeCalls\n' +
        perRepo
          .map(
            (row) =>
              `${row.repo.padEnd(15)} ${String(row.scans).padStart(5)} ${String(row.skips).padStart(5)} ` +
              `${String(row.checkouts).padStart(9)} ${String(row.modelCalls).padStart(10)} ` +
              `${row.usd.toFixed(4).padStart(12)} ${String(row.treeCalls).padStart(9)}`,
          )
          .join('\n'),
    );
    stdout(`decisions: ${JSON.stringify(Object.fromEntries(whys))}`);
    stdout(
      `GitHub API calls: ${github.total()} in all, ${(github.total() / REPOS.length).toFixed(1)} per repo per month ` +
        `(tree ${github.total() - github.installationList - github.tokens - github.repoList}, ` +
        `tokens ${github.tokens}, repo lists ${github.repoList}, installation lists ${github.installationList})`,
    );
    stdout(`fixes started: ${fixes}`);
    stdout(
      `mean seconds: skip ${mean(skipSeconds).toFixed(3)}, scan ${mean(scanSeconds).toFixed(3)}`,
    );
    stdout(`trigger log: ${(logBytes / REPOS.length / 1024).toFixed(1)} KB per repo per month`);
    expect(records.length).toBeGreaterThan(0);
  });

  it('spends nothing on a repo with no unclear match, and starts no fix on any of them', () => {
    expect(fixes).toBe(0);
    for (const { name } of REPOS.filter((repo) => repo.name !== NEEDS_AI)) {
      expect(usage.modelCalls.get(name) ?? 0, name).toBe(0);
    }
  });

  it('downloads a repo only for its first scan and when the in-force list moved', async () => {
    const waves = expectedWaves();
    expect(waves).toBeGreaterThanOrEqual(1);
    const records = await store.records();
    for (const { name } of REPOS) {
      expect(usage.checkouts.get(name), name).toBe(1 + waves);
      const own = records.filter((one) => one.repo === name);
      expect(
        own.filter((one) => one.decision === 'skipped'),
        name,
      ).toHaveLength(TICKS - waves);
      expect(
        own.filter((one) => one.decision === 'failed'),
        name,
      ).toEqual([]);
    }
  });

  it('asks the model once per scan of the repo that needs it, and adds it to the record', async () => {
    const scans = usage.checkouts.get(NEEDS_AI) ?? 0;
    expect(usage.modelCalls.get(NEEDS_AI)).toBe(scans);
    const spent = (await store.records())
      .filter((one) => one.repo === NEEDS_AI)
      .reduce((sum, one) => sum + one.costUsd, 0);
    expect(spent).toBeCloseTo(ledger.spentUsd);
    expect(spent).toBeGreaterThan(0);
  });

  it('uses one tree read per repo per tick and nothing more', () => {
    for (const { name } of REPOS) expect(github.tree.get(name), name).toBe(TICKS + 1);
    expect(github.installationList).toBe(TICKS);
    expect(github.repoList).toBe(TICKS + 1);
  });

  it('never calls a repo with an unlisted provider nothing to do', async () => {
    const queued = await readQueue(queueDir);
    expect(queued.find((one) => one.provider === 'resend')?.repos).toEqual(['sim/unlisted']);
    const rows = summarizeTriggers(await store.records(), new Date(clock));
    expect(rows.find((row) => row.repo === 'sim/unlisted')?.status).toBe('clean-unlisted-waiting');
  });

  it('can truthfully say every repo was checked, and says otherwise once the clock stops', async () => {
    const records = await store.records();
    const rows = summarizeTriggers(records, new Date(clock));
    expect(rows.map((row) => row.stale)).toEqual(REPOS.map(() => false));
    const threeDaysLater = new Date(clock + 3 * DAY_MS);
    const late = summarizeTriggers(records, threeDaysLater);
    expect(late.map((row) => row.stale)).toEqual(REPOS.map(() => true));
    expect(late.every((row) => (row.hoursSinceCheck ?? 0) >= 72)).toBe(true);
  });
});

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

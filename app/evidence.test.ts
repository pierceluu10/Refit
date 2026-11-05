import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../shared/types.ts';
import { createConsentStore } from './consent.ts';
import { MAX_COMMENT_CHARS, MAX_HUMAN_DIFF_CHARS, createEvidence, revertedBy } from './evidence.ts';
import type { EvidenceGitHub, PullEvent } from './evidence.ts';
import { createFactStore } from './fix-facts.ts';
import type { ChangedFile, ComparedCommit, PullComment } from './github.ts';
import type { FixEvidence, RepoHabitEvidence } from './types.ts';
import { handleWebhook } from './webhooks.ts';
import type { WebhookDeps } from './webhooks.ts';

const REPO = 'aptitude-example-org/billing-api';
const REPO_URL = `https://github.com/${REPO}`;
const INSTALLATION = 70000001;
const NUMBER = 41;
const PR_URL = `${REPO_URL}/pull/${NUMBER}`;
const BOT_AUTHOR = 'aptitude[bot] <bot@localhost>';
const PERSON_AUTHOR = 'Example Dev <dev@localhost>';
const MERGED_AT = '2026-11-01T11:00:00Z';
const CLOSED_AT = '2026-11-01T12:00:00Z';
const REVERTED_AT = '2026-11-02T09:00:00Z';
const VERDICT_AT = '2026-11-05T00:00:00.000Z';
const ENTRY = 'stripe-illustrative-entry';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<
    string,
    never
  >;

const billing = (version: string, middle: string, retries: number) =>
  [
    `export const apiVersion = '${version}';`,
    ...Array.from({ length: 12 }, (_, line) => `export const filler${line} = ${line};`),
    `export const middle = '${middle}';`,
    ...Array.from({ length: 12 }, (_, line) => `export const padding${line} = ${line};`),
    `export const retries = ${retries};`,
    '',
  ].join('\n');

type Git = (...args: string[]) => string;

// A real repo answering GitHub's questions the way GitHub does, so these tests run on real trees and a
// real squash: BASE...HEAD diffs from the merge base, and a PR's files are measured from its merge base.
function gitHubOver(git: Git, comments: () => PullComment[] = () => []) {
  const calls: string[] = [];
  const pull = { base: '', head: '' };
  const cache = new Map<string, unknown>();
  const once = <T>(key: string, read: () => T): T => {
    if (!cache.has(key)) cache.set(key, read());
    return cache.get(key) as T;
  };
  const blob = (sha: string, path: string) => {
    try {
      return git('rev-parse', `${sha}:${path}`).trim();
    } catch {
      return '';
    }
  };
  const filesBetween = (from: string, to: string): ChangedFile[] =>
    git('diff', '--name-status', '--no-renames', from, to)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, filename] = line.split('\t');
        const patch = git('diff', '--no-color', from, to, '--', filename);
        return {
          filename,
          status,
          sha: blob(to, filename),
          patch: patch.slice(patch.indexOf('@@')),
        };
      });
  const mergeBase = (a: string, b: string) => git('merge-base', a, b).trim();
  const github: EvidenceGitHub = {
    listPullCommits: async () => {
      calls.push('listPullCommits');
      return once('commits', () =>
        git('log', '--format=%P|%an', `${pull.base}..${pull.head}`)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line): ComparedCommit => {
            const [parents, author] = line.split('|');
            return {
              parents: parents.split(' '),
              author: { type: author.endsWith('[bot]') ? 'Bot' : 'User' },
            };
          }),
      );
    },
    listPullFiles: async () => {
      calls.push('listPullFiles');
      return once('files', () => filesBetween(mergeBase(pull.base, pull.head), pull.head));
    },
    commitFiles: async (_token, _repo, sha) => {
      calls.push('commitFiles');
      return once(`commit ${sha}`, () => filesBetween(`${sha}^`, sha));
    },
    compareFiles: async (_token, _repo, base, head) => {
      calls.push(`compareFiles ${base}...${head}`);
      return once(`compare ${base} ${head}`, () => {
        const shared = mergeBase(base, head);
        const status =
          base === head
            ? 'identical'
            : shared === base
              ? 'ahead'
              : shared === head
                ? 'behind'
                : 'diverged';
        return { status, files: filesBetween(shared, head) };
      });
    },
    listPullComments: async () => {
      calls.push('listPullComments');
      return comments();
    },
  };
  return { github, calls, pull };
}

// memory/store.ts on rebuild/otabek, by behaviour: a later verdict overwrites, and evidence keeps the
// first value except a revert, a diff or a comment arriving later. Tests read the state it ends in.
function fakeMemory() {
  const state = new Map<string, FixEvidence>();
  const verdicts = new Map<string, string>();
  const order: string[] = [];
  const sent: { pr: string; evidence: FixEvidence; consented: boolean }[] = [];
  const habits: RepoHabitEvidence[] = [];
  const recordVerdict: WebhookDeps['recordVerdict'] = async (pr, verdict) => {
    order.push(`verdict ${verdict}`);
    const current = verdicts.get(pr);
    if (current === 'merged' || (current === 'closed' && verdict === 'edited')) return;
    verdicts.set(pr, verdict);
    state.set(pr, {
      ...state.get(pr),
      ...(verdict === 'merged'
        ? { merged: { at: VERDICT_AT } }
        : verdict === 'closed'
          ? { closed: { at: VERDICT_AT } }
          : { edited: true }),
    });
  };
  const recordEvidence = async (
    pr: string,
    fresh: FixEvidence,
    consent: { consented: boolean },
  ) => {
    order.push('evidence');
    sent.push({ pr, evidence: fresh, consented: consent.consented });
    const old = state.get(pr) ?? {};
    state.set(pr, {
      ...fresh,
      ...old,
      ...(fresh.reverted ? { reverted: fresh.reverted } : {}),
      ...(fresh.merged?.humanDiff && !old.merged?.humanDiff ? { merged: fresh.merged } : {}),
      ...(fresh.closed?.comment && !old.closed?.comment ? { closed: fresh.closed } : {}),
    });
  };
  return {
    state,
    order,
    sent,
    habits,
    recordVerdict,
    recordEvidence,
    recordHabits: async (one: RepoHabitEvidence) => void habits.push(one),
  };
}

function world(github: EvidenceGitHub, dir = mkdtempSync(join(tmpdir(), 'aptitude-evidence-'))) {
  const memory = fakeMemory();
  const facts = createFactStore(join(dir, 'fixes'));
  const consent = createConsentStore(join(dir, 'installations'));
  const evidence = createEvidence({
    tokens: { token: async () => 'ghs_test_installation_token' },
    github,
    facts,
    consent,
    recordEvidence: memory.recordEvidence,
    recordHabits: memory.recordHabits,
  });
  const deps: WebhookDeps = {
    queue: { enqueue: async () => {} },
    forgetRepo: async () => {},
    recordVerdict: memory.recordVerdict,
    tokens: { token: async () => 'ghs_test_installation_token' },
    listRepos: async () => [],
    compareCommits: async () => [{ parents: ['one'], author: { type: 'User' } }],
    evidence,
    consent,
  };
  const deliver = (event: string, payload: unknown) => handleWebhook(event, payload, deps);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { memory, facts, consent, evidence, deps, deliver, dir, cleanup };
}

type PullOverrides = Record<string, unknown>;

const pullEvent = (action: string, overrides: PullOverrides, extra: object = {}) => {
  const base = fixture('pull_request.closed.merged');
  return {
    ...base,
    action,
    sender: { login: 'example-admin', type: 'User' },
    pull_request: { ...(base.pull_request as object), ...overrides },
    ...extra,
  };
};

const mergedEvent = (head: string, mergeSha: string) =>
  pullEvent('closed', {
    number: NUMBER,
    html_url: PR_URL,
    merged: true,
    merged_at: MERGED_AT,
    merge_commit_sha: mergeSha,
    head: { ref: 'aptitude/fix', sha: head },
  });

const closedEvent = (closer = 'example-admin') => ({
  ...pullEvent('closed', {
    number: NUMBER,
    html_url: PR_URL,
    merged: false,
    merged_at: null,
    closed_at: CLOSED_AT,
    merge_commit_sha: null,
    head: { ref: 'aptitude/fix', sha: 'ours' },
  }),
  sender: { login: closer, type: 'User' },
});

const synchronizeEvent = (head: string) =>
  pullEvent(
    'synchronize',
    { number: NUMBER, html_url: PR_URL, merged: false, head: { ref: 'aptitude/fix', sha: head } },
    { before: 'before-sha', after: head },
  );

const revertPullEvent = (overrides: PullOverrides = {}) =>
  pullEvent('closed', {
    number: 57,
    html_url: `${REPO_URL}/pull/57`,
    title: 'Revert "Illustrative fix (#41)"',
    body: `Reverts ${REPO}#${NUMBER}`,
    merged: true,
    merged_at: REVERTED_AT,
    merge_commit_sha: 'revert-merge-sha',
    head: { ref: `revert-${NUMBER}-aptitude/fix`, sha: 'revert-head' },
    base: { ref: 'main' },
    ...overrides,
  });

const pushEvent = (message: string, overrides: object = {}) => ({
  ...fixture('push.default-branch'),
  deleted: false,
  commits: [{ id: 'revert-commit', message, timestamp: REVERTED_AT }],
  ...overrides,
});

describe('a merged fix, on real git trees', () => {
  let dir: string;
  let git: Git;
  const commit = (author: string, message: string) => {
    git('add', '-A');
    git('commit', '-q', '--author', author, '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const write = (path: string, content: string) => writeFileSync(join(dir, path), content);
  // Our PR branches here: one bot commit changing the API version.
  const openOurFix = () => {
    git('checkout', '-q', '-b', 'aptitude/fix', 'main');
    write('billing.ts', billing('2026-10-01', 'keep', 1));
    return commit(BOT_AUTHOR, 'chore(stripe): Illustrative fix');
  };
  // main gains unrelated work in another file, and in our file on a line we didn't touch.
  const moveMain = () => {
    git('checkout', '-q', 'main');
    write('billing.ts', billing('2024-06-20', 'keep', 2));
    write('unrelated.ts', 'export const fromMain = true;\n');
    return commit(PERSON_AUTHOR, 'feat: work from another team');
  };
  const personEdits = (middle = 'edited by a person') => {
    git('checkout', '-q', 'aptitude/fix');
    write('billing.ts', billing('2026-10-01', middle, 1));
    write('added-by-person.ts', 'export const person = true;\n');
    return commit(PERSON_AUTHOR, 'fix: what the bot missed');
  };
  const updateBranch = () => {
    git('checkout', '-q', 'aptitude/fix');
    git('merge', '-q', '--no-edit', 'main');
    return git('rev-parse', 'HEAD').trim();
  };
  const squash = (head: string) => {
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', head);
    return commit(PERSON_AUTHOR, `Illustrative fix (#${NUMBER})`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aptitude-evidence-git-'));
    git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@localhost');
    write('billing.ts', billing('2024-06-20', 'keep', 1));
    commit(PERSON_AUTHOR, 'base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function mergeAndDeliver(ours: string, head: string, mainTip: string, mergeSha: string) {
    const fake = gitHubOver(git);
    Object.assign(fake.pull, { base: mainTip, head });
    const app = world(fake.github);
    await app.evidence.opened({
      repo: REPO,
      number: NUMBER,
      url: PR_URL,
      sha: ours,
      entryIds: [ENTRY],
    });
    await app.deliver('pull_request', mergedEvent(head, mergeSha));
    app.cleanup();
    return { fake, sent: app.memory.sent.at(-1)?.evidence, state: app.memory.state.get(PR_URL) };
  }

  it('a squash with no edits, while main moved on, reports no edit and asks GitHub nothing about trees', async () => {
    const ours = openOurFix();
    const mainTip = moveMain();
    const mergeSha = squash(ours);
    expect(
      git('diff', '--name-only', ours, mergeSha).trim().split('\n'),
      'the squash really does hold work that is not ours',
    ).toContain('unrelated.ts');

    const { fake, sent } = await mergeAndDeliver(ours, ours, mainTip, mergeSha);
    expect(sent).toEqual({ merged: { at: '2026-11-01T11:00:00.000Z' } });
    expect(fake.calls).toEqual(['listPullCommits']);
  });

  it("a person's commit, squash-merged, gives edited and only their change", async () => {
    const ours = openOurFix();
    const head = personEdits();
    const mainTip = moveMain();
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    expect(sent?.edited).toBe(true);
    const diff = sent?.merged?.humanDiff ?? '';
    expect(diff, diff).toContain("+export const middle = 'edited by a person';");
    expect(diff, diff).toContain('added-by-person.ts');
    expect(diff, 'our own change is not a human edit').not.toContain('2026-10-01');
    expect(diff, "main's unrelated file is not a human edit").not.toContain('unrelated.ts');
    expect(diff, "main's line in our file is not a human edit").not.toContain('retries = 2');
  });

  it('Update branch alone, even with main changing a file of ours, is no edit', async () => {
    const ours = openOurFix();
    const mainTip = moveMain();
    const head = updateBranch();
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    expect(sent).toEqual({ merged: { at: '2026-11-01T11:00:00.000Z' } });
  });

  it("a person's commit plus Update branch keeps only the files people changed", async () => {
    const ours = openOurFix();
    personEdits('kept by a person');
    const mainTip = moveMain();
    const head = updateBranch();
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    const diff = sent?.merged?.humanDiff ?? '';
    expect(sent?.edited).toBe(true);
    expect(diff, diff).toContain('kept by a person');
    expect(diff, diff).toContain('added-by-person.ts');
    expect(diff, 'a file only main touched stays out').not.toContain('unrelated.ts');
  });

  it("a person's amend keeps the bot as author, and still counts as an edit", async () => {
    const ours = openOurFix();
    write('billing.ts', billing('2026-10-01', 'amended by a person', 1));
    git('add', '-A');
    git('commit', '-q', '--amend', '--no-edit');
    const head = git('rev-parse', 'HEAD').trim();
    expect(git('log', '-1', '--format=%an', head).trim()).toBe('aptitude[bot]');
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, git('rev-parse', 'main~1').trim(), mergeSha);
    expect(sent?.edited).toBe(true);
    expect(sent?.merged?.humanDiff, sent?.merged?.humanDiff).toContain('amended by a person');
  });

  it('a rebase alone is no edit, because the change is the same', async () => {
    const ours = openOurFix();
    const mainTip = moveMain();
    git('checkout', '-q', 'aptitude/fix');
    git('rebase', '-q', 'main');
    const head = git('rev-parse', 'HEAD').trim();
    expect(head).not.toBe(ours);
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    expect(sent).toEqual({ merged: { at: '2026-11-01T11:00:00.000Z' } });
  });

  it('a rebase with a person edit says the diff is the whole merged change', async () => {
    const ours = openOurFix();
    personEdits('after a rebase');
    const mainTip = moveMain();
    git('checkout', '-q', 'aptitude/fix');
    git('rebase', '-q', 'main');
    const head = git('rev-parse', 'HEAD').trim();
    const mergeSha = squash(head);

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    const diff = sent?.merged?.humanDiff ?? '';
    expect(diff, diff).toContain('branch was rewritten');
    expect(diff, diff).toContain('after a rebase');
    expect(diff, diff).not.toContain('unrelated.ts');
  });

  it('a merge commit lands the same as a squash', async () => {
    const ours = openOurFix();
    const head = personEdits();
    const mainTip = moveMain();
    git('merge', '-q', '--no-edit', head);
    const mergeSha = git('rev-parse', 'HEAD').trim();

    const { sent } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    expect(sent?.edited).toBe(true);
    expect(sent?.merged?.humanDiff).toContain('edited by a person');
    expect(sent?.merged?.humanDiff).not.toContain('unrelated.ts');
  });

  it('redelivering the merge asks GitHub nothing new and changes nothing', async () => {
    const ours = openOurFix();
    const head = personEdits();
    const mainTip = moveMain();
    const mergeSha = squash(head);
    const fake = gitHubOver(git);
    Object.assign(fake.pull, { base: mainTip, head });
    const app = world(fake.github);
    await app.evidence.opened({
      repo: REPO,
      number: NUMBER,
      url: PR_URL,
      sha: ours,
      entryIds: [ENTRY],
    });
    await app.deliver('pull_request', mergedEvent(head, mergeSha));
    const calls = fake.calls.length;
    const first = app.memory.state.get(PR_URL);
    await app.deliver('pull_request', mergedEvent(head, mergeSha));

    expect(fake.calls.length, fake.calls.join(', ')).toBe(calls);
    expect(app.memory.state.get(PR_URL)).toEqual(first);
    expect(app.memory.state.get(PR_URL)?.merged?.humanDiff).toContain('edited by a person');
    app.cleanup();
  });

  it('sends the verdict first, so its overwrite cannot lose the diff', async () => {
    const ours = openOurFix();
    const head = personEdits();
    const mainTip = moveMain();
    const mergeSha = squash(head);
    const { state } = await mergeAndDeliver(ours, head, mainTip, mergeSha);
    expect(state?.merged?.humanDiff, 'memory kept the diff').toContain('edited by a person');
  });

  it('ends in one state whichever order the events arrive in', async () => {
    const ours = openOurFix();
    const head = personEdits();
    const mainTip = moveMain();
    const mergeSha = squash(head);
    const fake = gitHubOver(git);
    Object.assign(fake.pull, { base: mainTip, head });
    const events: [string, unknown][] = [
      ['pull_request', mergedEvent(head, mergeSha)],
      ['pull_request', synchronizeEvent(head)],
      [
        'push',
        pushEvent(`Revert "Illustrative fix (#${NUMBER})"\n\nThis reverts commit ${mergeSha}.`),
      ],
      ['pull_request', revertPullEvent()],
      ['pull_request', mergedEvent(head, mergeSha)], // redelivered
    ];
    const orders = permutations(events.map((_, index) => index));
    const results = new Set<string>();
    for (const order of orders) {
      const app = world(fake.github);
      await app.evidence.opened({
        repo: REPO,
        number: NUMBER,
        url: PR_URL,
        sha: ours,
        entryIds: [ENTRY],
      });
      for (const index of order) await app.deliver(...events[index]);
      results.add(
        JSON.stringify({
          memory: sortedKeys(app.memory.state.get(PR_URL)),
          facts: JSON.parse(readFileSync(join(app.dir, 'fixes', `${REPO}.json`), 'utf8')),
          habits: app.memory.habits.at(-1),
        }),
      );
      app.cleanup();
    }
    expect(results.size, [...results].join('\n')).toBe(1);
    const [only] = [...results];
    const { memory } = JSON.parse(only) as { memory: FixEvidence };
    expect(memory.edited).toBe(true);
    expect(memory.merged?.humanDiff).toContain('edited by a person');
    expect(memory.reverted).toEqual({ at: '2026-11-02T09:00:00.000Z', via: 'revert' });
  });
});

function permutations(items: number[]): number[][] {
  if (items.length < 2) return [items];
  const seen = new Map<string, number[]>();
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      const order = [item, ...tail];
      seen.set(order.join(), order);
    }
  });
  return [...seen.values()];
}

const sortedKeys = <T extends object>(value: T | undefined) =>
  Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));

// Everything below needs no trees.
const noGit: EvidenceGitHub = {
  listPullCommits: async () => [],
  listPullFiles: async () => [],
  commitFiles: async () => [],
  compareFiles: async () => ({ status: 'identical', files: [] }),
  listPullComments: async () => [],
};

const fileOf = (patch: string, filename = 'billing.ts'): ChangedFile => ({
  filename,
  status: 'modified',
  sha: `blob-${patch.length}`,
  patch,
});

describe('what a merged diff may carry', () => {
  const ours = fileOf('@@ -1 +1 @@\n-old\n+ours');
  const withDiff = (patch: string): EvidenceGitHub => ({
    ...noGit,
    commitFiles: async () => [ours],
    listPullFiles: async () => [fileOf(patch)],
    compareFiles: async () => ({ status: 'ahead', files: [fileOf(patch)] }),
  });

  async function merged(github: EvidenceGitHub) {
    const app = world(github);
    await app.evidence.opened({
      repo: REPO,
      number: NUMBER,
      url: PR_URL,
      sha: 'ours-sha',
      entryIds: [],
    });
    await app.deliver('pull_request', mergedEvent('person-head', 'squash-sha'));
    app.cleanup();
    return app.memory.sent.at(-1)?.evidence.merged?.humanDiff ?? '';
  }

  it('redacts a secret inside the diff', async () => {
    const stripe = `sk_live_${'a'.repeat(24)}`;
    const github = `ghp_${'b'.repeat(36)}`;
    const diff = await merged(withDiff(`@@ -1 +1 @@\n-old\n+${stripe} ${github}`));
    expect(diff, diff).toContain('[redacted]');
    expect(diff).not.toContain(stripe);
    expect(diff).not.toContain(github);
  });

  it("redacts this process's own secret values", async () => {
    vi.stubEnv('APTITUDE_TEST_SECRET', 'value-only-the-host-knows');
    try {
      const diff = await merged(withDiff('@@ -1 +1 @@\n-old\n+value-only-the-host-knows'));
      expect(diff, diff).not.toContain('value-only-the-host-knows');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('caps an oversized diff and says how much is missing', async () => {
    const line = '+x'.repeat(50);
    const diff = await merged(
      withDiff(
        `@@ -1 +1 @@\n-old\n${`${line}\n`.repeat(2 * (MAX_HUMAN_DIFF_CHARS / line.length))}`,
      ),
    );
    expect(diff.length, `${diff.length} characters`).toBeLessThan(MAX_HUMAN_DIFF_CHARS + 100);
    expect(diff).toMatch(/\[\.\.\. \d+ more characters not shown \.\.\.\]$/);
  });

  it('a secret straddling the cap is redacted before the cut, so no half survives', async () => {
    const secret = `sk_live_${'c'.repeat(40)}`;
    const before = '--- billing.ts (modified)\n@@ -1 +1 @@\n-old\n+';
    // Cut 10 characters into the secret: too short a stub for any pattern to recognise afterwards.
    const lead = 'x'.repeat(MAX_HUMAN_DIFF_CHARS - before.length - 11);
    const tail = 'x'.repeat(MAX_HUMAN_DIFF_CHARS);
    const diff = await merged(withDiff(`@@ -1 +1 @@\n-old\n+${lead} ${secret} ${tail}`));
    expect(diff).toContain('more characters not shown');
    expect(diff).not.toContain('sk_live_');
  });

  it('a binary file with no patch is compared by blob and named', async () => {
    const image: ChangedFile = { filename: 'logo.png', status: 'modified', sha: 'blob-a' };
    const github: EvidenceGitHub = {
      ...noGit,
      commitFiles: async () => [image],
      listPullFiles: async () => [{ ...image, sha: 'blob-b' }],
      compareFiles: async () => ({ status: 'ahead', files: [{ ...image, sha: 'blob-b' }] }),
    };
    const diff = await merged(github);
    expect(diff, diff).toContain('logo.png');
    expect(diff, diff).toContain('no text diff');
  });

  it('a GitHub failure stores no half a merge, and the redelivery finishes it', async () => {
    let down = true;
    const app = world({
      ...noGit,
      listPullCommits: async () => {
        if (down) throw new Error('GitHub 502');
        return [{ parents: ['one'], author: { type: 'User' } }];
      },
    });
    await expect(app.deliver('pull_request', mergedEvent('head', 'squash'))).rejects.toThrow(
      'GitHub 502',
    );
    expect(await app.evidence.hasFixToWatch(REPO)).toBe(false);
    expect(app.memory.sent).toEqual([]);
    down = false;
    await app.deliver('pull_request', mergedEvent('head', 'squash'));
    expect(app.memory.sent.at(-1)?.evidence.edited).toBe(true);
    app.cleanup();
  });

  it('a sink failure keeps the facts, and the redelivery sends them', async () => {
    const memory = fakeMemory();
    let down = true;
    const dir = mkdtempSync(join(tmpdir(), 'aptitude-evidence-'));
    const evidence = createEvidence({
      tokens: { token: async () => 'ghs_test_installation_token' },
      github: noGit,
      facts: createFactStore(join(dir, 'fixes')),
      consent: createConsentStore(join(dir, 'installations')),
      recordEvidence: async (pr, fresh, consent) => {
        if (down) throw new Error('store locked');
        await memory.recordEvidence(pr, fresh, consent);
      },
      recordHabits: memory.recordHabits,
    });
    const event = mergedEvent('head', 'squash') as unknown as PullEvent;
    await expect(evidence.closed(event)).rejects.toThrow('store locked');
    down = false;
    await evidence.closed(event);
    expect(memory.state.get(PR_URL)?.merged).toEqual({ at: '2026-11-01T11:00:00.000Z' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a PR opened before the app kept its commit still reports the merge and edit', async () => {
    const app = world({
      ...noGit,
      listPullCommits: async () => [{ parents: ['one'], author: { type: 'User' } }],
    });
    await app.deliver('pull_request', mergedEvent('head', 'squash'));
    expect(app.memory.sent.at(-1)?.evidence).toEqual({
      edited: true,
      merged: { at: '2026-11-01T11:00:00.000Z' },
    });
    app.cleanup();
  });

  it('a bot or merge commit alone is no edit', async () => {
    const app = world({
      ...noGit,
      listPullCommits: async () => [
        { parents: ['one'], author: { type: 'Bot' } },
        { parents: ['one', 'two'], author: { type: 'User' } },
      ],
    });
    await app.deliver('pull_request', mergedEvent('head', 'squash'));
    expect(app.memory.sent.at(-1)?.evidence.edited).toBeUndefined();
    app.cleanup();
  });
});

describe('a closed fix', () => {
  const person = (login: string, body: string | null, at: string): PullComment => ({
    user: { login, type: 'User' },
    body,
    at,
  });
  const robot = (body: string, at: string): PullComment => ({
    user: { login: 'ci[bot]', type: 'Bot' },
    body,
    at,
  });

  async function closedWith(comments: PullComment[], closer?: string) {
    const app = world({ ...noGit, listPullComments: async () => comments });
    await app.deliver('pull_request', closedEvent(closer));
    app.cleanup();
    return app.memory.sent.at(-1)?.evidence.closed;
  }

  it('with no comment, is simply closed', async () => {
    expect(await closedWith([])).toEqual({ at: '2026-11-01T12:00:00.000Z' });
  });

  it("takes the closing person's latest comment over someone else's newer one", async () => {
    const closed = await closedWith([
      person('example-admin', 'an earlier thought', '2026-11-01T09:00:00Z'),
      person('example-admin', 'we keep this version on purpose', '2026-11-01T10:00:00Z'),
      person('someone-else', 'a newer aside', '2026-11-01T11:00:00Z'),
    ]);
    expect(closed?.comment).toBe('we keep this version on purpose');
  });

  it('falls back to the latest comment from any person when the closer said nothing', async () => {
    const closed = await closedWith([
      person('reviewer', 'older review', '2026-11-01T09:00:00Z'),
      person('reviewer', 'this breaks our retries', '2026-11-01T10:00:00Z'),
    ]);
    expect(closed?.comment).toBe('this breaks our retries');
  });

  it('never takes a bot comment or an empty review as the reason', async () => {
    const closed = await closedWith([
      robot('coverage dropped', '2026-11-01T11:00:00Z'),
      person('example-admin', '   ', '2026-11-01T10:30:00Z'),
      person('example-admin', null, '2026-11-01T10:40:00Z'),
    ]);
    expect(closed).toEqual({ at: '2026-11-01T12:00:00.000Z' });
  });

  it('redacts and caps the comment', async () => {
    const secret = `sk_live_${'d'.repeat(24)}`;
    const closed = await closedWith([
      person('example-admin', `${secret} ${'y'.repeat(2 * MAX_COMMENT_CHARS)}`, CLOSED_AT),
    ]);
    expect(closed?.comment).not.toContain(secret);
    expect(closed?.comment?.length).toBeLessThan(MAX_COMMENT_CHARS + 100);
  });

  it('a redelivered close keeps the comment, even after the verdict overwrites it', async () => {
    const app = world({
      ...noGit,
      listPullComments: async () => [person('example-admin', 'not for us', CLOSED_AT)],
    });
    await app.deliver('pull_request', closedEvent());
    await app.deliver('pull_request', closedEvent());
    expect(app.memory.state.get(PR_URL)?.closed?.comment).toBe('not for us');
    expect(app.memory.order).toEqual(['verdict closed', 'evidence', 'verdict closed', 'evidence']);
    app.cleanup();
  });

  it('a redelivered close picks up a comment that was missing the first time', async () => {
    let comments: PullComment[] = [];
    const app = world({ ...noGit, listPullComments: async () => comments });
    await app.deliver('pull_request', closedEvent());
    comments = [person('example-admin', 'said a moment later', CLOSED_AT)];
    await app.deliver('pull_request', closedEvent());
    expect(app.memory.state.get(PR_URL)?.closed?.comment).toBe('said a moment later');
    app.cleanup();
  });

  it('a close before the edit, or a synchronize after the close, ends the same', async () => {
    const comments = [person('example-admin', 'no thanks', CLOSED_AT)];
    const github = { ...noGit, listPullComments: async () => comments };
    const finals = [];
    for (const events of [
      [closedEvent(), synchronizeEvent('head')],
      [synchronizeEvent('head'), closedEvent()],
    ]) {
      const app = world(github);
      for (const event of events) await app.deliver('pull_request', event);
      finals.push(app.memory.sent.at(-1)?.evidence);
      app.cleanup();
    }
    expect(finals[0]).toEqual({
      edited: true,
      closed: { at: '2026-11-01T12:00:00.000Z', comment: 'no thanks' },
    });
    expect(finals[1]).toEqual(finals[0]);
  });

  it('closed, reopened and merged sends merged, not closed, in either order', async () => {
    const orders = [
      [closedEvent(), mergedEvent('head', 'squash')],
      [mergedEvent('head', 'squash'), closedEvent()],
    ];
    for (const events of orders) {
      const app = world(noGit);
      for (const event of events) await app.deliver('pull_request', event);
      expect(app.memory.sent.at(-1)?.evidence).toEqual({
        merged: { at: '2026-11-01T11:00:00.000Z' },
      });
      app.cleanup();
    }
  });
});

describe('a revert', () => {
  const merge = () => mergedEvent('head', 'a'.repeat(40));
  const named = (message: string) => pushEvent(message);

  const shaOfMerge = 'a'.repeat(40);
  const forms: [string, string, unknown][] = [
    ['the revert PR form', 'pull_request', revertPullEvent()],
    ['a Revert commit naming the PR', 'push', named(`Revert "Illustrative fix (#${NUMBER})"`)],
    [
      'a squashed revert PR',
      'push',
      named(`Revert "Illustrative fix (#${NUMBER})" (#57)\n\nReverts ${REPO}#${NUMBER}`),
    ],
    [
      'a revert of a merge commit',
      'push',
      named(
        `Revert "Merge pull request #${NUMBER} from org/aptitude/fix"\n\nThis reverts commit ${'b'.repeat(40)}.`,
      ),
    ],
    [
      'a Revert commit naming the merge SHA',
      'push',
      named(`Revert "x"\n\nThis reverts commit ${shaOfMerge}.`),
    ],
  ];

  it.each(forms)('%s counts, after or before the merge arrives', async (_name, event, payload) => {
    for (const revertFirst of [false, true]) {
      const app = world(noGit);
      if (revertFirst) await app.deliver(event, payload);
      await app.deliver('pull_request', merge());
      if (!revertFirst) await app.deliver(event, payload);
      const final = app.memory.sent.at(-1)?.evidence;
      expect(final?.reverted, JSON.stringify(final)).toEqual({
        at: '2026-11-02T09:00:00.000Z',
        via: 'revert',
      });
      expect(final?.merged).toEqual({ at: '2026-11-01T11:00:00.000Z' });
      app.cleanup();
    }
  });

  it('a revert PR that was closed unmerged, or merged elsewhere, reverted nothing', async () => {
    const app = world(noGit);
    await app.deliver('pull_request', merge());
    await app.deliver('pull_request', revertPullEvent({ merged: false, merged_at: null }));
    await app.deliver('pull_request', revertPullEvent({ base: { ref: 'release' } }));
    expect(app.memory.sent.at(-1)?.evidence.reverted).toBeUndefined();
    app.cleanup();
  });

  it('a revert on another branch, or of something else, reverted nothing', async () => {
    const app = world(noGit);
    await app.deliver('pull_request', merge());
    const message = `Revert "Illustrative fix (#${NUMBER})"`;
    await app.deliver('push', pushEvent(message, { ref: 'refs/heads/other' }));
    await app.deliver('push', pushEvent('Revert "Someone else\'s work (#12)"'));
    await app.deliver('push', pushEvent(`Fix a typo, and mention #${NUMBER}`));
    expect(app.memory.sent.at(-1)?.evidence.reverted).toBeUndefined();
    app.cleanup();
  });

  it('reverting a revert puts the fix back, so it counts as nothing', () => {
    const message = `Revert "Revert "Illustrative fix (#${NUMBER})""\n\nThis reverts commit ${'c'.repeat(40)}.`;
    expect(revertedBy(message, REPO)).toEqual({ prs: [], shas: [] });
  });

  it("a revert naming another repo's PR is not ours", () => {
    expect(revertedBy(`Reverts other-org/other-repo#${NUMBER}`, REPO).prs).toEqual([]);
  });

  it('a revert naming a PR that never merged sends nothing, and its close stays a close', async () => {
    const app = world(noGit);
    await app.deliver('pull_request', closedEvent());
    await app.deliver('push', pushEvent(`Revert "Illustrative fix (#${NUMBER})"`));
    await app.deliver('pull_request', closedEvent()); // resends everything known about the fix
    expect(app.memory.sent.at(-1)?.evidence).toEqual({
      closed: { at: '2026-11-01T12:00:00.000Z' },
    });
    app.cleanup();
  });

  it('a redelivered revert keeps the first time, and the earliest of two forms wins', async () => {
    const app = world(noGit);
    await app.deliver('pull_request', merge());
    const later = pushEvent(`Revert "Illustrative fix (#${NUMBER})"`, {
      commits: [
        {
          id: 'later',
          message: `Revert "Illustrative fix (#${NUMBER})"`,
          timestamp: '2026-11-03T09:00:00+00:00',
        },
      ],
    });
    await app.deliver('push', later);
    await app.deliver('pull_request', revertPullEvent());
    await app.deliver('push', later);
    expect(app.memory.state.get(PR_URL)?.reverted?.at).toBe('2026-11-02T09:00:00.000Z');
    app.cleanup();
  });
});

describe('a rescan', () => {
  const live = (entryId: string, matchClass: Finding['matchClass'] = 'live'): Finding => ({
    entryId,
    file: 'billing.ts',
    line: 1,
    matchClass,
  });
  const AFTER = '2026-11-04T00:00:00Z';

  async function mergedFix(entryIds = [ENTRY]) {
    const app = world(noGit);
    await app.evidence.opened({ repo: REPO, number: NUMBER, url: PR_URL, sha: 'ours', entryIds });
    await app.deliver('pull_request', mergedEvent('ours', 'squash'));
    return app;
  }

  it('finding a fixed entry back after the merge is a rescan revert', async () => {
    const app = await mergedFix();
    await app.evidence.rescanFound(INSTALLATION, REPO, [live(ENTRY)], AFTER);
    expect(app.memory.sent.at(-1)?.evidence.reverted).toEqual({
      at: '2026-11-04T00:00:00.000Z',
      via: 'rescan',
    });
    app.cleanup();
  });

  it.each([
    ['a scan from before the merge', [live(ENTRY)], '2026-11-01T10:00:00Z'],
    ['a different entry', [live('another-entry')], AFTER],
    ['a mention in a comment', [live(ENTRY, 'comment')], AFTER],
    ['a mention in a test', [live(ENTRY, 'test')], AFTER],
    ['nothing found', [], AFTER],
  ] as const)('%s is no revert', async (_name, findings, at) => {
    const app = await mergedFix();
    const sends = app.memory.sent.length;
    await app.evidence.rescanFound(INSTALLATION, REPO, [...findings], at);
    expect(app.memory.sent.length).toBe(sends);
    app.cleanup();
  });

  it('an entry on a fix that never merged is no revert', async () => {
    const app = world(noGit);
    await app.evidence.opened({
      repo: REPO,
      number: NUMBER,
      url: PR_URL,
      sha: 'ours',
      entryIds: [ENTRY],
    });
    await app.evidence.rescanFound(INSTALLATION, REPO, [live(ENTRY)], AFTER);
    expect(app.memory.sent).toEqual([]);
    app.cleanup();
  });

  it('later scans keep the first time it came back, and a real revert before it wins', async () => {
    const app = await mergedFix();
    await app.evidence.rescanFound(INSTALLATION, REPO, [live(ENTRY)], AFTER);
    await app.evidence.rescanFound(INSTALLATION, REPO, [live(ENTRY)], '2026-11-05T00:00:00Z');
    expect(app.memory.state.get(PR_URL)?.reverted?.at).toBe('2026-11-04T00:00:00.000Z');
    await app.deliver('push', pushEvent(`Revert "Illustrative fix (#${NUMBER})"`));
    expect(app.memory.state.get(PR_URL)?.reverted).toEqual({
      at: '2026-11-02T09:00:00.000Z',
      via: 'revert',
    });
    app.cleanup();
  });

  it('a repo skips the scan until a merged fix names an entry it fixed', async () => {
    const unnamed = await mergedFix([]);
    expect(await unnamed.evidence.hasFixToWatch(REPO)).toBe(false);
    unnamed.cleanup();
    const app = world(noGit);
    expect(await app.evidence.hasFixToWatch(REPO)).toBe(false);
    await app.evidence.opened({
      repo: REPO,
      number: NUMBER,
      url: PR_URL,
      sha: 'ours',
      entryIds: [ENTRY],
    });
    expect(await app.evidence.hasFixToWatch(REPO), 'still open').toBe(false);
    await app.deliver('pull_request', mergedEvent('ours', 'squash'));
    expect(await app.evidence.hasFixToWatch(REPO)).toBe(true);
    app.cleanup();
  });
});

describe('repo habits', () => {
  it('counts rejections with their reasons, edits, and files people keep changing', async () => {
    const edit = (filename: string) => fileOf('@@ -1 +1 @@\n-old\n+person', filename);
    const ours = fileOf('@@ -1 +1 @@\n-old\n+ours');
    const app = world({
      ...noGit,
      commitFiles: async () => [ours],
      listPullFiles: async (_token, _repo, number) => [
        edit('billing.ts'),
        edit(number === 1 ? 'only-once.ts' : 'also-once.ts'),
      ],
      compareFiles: async (_token, _repo, _base, head) => ({
        status: 'ahead',
        files: [edit('billing.ts'), edit(head === 'head-1' ? 'only-once.ts' : 'also-once.ts')],
      }),
      listPullComments: async (_token, _repo, number) => [
        { user: { login: 'example-admin', type: 'User' }, body: `no, ${number}`, at: CLOSED_AT },
      ],
    });
    for (const number of [1, 2]) {
      const url = `${REPO_URL}/pull/${number}`;
      await app.evidence.opened({ repo: REPO, number, url, sha: 'ours', entryIds: [] });
      const event = mergedEvent(`head-${number}`, `squash-${number}`) as unknown as {
        pull_request: object;
      };
      await app.deliver('pull_request', {
        ...event,
        pull_request: { ...event.pull_request, number, html_url: url },
      });
    }
    for (const number of [3, 4]) {
      const event = closedEvent() as unknown as { pull_request: object };
      await app.deliver('pull_request', {
        ...event,
        pull_request: {
          ...event.pull_request,
          number,
          html_url: `${REPO_URL}/pull/${number}`,
          closed_at: `2026-11-0${number}T12:00:00Z`,
        },
      });
    }
    expect(app.memory.habits.at(-1)).toEqual({
      repo: REPO,
      rejections: { count: 2, reasons: ['no, 3', 'no, 4'] },
      edits: { count: 2, repeatedFiles: ['billing.ts'] },
    });
    app.cleanup();
  });
});

describe('shared learning consent', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aptitude-evidence-consent-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const merged = () => mergedEvent('ours', 'squash');
  const install = (action = 'created') => ({
    ...fixture(`installation.${action}`),
    action,
    installation: { id: INSTALLATION },
  });
  const lastConsent = (app: ReturnType<typeof world>) => app.memory.sent.at(-1)?.consented;

  it('a default install passes false, and evidence still reaches the customer store', async () => {
    const app = world(noGit);
    await app.deliver('installation', install());
    await app.deliver('pull_request', merged());
    expect(lastConsent(app)).toBe(false);
    expect(app.memory.state.get(PR_URL)?.merged).toBeDefined();
    app.cleanup();
  });

  it('with no record at all it passes false, never true', async () => {
    const app = world(noGit);
    await app.deliver('pull_request', merged());
    expect(lastConsent(app)).toBe(false);
    app.cleanup();
  });

  it('a yes passes true, and revoking it stops sharing from the next event', async () => {
    const app = world(noGit);
    await app.deliver('installation', install());
    await app.consent.set(INSTALLATION, true);
    await app.deliver('pull_request', merged());
    expect(lastConsent(app)).toBe(true);
    await app.consent.set(INSTALLATION, false);
    await app.deliver('push', pushEvent(`Revert "Illustrative fix (#${NUMBER})"`));
    expect(lastConsent(app)).toBe(false);
    app.cleanup();
  });

  it('a redelivered install keeps a yes, and an uninstall drops it', async () => {
    const app = world(noGit);
    await app.deliver('installation', install());
    await app.consent.set(INSTALLATION, true);
    await app.deliver('installation', install());
    expect(await app.consent.consented(INSTALLATION)).toBe(true);
    await app.deliver('installation', install('deleted'));
    expect(await app.consent.consented(INSTALLATION)).toBe(false);
    await app.deliver('installation', install());
    expect(await app.consent.consented(INSTALLATION)).toBe(false);
    app.cleanup();
  });

  it('an unreadable setting passes false, and the evidence still goes through', async () => {
    const app = world(noGit);
    await app.deliver('installation', install());
    writeFileSync(join(app.dir, 'installations', `${INSTALLATION}.json`), '{not json');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.deliver('pull_request', merged());
    expect(lastConsent(app)).toBe(false);
    expect(logged.mock.calls.flat().join(' ')).toContain('unreadable');
    logged.mockRestore();
    app.cleanup();
  });
});

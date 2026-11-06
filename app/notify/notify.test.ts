import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehindItem, ExternalChange, RunRecord, ScanReport } from '../../shared/types.ts';
import { createNotifier, notifyRun, sendWeeklyDigest } from './index.ts';

// All repos, titles and URLs here are illustrative examples, not real customers or vendors.
const WEBHOOK = 'https://hooks.slack.example/services/T000/B000/SECRETWEBHOOKPATH';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const DAY = 86_400_000;
const inDays = (days: number, from = NOW) => new Date(from + days * DAY).toISOString().slice(0, 10);

// Slack's answers below are taken from its incoming webhook docs, not captured from a live call.
const accepted = () =>
  new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
const invalidPayload = () => new Response('invalid_payload', { status: 400 });
const serverError = () => new Response('server error', { status: 500 });

function fakeSlack(answer: (text: string) => Response | Promise<Response> = accepted) {
  const texts: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { text } = JSON.parse(init.body as string) as { text: string };
    texts.push(text);
    requests.push({ url, init });
    return answer(text);
  }) as unknown as typeof fetch;
  return { texts, requests, fetchImpl };
}

const change = (overrides: Partial<ExternalChange> = {}): ExternalChange => ({
  provider: 'examplepay',
  id: 'change-1',
  kind: 'api-version',
  title: 'ExamplePay retires API v1',
  source: { url: 'https://docs.example.com/changelog', quote: 'quote' },
  affects: {},
  dependencyKind: 'api',
  dependency: 'examplepay',
  ...overrides,
});

const item = (
  overrides: Partial<BehindItem> & { title?: string; changeId?: string; name?: string } = {},
): BehindItem => {
  const { title, changeId, name, ...rest } = overrides;
  return {
    repo: 'acme/api',
    dependency: { repo: 'acme/api', kind: 'api', name: name ?? 'examplepay', declaredIn: [] },
    change: change({
      id: changeId ?? 'change-1',
      title: title ?? 'ExamplePay retires API v1',
      effectiveDate: inDays(10),
    }),
    status: 'open',
    ...rest,
  };
};

const report = (items: BehindItem[], repo = 'acme/api'): ScanReport => ({
  repo,
  scannedAt: new Date(NOW).toISOString(),
  items,
  costUsd: 0,
  errors: [],
});

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  taskId: 'task-1',
  outcome: 'verified',
  diff: '',
  checks: [],
  costUsd: 0,
  transcriptPath: 'transcript.json',
  pr: 'https://github.example/acme/api/pull/7',
  ...overrides,
});

const runInput = (records: RunRecord[], scan?: ScanReport, repo = 'acme/api') => ({
  installationId: 70000001,
  repo,
  records,
  ...(scan && { report: scan }),
});

let dir: string;
let stateFile: string;
let errorLog: ReturnType<typeof vi.spyOn>;
const savedEnv = { ...process.env };

const notifierWith = (slack: ReturnType<typeof fakeSlack>, now = NOW) =>
  createNotifier({ webhookUrl: WEBHOOK, stateFile, fetchImpl: slack.fetchImpl, now: () => now });

const logged = () => errorLog.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

const failingAnswers: [string, () => Response | Promise<Response>, string][] = [
  ['a 500', serverError, '500'],
  ['Slack invalid_payload', invalidPayload, '400'],
  [
    'a thrown fetch whose message embeds the URL',
    () => Promise.reject(new TypeError(`fetch failed for ${WEBHOOK}`)),
    'TypeError',
  ],
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-notify-'));
  stateFile = join(dir, 'nested', 'notified.json');
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.REFIT_SLACK_WEBHOOK_URL;
  delete process.env.REFIT_NOTIFY_STATE_FILE;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
  await rm(dir, { recursive: true, force: true });
});

describe('without a webhook URL', () => {
  it('sends nothing and writes no state from any method', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const notifier = createNotifier({ webhookUrl: undefined, stateFile, fetchImpl });

    await notifier.notifyRun(runInput([record()]));
    await notifier.notifyRun(runInput([], report([item()])));
    await notifier.weeklyDigest([report([item()])]);

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readdir(dir), 'no state folder should exist').resolves.toEqual([]);
    expect(logged(), 'an unset URL is not an error').toBe('');
  });

  it('treats an empty environment variable as unset', async () => {
    process.env.REFIT_SLACK_WEBHOOK_URL = '';
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await createNotifier({ stateFile, fetchImpl }).weeklyDigest([report([])]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('configuration and transport', () => {
  it('reads the URL and state file from the environment and posts JSON { text }', async () => {
    const envState = join(dir, 'from-env.json');
    process.env.REFIT_SLACK_WEBHOOK_URL = WEBHOOK;
    process.env.REFIT_NOTIFY_STATE_FILE = envState;
    const slack = fakeSlack();

    await createNotifier({ fetchImpl: slack.fetchImpl }).notifyRun(runInput([record()]));

    expect(slack.requests).toHaveLength(1);
    const [{ url, init }] = slack.requests;
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(['text']);
    expect(init.signal, 'a hung Slack must not hang the caller').toBeInstanceOf(AbortSignal);
    expect(JSON.parse(await readFile(envState, 'utf8'))).toEqual([record().pr]);
  });

  it('survives a request timeout', async () => {
    const slack = fakeSlack(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await expect(notifierWith(slack).notifyRun(runInput([record()]))).resolves.toBeUndefined();
    expect(logged()).toContain('TimeoutError');
  });
});

describe('top-level functions', () => {
  it('see an environment change between calls', async () => {
    const slack = fakeSlack();
    vi.stubGlobal('fetch', slack.fetchImpl);
    process.env.REFIT_NOTIFY_STATE_FILE = stateFile;

    await notifyRun(runInput([record()]));
    await sendWeeklyDigest([report([])]);
    expect(slack.requests, 'unset means silent').toEqual([]);

    process.env.REFIT_SLACK_WEBHOOK_URL = WEBHOOK;
    await notifyRun(runInput([record()]));
    await sendWeeklyDigest([report([])]);
    expect(slack.requests.map(({ url }) => url)).toEqual([WEBHOOK, WEBHOOK]);

    const moved = `${WEBHOOK}/moved`;
    process.env.REFIT_SLACK_WEBHOOK_URL = moved;
    await sendWeeklyDigest([report([])]);
    expect(slack.requests[2].url).toBe(moved);
  });

  it('do not lose keys when calls overlap, though each builds its own notifier', async () => {
    const slack = fakeSlack();
    vi.stubGlobal('fetch', slack.fetchImpl);
    process.env.REFIT_SLACK_WEBHOOK_URL = WEBHOOK;
    process.env.REFIT_NOTIFY_STATE_FILE = stateFile;
    const prs = [1, 2, 3, 4, 5].map((n) => `https://github.example/acme/api/pull/${n}`);

    await Promise.all(prs.map((pr) => notifyRun(runInput([record({ pr })]))));

    const keys = JSON.parse(await readFile(stateFile, 'utf8')) as string[];
    expect(keys.sort(), `log: ${logged()}`).toEqual(prs);
    expect(logged()).toBe('');
  });

  it('never throw when Slack fails', async () => {
    vi.stubGlobal('fetch', fakeSlack(serverError).fetchImpl);
    process.env.REFIT_SLACK_WEBHOOK_URL = WEBHOOK;
    process.env.REFIT_NOTIFY_STATE_FILE = stateFile;
    await expect(notifyRun(runInput([record()]))).resolves.toBeUndefined();
    await expect(sendWeeklyDigest([report([])])).resolves.toBeUndefined();
    expect(logged()).not.toContain(WEBHOOK);
  });
});

describe('notifyRun pull requests', () => {
  it('sends repo, title from the report and PR link for a verified run', async () => {
    const slack = fakeSlack();
    const matching = item({
      title: 'Title from the report',
      status: 'pr-open',
      pr: record().pr,
      deadline: inDays(90),
    });
    await notifierWith(slack).notifyRun(runInput([record()], report([matching])));

    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(1);
    const [text] = slack.texts;
    expect(text).toContain('acme/api');
    expect(text).toContain('Title from the report');
    expect(text).toContain('<https://github.example/acme/api/pull/7|PR>');
    expect(text, 'should be one short line').not.toContain('\n');
  });

  it.each([
    ['no report', undefined],
    ['a report with no matching PR', report([item({ title: 'Other', deadline: inDays(90) })])],
  ])('falls back to the task id with %s', async (_name, scan) => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([record({ taskId: 'task-42' })], scan));
    expect(slack.texts).toHaveLength(1);
    expect(slack.texts[0]).toContain('task-42');
    expect(slack.texts[0]).not.toContain('Other');
  });

  it('sends one line per PR, and one for a PR listed twice', async () => {
    const slack = fakeSlack();
    const second = 'https://github.example/acme/api/pull/8';
    await notifierWith(slack).notifyRun(
      runInput([record(), record({ taskId: 'task-2' }), record({ pr: second })]),
    );
    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(2);
  });

  it('sends the PR line and the deadline alert separately from one call', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(
      runInput([record()], report([item({ status: 'pr-open', pr: record().pr })])),
    );
    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(2);
    expect(slack.texts[0]).toContain('Migration verified');
    expect(slack.texts[1]).toContain('Deadlines coming up');
  });

  it('accepts no records and no report', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([]));
    expect(slack.texts).toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('still sends later PRs and the deadline alert after one PR line fails, then retries it', async () => {
    let failures = 1;
    const slack = fakeSlack(() => (failures-- > 0 ? serverError() : accepted()));
    const second = 'https://github.example/acme/api/pull/8';
    const input = runInput([record(), record({ pr: second })], report([item()]));

    await expect(notifierWith(slack).notifyRun(input)).resolves.toBeUndefined();
    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(3);
    expect(errorLog).toHaveBeenCalledTimes(1);

    await notifierWith(slack).notifyRun(input);
    expect(slack.texts, 'only the failed line is sent again').toHaveLength(4);
    expect(slack.texts[3]).toContain('/pull/7');
  });

  it.each(['needs-review', 'not-affected', 'failed'] as const)(
    'sends nothing for outcome %s, even with a PR',
    async (outcome) => {
      const slack = fakeSlack();
      await notifierWith(slack).notifyRun(runInput([record({ outcome })]));
      expect(slack.texts).toEqual([]);
    },
  );

  it('sends nothing for a verified run without a PR', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([record({ pr: undefined })]));
    expect(slack.texts).toEqual([]);
  });

  it('sends once per PR URL, across a fresh notifier on the same state file', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([record()]));
    await notifierWith(slack).notifyRun(runInput([record()]));
    await notifierWith(slack).notifyRun(runInput([record({ taskId: 'task-2' })]));
    expect(slack.texts, `sent: ${JSON.stringify(slack.texts)}`).toHaveLength(1);

    await notifierWith(slack).notifyRun(
      runInput([record({ pr: 'https://github.example/acme/api/pull/8' })]),
    );
    expect(slack.texts).toHaveLength(2);
  });
});

describe('notifyRun deadlines', () => {
  const sentFor = async (entry: BehindItem, now = NOW) => {
    const slack = fakeSlack();
    await notifierWith(slack, now).notifyRun(runInput([], report([entry])));
    return slack.texts;
  };

  it('alerts at 29 days and not at 30', async () => {
    const near = await sentFor(item({ deadline: inDays(29) }));
    expect(near, '29 days away must alert').toHaveLength(1);
    expect(near[0]).toContain(inDays(29));

    await rm(stateFile, { force: true });
    expect(await sentFor(item({ deadline: inDays(30) })), '30 days away must not').toEqual([]);
  });

  it('holds the 30-day line at any time of day', async () => {
    const lateEvening = Date.parse('2026-11-05T23:59:00Z');
    const earlyMorning = Date.parse('2026-11-05T00:01:00Z');
    for (const now of [lateEvening, earlyMorning]) {
      expect(await sentFor(item({ deadline: inDays(30, now) }), now)).toEqual([]);
    }
  });

  it('says passed for a past deadline, never a negative number', async () => {
    const [text] = await sentFor(item({ deadline: inDays(-3) }));
    expect(text).toContain(`${inDays(-3)} (passed)`);
    expect(text).not.toMatch(/-\d+ day/);
  });

  it('does not call a deadline passed on its own day', async () => {
    const [text] = await sentFor(item({ deadline: inDays(0) }));
    expect(text).toContain(inDays(0));
    expect(text).not.toContain('passed');
  });

  it('falls back to effectiveDate and prefers deadline when both exist', async () => {
    const fallback = await sentFor(item());
    expect(fallback[0]).toContain(inDays(10));

    await rm(stateFile, { force: true });
    const overridden = await sentFor(item({ deadline: inDays(90) }));
    expect(overridden, 'a far deadline overrides a near effectiveDate').toEqual([]);
  });

  it('formats a month-only date and a timestamp as YYYY-MM-DD', async () => {
    expect((await sentFor(item({ deadline: '2026-11' })))[0]).toContain('2026-11-01 (passed)');
    await rm(stateFile, { force: true });
    expect((await sentFor(item({ deadline: `${inDays(5)}T09:30:00Z` })))[0]).toMatch(
      new RegExp(`deadline ${inDays(5)} ·`),
    );
  });

  it.each(['soon', 'June', 'late 2026', '2026-02-30', '2026-13-01', ''])(
    'skips the unparseable date %j',
    async (deadline) => {
      expect(await sentFor(item({ deadline }))).toEqual([]);
      expect(logged()).toBe('');
    },
  );

  it('skips an item with no date at all', async () => {
    const undated = item();
    delete undated.change.effectiveDate;
    expect(await sentFor(undated)).toEqual([]);
  });

  it.each(['merged', 'not-affected'] as const)('skips %s items', async (status) => {
    expect(await sentFor(item({ status, deadline: inDays(1) }))).toEqual([]);
  });

  it('lists an open and a pr-open item in one message with their links', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(
      runInput(
        [],
        report([
          item({ name: 'first-dep', changeId: 'a' }),
          item({
            name: 'second-dep',
            changeId: 'b',
            status: 'pr-open',
            pr: 'https://github.example/acme/api/pull/9',
          }),
        ]),
      ),
    );

    expect(slack.texts, 'one message per report').toHaveLength(1);
    const [text] = slack.texts;
    expect(text).toContain('first-dep');
    expect(text).toContain('second-dep');
    expect(text).toContain('<https://docs.example.com/changelog|source>');
    expect(text).toContain('<https://github.example/acme/api/pull/9|PR>');
  });

  it('sends nothing and writes no state when nothing is due', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([], report([item({ deadline: inDays(60) })])));
    expect(slack.texts).toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe('notifyRun deadline dedupe', () => {
  it('repeats nothing on a re-scan, and lists only the newly due item', async () => {
    const slack = fakeSlack();
    const old = item({ name: 'old-dep', changeId: 'a' });
    await notifierWith(slack).notifyRun(runInput([], report([old])));
    await notifierWith(slack).notifyRun(runInput([], report([old])));
    expect(slack.texts, 'a re-scan should be silent').toHaveLength(1);

    await notifierWith(slack).notifyRun(
      runInput([], report([old, item({ name: 'new-dep', changeId: 'b' })])),
    );
    expect(slack.texts).toHaveLength(2);
    expect(slack.texts[1]).toContain('new-dep');
    expect(slack.texts[1]).not.toContain('old-dep');
  });

  it.each([
    ['repo', item({ repo: 'acme/web' })],
    ['change id', item({ changeId: 'change-2' })],
    ['dependency name', item({ name: 'other-dep' })],
  ])('treats a different %s as a new alert', async (_field, other) => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([], report([item()])));
    await notifierWith(slack).notifyRun(runInput([], report([other])));
    expect(slack.texts).toHaveLength(2);
  });

  it('lists an item once when a report holds it twice', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([], report([item(), item()])));
    expect(slack.texts[0].match(/ExamplePay retires/g)).toHaveLength(1);
  });

  it('keeps PR keys and item keys from colliding on awkward names', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(
      runInput([], report([item({ changeId: 'a","b', name: 'c' })])),
    );
    await notifierWith(slack).notifyRun(
      runInput([], report([item({ changeId: 'a', name: 'b","c' })])),
    );
    expect(slack.texts).toHaveLength(2);
  });
});

describe('failed sends', () => {
  it.each(failingAnswers)(
    'resolves, hides the URL and retries after %s',
    async (_name, answer, expectedInLog) => {
      let failing = true;
      const slack = fakeSlack(() => (failing ? answer() : accepted()));
      const notifier = notifierWith(slack);
      const entry = item();

      await expect(notifier.notifyRun(runInput([record()]))).resolves.toBeUndefined();
      await expect(notifier.notifyRun(runInput([], report([entry])))).resolves.toBeUndefined();
      await expect(notifier.weeklyDigest([report([entry])])).resolves.toBeUndefined();

      expect(slack.texts, 'each call should have tried').toHaveLength(3);
      expect(errorLog).toHaveBeenCalledTimes(3);
      const log = logged();
      expect(log, `log was: ${log}`).toContain(expectedInLog);
      expect(log, 'the webhook URL is a secret').not.toContain(WEBHOOK);
      expect(log, 'no part of the webhook path').not.toContain('SECRETWEBHOOKPATH');
      await expect(readdir(dir), 'a failed send records nothing').resolves.toEqual([]);

      failing = false;
      await notifier.notifyRun(runInput([record()]));
      await notifier.notifyRun(runInput([], report([entry])));
      expect(slack.texts, 'both should retry').toHaveLength(5);

      await notifier.notifyRun(runInput([record()]));
      await notifier.notifyRun(runInput([], report([entry])));
      expect(slack.texts, 'accepted sends are not repeated').toHaveLength(5);
    },
  );

  it('keeps the queue moving after a failure', async () => {
    const answers = [serverError, accepted];
    const slack = fakeSlack(() => answers.shift()!());
    const notifier = notifierWith(slack);
    await Promise.all([
      notifier.notifyRun(runInput([record({ pr: 'https://github.example/a/b/pull/1' })])),
      notifier.notifyRun(runInput([record({ pr: 'https://github.example/a/b/pull/2' })])),
    ]);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual([
      'https://github.example/a/b/pull/2',
    ]);
  });
});

describe('state file', () => {
  it.each([
    ['broken JSON', '{not json'],
    ['JSON that is not an array', '{"sent":[]}'],
  ])('survives %s: alerts, logs, and repairs the file', async (_name, content) => {
    await mkdir(join(dir, 'nested'));
    await writeFile(stateFile, content);
    const slack = fakeSlack();

    await expect(notifierWith(slack).notifyRun(runInput([record()]))).resolves.toBeUndefined();
    expect(slack.texts).toHaveLength(1);
    expect(logged()).toContain('corrupt');
    expect(logged(), 'file contents stay out of the log').not.toContain(content);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual([record().pr]);

    await notifierWith(slack).notifyRun(runInput([record()]));
    expect(slack.texts, 'the repaired file dedupes').toHaveLength(1);
  });

  it('sends nothing rather than risk repeats when the file cannot be read', async () => {
    await mkdir(stateFile, { recursive: true }); // a folder in its place gives EISDIR
    const slack = fakeSlack();
    await expect(
      notifierWith(slack).notifyRun(runInput([], report([item()]))),
    ).resolves.toBeUndefined();
    expect(slack.texts).toEqual([]);
    expect(logged()).toContain('notifyRun failed');
  });

  it('does not lose keys under concurrent calls, and leaves no temp file', async () => {
    const slack = fakeSlack();
    const notifier = notifierWith(slack);
    const prs = [1, 2, 3, 4, 5].map((n) => `https://github.example/acme/api/pull/${n}`);

    await Promise.all([
      ...prs.map((pr) => notifier.notifyRun(runInput([record({ pr })]))),
      notifier.notifyRun(runInput([], report([item()]))),
      notifier.notifyRun(runInput([], report([item()]))),
    ]);

    expect(slack.texts, 'five PRs and one report').toHaveLength(6);
    const keys = JSON.parse(await readFile(stateFile, 'utf8')) as string[];
    expect(keys, `keys: ${keys}`).toEqual(expect.arrayContaining(prs));
    expect(keys).toHaveLength(6);
    await expect(readdir(join(dir, 'nested'))).resolves.toEqual(['notified.json']);
  });
});

describe('weeklyDigest', () => {
  const dated = (index: number, overrides: Partial<BehindItem> = {}) =>
    item({
      name: `dep-${index}`,
      changeId: `change-${index}`,
      title: `Title ${index}`,
      deadline: inDays(index),
      ...overrides,
    });

  it('sends one message per org, with counts and the next deadline', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).weeklyDigest([
      report([dated(5), dated(3, { status: 'pr-open' }), dated(2, { status: 'merged' })]),
      report([dated(9, { repo: 'acme/web' })], 'acme/web'),
      report([dated(4, { repo: 'globex/app' })], 'globex/app'),
    ]);

    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(2);
    const [acme, globex] = slack.texts;
    expect(acme).toContain('*acme*: 2 open, 1 PR open.');
    expect(acme).toContain(`Next deadline ${inDays(3)}.`);
    expect(acme, 'merged items do not count').not.toContain('dep-2');
    expect(acme).toContain('acme/web');
    expect(globex).toContain('*globex*: 1 open, 0 PR open.');
    expect(globex).not.toContain('acme');
  });

  it('shows repo, dependency, title, target, deadline and the PR link over the source', async () => {
    const slack = fakeSlack();
    const withTarget = item({ status: 'pr-open', pr: 'https://github.example/acme/api/pull/3' });
    withTarget.change.toVersion = 'v2';
    await notifierWith(slack).weeklyDigest([report([withTarget, dated(11)])]);

    const [, first, second] = slack.texts[0].split('\n');
    expect(first).toContain('acme/api, examplepay: ExamplePay retires API v1');
    expect(first).toContain('target v2');
    expect(first).toContain(`deadline ${inDays(10)}`);
    expect(first).toContain('<https://github.example/acme/api/pull/3|PR>');
    expect(first, 'one link per row').not.toContain('|source>');
    expect(second).toContain('<https://docs.example.com/changelog|source>');
    expect(second, 'no target line without a target').not.toContain('target');
  });

  it('truncates at 10 items with "and N more", keeping the soonest', async () => {
    const slack = fakeSlack();
    const items = Array.from({ length: 13 }, (_, index) => dated(13 - index));
    await notifierWith(slack).weeklyDigest([report(items)]);

    const lines = slack.texts[0].split('\n');
    expect(lines, lines.join('\n')).toHaveLength(12);
    expect(lines[1]).toContain('dep-1:');
    expect(lines[10]).toContain('dep-10:');
    expect(lines[11]).toBe('and 3 more');
    expect(slack.texts[0], 'counts cover all items').toContain('13 open');
  });

  it('does not say "and N more" at exactly 10 items', async () => {
    const slack = fakeSlack();
    const items = Array.from({ length: 10 }, (_, index) => dated(index + 1));
    await notifierWith(slack).weeklyDigest([report(items)]);
    expect(slack.texts[0]).not.toContain('more');
  });

  it('says nothing behind for an org with only merged or not-affected items', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).weeklyDigest([
      report([dated(1, { status: 'merged' }), dated(2, { status: 'not-affected' })]),
      report([], 'globex/app'),
    ]);
    expect(slack.texts).toEqual(['*acme*: nothing behind.', '*globex*: nothing behind.']);
  });

  it('sorts undated and unparseable items last, in a list that keeps several of them', async () => {
    const slack = fakeSlack();
    const undated = item({ name: 'undated-dep' });
    delete undated.change.effectiveDate;
    await notifierWith(slack).weeklyDigest([
      report([undated, dated(8), item({ name: 'garbled-dep', deadline: 'soon' }), dated(2)]),
    ]);

    const rows = slack.texts[0].split('\n').slice(1);
    expect(rows[0]).toContain('dep-2');
    expect(rows[1]).toContain('dep-8');
    expect(rows[2]).toContain('undated-dep');
    expect(rows[2]).toContain('no deadline');
    expect(rows[3]).toContain('garbled-dep');
    expect(rows[3]).toContain('no deadline');
    expect(slack.texts[0], 'the raw bad date is not shown').not.toContain('soon');
  });

  it('counts the next deadline from today, not from an overdue item', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).weeklyDigest([report([dated(-40), dated(6)])]);
    expect(slack.texts[0]).toContain(`Next deadline ${inDays(6)}.`);
    expect(slack.texts[0]).toContain(`deadline ${inDays(-40)} (passed)`);
  });

  it('says no upcoming deadline when every item is overdue or undated', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).weeklyDigest([report([dated(-1)])]);
    expect(slack.texts[0]).toContain('No upcoming deadline.');
  });

  it.each(failingAnswers)('still sends the other org after %s', async (_name, answer) => {
    const slack = fakeSlack((text) => (text.includes('*acme*') ? answer() : accepted()));
    const notifier = notifierWith(slack);
    await expect(
      notifier.weeklyDigest([report([dated(1)]), report([], 'globex/app')]),
    ).resolves.toBeUndefined();

    expect(slack.texts, slack.texts.join('\n---\n')).toHaveLength(2);
    expect(slack.texts[1]).toContain('*globex*');
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(WEBHOOK);
  });

  it('never dedupes and writes no state', async () => {
    const slack = fakeSlack();
    const notifier = notifierWith(slack);
    await notifier.weeklyDigest([report([dated(1)])]);
    await notifier.weeklyDigest([report([dated(1)])]);
    expect(slack.texts).toHaveLength(2);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe('content rule', () => {
  const sentinels = {
    quote: 'SENTINEL_SOURCE_QUOTE',
    declaredFile: 'SENTINEL_DECLARED_FILE',
    declaredText: 'SENTINEL_DECLARED_TEXT',
    callSiteFile: 'SENTINEL_CALLSITE_FILE',
    callSiteOperation: 'SENTINEL_CALLSITE_OPERATION',
    callSiteNotes: 'SENTINEL_CALLSITE_NOTES',
    dependencyNotes: 'SENTINEL_DEPENDENCY_NOTES',
    reportError: 'SENTINEL_REPORT_ERROR',
    diff: 'SENTINEL_DIFF',
    checkName: 'SENTINEL_CHECK_NAME',
    checkAfter: 'SENTINEL_CHECK_AFTER',
    version: 'SENTINEL_CURRENT_VERSION',
    fromVersion: 'SENTINEL_FROM_VERSION',
    transcript: 'SENTINEL_TRANSCRIPT_PATH',
  };

  it('sends only names, titles and links from notifyRun and weeklyDigest', async () => {
    const leaky: BehindItem = {
      repo: 'acme/api',
      dependency: {
        repo: 'acme/api',
        kind: 'sdk',
        name: 'examplepay-sdk',
        version: sentinels.version,
        declaredIn: [{ file: sentinels.declaredFile, line: 1, text: sentinels.declaredText }],
        callSites: [
          {
            file: sentinels.callSiteFile,
            line: 2,
            operation: sentinels.callSiteOperation,
            notes: sentinels.callSiteNotes,
          },
        ],
        notes: sentinels.dependencyNotes,
      },
      change: change({
        title: 'Visible title',
        effectiveDate: inDays(5),
        toVersion: 'v9',
        fromVersions: [sentinels.fromVersion],
        source: { url: 'https://docs.example.com/visible', quote: sentinels.quote },
      }),
      status: 'pr-open',
      pr: 'https://github.example/acme/api/pull/11',
    };
    const leakyReport: ScanReport = { ...report([leaky]), errors: [sentinels.reportError] };
    const leakyRecord = record({
      diff: sentinels.diff,
      checks: [{ name: sentinels.checkName, before: 'x', after: sentinels.checkAfter }],
      transcriptPath: sentinels.transcript,
      pr: leaky.pr,
    });

    const slack = fakeSlack();
    const notifier = notifierWith(slack);
    await notifier.notifyRun(runInput([leakyRecord], leakyReport));
    await notifier.weeklyDigest([leakyReport]);

    expect(
      slack.texts,
      'the check is empty unless the PR line, alert and digest all sent',
    ).toHaveLength(3);
    for (const text of slack.texts) {
      expect(text, 'positive control').toContain('Visible title');
      for (const [field, sentinel] of Object.entries(sentinels)) {
        expect(text, `${field} leaked into: ${text}`).not.toContain(sentinel);
      }
    }
    const state = await readFile(stateFile, 'utf8');
    for (const sentinel of Object.values(sentinels)) expect(state).not.toContain(sentinel);
  });
});

describe('Slack escaping', () => {
  const HOSTILE = '<!channel> & <https://evil.example|click>';
  const ESCAPED = '&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;';
  const hostile = (overrides: Partial<BehindItem> = {}) =>
    item({ title: HOSTILE, name: '<!here>', deadline: inDays(1), pr: record().pr, ...overrides });

  // The PR line, the alert and the digest, each carrying the hostile title.
  async function allTexts(entry: BehindItem) {
    const slack = fakeSlack();
    const notifier = notifierWith(slack);
    const scan = report([entry], '<!everyone>/api');
    await notifier.notifyRun(runInput([record()], scan, '<!everyone>/api'));
    await notifier.weeklyDigest([report([entry], '<!everyone>/api')]);
    expect(slack.texts).toHaveLength(3);
    return slack.texts;
  }

  it('leaves no live mrkdwn in titles, names or repos', async () => {
    for (const text of await allTexts(hostile())) {
      expect(text).toContain(ESCAPED);
      expect(text).toContain('&lt;!everyone&gt;');
      for (const tag of text.match(/<[^>]*>/g) ?? []) {
        expect(tag, `unexpected Slack control in: ${text}`).toMatch(
          /^<https:\/\/(github\.example|docs\.example\.com)\/[^|]*\|(PR|source)>$/,
        );
      }
    }
  });

  it('escapes the task id used as a fallback title', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([record({ taskId: '<!channel>' })]));
    expect(slack.texts[0]).toContain('&lt;!channel&gt;');
    expect(slack.texts[0]).not.toContain('<!channel>');
  });

  it('keeps a title from adding lines of its own', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(
      runInput([], report([item({ title: 'first\n• forged row\r\n<!channel>' })])),
    );
    expect(slack.texts[0].split('\n')).toHaveLength(2);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'not a url', 'ftp://files.example/x'])(
    'does not link the source URL %j',
    async (url) => {
      const entry = item({ deadline: inDays(1) });
      entry.change.source.url = url;
      const slack = fakeSlack();
      await notifierWith(slack).notifyRun(runInput([], report([entry])));
      await notifierWith(slack).weeklyDigest([report([entry])]);

      expect(slack.texts).toHaveLength(2);
      for (const text of slack.texts) {
        expect(text, text).not.toMatch(/<[a-z]+:/);
        expect(text, text).not.toContain('<script>');
        expect(text, 'still shown as text').toContain(
          url.replace('<', '&lt;').replace('>', '&gt;'),
        );
      }
    },
  );

  it('does not link a non-http PR URL either', async () => {
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([record({ pr: 'javascript:alert(1)' })]));
    expect(slack.texts[0]).not.toContain('<javascript');
    expect(slack.texts[0]).toContain('javascript:alert(1)');
  });

  it('stops a URL forging a label or carrying a control', async () => {
    const entry = item({ deadline: inDays(1) });
    entry.change.source.url = 'https://evil.example/a|Trusted label>&x=<!channel>';
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([], report([entry])));

    const [text] = slack.texts;
    expect(text, text).toContain('|source>');
    expect(text, text).not.toContain('|Trusted label');
    expect(text, text).not.toContain('<!channel>');
    expect(text, 'the raw ampersand is escaped').toContain('&amp;x=');
  });

  it('drops credentials embedded in a link', async () => {
    const entry = item({ deadline: inDays(1) });
    entry.change.source.url = 'https://user:hunter2@docs.example.com/changelog';
    const slack = fakeSlack();
    await notifierWith(slack).notifyRun(runInput([], report([entry])));
    expect(slack.texts[0]).not.toContain('hunter2');
    expect(slack.texts[0]).toContain('<https://docs.example.com/changelog|source>');
  });
});

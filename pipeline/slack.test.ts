import { afterEach, expect, it, vi } from 'vitest';
import { deadlineNotice, slackNotifier, workflowNotice } from './slack.ts';

const URL = 'https://hooks.slack.com/services/T000/B000/secret';

afterEach(() => vi.unstubAllGlobals());

it('is off without a webhook URL and refuses anything but a Slack incoming webhook', () => {
  expect(slackNotifier({})).toBeUndefined();
  expect(slackNotifier({ REFIT_SLACK_WEBHOOK_URL: '  ' })).toBeUndefined();
  for (const value of ['http://hooks.slack.com/services/x', 'https://example.com/services/x'])
    expect(() => slackNotifier({ REFIT_SLACK_WEBHOOK_URL: value })).toThrow(
      /must be a Slack incoming webhook URL/,
    );
});

it('posts the text and only warns, without the URL, when Slack fails', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
  vi.stubGlobal('fetch', fetcher);
  const warn = vi.fn();
  const send = slackNotifier({ REFIT_SLACK_WEBHOOK_URL: URL }, warn)!;
  await send('hello');
  expect(fetcher).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    text: 'hello',
  });
  expect(warn).not.toHaveBeenCalled();

  fetcher.mockResolvedValueOnce(new Response('no', { status: 404 }));
  await send('hello');
  fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
  await send('hello');
  expect(warn.mock.calls).toEqual([
    ['Slack notification not sent: Slack returned HTTP 404.'],
    ['Slack notification not sent: fetch failed.'],
  ]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
});

it('notifies only new drafts, regressions and publication failures', () => {
  const base = { repository: 'o/r', stage: 'validation', reason: 'r', error: null };
  expect(workflowNotice({ ...base, status: 'validated' })).toBeNull();
  expect(workflowNotice({ ...base, status: 'existing-pr' })).toBeNull();
  expect(workflowNotice({ ...base, status: 'needs-review' })).toBeNull();
  expect(
    workflowNotice({ ...base, status: 'validation-failed', validation: 'baseline-failed' }),
  ).toBeNull();
  expect(workflowNotice({ ...base, status: 'error' })).toBeNull();
  expect(
    workflowNotice({
      ...base,
      repository: '<!channel>',
      status: 'error',
      stage: 'publication',
      error: { message: `a\n${'x'.repeat(300)}` },
    }),
  ).toBe(
    `🚨 [URGENT] &lt;!channel&gt;: publication failed partway (a ${'x'.repeat(197)}…); a remote branch or draft PR may remain, reconcile before retrying.`,
  );
});

it('marks deadline alerts urgent from seven days out', () => {
  const alert = { repository: 'o/r', title: 'Sunset', timing: '7 days left', issue: 4 };
  expect(deadlineNotice({ ...alert, stage: 30 })).toBeNull();
  expect(deadlineNotice({ ...alert, stage: 7 })).toBe(
    '🚨 [URGENT] o/r: Sunset (7 days left); https://github.com/o/r/issues/4',
  );
  expect(deadlineNotice({ ...alert, stage: 0, timing: 'today', issue: null })).toBe(
    '🚨 [URGENT] o/r: Sunset (today); the GitHub issue could not be updated',
  );
});

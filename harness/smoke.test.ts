import { describe, expect, it, vi } from 'vitest';
import { repoTask, type DeadApiEntry } from './findings.ts';
import { liveSmoke, sampled } from './smoke.ts';

const entry = (provider: string, replacement: string): DeadApiEntry => ({
  id: provider,
  provider,
  what: 'an old model',
  diedOn: '2026-01-01',
  source: { url: 'https://example.com', checkedOn: '2026-11-04' },
  lookFor: [],
  matchers: [],
  replacement,
  requires: [],
});
const task = (entries: DeadApiEntry[]) =>
  repoTask(
    'acme/app',
    {
      findings: entries.map((e) => ({ entryId: e.id, file: 'a', line: 1, matchClass: 'live' })),
      unlistedProviders: [],
      clean: false,
    },
    entries,
  );

describe('liveSmoke', () => {
  it('logs a provider with no key, and calls nothing', async () => {
    const send = vi.fn();
    const results = await liveSmoke(task([entry('groq', 'Use `openai/gpt-oss-120b`')]), {
      env: {},
      fetch: send,
      rate: 1,
    });
    expect(results).toEqual([
      {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        outcome: 'no-key',
        detail: 'GROQ_API_KEY is not set here',
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a real answer and a refusal, and only a 2xx counts as answered', async () => {
    const send = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('anthropic')
        ? new Response('{}', { status: 200 })
        : new Response('{}', { status: 404 }),
    );
    const results = await liveSmoke(
      task([entry('anthropic', 'claude-sonnet-5-5'), entry('gemini', '`gemini-3.6-flash`')]),
      {
        env: { ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k' },
        fetch: send as typeof fetch,
        rate: 1,
      },
    );
    expect(results.map((result) => result.outcome)).toEqual(['answered', 'refused']);
  });

  it('skips repos outside the sample and providers with no model call', async () => {
    const send = vi.fn();
    expect(
      await liveSmoke(task([entry('anthropic', 'claude-sonnet-5-5')]), { rate: 0, fetch: send }),
    ).toEqual([]);
    expect(
      await liveSmoke(task([entry('stripe', 'subscription.items.data[]')]), {
        rate: 1,
        fetch: send,
      }),
    ).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(sampled('acme/app', 1)).toBe(true);
    expect(sampled('acme/app', 0)).toBe(false);
  });
});

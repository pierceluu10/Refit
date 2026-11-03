import { describe, expect, it } from 'vitest';
import { FakeModelClient } from '../reviewer/model.ts';
import { baselinePrompt, judge, passesChecks, refitIsA } from './baseline.ts';

describe('passesChecks', () => {
  const own = new Set(['typecheck', 'build']);
  const diff = 'diff --git a/a.ts b/a.ts';

  it('passes a real diff that keeps the own checks green', () => {
    const checks = [
      { name: 'typecheck', before: 'pass', after: 'pass' },
      { name: 'build', before: 'pass', after: 'pass' },
    ];
    expect(passesChecks(diff, checks, own)).toBe(true);
    expect(passesChecks('', checks, own)).toBe(false);
  });

  it('fails an own check that newly fails, and ignores checks an agent added', () => {
    expect(passesChecks(diff, [{ name: 'build', before: 'pass', after: 'fail (1)' }], own)).toBe(
      false,
    );
    const withAgentCheck = [
      { name: 'build', before: 'pass', after: 'pass' },
      { name: 'agent-test', before: 'fail (1)', after: 'fail (2)' },
    ];
    expect(passesChecks(diff, withAgentCheck, own)).toBe(true);
  });
});

describe('baselinePrompt', () => {
  it('names no provider, change or repo detail: plain Claude finds them itself', () => {
    const prompt = baselinePrompt('2026-11-03');
    expect(prompt).toContain('Today is 2026-11-03.');
    expect(prompt).toContain('Find the external APIs and SDKs this repository uses.');
    expect(prompt).not.toMatch(/stripe|openai|anthropic|gemini/i);
  });
});

describe('judge', () => {
  const side = (change: string) => ({
    handled: [{ change, correct: true, note: '' }],
    breaks: [],
  });

  it('maps A and B back to Refit and Claude whichever order the repo got', async () => {
    for (const repo of ['acme/one', 'acme/two', 'acme/three', 'acme/four']) {
      const client = new FakeModelClient(
        JSON.stringify({
          a: side('change A'),
          b: side('change B'),
          better: 'A',
          why: 'A is better',
        }),
      );
      const result = await judge(
        client,
        repo,
        { text: 'first side', diff: 'first diff' },
        { text: 'second side', diff: 'second diff' },
      );
      const aIsRefit = refitIsA(repo);
      expect(result.better).toBe(aIsRefit ? 'refit' : 'claude');
      expect(result.refit.handled[0]?.change).toBe(aIsRefit ? 'change A' : 'change B');
      // The prompt never says which attempt is Refit.
      expect(client.requests[0]?.prompt).not.toMatch(/refit|claude/i);
    }
  });
});

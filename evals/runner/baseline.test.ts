import { describe, expect, it } from 'vitest';
import { baselinePrompt, passesChecks } from './baseline.ts';

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
    expect(
      passesChecks(
        diff,
        [
          { name: 'build', before: 'pass', after: 'pass' },
          { name: 'agent-test', before: 'fail (1)', after: 'fail (2)' },
        ],
        own,
      ),
    ).toBe(true);
  });

  it('allows a fallback check that fails no worse than before', () => {
    const checks = [
      { name: 'typecheck', before: 'fail (3)', after: 'fail (3)' },
      { name: 'build', before: 'pass', after: 'pass' },
    ];
    expect(passesChecks(diff, checks, own)).toBe(true);
    expect(passesChecks(diff, [{ ...checks[0]!, after: 'fail (4)' }, checks[1]!], own)).toBe(false);
  });
});

describe('baselinePrompt', () => {
  it('gives the change and its source, and nothing of Refit', () => {
    const prompt = baselinePrompt({
      provider: 'stripe',
      id: 'node-23',
      kind: 'sdk-major',
      title: 'stripe-node 23.0.0',
      source: { url: 'https://example.com/changelog', quote: 'Removes X.' },
      affects: {},
    });
    expect(prompt).toContain('stripe-node 23.0.0');
    expect(prompt).toContain('> Removes X.');
    expect(prompt).toContain('Update the repository for this change.');
  });
});

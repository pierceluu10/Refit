import { describe, expect, it } from 'vitest';
import { FakeModelClient } from '../reviewer/model.ts';
import {
  baselinePrompt,
  judge,
  passesChecks,
  refitIsA,
  syntaxCheck,
  unredact,
} from './baseline.ts';

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

describe('syntaxCheck', () => {
  it('checks JavaScript, Python and JSON files, and skips what it has no cheap check for', () => {
    expect(syntaxCheck('src/app.mjs')?.command).toBe("node --check 'src/app.mjs'");
    expect(syntaxCheck('bot/main.py')?.command).toBe("python3 -m py_compile 'bot/main.py'");
    expect(syntaxCheck('package.json')?.command).toContain('JSON.parse');
    expect(syntaxCheck('tsconfig.json')).toBeUndefined();
    expect(syntaxCheck('src/app.ts')).toBeUndefined();
    expect(syntaxCheck("it's.js")?.command).toBe("node --check 'it'\\''s.js'");
  });
});

describe('unredact', () => {
  it("restores the repo's own lines the scrubber rewrote, and keeps an added line as recorded", () => {
    const original = [
      'const s3 = new S3({',
      '  accessKeyId: process.env.R2_ACCESS_KEY_ID,',
      '  region: "auto",',
      '});',
    ];
    const diff = [
      'diff --git a/lib/r2.ts b/lib/r2.ts',
      '--- a/lib/r2.ts',
      '+++ b/lib/r2.ts',
      '@@ -1,4 +1,4 @@',
      ' const s3 = new S3({',
      '   accessKeyId: [redacted],',
      '-  region: "auto",',
      '+  region: "[redacted]",',
      ' });',
    ].join('\n');
    const restored = unredact(diff, (file) => (file === 'lib/r2.ts' ? original : undefined));
    expect(restored).toContain('   accessKeyId: process.env.R2_ACCESS_KEY_ID,');
    expect(restored).toContain('-  region: "auto",');
    expect(restored).toContain('+  region: "[redacted]",');
  });
});

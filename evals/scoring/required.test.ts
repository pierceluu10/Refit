import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeChange, majorUpgrades, proveLock, type RepoLock } from './required.ts';

const lock: RepoLock = {
  repo: 'acme/app',
  commit: 'abc',
  required: [
    {
      id: 'R1',
      entryId: 'gemini-1',
      file: 'llm.ts',
      dead: 'gemini-2\\.0-flash',
      alive: ['gemini-3\\.6-flash'],
      proof: { from: 'gemini-2.0-flash', to: 'gemini-3.6-flash' },
    },
  ],
};

const repo = (text: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'required-'));
  writeFileSync(path.join(dir, 'llm.ts'), text);
  return dir;
};

describe('required changes', () => {
  const [change] = lock.required;

  it('needs the dead code gone and the replacement there', () => {
    expect(gradeChange(repo("model = 'gemini-2.0-flash'"), change).fixed).toBe(false);
    expect(gradeChange(repo("model = 'gemini-3.6-flash'"), change).fixed).toBe(true);
    expect(gradeChange(repo("model = 'made-up-model'"), change)).toMatchObject({
      fixed: false,
      why: 'dead code gone, but no replacement from the list',
    });
  });

  it('proves a sound lock', () => {
    expect(proveLock(repo("model = 'gemini-2.0-flash'"), lock)).toEqual([]);
  });

  it('flags a change that already passes, and a proof that cannot apply', () => {
    expect(proveLock(repo("model = 'gemini-3.6-flash'"), lock)).toEqual([
      'R1 passes at baseline',
      'R1: proof edit not found',
    ]);
  });
});

describe('majorUpgrades', () => {
  const diff = (old: string, next: string, file = 'package.json') =>
    `diff --git a/${file} b/${file}\n-    "stripe": "${old}",\n+    "stripe": "${next}",\n`;

  it('names a package moved across a major, and nothing else', () => {
    expect(majorUpgrades(diff('^14.0.0', '^18.2.0'))).toEqual(['stripe ^14.0.0 -> ^18.2.0']);
    expect(majorUpgrades(diff('^14.0.0', '^14.9.0'))).toEqual([]);
    expect(majorUpgrades(diff('^14.0.0', '^18.2.0', 'src/a.ts'))).toEqual([]);
    expect(majorUpgrades(diff('^14.0.0', '^18.2.0', 'web/package.json'))).toHaveLength(1);
  });
});

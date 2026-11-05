import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoTask } from '../../harness/findings.ts';
import { SqliteMemoryStore } from '../../memory/index.ts';
import type { RepoLock } from '../scoring/required.ts';
import { feed, memoryOn } from './learning.ts';

const entry = (id: string) => ({
  id,
  provider: 'gemini',
  what: id,
  diedOn: '2026-06-01',
  source: { url: 'https://example.com', checkedOn: '2026-11-04' },
  lookFor: [],
  matchers: [],
  replacement: 'gemini-3.6-flash',
  requires: [],
});

const lock = (repo: string): RepoLock => ({
  repo,
  commit: 'abc',
  required: [
    {
      id: 'R1',
      entryId: 'gemini-1',
      file: 'a.ts',
      dead: 'x',
      alive: [],
      proof: { from: 'x', to: 'y' },
    },
    {
      id: 'R2',
      entryId: 'other',
      file: 'a.ts',
      dead: 'y',
      alive: [],
      proof: { from: 'y', to: 'z' },
    },
  ],
});

function round(repos: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'aptitude-learning-'));
  const results = repos.map((repo) => {
    const scan = {
      findings: [{ entryId: 'gemini-1', file: 'a.ts', line: 1, matchClass: 'live' as const }],
      unlistedProviders: [],
      clean: false,
    };
    mkdirSync(join(dir, repo.replace('/', '__')));
    writeFileSync(
      join(dir, repo.replace('/', '__'), 'task.json'),
      JSON.stringify(repoTask(repo, scan, [entry('gemini-1'), entry('other')])),
    );
    return {
      repo,
      commit: 'abc',
      outcome: 'verified',
      // R1 passed and R2 did not, so only the first entry counts.
      required: [
        { id: 'R1', fixed: true, why: '' },
        { id: 'R2', fixed: false, why: '' },
      ],
      costUsd: 0.1,
      durationMs: 1,
      record: {
        taskId: `${repo}:dead-apis`,
        outcome: 'verified',
        diff: '+x',
        checks: [],
        costUsd: 0.1,
        transcriptPath: '',
        rescan: { findings: [], unlistedProviders: [], clean: true },
      },
    };
  });
  const file = join(dir, 'results.json');
  writeFileSync(file, JSON.stringify(results));
  return file;
}

describe('the memory test', () => {
  it('counts a locked test only for what passed, and lets benchmark evidence open a proven fix', async () => {
    const store = new SqliteMemoryStore(
      join(mkdtempSync(join(tmpdir(), 'aptitude-store-')), 'test.sqlite'),
    );
    const repos = ['acme/a', 'acme/b', 'acme/c'];
    expect(await feed([round(repos)], repos.map(lock), store)).toBe(3);

    const ladder = await store.listLadder();
    expect(ladder.find((e) => e.entryId === 'gemini-1')).toMatchObject({
      level: 'new',
      benchmarkLevel: 'proven',
    });

    const task = repoTask(
      'acme/fresh',
      {
        findings: [{ entryId: 'gemini-1', file: 'a.ts', line: 1, matchClass: 'live' }],
        unlistedProviders: [],
        clean: false,
      },
      [entry('gemini-1')],
    );
    const fixes = await memoryOn(store).provenFixes(task);
    expect(fixes.map((fix) => fix.entryId)).toEqual(['gemini-1']);
  });
});

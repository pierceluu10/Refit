#!/usr/bin/env node
// Does memory help? From the same commits, on fresh repos, one session with memory on and one with it
// off. The order varies by repo, a repo that fed the memory can't be tested, and each arm's diff is
// written under a shuffled label, so a grader who hasn't seen the key can compare them blind.
//   node evals/runner/learning.ts feed <results.json>... --memory <dir>
//   APTITUDE_AI_BUDGET_USD=5 node evals/runner/learning.ts test <lock.json> <out> --memory <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isRepoTask, providersOf, type RepoTask } from '../../harness/findings.ts';
import { budgetFromEnv } from '../../harness/index.ts';
import {
  learnFromRun,
  LocalEmbedder,
  provenAllowed,
  recipesForEntries,
  recordEvidence,
  SqliteMemoryStore,
} from '../../memory/index.ts';
import { loadProvenFixes } from '../../providers/toolkit/proven.ts';
import type { MigrationTask } from '../../shared/types.ts';
import type { RepoLock } from '../scoring/required.ts';
import { runRepoLock, type SessionResult } from './session-run.ts';

const OWNER = 'benchmark';
const stable = (text: string) => createHash('sha256').update(text).digest();

// Stores a round's runs as evidence. A run counts only if every locked change passed, and that
// stand-in for a merge stays labelled: nothing here can ever be proven for a customer.
export async function feed(files: string[], store: SqliteMemoryStore) {
  const embedder = new LocalEmbedder();
  let fed = 0;
  for (const file of files) {
    for (const result of JSON.parse(readFileSync(file, 'utf8')) as SessionResult[]) {
      if (!result.record) continue;
      const task = JSON.parse(
        readFileSync(
          path.join(path.dirname(file), result.repo.replace('/', '__'), 'task.json'),
          'utf8',
        ),
      ) as RepoTask;
      const { run } = await learnFromRun(
        { task, record: result.record, commit: result.commit },
        { store, embedder },
      );
      if (result.required.every((change) => change.fixed)) {
        await recordEvidence(run.id, { lockedTest: true }, { store, embedder });
      }
      fed += 1;
    }
  }
  return fed;
}

// The memory a real run would get, for one repo. Benchmark evidence may stand in for merges here.
export function memoryOn(store: SqliteMemoryStore) {
  return {
    provenFixes: async (task: RepoTask) => {
      const runs = await store.listRuns();
      const ladder = await store.listLadder();
      const allowed = task.entries
        .map((entry) => entry.id)
        .filter((id) =>
          provenAllowed(
            ladder.find((entry) => entry.entryId === id),
            runs,
            { benchmark: true },
          ),
        );
      return loadProvenFixes(providersOf(task), allowed);
    },
    retrieveRecipes: async (task: MigrationTask) =>
      recipesForEntries(isRepoTask(task) ? task.entries.map((entry) => entry.id) : [], store),
  };
}

async function test(lockFile: string, outDir: string, store: SqliteMemoryStore) {
  const capUsd = budgetFromEnv();
  const locks = JSON.parse(readFileSync(lockFile, 'utf8')) as RepoLock[];
  const fedBy = new Set((await store.listRuns()).map((run) => run.task.repo));
  for (const { repo } of locks) {
    if (fedBy.has(repo)) throw new Error(`${repo} fed this memory, so it can't test it`);
  }
  mkdirSync(outDir, { recursive: true });
  const key: Record<string, { A: string; B: string }> = {};
  const rows: (SessionResult & { arm: string })[] = [];
  let spentUsd = 0;
  for (const lock of locks) {
    const first = (stable(`order:${lock.repo}`)[0] as number) % 2 === 0 ? 'on' : 'off';
    const arms = first === 'on' ? ['on', 'off'] : ['off', 'on'];
    const label = (stable(`label:${lock.repo}`)[0] as number) % 2 === 0;
    key[lock.repo] = label ? { A: 'on', B: 'off' } : { A: 'off', B: 'on' };
    for (const arm of arms) {
      if (spentUsd + 1 > capUsd) throw new Error(`stopped: $${spentUsd.toFixed(2)} of $${capUsd}`);
      const armDir = path.join(outDir, arm);
      const result = await runRepoLock(lock, armDir, arm === 'on' ? memoryOn(store) : {});
      spentUsd += result.costUsd;
      rows.push({ ...result, arm });
      const blind = key[lock.repo]?.A === arm ? 'A' : 'B';
      const blindDir = path.join(outDir, 'blind', lock.repo.replace('/', '__'));
      mkdirSync(blindDir, { recursive: true });
      writeFileSync(path.join(blindDir, `${blind}.diff`), result.record?.diff ?? '');
      const fixed = result.required.filter((change) => change.fixed).length;
      console.log(
        `${arm.padEnd(4)} ${result.outcome.padEnd(12)} ${lock.repo} fixed ${fixed}/${lock.required.length} $${result.costUsd.toFixed(4)} ${(result.durationMs / 1000).toFixed(0)}s ${result.record?.provenFixes ? 'proven' : ''} ${result.error ?? ''}`,
      );
      writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`);
    }
  }
  writeFileSync(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  for (const arm of ['on', 'off']) {
    const mine = rows.filter((row) => row.arm === arm);
    const required = mine.flatMap((row) => row.required);
    const fixed = required.filter((change) => change.fixed).length;
    const usd = mine.reduce((sum, row) => sum + row.costUsd, 0);
    console.log(`${arm}: ${fixed}/${required.length} fixed, $${usd.toFixed(4)}`);
  }
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { memory: { type: 'string' } },
  });
  if (!values.memory) throw new Error('--memory <dir> is required');
  const store = SqliteMemoryStore.forOwner(values.memory, OWNER);
  const [command, ...rest] = positionals;
  if (command === 'feed') console.log(`fed ${await feed(rest, store)} run(s)`);
  else if (command === 'test') await test(rest[0] as string, rest[1] as string, store);
  else throw new Error('usage: learning.ts feed|test ...');
}

if (process.argv[1] === import.meta.filename) await main(process.argv.slice(2));

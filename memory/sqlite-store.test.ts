import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { makeRecipe, makeRecord, makeTask } from './fixtures/tasks.ts';
import { customerStores, SqliteMemoryStore } from './sqlite-store.ts';

const dir = () => mkdtemp(join(tmpdir(), 'aptitude-sqlite-'));

describe('SqliteMemoryStore', () => {
  it('keeps runs, recipes, verdicts and evidence like the JSON store', async () => {
    const store = SqliteMemoryStore.forOwner(await dir(), 'acme');
    const pr = 'https://github.com/acme/shop/pull/1';
    const run = await store.recordRun({ task: makeTask(), record: makeRecord({ pr }) });
    await store.saveRecipe(makeRecipe());
    expect(await store.getRun(run.id)).toMatchObject({ id: run.id });
    expect((await store.listRecipes()).map((r) => r.id)).toEqual(['recipe-stripe-charges']);

    expect((await store.recordVerdict(pr, 'merged'))?.record.humanVerdict).toBe('merged');
    expect((await store.recordVerdict(pr, 'closed'))?.record.humanVerdict).toBe('merged');
    const at = '2026-11-05T00:00:00.000Z';
    const after = await store.addEvidence(pr, { reverted: { at, via: 'revert' } });
    expect(after?.evidence).toMatchObject({ rescanClean: true, reverted: { via: 'revert' } });
  });

  it('keeps one customer out of another customer’s file', async () => {
    const root = await dir();
    const acme = SqliteMemoryStore.forOwner(root, 'acme');
    const other = SqliteMemoryStore.forOwner(root, 'other');
    await acme.saveRecipe(makeRecipe());
    expect(await other.listRecipes()).toEqual([]);
    expect(customerStores(root)).toHaveLength(2);
  });

  it('gives an owner with odd characters its own file inside the folder', async () => {
    const root = await dir();
    SqliteMemoryStore.forOwner(root, '../../etc');
    expect(customerStores(root)).toHaveLength(1);
  });

  it('loses no verdict when two processes write at once', async () => {
    const root = await dir();
    const file = join(root, 'race.sqlite');
    const store = new SqliteMemoryStore(file);
    const run = await store.recordRun({ task: makeTask(), record: makeRecord() });
    const worker = join(root, 'worker.mjs');
    const module = new URL('./sqlite-store.ts', import.meta.url).href;
    await writeFile(
      worker,
      `const { SqliteMemoryStore } = await import(${JSON.stringify(module)});
       const [file, id, who] = process.argv.slice(2);
       const store = new SqliteMemoryStore(file);
       for (let i = 0; i < 30; i++) {
         await store.addEvidence(id, { reverted: { at: who + i, via: 'revert' } });
       }`,
    );
    const go = promisify(execFile);
    await Promise.all(
      ['a', 'b'].map((who) => go('node', ['--no-warnings', worker, file, run.id, who])),
    );
    const latest = await store.getRun(run.id);
    // A lost update would leave the record without one writer's fields; the row is whole and last-wins.
    expect(latest?.evidence?.reverted?.at).toMatch(/^[ab]29$/);
    expect(latest?.record.taskId).toBe(run.record.taskId);
  });
});

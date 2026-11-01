import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import type { HumanVerdict, MemoryRecipe, SelfEvalReport, StoredRun } from './types.ts';

// Everything memory/ persists. Async throughout so a Postgres implementation can drop in.
export interface MemoryStore {
  recordRun(input: {
    task: MigrationTask;
    record: RunRecord;
    transcript?: string;
    usedRecipeIds?: string[];
  }): Promise<StoredRun>;
  saveRun(run: StoredRun): Promise<void>;
  getRun(id: string): Promise<StoredRun | undefined>;
  listRuns(): Promise<StoredRun[]>;
  // Matches by run id or by PR URL, since the GitHub App only knows the PR.
  recordVerdict(runIdOrPr: string, verdict: HumanVerdict): Promise<StoredRun | undefined>;

  saveRecipe(recipe: MemoryRecipe): Promise<void>;
  getRecipe(id: string): Promise<MemoryRecipe | undefined>;
  listRecipes(): Promise<MemoryRecipe[]>;

  saveSelfEval(report: SelfEvalReport): Promise<void>;
  listSelfEvals(): Promise<SelfEvalReport[]>;
  getSelfEvalTaskIds(): Promise<string[] | undefined>;
  setSelfEvalTaskIds(ids: string[]): Promise<void>;
}

type Collection = 'runs' | 'recipes' | 'selfevals';

// Local JSON: one file per item under <dir>/<collection>/, written atomically.
export class JsonMemoryStore implements MemoryStore {
  constructor(readonly dir: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JsonMemoryStore {
    return new JsonMemoryStore(
      env.APTITUDE_MEMORY_DIR ?? join(process.cwd(), '.aptitude', 'memory'),
    );
  }

  async recordRun({
    task,
    record,
    transcript,
    usedRecipeIds = [],
  }: Parameters<MemoryStore['recordRun']>[0]): Promise<StoredRun> {
    const run: StoredRun = {
      id: `${record.taskId}-${randomUUID().slice(0, 8)}`,
      recordedAt: new Date().toISOString(),
      task,
      record,
      transcript: transcript ?? (await readTranscript(record.transcriptPath)),
      usedRecipeIds,
    };
    await this.write('runs', run.id, run);
    return run;
  }

  saveRun(run: StoredRun) {
    return this.write('runs', run.id, run);
  }

  getRun(id: string) {
    return this.read<StoredRun>('runs', id);
  }

  listRuns() {
    return this.list<StoredRun>('runs');
  }

  async recordVerdict(runIdOrPr: string, verdict: HumanVerdict) {
    const run =
      (await this.getRun(runIdOrPr)) ??
      (await this.listRuns())
        .filter((candidate) => candidate.record.pr === runIdOrPr)
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
        .at(-1);
    if (!run) return undefined;
    run.record = { ...run.record, humanVerdict: verdict };
    await this.write('runs', run.id, run);
    return run;
  }

  saveRecipe(recipe: MemoryRecipe) {
    return this.write('recipes', recipe.id, recipe);
  }

  getRecipe(id: string) {
    return this.read<MemoryRecipe>('recipes', id);
  }

  listRecipes() {
    return this.list<MemoryRecipe>('recipes');
  }

  saveSelfEval(report: SelfEvalReport) {
    return this.write('selfevals', report.id, report);
  }

  listSelfEvals() {
    return this.list<SelfEvalReport>('selfevals');
  }

  async getSelfEvalTaskIds() {
    return readJson<string[]>(join(this.dir, 'selfeval-tasks.json'));
  }

  async setSelfEvalTaskIds(ids: string[]) {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(join(this.dir, 'selfeval-tasks.json'), ids);
  }

  private async write(collection: Collection, id: string, value: unknown) {
    await mkdir(join(this.dir, collection), { recursive: true });
    await atomicWrite(join(this.dir, collection, `${fileName(id)}.json`), value);
  }

  private read<T>(collection: Collection, id: string) {
    return readJson<T>(join(this.dir, collection, `${fileName(id)}.json`));
  }

  // Sorted by file name, which is stable across runs; callers sort by date where order matters.
  private async list<T>(collection: Collection): Promise<T[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.dir, collection))).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items = await Promise.all(
      names.sort().map((name) => readJson<T>(join(this.dir, collection, name))),
    );
    return items.filter((item) => item !== undefined);
  }
}

// Ids come from tasks and PRs, so escape anything that could leave the folder ("../", "/").
function fileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, (char) => `~${char.charCodeAt(0).toString(16)}`);
}

async function atomicWrite(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readTranscript(path: string): Promise<string> {
  if (!path) return '';
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

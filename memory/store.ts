import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, ScanReport } from '../shared/types.ts';
import type {
  AnyTask,
  HumanVerdict,
  MemoryRecipe,
  SelfEvalReport,
  StoredRun,
  StoredScan,
} from './types.ts';

// Everything memory/ persists. Async throughout so a Postgres implementation can drop in.
export interface MemoryStore {
  recordRun(input: {
    task: AnyTask;
    record: RunRecord;
    transcript?: string;
    usedRecipeIds?: string[];
    commit?: string;
  }): Promise<StoredRun>;
  saveRun(run: StoredRun): Promise<void>;
  getRun(id: string): Promise<StoredRun | undefined>;
  listRuns(): Promise<StoredRun[]>;
  // Matches by run id or by PR URL, since the GitHub App only knows the PR. 'merged' is final, since a
  // merged PR can't be reopened, and a late 'edited' never replaces 'closed': GitHub can deliver an
  // event after a later one, and a redelivery can replay an old one. `finalDiff`, when the app sends
  // it, is the PR's diff after a human's edits; it is kept as the run's humanDiff.
  recordVerdict(
    runIdOrPr: string,
    verdict: HumanVerdict,
    finalDiff?: string,
  ): Promise<StoredRun | undefined>;

  saveRecipe(recipe: MemoryRecipe): Promise<void>;
  getRecipe(id: string): Promise<MemoryRecipe | undefined>;
  listRecipes(): Promise<MemoryRecipe[]>;

  saveSelfEval(report: SelfEvalReport): Promise<void>;
  listSelfEvals(): Promise<SelfEvalReport[]>;
  getSelfEvalTaskIds(): Promise<string[] | undefined>;
  setSelfEvalTaskIds(ids: string[]): Promise<void>;

  // Every scan's report, for the dashboard's "what's behind" history.
  saveScan(report: ScanReport): Promise<StoredScan>;
  listScans(): Promise<StoredScan[]>;
}

type Collection = 'runs' | 'recipes' | 'selfevals' | 'scans';

// Local JSON: one file per item under <dir>/<collection>/, written atomically.
export class JsonMemoryStore implements MemoryStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JsonMemoryStore {
    return new JsonMemoryStore(env.REFIT_MEMORY_DIR ?? join(process.cwd(), '.refit', 'memory'));
  }

  async recordRun({
    task,
    record,
    transcript,
    usedRecipeIds = [],
    commit,
  }: Parameters<MemoryStore['recordRun']>[0]): Promise<StoredRun> {
    const run: StoredRun = {
      id: `${record.taskId}-${randomUUID().slice(0, 8)}`,
      recordedAt: new Date().toISOString(),
      task,
      record,
      transcript: transcript ?? (await readTranscript(record.transcriptPath)),
      usedRecipeIds,
      ...(commit && { commit }),
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

  async recordVerdict(runIdOrPr: string, verdict: HumanVerdict, finalDiff?: string) {
    const run =
      (await this.getRun(runIdOrPr)) ??
      (await this.listRuns())
        .filter((candidate) => candidate.record.pr === runIdOrPr)
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
        .at(-1);
    if (!run) return undefined;
    const current = run.record.humanVerdict;
    if (current === 'merged' || (current === 'closed' && verdict === 'edited')) return run;
    run.record = { ...run.record, humanVerdict: verdict };
    // A close carries no diff worth learning from; a merge or an edit does.
    if (finalDiff?.trim() && verdict !== 'closed') run.humanDiff = finalDiff;
    await this.write('runs', run.id, run);
    return run;
  }

  async saveScan(report: ScanReport): Promise<StoredScan> {
    const scan: StoredScan = { ...report, id: `${report.repo}@${report.scannedAt}` };
    await this.write('scans', scan.id, scan);
    return scan;
  }

  listScans() {
    return this.list<StoredScan>('scans');
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

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import type { RepoHabits } from './habits.ts';
import type { LadderEntry } from './ladder.ts';
import type {
  FixEvidence,
  HumanVerdict,
  MemoryRecipe,
  SelfEvalReport,
  StoredRun,
} from './types.ts';

// Everything memory/ persists. Async throughout so a Postgres implementation can drop in.
export interface MemoryStore {
  recordRun(input: {
    task: MigrationTask;
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
  // event after a later one, and a redelivery can replay an old one.
  recordVerdict(runIdOrPr: string, verdict: HumanVerdict): Promise<StoredRun | undefined>;
  addEvidence(runIdOrPr: string, evidence: FixEvidence): Promise<StoredRun | undefined>;

  saveRecipe(recipe: MemoryRecipe): Promise<void>;
  getRecipe(id: string): Promise<MemoryRecipe | undefined>;
  listRecipes(): Promise<MemoryRecipe[]>;

  getHabits(repo: string): Promise<RepoHabits | undefined>;
  saveHabits(habits: RepoHabits): Promise<void>;
  saveLadder(entry: LadderEntry): Promise<void>;
  listLadder(): Promise<LadderEntry[]>;

  saveSelfEval(report: SelfEvalReport): Promise<void>;
  listSelfEvals(): Promise<SelfEvalReport[]>;
  getSelfEvalTaskIds(): Promise<string[] | undefined>;
  setSelfEvalTaskIds(ids: string[]): Promise<void>;
}

// The plain verdict the app sends today, as evidence, until its P7 evidence arrives.
const verdictEvidence = (verdict: HumanVerdict, at = new Date().toISOString()): FixEvidence =>
  verdict === 'merged'
    ? { merged: { at } }
    : verdict === 'closed'
      ? { closed: { at } }
      : { edited: true };

// Fields that may move on after they were first set: a later revert, a merge that now has its diff.
const keepNew = (old: FixEvidence = {}, fresh: FixEvidence): FixEvidence => ({
  ...(fresh.reverted ? { reverted: fresh.reverted } : {}),
  ...(fresh.merged?.humanDiff && !old.merged?.humanDiff ? { merged: fresh.merged } : {}),
  ...(fresh.closed?.comment && !old.closed?.comment ? { closed: fresh.closed } : {}),
});

// A repo session's record carries its last rescan.
const rescanEvidence = (record: RunRecord) => {
  const { rescan } = record as RunRecord & { rescan?: { clean: boolean } };
  return rescan ? { evidence: { rescanClean: rescan.clean } } : {};
};

export type Collection = 'runs' | 'recipes' | 'selfevals' | 'habits' | 'ladder';

// Local JSON: one file per item under <dir>/<collection>/, written atomically.
export class JsonMemoryStore implements MemoryStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

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
      ...rescanEvidence(record),
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
    const run = await this.findRun(runIdOrPr);
    if (!run) return undefined;
    return this.update<StoredRun>('runs', run.id, (latest = run) => {
      const current = latest.record.humanVerdict;
      if (current === 'merged' || (current === 'closed' && verdict === 'edited')) return latest;
      return {
        ...latest,
        record: { ...latest.record, humanVerdict: verdict },
        evidence: { ...latest.evidence, ...verdictEvidence(verdict) },
      };
    });
  }

  async addEvidence(runIdOrPr: string, evidence: FixEvidence) {
    const run = await this.findRun(runIdOrPr);
    if (!run) return undefined;
    // A close or merge is once; a redelivered webhook keeps the first.
    return this.update<StoredRun>('runs', run.id, (latest = run) => ({
      ...latest,
      evidence: { ...evidence, ...latest.evidence, ...keepNew(latest.evidence, evidence) },
    }));
  }

  // One read-change-write. A store that several processes share makes this a transaction.
  protected async update<T>(
    collection: Collection,
    id: string,
    change: (value: T | undefined) => T,
  ): Promise<T> {
    const value = change(await this.read<T>(collection, id));
    await this.write(collection, id, value);
    return value;
  }

  private async findRun(runIdOrPr: string) {
    return (
      (await this.getRun(runIdOrPr)) ??
      (await this.listRuns())
        .filter((candidate) => candidate.record.pr === runIdOrPr)
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
        .at(-1)
    );
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

  getHabits(repo: string) {
    return this.read<RepoHabits>('habits', repo);
  }

  saveHabits(habits: RepoHabits) {
    return this.write('habits', habits.repo, habits);
  }

  saveLadder(entry: LadderEntry) {
    return this.write('ladder', entry.entryId, entry);
  }

  listLadder() {
    return this.list<LadderEntry>('ladder');
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

  protected async write(collection: Collection, id: string, value: unknown) {
    await mkdir(join(this.dir, collection), { recursive: true });
    await atomicWrite(join(this.dir, collection, `${fileName(id)}.json`), value);
  }

  protected read<T>(collection: Collection, id: string): Promise<T | undefined> {
    return readJson<T>(join(this.dir, collection, `${fileName(id)}.json`));
  }

  // Sorted by file name, which is stable across runs; callers sort by date where order matters.
  protected async list<T>(collection: Collection): Promise<T[]> {
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

import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { JsonAuditStore, repoFileName } from '../compliance/audit.ts';
import type { MemoryRecipe, SelfEvalReport, StoredRun, StoredScan } from '../memory/types.ts';
import { writeJsonAtomic } from './queue.ts';
import type { ReportStore } from './reports.ts';
import type { ForgetJob } from './types.ts';

const JSON_EXTENSION = '.json';
const RUN_FOLDER_PREFIX = 'refit-run-';
const SELF_EVAL_TASKS = 'selfeval-tasks.json';

export type IsForgotten = (repo: string) => boolean;

export type ForgetDeps = {
  reports: ReportStore;
  memoryDir: string;
  auditDir: string;
  runLog: string; // the orchestrator's JSON-lines run log
  scanReportDir: string; // the orchestrator's copy of each scan report
  forgetNotified: (isForgotten: IsForgotten) => Promise<void>;
  settled: (installationId: number) => Promise<void>;
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function readIfPresent(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
}

async function jsonFiles<T>(dir: string): Promise<{ file: string; value: T }[]> {
  const names = await readdir(dir).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  return Promise.all(
    names
      .filter((name) => name.endsWith(JSON_EXTENSION))
      .map(async (name) => {
        const file = join(dir, name);
        return { file, value: JSON.parse(await readFile(file, 'utf8')) as T };
      }),
  );
}

const remove = (path: string) => rm(path, { recursive: true, force: true });

// A task id and a run id both start `owner/name:`.
const repoOfId = (id: string) => id.split(':', 1)[0];

// Only the harness's own temp folder, whatever the stored path says.
async function removeRunFolder(transcriptPath: string) {
  if (!transcriptPath) return;
  const folder = dirname(transcriptPath);
  if (dirname(folder) === tmpdir() && basename(folder).startsWith(RUN_FOLDER_PREFIX)) {
    await remove(folder);
  }
}

async function forgetRuns(dir: string, isForgotten: IsForgotten) {
  for (const { file, value: run } of await jsonFiles<StoredRun>(join(dir, 'runs'))) {
    if (!isForgotten(run.task.repo)) continue;
    await removeRunFolder(run.record.transcriptPath);
    await remove(file);
  }
}

async function forgetScans(dir: string, isForgotten: IsForgotten) {
  for (const { file, value } of await jsonFiles<StoredScan>(dir)) {
    if (isForgotten(value.repo)) await remove(file);
  }
}

// A recipe only this org taught goes. One other orgs taught too stays, minus this org's names and ids.
async function forgetRecipes(dir: string, isForgotten: IsForgotten) {
  const keep = (id: string) => !isForgotten(repoOfId(id));
  for (const { file, value: recipe } of await jsonFiles<MemoryRecipe>(join(dir, 'recipes'))) {
    if (!recipe.repos.some(isForgotten) && recipe.sourceRuns.every(keep)) continue;
    const repos = recipe.repos.filter((repo) => !isForgotten(repo));
    if (repos.length === 0) {
      await remove(file);
      continue;
    }
    await writeJsonAtomic(file, {
      ...recipe,
      repos,
      sourceRuns: recipe.sourceRuns.filter(keep),
      ...(recipe.failedRunIds && { failedRunIds: recipe.failedRunIds.filter(keep) }),
      ...(recipe.skill && {
        skill: { ...recipe.skill, failedRunIds: recipe.skill.failedRunIds.filter(keep) },
      }),
    });
  }
}

async function forgetSelfEvals(dir: string, isForgotten: IsForgotten) {
  const keep = (id: string) => !isForgotten(repoOfId(id));
  for (const { file, value: report } of await jsonFiles<SelfEvalReport>(join(dir, 'selfevals'))) {
    if (report.taskIds.every(keep)) continue;
    await writeJsonAtomic(file, {
      ...report,
      taskIds: report.taskIds.filter(keep),
      results: report.results.filter((result) => keep(result.taskId)),
    });
  }
  const tasksFile = join(dir, SELF_EVAL_TASKS);
  const content = await readIfPresent(tasksFile);
  if (content === undefined) return;
  const taskIds = JSON.parse(content) as string[];
  if (!taskIds.every(keep)) await writeJsonAtomic(tasksFile, taskIds.filter(keep));
}

async function forgetAudit(dir: string, isForgotten: IsForgotten) {
  const entries = await new JsonAuditStore(dir).list();
  const repos = new Set(entries.map((entry) => entry.repo).filter(isForgotten));
  for (const repo of repos) await remove(join(dir, repoFileName(repo)));
}

function lineRepo(line: string): string | undefined {
  try {
    return (JSON.parse(line) as { repo?: string }).repo;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined; // an empty or torn line names nobody
    throw error;
  }
}

async function forgetRunLog(file: string, isForgotten: IsForgotten) {
  const content = await readIfPresent(file);
  if (content === undefined) return;
  const lines = content.split('\n');
  const kept = lines.filter((line) => {
    const repo = lineRepo(line);
    return repo === undefined || !isForgotten(repo);
  });
  if (kept.length === lines.length) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, kept.join('\n'));
  await rename(temporary, file);
}

async function forgetReports(deps: ForgetDeps, job: ForgetJob, isForgotten: IsForgotten) {
  await deps.reports.removeInstallation(job.installationId);
  const left = (await deps.reports.list()).filter((report) => isForgotten(report.repo));
  await Promise.all(left.map((report) => deps.reports.remove(report.repo)));
}

// shortcut: memory/ and compliance/ have no delete, so this works on their folders; give each store a
// forget method and call that instead.
async function eraseOrgData(deps: ForgetDeps, job: ForgetJob, isForgotten: IsForgotten) {
  await forgetRuns(deps.memoryDir, isForgotten);
  await forgetScans(join(deps.memoryDir, 'scans'), isForgotten);
  await forgetRecipes(deps.memoryDir, isForgotten);
  await forgetSelfEvals(deps.memoryDir, isForgotten);
  await forgetAudit(deps.auditDir, isForgotten);
  await forgetScans(deps.scanReportDir, isForgotten);
  await forgetRunLog(deps.runLog, isForgotten);
  await deps.forgetNotified(isForgotten);
  await forgetReports(deps, job, isForgotten);
}

// Removing one repo drops only its report. An uninstall erases everything held about the org.
export function createForget(deps: ForgetDeps) {
  return async (job: ForgetJob): Promise<void> => {
    if (job.repo) return deps.reports.remove(job.repo);
    // GitHub logins ignore case, and a renamed org's repos are only reachable through stored reports.
    const owner = job.account === undefined ? undefined : `${job.account.toLowerCase()}/`;
    const known = new Set(await deps.reports.reposOf(job.installationId));
    const isForgotten: IsForgotten = (repo) =>
      known.has(repo) || (owner !== undefined && repo.toLowerCase().startsWith(owner));
    await eraseOrgData(deps, job, isForgotten);
    // The job that was just aborted may still write its last records, so erase again once it stops.
    await deps.settled(job.installationId);
    await eraseOrgData(deps, job, isForgotten);
    console.log(`erased the data of installation ${job.installationId}`);
  };
}

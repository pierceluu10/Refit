import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BehindItem, ScanReport } from '../shared/types.ts';
import { InvalidRepoError } from './git.ts';
import { REPO_PATTERN } from './types.ts';
import type { HumanVerdict } from './types.ts';

const EXTENSION = '.json';
const PR_REPO = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/;

type StoredReport = ScanReport & { installationId: number };

export type ReportStore = {
  save: (installationId: number, report: ScanReport) => Promise<void>;
  latest: (repo: string) => Promise<ScanReport | undefined>;
  list: () => Promise<ScanReport[]>;
  remove: (repo: string) => Promise<void>;
  removeInstallation: (installationId: number) => Promise<void>;
  markPullRequest: (
    repo: string,
    task: { id: string; change: { id: string } },
    url: string,
  ) => Promise<void>;
  markVerdict: (prUrl: string, verdict: HumanVerdict) => Promise<void>;
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function read(file: string): Promise<StoredReport | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoredReport;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error; // a corrupt report must not read as "never scanned"
  }
}

const sameItem = (a: BehindItem, b: BehindItem) =>
  a.change.id === b.change.id && a.dependency.name === b.dependency.name;

// A scan reads the code, not GitHub, so a finding it reports as open keeps the PR it already has.
function carryPullRequests(next: ScanReport, previous: ScanReport | undefined): BehindItem[] {
  return next.items.map((item) => {
    const known = previous?.items.find((other) => sameItem(other, item));
    const hasPullRequest = known?.pr && (known.status === 'pr-open' || known.status === 'merged');
    return item.status === 'open' && hasPullRequest
      ? { ...item, status: known.status, pr: known.pr }
      : item;
  });
}

// The latest ScanReport per repo, one JSON file each, rewritten atomically.
// shortcut: one process owns the folder, like the queue file; move to a database for several workers.
export function createReportStore(dir: string): ReportStore {
  let writing: Promise<unknown> = Promise.resolve();
  const serial = <T>(change: () => Promise<T>): Promise<T> => {
    const next = writing.then(change);
    writing = next.catch(() => undefined);
    return next;
  };

  const fileFor = (repo: string) => {
    if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
    return join(dir, `${encodeURIComponent(repo)}${EXTENSION}`);
  };

  const write = async (file: string, report: StoredReport) => {
    await mkdir(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(report));
    await rename(temporary, file);
  };

  const readAll = async (): Promise<StoredReport[]> => {
    const names = await readdir(dir).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const reports = await Promise.all(
      names.filter((name) => name.endsWith(EXTENSION)).map((name) => read(join(dir, name))),
    );
    return reports.filter((report) => report !== undefined);
  };

  const updateItems = (repo: string, update: (item: BehindItem) => void) =>
    serial(async () => {
      const file = fileFor(repo);
      const report = await read(file);
      if (!report) return;
      report.items.forEach(update);
      await write(file, report);
    });

  return {
    save: (installationId, report) =>
      serial(async () => {
        const file = fileFor(report.repo);
        const items = carryPullRequests(report, await read(file));
        await write(file, { ...report, items, installationId });
      }),
    latest: async (repo) => read(fileFor(repo)),
    list: readAll,
    remove: (repo) => serial(() => rm(fileFor(repo), { force: true })),
    removeInstallation: (installationId) =>
      serial(async () => {
        const reports = await readAll();
        await Promise.all(
          reports
            .filter((report) => report.installationId === installationId)
            .map((report) => rm(fileFor(report.repo), { force: true })),
        );
      }),
    markPullRequest: (repo, task, url) =>
      updateItems(repo, (item) => {
        // Changes a task also resolves have their own rows, which carry that task's id.
        if (item.change.id !== task.change.id && item.taskId !== task.id) return;
        item.status = 'pr-open';
        item.pr = url;
      }),
    async markVerdict(prUrl, verdict) {
      const repo = PR_REPO.exec(prUrl)?.[1];
      if (!repo || verdict === 'edited') return;
      await updateItems(repo, (item) => {
        if (item.pr === prUrl) item.status = verdict === 'merged' ? 'merged' : 'open';
      });
    },
  };
}

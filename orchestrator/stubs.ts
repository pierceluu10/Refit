// STUBS for tonight. Each stands in for a module landing in another branch; deps.ts swaps them out.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApiUsage,
  InventoryRepo,
  ProviderChange,
  RunTask,
  WatchProvider,
} from '../shared/types.ts';
import type { LoopRecord, OpenPullRequest, RecordRun } from './loop.ts';
import type { MatchChanges, MatchResult } from './match.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));

// Stub for inventory/: replays a fixture usage map relabelled for the repo. It never reads the repo.
export function stubInventory(file = fixture('usages.json')): InventoryRepo {
  return async (_repoDir, repo) => (await readJson<ApiUsage[]>(file)).map((u) => ({ ...u, repo }));
}

// Stub for providers/: replays fixture changes and ignores `since`.
export function stubWatcher(file = fixture('changes.json')): WatchProvider {
  return () => readJson<ProviderChange[]>(file);
}

// Stub for harness/: changes nothing and says so. The real harness works in a sandboxed copy.
export const stubRunTask: RunTask = async (task) => {
  const result: LoopRecord = {
    taskId: task.id,
    outcome: 'needs-review',
    diff: `# stub: placeholder diff for ${task.id}; the harness is not wired yet, no code was changed\n`,
    checks: [],
    costUsd: 0,
    transcriptPath: '',
    note: 'stub runTask: harness/ is not wired yet, so nothing was migrated or proven',
  };
  return result;
};

// Stub for app/'s PR opener: a fake URL; it never touches GitHub.
export const stubOpenPullRequest: OpenPullRequest = async (task) => `stub://pr/${task.id}`;

// Stub for memory/: appends one JSON line per run to `file`, which must be outside the target repo.
export function stubRecordRun(file: string): RecordRun {
  return async (task, result) => {
    await mkdir(dirname(file), { recursive: true });
    const line = { repo: task.repo, changeId: task.change.id, ...result };
    await appendFile(file, `${JSON.stringify(line)}\n`);
  };
}

// shortcut: offline stand-in for the match agent, never used when ANTHROPIC_API_KEY is set
export const stubMatch: MatchChanges = async ({ repo, changes, usages }) => {
  const result: MatchResult = { tasks: [], notAffected: [], costUsd: 0 };
  for (const change of changes) {
    const same = usages.filter((u) => u.provider === change.provider);
    if (same.length === 0) {
      result.notAffected.push({
        changeId: change.id,
        reasoning: `stub matcher: the repo's usage map has no ${change.provider} usage`,
      });
      continue;
    }
    result.tasks.push({
      id: `${repo}:${change.id}`,
      repo,
      change,
      usages: same,
      deadline: change.effectiveDate,
      priority: 0,
      reasoning:
        'stub matcher: no model available; every same-provider usage is passed on for the harness to judge',
      urgency: change.effectiveDate ? `effective ${change.effectiveDate}` : 'no date stated',
      callSites: same.flatMap((u) =>
        u.callSites.map(({ file, line }) => ({ file, line, why: `calls ${change.provider}` })),
      ),
    });
  }
  return result;
};

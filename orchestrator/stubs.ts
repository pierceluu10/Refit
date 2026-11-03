// Offline stand-ins: deps.ts uses them when no model is available, and the PR opener until the app passes its own.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BudgetLedger as WatchLedger } from '../providers/core/model.ts';
import type {
  ApiUsage,
  InventoryRepo,
  OpenPullRequest,
  ProviderChange,
  ProviderHints,
  RunTask,
  WatchProvider,
} from '../shared/types.ts';
import type { LoopRecord, RecordRun } from './loop.ts';
import type { MatchChanges, MatchResult } from './match.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));

// Stub for inventory/: replays a fixture usage map relabelled for the repo. It never reads the repo.
export function stubInventory(file = fixture('usages.json')): InventoryRepo {
  return async (_repoDir, repo) => (await readJson<ApiUsage[]>(file)).map((u) => ({ ...u, repo }));
}

// Stub for providers/: replays the fixture changes for one provider and ignores `since`.
export function stubWatcher(provider: string, file = fixture('changes.json')): WatchProvider {
  return async () =>
    (await readJson<ProviderChange[]>(file)).filter((change) => change.provider === provider);
}

// Stub for F4's anyProviderWatcher (providers/core/any-watcher.ts), with its signature, until it lands.
// It throws rather than return nothing, so the run reports the provider as unwatched.
export function anyProviderWatcher(
  provider: string,
  _hints: ProviderHints,
  _deps?: { budget?: WatchLedger },
): WatchProvider {
  return async () => {
    throw new Error(
      `no changelog watcher for ${provider} yet: anyProviderWatcher (providers/core/any-watcher.ts) has not landed`,
    );
  };
}

// Stub for harness/: changes nothing and says so. The real harness works in a sandboxed copy.
export const stubRunTask: RunTask = async (task) => {
  const result: LoopRecord = {
    taskId: task.id,
    outcome: 'needs-review',
    diff: `# stub: placeholder diff for ${task.id}; offline run, no code was changed\n`,
    checks: [],
    costUsd: 0,
    transcriptPath: '',
    note: 'stub runTask: offline run without ANTHROPIC_API_KEY, so nothing was migrated or proven',
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
    const same = usages.filter((u) => u.provider.toLowerCase() === change.provider.toLowerCase());
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

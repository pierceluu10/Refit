import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Budget } from './budget.ts';
import type { LoopDeps } from './loop.ts';
import { createMatchAgent, type MatchChanges } from './match.ts';
import { createMemoryQueue } from './queue.ts';
import {
  stubInventory,
  stubMatch,
  stubOpenPullRequest,
  stubRecordRun,
  stubRunTask,
  stubWatcher,
} from './stubs.ts';

// Run records go outside the target repo; Aptitude never writes into a repo except through a PR.
export const defaultOut = join(tmpdir(), 'aptitude-runs.jsonl');

// The one place that picks real or stub modules for the loop.
export function createDeps({
  out = defaultOut,
  budget,
  log = (line: string) => console.error(line),
}: {
  out?: string;
  budget?: Budget;
  log?: (line: string) => void;
}): LoopDeps {
  let match: MatchChanges = stubMatch;
  if (process.env.ANTHROPIC_API_KEY) {
    if (!budget) throw new Error('ANTHROPIC_API_KEY is set, so pass a budget from createBudget().');
    match = createMatchAgent({ budget });
  } else {
    log(
      'WARNING: ANTHROPIC_API_KEY is not set. The offline stub matcher stands in for the match agent; its tasks are not AI judgements.',
    );
  }
  return {
    // Stubs until their branches merge: inventory/, providers/, harness/, app/ (PR opener), memory/ (run records).
    inventory: stubInventory(),
    watchers: [stubWatcher()],
    match,
    runTask: stubRunTask,
    openPullRequest: stubOpenPullRequest,
    recordRun: stubRecordRun(out),
    queue: createMemoryQueue({ concurrency: 4, retries: 2, backoffMs: 1000, log }),
    log,
  };
}

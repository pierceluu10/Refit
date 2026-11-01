// The self-eval as one command, run from the repo root:
//   APTITUDE_AI_BUDGET_USD=<cap> node memory/scripts/selfeval.ts [--size <n>]
// Reruns the fixed set of stored tasks through the loop's own task path (today's memory, the harness,
// the provider tool packs) and prints whether the verified rate moved. Reruns open no PR and are not
// recorded as runs; the report is saved with the store's self-evals.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitCheckout } from '../../evals/runner/checkout.ts';
import type { CheckoutRepo } from '../../evals/runner/types.ts';
import { createBudget, type Budget } from '../../orchestrator/budget.ts';
import { createDeps, MIN_TASK_USD } from '../../orchestrator/deps.ts';
import type { RunTask } from '../../shared/types.ts';
import { BudgetExceededError } from '../ai.ts';
import { defaultMemory } from '../index.ts';
import { runSelfEval } from '../selfeval.ts';
import type { MemoryStore } from '../store.ts';
import type { SelfEvalReport } from '../types.ts';

const USAGE = 'usage: node memory/scripts/selfeval.ts [--size <n>]';

export type SelfEvalParts = {
  store: MemoryStore;
  budget: Budget;
  runTask: RunTask;
  checkout: CheckoutRepo;
};

// The real parts: the store APTITUDE_MEMORY_DIR names, a run budget (createBudget refuses to build
// one without APTITUDE_AI_BUDGET_USD) and the loop's runTask, which picks recipes from that store.
function realParts(): SelfEvalParts {
  const budget = createBudget();
  return {
    store: defaultMemory().store,
    budget,
    runTask: createDeps({ budget }).runTask,
    checkout: gitCheckout(),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function main(
  argv: string[],
  parts: () => SelfEvalParts = realParts,
): Promise<number> {
  let size: number;
  try {
    const { values } = parseArgs({ args: argv, options: { size: { type: 'string' } } });
    size = Number(values.size ?? 5);
    if (!Number.isInteger(size) || size < 1)
      throw new Error('--size must be a whole number above 0');
  } catch (error) {
    console.error(`selfeval: ${message(error)}\n${USAGE}`);
    return 2;
  }
  // Without a model the loop swaps in offline stubs, and a rate measured on stubs means nothing.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'selfeval: set ANTHROPIC_API_KEY. Without a model the harness is an offline stub, so the verified rate would mean nothing.',
    );
    return 2;
  }
  let made: SelfEvalParts;
  try {
    made = parts();
  } catch (error) {
    console.error(`selfeval: ${message(error)}`);
    return 2;
  }
  const { store, budget, runTask, checkout } = made;
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const report = await runSelfEval({
      store,
      size,
      prepareRepo: async (task, run) => {
        const left = budget.capUsd - budget.spentUsd();
        if (left < MIN_TASK_USD) {
          throw new BudgetExceededError(
            `$${left.toFixed(2)} of the $${budget.capUsd} cap is left, below the $${MIN_TASK_USD} a task needs`,
          );
        }
        // Fetching runs no repo code; only the harness runs it, in its sandbox.
        const copy = await checkout({ repo: task.repo, commit: run.commit ?? 'HEAD' });
        cleanups.push(copy.cleanup);
        return copy.repoDir;
      },
      // Everything the rerun spent, memory's recipe pick included, not only the harness's share.
      runTask: async (task, dir) => {
        const before = budget.spentUsd();
        const record = await runTask(task, dir);
        return { ...record, costUsd: budget.spentUsd() - before };
      },
    });
    console.log(format(report, budget));
    return 0;
  } catch (error) {
    console.error(`selfeval: ${message(error)}`);
    return 1;
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
}

function format(report: SelfEvalReport, budget: Budget): string {
  return [
    `Aptitude self-eval ${report.ranAt}`,
    `  ${report.summary}`,
    ...report.results.map((r) => `  ${r.taskId}: ${r.before} -> ${r.after}`),
    `  AI spent: $${budget.spentUsd().toFixed(4)} of the $${budget.capUsd} cap`,
    `  saved as ${report.id}`,
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

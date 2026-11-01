// Wires the runner to the real Aptitude modules through the orchestrator's createDeps, so the
// benchmark runs what the loop runs, under one run budget. It refuses to start without a key.
import { createBudget } from '../../orchestrator/budget.ts';
import { createDeps, providerWatcher } from '../../orchestrator/deps.ts';
import { listProviderIds } from '../../providers/core/registry.ts';
import type { ProviderChange } from '../../shared/types.ts';
import { createReviewer } from '../reviewer/reviewer.ts';
import { unwiredModelClient } from '../reviewer/model.ts';
import { gitCheckout } from './checkout.ts';
import type { Meter, PipelineFactory } from './types.ts';

export async function loadRealPipeline(budgetUsd: number): Promise<PipelineFactory> {
  // Without a key createDeps falls back to offline stubs, and the benchmark would grade fake work.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Set ANTHROPIC_API_KEY for a real run. For a $0 check run "npm run smoke -w evals".',
    );
  }
  const budget = createBudget(budgetUsd);
  const deps = createDeps({ budget });
  const providerIds = listProviderIds();

  // One spending call at a time: each part may spend what is left of the run, so calls from
  // repos running in parallel could each spend the same remainder.
  let last: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(call: () => Promise<T>): Promise<T> => {
    const run = last.then(call);
    last = run.catch(() => {});
    return run;
  };
  // Charges the repo's meter with what the call spent from the run budget.
  const spending = <T>(meter: Meter, label: string, call: () => Promise<T>): Promise<T> =>
    oneAtATime(async () => {
      const before = budget.spentUsd();
      try {
        return await call();
      } finally {
        meter.charge(budget.spentUsd() - before, label);
      }
    });

  const checkout = gitCheckout();
  const review = createReviewer(unwiredModelClient);
  const changesByProvider = new Map<string, Promise<ProviderChange[]>>();
  return ({ entry, provider, meter }) => ({
    checkout,
    // Inventory is the first step that spends, so a provider with no watcher stops before any spend.
    inventory: (repoDir, repo) =>
      providerIds.includes(provider)
        ? spending(meter, 'inventory', () => deps.inventory(repoDir, repo))
        : Promise.reject(
            new Error(
              `no changelog watcher for ${provider} yet: providers/ has no ${provider} folder`,
            ),
          ),
    watch: () => {
      // One watcher read per provider per run, so every repo is matched against the same changes.
      let changes = changesByProvider.get(provider);
      if (!changes) {
        changes = spending(meter, 'watch', () => providerWatcher(provider, budget)());
        changesByProvider.set(provider, changes);
      }
      return changes;
    },
    match: (changes, usages) =>
      spending(meter, 'match', async () => {
        const result = await deps.match({ repo: entry.repo, changes, usages });
        return {
          tasks: result.tasks,
          reasoning: [
            ...result.tasks.map((task) => `${task.id}: ${task.reasoning}`),
            ...result.notAffected.map((n) => `${n.changeId}: not affected: ${n.reasoning}`),
          ].join('\n'),
        };
      }),
    // The runner charges each record's costUsd to the meter itself.
    runTask: (task, repoDir) => oneAtATime(() => deps.runTask(task, repoDir)),
    review,
  });
}

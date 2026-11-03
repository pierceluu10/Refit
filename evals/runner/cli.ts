// Benchmark runner CLI.
//
//   node evals/runner/cli.ts run --set <dev set> --budget-usd <cap> --concurrency <n> [--shard <i>] [--out <dir>] [--watch-cache <dir>]
//   node evals/runner/cli.ts watch --set <dev set> --budget-usd <cap> --watch-cache <dir>
//   node evals/runner/cli.ts matrix --set <dev set> --budget-usd <total cap>
//   node evals/runner/cli.ts score --in <dir> [--reviews evals/reviews.json] [--report <file>]
//   node evals/runner/cli.ts review --in <dir> --budget-usd <cap> [--only <task id part>] [--out <file>]
//   node evals/runner/cli.ts screen --sets <a,b,...> --budget-usd <cap> --concurrency <n> [--out <dir>] [--exclusions <file>]
//   node evals/runner/cli.ts score3 --in <results dir> --screen <dir> [--report <file>]
//
// `run --screen <dir>` runs only the repos that screen found green (evals only, never the product).
//
// `run` refuses to start without an explicit dollar cap and concurrency. It uses the real
// modules and fails before spending anything if one hasn't merged yet. For a $0 check of the
// whole path, use `npm run smoke -w evals`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadDevSet } from '../sets/index.ts';
import { formatReport, readResults, scoreResults } from '../scoring/score.ts';
import {
  handCheckSummary,
  missingHandChecks,
  readReviews,
  REVIEWS_PATH,
  syncReviews,
  writeReviews,
} from '../scoring/reviews.ts';
import { createBudget } from '../../orchestrator/budget.ts';
import { WATCH_USD } from '../../orchestrator/deps.ts';
import { TURN_RESERVE_USD } from '../../harness/index.ts';
import { anyProviderWatcher } from '../../providers/core/any-watcher.ts';
import { anthropicModelClient } from '../reviewer/model.ts';
import { createReviewer } from '../reviewer/reviewer.ts';
import { formatRereviews, rereview } from '../reviewer/rereview.ts';
import { gitCheckout } from './checkout.ts';
import type { DevSet } from '../sets/index.ts';
import { BudgetLedger } from './budget.ts';
import { ConfigError, parseFlags, parseRunConfig } from './config.ts';
import { loadRealPipeline, type AnyProviderWatcher } from './real.ts';
import { runSet } from './run.ts';
import { exclusionsOf, readScreen, screenFile, screenSet } from './screen.ts';
import { formatRound3, scoreRound3 } from '../scoring/round3.ts';
import { existsSync, readFileSync } from 'node:fs';
import type { BaselineRecord } from './screen.ts';

// Watches providers with no folder in providers/ (the Anthropic, Gemini and long-tail sets).
const watchAny: AnyProviderWatcher = anyProviderWatcher;

/** The providers a set's repos use: the set's own, or each entry's in a mixed set. */
export function setProviders(set: Pick<DevSet, 'provider' | 'repos'>): string[] {
  return [
    ...new Set(
      set.repos.map((entry) =>
        typeof entry.provider === 'string' ? entry.provider : set.provider,
      ),
    ),
  ].sort();
}

/**
 * GitHub Actions matrix. One `watch` job reads each of the set's providers once (WATCH_USD each)
 * and hands its cache to every shard, so a shard pays for no read of its own; the rest of the cap
 * is split evenly across one shard per repo. A share below a task's overshoot reserve
 * (TURN_RESERVE_USD) can never start a task, so the plan refuses it rather than spend on repos
 * whose tasks are bound to be unrun.
 */
export function planMatrix(setName: string, totalBudgetUsd: number) {
  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0) {
    throw new ConfigError('--budget-usd (the whole run’s cap) is required and must be above zero');
  }
  const set = loadDevSet(setName);
  const watchBudgetUsd = WATCH_USD * setProviders(set).length;
  const shardBudgetUsd =
    Math.floor(((totalBudgetUsd - watchBudgetUsd) / set.repos.length) * 10_000) / 10_000;
  if (shardBudgetUsd < TURN_RESERVE_USD) {
    throw new ConfigError(
      `$${totalBudgetUsd} less $${watchBudgetUsd.toFixed(2)} for the watch job leaves $${Math.max(shardBudgetUsd, 0).toFixed(2)} for each of ${set.repos.length} shards, below the $${TURN_RESERVE_USD} overshoot reserve a task needs free, so no task could start. In the first benchmark (evals/reports/2026-11-03.md) a repo spent $0.17 to $0.66 on inventory and matching before its first task.`,
    );
  }
  return {
    set: set.name,
    shards: set.repos.map((entry, index) => ({ index, repo: entry.repo })),
    shardBudgetUsd,
    watchBudgetUsd,
  };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === 'run') {
    const config = parseRunConfig(flags);
    const full = loadDevSet(config.set);
    // The screen's green repos only: a red baseline can't prove a fix, so it is never run.
    const screenDir = typeof flags.screen === 'string' ? flags.screen : undefined;
    const green = (entry: (typeof full.repos)[number]) => {
      const file = screenDir && screenFile(screenDir, full.name, entry);
      if (!file || !existsSync(file)) return !screenDir;
      return !(JSON.parse(readFileSync(file, 'utf8')) as BaselineRecord).exclusion;
    };
    const set = { ...full, repos: full.repos.filter(green) };
    console.log(`${set.name}: running ${set.repos.length} of ${full.repos.length} repos`);
    const startedAt = new Date().toISOString();
    const real = await loadRealPipeline(config.budgetUsd, {
      watchAny,
      ...(config.watchCache ? { watchCache: config.watchCache } : {}),
    });
    const { results, ledger } = await runSet(config, set, real.factory);
    const score = scoreResults(results);
    const title = `${set.name}${config.shard === undefined ? '' : ` shard ${config.shard}`}`;
    console.log(formatReport(score, title));
    // The meter (what the runner charged each repo) and the run budget (what every real part held
    // and settled) should agree; both are printed so a gap shows.
    const summary = {
      set: set.name,
      shard: config.shard,
      capUsd: config.budgetUsd,
      meterSpentUsd: ledger.spentUsd,
      budgetSpentUsd: real.spentUsd(),
      stopReason: ledger.stopReason,
      costByPart: score.costByPart,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    const summaryDir = join(config.outDir, set.name);
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      join(summaryDir, `run-summary${config.shard === undefined ? '' : `-${config.shard}`}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(
      `Spent $${ledger.spentUsd.toFixed(4)} by the meter, $${real.spentUsd().toFixed(4)} by the run budget, of a $${config.budgetUsd} cap`,
    );
    return score.attemptedRate === 1 ? 0 : 1;
  }
  if (command === 'watch') {
    // Reads each provider of the set once into the cache, for shards to share.
    if (typeof flags.set !== 'string') throw new ConfigError('--set is required');
    const watchCache = flags['watch-cache'];
    if (typeof watchCache !== 'string') throw new ConfigError('--watch-cache <dir> is required');
    const budgetUsd = typeof flags['budget-usd'] === 'string' ? Number(flags['budget-usd']) : NaN;
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new ConfigError('--budget-usd is required and must be above zero');
    }
    const set = loadDevSet(flags.set);
    const real = await loadRealPipeline(budgetUsd, { watchAny, watchCache });
    const ledger = new BudgetLedger(budgetUsd);
    let failed = 0;
    for (const provider of setProviders(set)) {
      const entry = set.repos.find((repo) => (repo.provider ?? set.provider) === provider);
      if (!entry) continue;
      const meter = ledger.meter(provider);
      try {
        const changes = await real.factory({ entry, provider, meter }).watch([]);
        console.log(`${provider}: ${changes.length} changes, $${meter.totalUsd().toFixed(4)}`);
      } catch (error) {
        failed += 1;
        console.error(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(
      `Spent $${real.spentUsd().toFixed(4)} of a $${budgetUsd} cap; cache in ${watchCache}`,
    );
    return failed === 0 ? 0 : 1;
  }
  if (command === 'review') {
    // The advisory reviewer again, on PRs a past run produced. Real money, under its own cap.
    if (typeof flags.in !== 'string') throw new ConfigError('--in <results dir> is required');
    const budgetUsd = typeof flags['budget-usd'] === 'string' ? Number(flags['budget-usd']) : NaN;
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new ConfigError('--budget-usd is required and must be above zero');
    }
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY to review again.');
    const budget = createBudget(budgetUsd);
    const ledger = new BudgetLedger(budgetUsd);
    const rows = await rereview(readResults(resolve(flags.in)), {
      review: createReviewer(anthropicModelClient({ budget })),
      checkout: gitCheckout(),
      meter: (repo) => ledger.meter(repo),
      ...(typeof flags.only === 'string' ? { only: flags.only } : {}),
    });
    console.log(formatRereviews(rows));
    if (typeof flags.out === 'string') {
      writeFileSync(resolve(flags.out), `${JSON.stringify(rows, null, 2)}\n`);
    }
    console.log(`Spent $${budget.spentUsd().toFixed(4)} of a $${budgetUsd} cap`);
    return 0;
  }
  if (command === 'screen') {
    if (typeof flags.sets !== 'string') throw new ConfigError('--sets <a,b,...> is required');
    const budgetUsd = typeof flags['budget-usd'] === 'string' ? Number(flags['budget-usd']) : NaN;
    const concurrency = typeof flags.concurrency === 'string' ? Number(flags.concurrency) : NaN;
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new ConfigError('--budget-usd is required and must be above zero');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ConfigError('--concurrency must be a positive integer');
    }
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY to screen.');
    const outDir = resolve(
      typeof flags.out === 'string' ? flags.out : 'evals/reports/round-3/screen',
    );
    const budget = createBudget(budgetUsd);
    const deps = {
      checkout: gitCheckout(),
      budget,
      classify: anthropicModelClient({ budget, model: 'claude-sonnet-5-5' }),
    };
    for (const name of flags.sets.split(',')) {
      const records = await screenSet(loadDevSet(name), outDir, concurrency, deps);
      const green = records.filter((record) => !record.exclusion).length;
      console.log(`${name}: ${green} of ${records.length} green`);
    }
    const exclusions = exclusionsOf(readScreen(outDir));
    const exclusionsFile = resolve(
      typeof flags.exclusions === 'string'
        ? flags.exclusions
        : 'evals/reports/round-3/exclusions.json',
    );
    writeFileSync(exclusionsFile, `${JSON.stringify(exclusions, null, 2)}\n`);
    console.log(
      `Spent $${budget.spentUsd().toFixed(4)}; ${exclusions.length} exclusions in ${exclusionsFile}`,
    );
    return 0;
  }
  if (command === 'score3') {
    if (typeof flags.in !== 'string') throw new ConfigError('--in <results dir> is required');
    if (typeof flags.screen !== 'string') throw new ConfigError('--screen <dir> is required');
    const score = scoreRound3(readResults(resolve(flags.in)), readScreen(resolve(flags.screen)));
    const report = formatRound3(score, `Round 3: ${flags.in}`);
    console.log(report);
    if (typeof flags.report === 'string') writeFileSync(resolve(flags.report), report);
    if (typeof flags.json === 'string') {
      writeFileSync(resolve(flags.json), `${JSON.stringify(score, null, 2)}\n`);
    }
    return 0;
  }
  if (command === 'matrix') {
    if (typeof flags.set !== 'string') throw new ConfigError('--set is required');
    const budget = typeof flags['budget-usd'] === 'string' ? Number(flags['budget-usd']) : NaN;
    console.log(JSON.stringify(planMatrix(flags.set, budget)));
    return 0;
  }
  if (command === 'score') {
    if (typeof flags.in !== 'string') throw new ConfigError('--in <results dir> is required');
    const results = readResults(resolve(flags.in));
    const score = scoreResults(results);
    const reviewsPath = typeof flags.reviews === 'string' ? resolve(flags.reviews) : REVIEWS_PATH;
    const { reviews, added } = syncReviews(readReviews(reviewsPath), results);
    writeReviews(reviews, reviewsPath);
    const hand = handCheckSummary(reviews);
    const report = `${formatReport(score)}
Hand-check log: ${added.length} new entries, ${hand.pending} pending, ${hand.agree} agree, ${hand.disagree} disagree (${reviewsPath})
`;
    console.log(report);
    if (typeof flags.report === 'string') writeFileSync(resolve(flags.report), report);
    if (missingHandChecks(reviews, results).length > 0) return 1;
    return score.attemptedRate === 1 ? 0 : 1;
  }
  console.error(
    'usage: cli.ts run|watch|matrix|score|review|screen|score3 (see the header of evals/runner/cli.ts)',
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = error instanceof ConfigError ? 2 : 1;
    },
  );
}

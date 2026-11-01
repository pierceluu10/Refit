// Benchmark runner CLI.
//
//   node evals/runner/cli.ts run --set <dev set> --budget-usd <cap> --concurrency <n> [--shard <i>] [--out <dir>]
//   node evals/runner/cli.ts matrix --set <dev set> --budget-usd <total cap>
//   node evals/runner/cli.ts score --in <dir> [--reviews evals/reviews.json] [--report <file>]
//
// `run` refuses to start without an explicit dollar cap and concurrency. It uses the real
// modules and fails before spending anything if one hasn't merged yet. For a $0 check of the
// whole path, use `npm run smoke -w evals`.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { ConfigError, parseFlags, parseRunConfig } from './config.ts';
import { loadRealPipeline } from './real.ts';
import { runSet } from './run.ts';

/** GitHub Actions matrix: one shard per repo, each with an equal share of the total cap. */
export function planMatrix(setName: string, totalBudgetUsd: number) {
  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0) {
    throw new ConfigError('--budget-usd (the whole run’s cap) is required and must be above zero');
  }
  const set = loadDevSet(setName);
  const shardBudgetUsd = Math.floor((totalBudgetUsd / set.repos.length) * 10_000) / 10_000;
  if (shardBudgetUsd <= 0) throw new ConfigError('the cap is too small to split across shards');
  return {
    set: set.name,
    shards: set.repos.map((entry, index) => ({ index, repo: entry.repo })),
    shardBudgetUsd,
  };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === 'run') {
    const config = parseRunConfig(flags);
    const set = loadDevSet(config.set);
    const factory = await loadRealPipeline(config.budgetUsd);
    const { results, ledger } = await runSet(config, set, factory);
    const score = scoreResults(results);
    console.log(
      formatReport(
        score,
        `${set.name}${config.shard === undefined ? '' : ` shard ${config.shard}`}`,
      ),
    );
    console.log(`Spent $${ledger.spentUsd.toFixed(4)} of $${config.budgetUsd} cap`);
    return score.attemptedRate === 1 ? 0 : 1;
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
  console.error('usage: cli.ts run|matrix|score (see the header of evals/runner/cli.ts)');
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

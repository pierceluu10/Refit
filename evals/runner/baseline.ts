// The plain-Claude baseline (round 3): the same model, on the tasks Refit attempted, in the same
// sandbox with the same install and codegen, given one prompt and plain file and shell tools. It
// gets none of Refit's instructions, provider validators, recipes, call sites, proof-test rule or
// second attempt. Both sides are graded the same way, by the repo's own checks, and re-reviewed
// by the same reviewer.
//
//   node evals/runner/baseline.ts --in <iteration dir> --out <dir> --budget-usd <cap> --concurrency <n>
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { claudeAgentSession } from '../../harness/agent.ts';
import { compareChecks, runChecks } from '../../harness/checks.ts';
import { BudgetLedger } from '../../harness/ledger.ts';
import { MODEL, TURN_RESERVE_USD, prepareBaseline } from '../../harness/run.ts';
import { createSandbox } from '../../harness/sandbox.ts';
import { createBudget } from '../../orchestrator/budget.ts';
import { buildTools } from '../../harness/tools.ts';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import { anthropicModelClient } from '../reviewer/model.ts';
import { createReviewer, type AdvisoryReview } from '../reviewer/reviewer.ts';
import { gitCheckout } from './checkout.ts';
import type { RepoResult, TaskResult } from './types.ts';

/** Plain file and shell tools: what any coding agent has. */
export const BASELINE_TOOLS = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'search',
  'shell',
  'install',
  'diff',
  'fetch_url',
];
const SYSTEM = 'You are a software engineer. Work in the repository with the tools you have.';
const TASK_USD = 3;

export function baselinePrompt(change: TaskResult['change'] & {}): string {
  return [
    `An API this repository uses has changed (${change.provider}):`,
    change.title,
    change.effectiveDate ? `Effective: ${change.effectiveDate}` : '',
    `Source (${change.source.url}):\n> ${change.source.quote}`,
    'Update the repository for this change.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

type Checks = RunRecord['checks'];

/**
 * Passes the repo's own checks: a real diff, no own check newly failing, and one of them passing.
 * Read from the before/after summaries both sides keep, so both are graded by the same rule.
 */
export function passesChecks(diff: string, checks: Checks, own: Set<string>): boolean {
  const mine = checks.filter((check) => own.has(check.name));
  const count = (summary: string) => Number(summary.match(/fail \((\d+)\)/)?.[1] ?? 0);
  const broke = mine.some(
    (check) =>
      check.after !== 'pass' &&
      (check.before === 'pass' || count(check.after) > count(check.before)),
  );
  return diff.trim() !== '' && !broke && mine.some((check) => check.after === 'pass');
}

type Side = { passesChecks: boolean; costUsd: number; review?: AdvisoryReview; diffLines: number };
export type BaselineComparison = {
  set: string;
  repo: string;
  taskId: string;
  title: string;
  refit: Side & { outcome: string };
  claude: Side & {
    stopReason?: string;
    prepCostUsd: number;
    transcriptPath: string;
    error?: string;
    checks?: Checks;
  };
};

function attempted(inDir: string): { result: RepoResult; task: TaskResult }[] {
  const out: { result: RepoResult; task: TaskResult }[] = [];
  for (const set of readdirSync(inDir)) {
    const dir = join(inDir, set);
    if (!existsSync(dir) || !/^[a-z0-9-]+$/.test(set)) continue;
    for (const file of readdirSync(dir).filter((name) => /^\d+-.*\.json$/.test(name))) {
      const result = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RepoResult;
      for (const task of result.tasks) {
        if (task.change && ['verified', 'needs-review'].includes(task.record?.outcome ?? '')) {
          out.push({ result, task });
        }
      }
    }
  }
  return out;
}

async function compareOne(
  { result, task }: { result: RepoResult; task: TaskResult },
  review: ReturnType<typeof createReviewer>,
  budget: ReturnType<typeof createBudget>,
): Promise<BaselineComparison> {
  const change = task.change as NonNullable<TaskResult['change']>;
  const migration: MigrationTask = {
    id: task.taskId,
    repo: result.repo,
    change,
    usages: [],
    priority: 0,
  };
  const refitRecord = task.record as RunRecord & { agentChecks?: { name: string }[] };
  const agentNames = new Set((refitRecord.agentChecks ?? []).map((check) => check.name));
  const own = new Set(refitRecord.checks.map((c) => c.name).filter((n) => !agentNames.has(n)));
  const comparison: BaselineComparison = {
    set: result.set,
    repo: result.repo,
    taskId: task.taskId,
    title: change.title,
    refit: {
      outcome: refitRecord.outcome,
      passesChecks: passesChecks(refitRecord.diff, refitRecord.checks, own),
      costUsd: refitRecord.costUsd,
      diffLines: refitRecord.diff.split('\n').length,
    },
    claude: { passesChecks: false, costUsd: 0, prepCostUsd: 0, diffLines: 0, transcriptPath: '' },
  };
  const hold = await budget.reserve(`baseline ${task.taskId}`, TASK_USD + 1);
  const ledger = new BudgetLedger(hold.usd);
  const copy = await gitCheckout()({ repo: result.repo, commit: result.commit });
  const meter = {
    charge: (usd: number, note: string) => ledger.charge({ model: 'reviewer', costUsd: usd, note }),
  };
  try {
    const sandbox = await createSandbox(copy.repoDir);
    try {
      const prepared = await prepareBaseline(sandbox, ledger);
      comparison.claude.prepCostUsd = ledger.spentUsd;
      const outDir = join(copy.repoDir, '..', `baseline-${task.taskId.replace(/\W+/g, '-')}`);
      mkdirSync(outDir, { recursive: true });
      const transcriptPath = join(outDir, 'transcript.jsonl');
      comparison.claude.transcriptPath = transcriptPath;
      const tools = buildTools({
        sandbox,
        task: migration,
        toolPack: { provider: change.provider, tools: [], playbooks: {} },
        retrieveRecipes: async () => [],
        checks: prepared.checks,
        onFinish: () => {},
      }).filter((tool) => BASELINE_TOOLS.includes(tool.name));
      const session = await claudeAgentSession({
        model: MODEL,
        systemPrompt: SYSTEM,
        prompt: baselinePrompt(change),
        tools,
        sandbox,
        ledger,
        budgetUsd: Math.min(TASK_USD, ledger.remainingUsd - TURN_RESERVE_USD),
        maxTurns: 80,
        log: (event) => writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, { flag: 'a' }),
      });
      comparison.claude.stopReason = session.stopReason;
      const after = await runChecks(sandbox, prepared.checks);
      const checks = compareChecks(prepared.before, after).map(({ name, before, after: now }) => ({
        name,
        before,
        after: now,
      }));
      const diff = await sandbox.diff();
      comparison.claude.checks = checks;
      comparison.claude.passesChecks = passesChecks(diff, checks, own);
      comparison.claude.diffLines = diff.split('\n').length;
      comparison.claude.costUsd = ledger.spentUsd - comparison.claude.prepCostUsd;
      const claudeRecord: RunRecord = {
        taskId: task.taskId,
        outcome: comparison.claude.passesChecks ? 'verified' : 'needs-review',
        diff,
        checks,
        costUsd: comparison.claude.costUsd,
        transcriptPath,
      };
      // The same reviewer reads both diffs against the untouched checkout.
      comparison.claude.review = await review({
        task: migration,
        record: claudeRecord,
        meter,
        repoDir: copy.repoDir,
      }).catch(() => undefined);
      comparison.refit.review = await review({
        task: migration,
        record: refitRecord,
        meter,
        repoDir: copy.repoDir,
      }).catch(() => undefined);
    } finally {
      await sandbox.dispose();
    }
  } catch (error) {
    comparison.claude.error = error instanceof Error ? error.message : String(error);
  } finally {
    hold.settle(ledger.spentUsd);
    await copy.cleanup().catch(() => undefined);
  }
  return comparison;
}

/** Repos whose screen found no checks of their own (only the harness's fallback, or none). */
export function reposWithoutChecks(screenDir: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(screenDir)) return out;
  for (const set of readdirSync(screenDir)) {
    for (const file of readdirSync(join(screenDir, set)).filter((name) => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(screenDir, set, file), 'utf8')) as {
        repo: string;
        checks: { fallback?: boolean }[];
      };
      if (record.checks.every((check) => check.fallback)) out.add(`${set}/${record.repo}`);
    }
  }
  return out;
}

export function formatComparison(
  all: BaselineComparison[],
  noChecks: Set<string> = new Set(),
): string {
  // A repo with no checks of its own can't pass them on either side, so it is listed, not scored.
  const unscored = all.filter((row) => noChecks.has(`${row.set}/${row.repo}`));
  const rows = all.filter((row) => !noChecks.has(`${row.set}/${row.repo}`));
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  const tally = (subset: BaselineComparison[]) => {
    const n = subset.length;
    const refit = subset.filter((row) => row.refit.passesChecks).length;
    const claude = subset.filter((row) => row.claude.passesChecks).length;
    const refitRight = subset.filter((row) => row.refit.review?.opinion === 'looks-right').length;
    const claudeRight = subset.filter((row) => row.claude.review?.opinion === 'looks-right').length;
    const cost = (side: 'refit' | 'claude') =>
      subset.reduce((sum, row) => sum + row[side].costUsd, 0) / (n || 1);
    return `| ${n} | ${refit} (${pct(refit, n)}) | ${claude} (${pct(claude, n)}) | ${refitRight} (${pct(refitRight, n)}) | ${claudeRight} (${pct(claudeRight, n)}) | $${cost('refit').toFixed(2)} | $${cost('claude').toFixed(2)} |`;
  };
  const header =
    '| Tasks | Refit passes checks | Claude passes checks | Reviewer: Refit looks right | Reviewer: Claude looks right | Refit $/task | Claude $/task |\n| --- | --- | --- | --- | --- | --- | --- |';
  const verified = rows.filter((row) => row.refit.outcome === 'verified');
  return [
    '# Refit vs plain Claude',
    '',
    `Same model (${MODEL}), same tasks, same sandbox and setup. Plain Claude gets one prompt and plain file and shell tools.`,
    '',
    '## Every task Refit attempted',
    '',
    header,
    tally(rows),
    '',
    '## Only the tasks Refit verified',
    '',
    header,
    tally(verified),
    '',
    `Refit verified ${verified.length} of ${rows.length}; plain Claude has no proof-test rule, so "verified" applies to Refit only.`,
    '',
    `${unscored.length} more tasks are on repos with no checks of their own, so neither side can pass them; they are listed below, judged only by the reviewer.`,
    '',
    '| Set | Repo | Change | Refit | Claude | Reviewer (Refit / Claude) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...all.map(
      (row) =>
        `| ${row.set} | ${row.repo} | ${row.title.replace(/\|/g, '/').slice(0, 80)} | ${row.refit.outcome}${noChecks.has(`${row.set}/${row.repo}`) ? ' (no repo checks)' : row.refit.passesChecks ? '' : ' (checks fail)'} | ${row.claude.error ? `error: ${row.claude.error.slice(0, 60)}` : noChecks.has(`${row.set}/${row.repo}`) ? 'no repo checks' : row.claude.passesChecks ? 'passes checks' : 'checks fail'} | ${row.refit.review?.opinion ?? '-'} / ${row.claude.review?.opinion ?? '-'} |`,
    ),
    '',
  ].join('\n');
}

async function main(argv: string[]) {
  const flag = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const inDir = resolve(flag('in') ?? 'evals/reports/round-3/iter-1');
  const outDir = resolve(flag('out') ?? 'evals/reports/round-3/baseline-iter-1');
  const budgetUsd = Number(flag('budget-usd'));
  const concurrency = Number(flag('concurrency') ?? 2);
  const noChecks = reposWithoutChecks(resolve(flag('screen') ?? join(inDir, '..', 'screen')));
  if (argv.includes('--report-only')) {
    const cached = readdirSync(outDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(outDir, name), 'utf8')) as BaselineComparison);
    const report = formatComparison(
      cached.sort((a, b) => a.taskId.localeCompare(b.taskId)),
      noChecks,
    );
    writeFileSync(join(outDir, 'COMPARISON.md'), report);
    console.log(report);
    return;
  }
  if (!(budgetUsd > 0)) throw new Error('--budget-usd is required and must be above zero');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY for the baseline.');
  mkdirSync(outDir, { recursive: true });
  const budget = createBudget(budgetUsd);
  const review = createReviewer(anthropicModelClient({ budget }));
  const todo = attempted(inDir);
  const rows: BaselineComparison[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++] as (typeof todo)[number];
      const file = join(outDir, `${item.task.taskId.replace(/\W+/g, '-')}.json`);
      if (existsSync(file)) {
        rows.push(JSON.parse(readFileSync(file, 'utf8')) as BaselineComparison);
        continue;
      }
      const row = await compareOne(item, review, budget).catch(
        (error: unknown): BaselineComparison => ({
          set: item.result.set,
          repo: item.result.repo,
          taskId: item.task.taskId,
          title: item.task.change?.title ?? '',
          refit: {
            outcome: item.task.record?.outcome ?? '',
            passesChecks: false,
            costUsd: 0,
            diffLines: 0,
          },
          claude: {
            passesChecks: false,
            costUsd: 0,
            prepCostUsd: 0,
            diffLines: 0,
            transcriptPath: '',
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
      console.log(
        `${row.repo} ${row.taskId.split(':').at(-1)}: Refit ${row.refit.outcome}, Claude ${row.claude.error ? 'error' : row.claude.passesChecks ? 'passes checks' : 'checks fail'} ($${row.claude.costUsd.toFixed(2)})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  const report = formatComparison(
    rows.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    noChecks,
  );
  writeFileSync(join(outDir, 'COMPARISON.md'), report);
  console.log(report);
  console.log(`Spent $${budget.spentUsd().toFixed(2)} of $${budgetUsd}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

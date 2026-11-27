// The MVP smoke test: the three sample repos end to end with a
// fake model, through scanRepo and runRepoJob, into memory, the advisory reviewer and scoring.
//
//   npm run smoke -w evals                      (runs this after the API smoke test)
//   node evals/smoke/mvp.ts [--orchestrator real]
//
// It spends $0, needs no network and runs nothing from the fixtures. By default local stand-ins
// (mvp-fake.ts) play the orchestrator; `--orchestrator real` uses orchestrator/index.ts with its
// offline parts.
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createRetriever,
  latestScanReports,
  learnFromRun,
  listRunViews,
  LocalEmbedder,
  JsonMemoryStore,
  recordScanReport,
  recordVerdict,
  type JsonRequest,
  type Model,
} from '../../memory/index.ts';
import type {
  ExternalTask,
  OpenPullRequest,
  RunRepoJob,
  ScanReport,
  ScanRepo,
} from '../../shared/types.ts';
import { FakeModelClient } from '../reviewer/model.ts';
import { createReviewer } from '../reviewer/reviewer.ts';
import { BudgetLedger } from '../runner/budget.ts';
import type { RepoResult, TaskResult } from '../runner/types.ts';
import { familyOf, formatReport, scoreResults, type Score } from '../scoring/score.ts';
import { createFakeRunRepoJob, createFakeScanRepo } from './mvp-fake.ts';

/** The three sample repos in the refit-dev test org, and the fixture standing in for each. */
export const MVP_REPOS = [
  { repo: 'refit-dev/demo-node-api', fixture: 'demo-node-api' },
  { repo: 'refit-dev/demo-python-app', fixture: 'demo-python-app' },
  { repo: 'refit-dev/demo-next-web', fixture: 'demo-next-web' },
] as const;

/** Simulated cap for the run. The fake model costs nothing real. */
export const MVP_SMOKE_BUDGET_USD = 1;

/** The demo needs PRs of these families. */
const DEMO_FAMILIES = [['runtime'], ['model'], ['ci', 'library', 'framework', 'api']] as const;

export type Orchestrator = { scanRepo: ScanRepo; runRepoJob: RunRepoJob; source: string };

export type MvpSmokeOutcome = {
  reports: ScanReport[];
  results: RepoResult[];
  score: Score;
  report: string;
  problems: string[];
  memoryDir: string;
  orchestrator: string;
};

export function fakeOrchestrator(): Orchestrator {
  const scanRepo = createFakeScanRepo();
  return { scanRepo, runRepoJob: createFakeRunRepoJob(scanRepo), source: 'local stand-ins' };
}

/** orchestrator/index.ts's scanRepo and runRepoJob. */
export async function realOrchestrator(): Promise<Orchestrator> {
  // This test spends $0: with no key the orchestrator's offline stand-ins play every AI part.
  delete process.env.ANTHROPIC_API_KEY;
  const { scanRepo, runRepoJob } = await import('../../orchestrator/index.ts');
  return { scanRepo, runRepoJob, source: 'orchestrator/index.ts' };
}

// The fake memory model: one recipe per run, merged into an existing one for the same dependency.
function fakeMemoryModel(): Model {
  return {
    async json<T>({ schema, prompt }: JsonRequest): Promise<T> {
      const properties = (schema as { properties: Record<string, unknown> }).properties;
      const existing = prompt.match(/"id": "(recipe-[^"]+)"/)?.[1] ?? null;
      if ('diffSketch' in properties) {
        return {
          sameAsRecipeId: existing,
          preconditions: 'Fake extraction: the dependency is pinned to an old version.',
          steps: 'Fake extraction: move every declared version together.',
          pitfalls: 'Fake extraction: none recorded.',
          diffSketch: '- old version\n+ new version',
        } as T;
      }
      if ('picks' in properties) {
        const shown = [...prompt.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
        return { picks: shown.map((id) => ({ id, why: 'fake judge' })) } as T;
      }
      if ('sameAsRecipeId' in properties) return { sameAsRecipeId: null, pitfalls: '' } as T;
      return { prompt: 'Fake skill.' } as T;
    },
  };
}

// The fake reviewer: concerns on a needs-review PR, looks-right otherwise. Advisory either way.
function fakeReviewerReply(request: { prompt: string }): string {
  const grade = request.prompt.match(/Grade the agent gave: (\S+)/)?.[1];
  return JSON.stringify(
    grade === 'needs-review'
      ? {
          opinion: 'has-concerns',
          summary: 'Fake review: the PR says what it could not prove.',
          concerns: [{ file: '', issue: 'Fake concern: unproven behaviour.', severity: 'medium' }],
          checkFirst: ['the unproven note'],
        }
      : { opinion: 'looks-right', summary: 'Fake review.', concerns: [], checkFirst: [] },
  );
}

export async function runMvpSmoke(
  options: { orchestrator?: Orchestrator; dryRun?: boolean } = {},
): Promise<MvpSmokeOutcome> {
  const orchestrator = options.orchestrator ?? fakeOrchestrator();
  const fixturesDir = join(import.meta.dirname, 'fixtures');
  const memoryDir = mkdtempSync(join(tmpdir(), 'refit-mvp-memory-'));
  const store = new JsonMemoryStore(memoryDir);
  const memory = { store, embedder: new LocalEmbedder(), model: fakeMemoryModel() };
  const ledger = new BudgetLedger(MVP_SMOKE_BUDGET_USD);
  const review = createReviewer(new FakeModelClient(fakeReviewerReply));
  const problems: string[] = [];
  const reports: ScanReport[] = [];
  const results: RepoResult[] = [];
  const allTasks: ExternalTask[] = [];
  let prNumber = 0;

  for (const [index, { repo, fixture }] of MVP_REPOS.entries()) {
    const started = Date.now();
    // A fresh copy per repo, like the app's checkout; the fixture itself is never touched.
    const dir = mkdtempSync(join(tmpdir(), 'refit-mvp-smoke-'));
    cpSync(join(fixturesDir, fixture), dir, { recursive: true });

    const { report, tasks } = await orchestrator.scanRepo(repo, dir);
    allTasks.push(...tasks);
    ledger.charge(report.costUsd, 'inventory scan');
    await recordScanReport(report, store);
    reports.push(report);
    if (report.errors.length) problems.push(`${repo}: scan errors: ${report.errors.join('; ')}`);
    if (!report.items.some((item) => item.status === 'open')) {
      problems.push(`${repo}: the scan found nothing behind`);
    }

    const opened: string[] = [];
    // Fake PR opener: no GitHub call. Each URL is labelled fake.
    const openPullRequest: OpenPullRequest = async () => {
      const url = `https://github.com/${repo}/pull/fake-${++prNumber}`;
      opened.push(url);
      return url;
    };
    const records = await orchestrator.runRepoJob({
      repo,
      dir,
      openPullRequest,
      dryRun: options.dryRun,
      tasks,
    });

    const byId = new Map<string, ExternalTask>(tasks.map((task) => [task.id, task]));
    const taskResults: TaskResult[] = [];
    for (const record of records) {
      const task = byId.get(record.taskId);
      if (!task) {
        problems.push(`${repo}: record ${record.taskId} has no task in the scan`);
        continue;
      }
      ledger.charge(record.costUsd, `task ${task.id}`);
      await learnFromRun({ task, record, transcript: `fake transcript for ${task.id}` }, memory);
      const reviewed = record.diff
        ? await review({ task, record, meter: ledger, repoDir: dir })
        : undefined;
      const attempted = record.diff !== '' || record.outcome === 'not-affected';
      taskResults.push({
        taskId: task.id,
        changeId: task.change.id,
        kind: task.change.kind,
        attempted,
        ...(!attempted && { noAttemptReason: `${record.outcome} with an empty diff` }),
        record,
        ...(reviewed && { review: reviewed }),
      });
    }
    if (options.dryRun && opened.length) problems.push(`${repo}: a dry run opened PRs`);
    if (!options.dryRun) {
      const withDiff = records.filter((r) => r.diff && r.outcome !== 'not-affected');
      if (withDiff.some((r) => !r.pr)) problems.push(`${repo}: a task with a diff has no PR`);
    }

    results.push({
      set: 'mvp-smoke-3',
      index,
      repo,
      commit: '0'.repeat(40),
      provider: 'mixed',
      usages: new Set(report.items.map((item) => item.dependency.name)).size,
      changes: report.items.length,
      verdict: taskResults.length ? 'tasks' : 'not-affected',
      tasks: taskResults,
      costUsd: report.costUsd + records.reduce((sum, r) => sum + r.costUsd, 0),
      durationMs: Date.now() - started,
    });
  }

  const score = scoreResults(results);
  if (score.attemptedRate !== 1) problems.push(`attempted rate ${score.attemptedRate}, want 1`);
  for (const bug of score.attemptBugs) problems.push(`no attempt: ${bug.repo} ${bug.reason}`);
  const tasks = results.flatMap((repo) => repo.tasks);
  if (!options.dryRun) {
    for (const families of DEMO_FAMILIES) {
      const pr = tasks.find(
        (task) => task.record?.pr && (families as readonly string[]).includes(familyOf(task.kind)),
      );
      if (!pr) problems.push(`no demo PR for ${families.join(' or ')}`);
    }
  }
  if (!reports.some((r) => r.items.some((item) => item.status === 'not-affected'))) {
    problems.push('no change was judged not affected, so the verdict path went unexercised');
  }
  const unreviewed = tasks.filter((task) => task.record?.diff && !task.review);
  if (unreviewed.length) problems.push(`PRs the reviewer never saw: ${unreviewed.length}`);
  if (ledger.spentUsd > MVP_SMOKE_BUDGET_USD) problems.push('simulated spend went over the cap');

  // Memory: one report per repo, every run on the dashboard, a merge recorded, a recipe retrievable.
  const latest = await latestScanReports({}, store);
  if (latest.length !== MVP_REPOS.length) problems.push(`latest reports: ${latest.length}, want 3`);
  const views = await listRunViews({}, store);
  if (views.length !== tasks.length)
    problems.push(`run views: ${views.length}, want ${tasks.length}`);
  const merged = tasks.find((task) => task.record?.pr && familyOf(task.kind) === 'runtime');
  if (merged?.record?.pr) {
    await recordVerdict(merged.record.pr, 'merged', memory);
    const view = (await listRunViews({}, store)).find((v) => v.pr === merged.record?.pr);
    if (!view?.summary.includes('A human merged the PR.')) {
      problems.push('a merged verdict did not reach the dashboard');
    }
  }
  const recipes = await store.listRecipes();
  if (!recipes.some((recipe) => recipe.upgrade))
    problems.push('memory distilled no upgrade recipe');
  // The same upgrade in another repo should find what the first one taught.
  const repeat = allTasks.find((task) => familyOf(task.change.kind) === 'runtime');
  if (repeat) {
    const retrieved = await createRetriever(memory)({ ...repeat, repo: 'refit-dev/another-repo' });
    if (retrieved.length === 0) problems.push('memory retrieved no recipe for a repeat upgrade');
  }

  const summary = reports
    .map((r) => {
      const open = r.items.filter((item) => item.status === 'open').length;
      return `- ${r.repo}: ${open} behind, ${r.items.length - open} not affected`;
    })
    .join('\n');
  const prs = tasks
    .filter((task) => task.record?.pr)
    .map((task) => `- ${task.record?.outcome} ${task.kind}: ${task.record?.pr}`)
    .join('\n');
  const report = `${formatReport(score, 'Refit MVP smoke test (fake model, $0 real spend)')}
Orchestrator: ${orchestrator.source}
What's behind:
${summary}
PRs (fake URLs, nothing opened on GitHub):
${prs || '- none (dry run)'}
Memory: ${recipes.length} recipe(s), ${views.length} run view(s), ${latest.length} latest report(s) in ${memoryDir}
Simulated spend: $${ledger.spentUsd.toFixed(4)} of a $${MVP_SMOKE_BUDGET_USD} simulated cap
${problems.length === 0 ? 'MVP SMOKE OK' : `MVP SMOKE FAILED\n${problems.map((p) => `- ${p}`).join('\n')}`}
`;
  return {
    reports,
    results,
    score,
    report,
    problems,
    memoryDir,
    orchestrator: orchestrator.source,
  } satisfies MvpSmokeOutcome;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const which = args[args.indexOf('--orchestrator') + 1];
  const chosen =
    args.includes('--orchestrator') && which === 'real' ? await realOrchestrator() : undefined;
  const outcome = await runMvpSmoke({ orchestrator: chosen });
  console.log(outcome.report);
  process.exitCode = outcome.problems.length === 0 ? 0 : 1;
}

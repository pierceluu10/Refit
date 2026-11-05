// runTask: sandbox → baseline checks → agent → re-check → iterate (escalating when stuck) → record.
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationTask, RetrieveRecipes, RunTask, ToolPack } from '../shared/types.ts';
import { claudeAgentSession } from './agent.ts';
import {
  compareChecks,
  detectChecks,
  detectPackageManager,
  installCommand,
  packageManagerVersion,
  runChecks,
  runChecksAfter,
} from './checks.ts';
import {
  checksTouchChange,
  isRepoTask,
  labelFix,
  liveFindings,
  providersOf,
  type RepoTask,
  type ScanResult,
} from './findings.ts';
import { installWithLayer } from './install-layers.ts';
import { BudgetLedger, budgetFromEnv } from './ledger.ts';
import { filesFromDiff, writePrBody } from './pr.ts';
import { applyProvenFixes } from './proven.ts';
import {
  PROMPT_VERSION,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
  packageManagerNote,
} from './prompt.ts';
import { createSandbox, sandboxEnvNote } from './sandbox.ts';
import { preparationNotes, prepareRepo, runSteps, withEnv } from './prepare.ts';
import { redactSecrets } from './secrets.ts';
import { summarizeRun, type IterationSummary, type Step } from './summary.ts';
import { buildTools } from './tools.ts';
import type { PlanPreparation } from './prepare.ts';
import type {
  CheckCommand,
  CheckComparison,
  CheckRun,
  FinishReport,
  HarnessDeps,
  HarnessRunRecord,
  Sandbox,
  SessionResult,
  ValidatorRun,
} from './types.ts';
import { failingCheckers, gradeValidators } from './validators.ts';

export const MODEL = 'claude-sonnet-5-5';
export const ESCALATION_MODEL = 'claude-opus-5-5';
// The stream meter stops a query once its grant is spent, so the most it can overshoot is the call
// in flight: a query is given the remainder minus this and none starts below it. Sessions cap one
// call's output (agent.ts), so at Sonnet's prices this covers it with its input and cache reads.
export const TURN_RESERVE_USD = 0.15;
// Opus costs twice as much per token and re-reads the session uncached, so its call needs more room.
const ESCALATED_RESERVE_FACTOR = 3;
// How many times a rescan that still finds something goes back to the session.
const MAX_RESCAN_RETRIES = 2;

// shortcut: stubs until providers/ (F2) and memory/ (O3) land; the orchestrator passes the real ones.
const emptyToolPack = async (provider: string): Promise<ToolPack> => ({
  provider,
  tools: [],
  playbooks: {},
});
const noRecipes: RetrieveRecipes = async () => [];

// A repo session works from the list, so it takes each provider's tools but no playbook.
function mergePacks(packs: ToolPack[]): ToolPack {
  const tools = new Map(packs.flatMap((pack) => pack.tools.map((tool) => [tool.name, tool])));
  return {
    provider: packs.length === 1 && packs[0] ? packs[0].provider : 'list',
    tools: [...tools.values()],
    playbooks: {},
  };
}

// Install layers stay within one owner.
const ownerOf = (repo: string) => repo.split('/')[0] ?? '';

const newFailureCount = (comparisons: CheckComparison[]) =>
  comparisons.reduce((sum, comparison) => sum + comparison.newFailures.length, 0);

export function decideOutcome(input: {
  diff: string;
  report?: FinishReport;
  comparisons: CheckComparison[];
  after: CheckRun[];
  validatorRuns: ValidatorRun[];
}): HarnessRunRecord['outcome'] {
  const { diff, report, comparisons, after, validatorRuns } = input;
  const changed = diff.trim() !== '';
  // The agent's own test of the change must pass, unless it said why no test can be written.
  const proofTest = report?.proofTest?.trim();
  const tested = proofTest
    ? after.some((run) => run.name === proofTest && run.ok)
    : (report?.noProofTestReason ?? '').trim() !== '';
  if (!changed && report?.verdict === 'not-affected') return 'not-affected';
  // No edit and no word from the agent means no attempt happened (budget or model down).
  if (!changed && !report) return 'failed';
  const proven =
    changed &&
    report !== undefined &&
    // Checks that fail alike before and after add no new failures, but they prove nothing either.
    after.some((run) => run.ok) &&
    newFailureCount(comparisons) === 0 &&
    tested &&
    gradeValidators(report.validators, validatorRuns).every((grade) => grade.passed) &&
    // What the agent lists as unproven goes to the PR for the reviewer; it does not hold back the grade.
    failingCheckers(validatorRuns).length === 0;
  return proven ? 'verified' : 'needs-review';
}

// Install, the repo's own codegen and the baseline checks: what runTask does before the agent, and
// what the eval screen runs to tell a green baseline from a red one.
export async function prepareBaseline(
  sandbox: Sandbox,
  ledger: BudgetLedger,
  planPreparation?: PlanPreparation,
  layerScope = '',
) {
  const pm = await detectPackageManager(sandbox.dir);
  const pmVersion = await packageManagerVersion(sandbox.dir, pm);
  const install =
    pm === 'none'
      ? undefined
      : await installWithLayer(sandbox, {
          pm,
          version: pmVersion,
          command: installCommand(pm, pmVersion),
          scope: layerScope,
        });
  const checks = await detectChecks(sandbox.dir, pm, pmVersion);
  const commands = checks.map((check) => check.command);
  // The repo's own codegen, which install scripts off never ran, and the placeholder env its
  // checks need. What it writes is snapshotted, so only the agent's edit is in the PR, and the PR
  // names any repo file it changed.
  const changed = new Set<string>();
  const settle = async () => {
    checks.forEach((check, i) => (check.command = withEnv(commands[i] as string, preparation.env)));
    for (const file of filesFromDiff(await sandbox.diff().catch(() => ''))) changed.add(file);
    await sandbox.snapshot?.();
    return runChecks(sandbox, checks);
  };
  const preparation = await prepareRepo(sandbox, checks, ledger, planPreparation);
  let before = await settle();
  // One more look with the failures in hand: a missing env var or generated client often shows
  // only when a check runs.
  const failing = before.filter((run) => !run.ok);
  if (failing.length > 0 && !preparation.error) {
    const failures = failing
      .map((run) => `Check ${run.name} (\`${run.command}\`):\n${run.output.slice(-2500)}`)
      .join('\n\n');
    const retry = await prepareRepo(sandbox, checks, ledger, planPreparation, failures);
    if (retry.steps.length > 0 || Object.keys(retry.env).length > 0) {
      preparation.steps.push(...retry.steps);
      Object.assign(preparation.env, retry.env);
      preparation.reasoning = `${preparation.reasoning}\n${retry.reasoning}`.trim();
      before = await settle();
    }
  }
  if (changed.size > 0) preparation.changedFiles = [...changed];
  return { pm, pmVersion, install, checks, preparation, before };
}

export async function runTask(
  task: MigrationTask,
  repoDir: string,
  deps: HarnessDeps = {},
): Promise<HarnessRunRecord> {
  const ledger = new BudgetLedger(deps.budgetUsd ?? budgetFromEnv(), deps.chargeRun);
  const outDir =
    deps.outDir ?? (await mkdtemp(join(tmpdir(), `aptitude-run-${task.id.replace(/\W+/g, '-')}-`)));
  await mkdir(outDir, { recursive: true });
  const transcriptPath = join(outDir, 'transcript.jsonl');
  const log = (event: unknown) =>
    appendFileSync(
      transcriptPath,
      redactSecrets(JSON.stringify({ at: new Date().toISOString(), event })) + '\n',
    );
  const models: string[] = [];
  const timing = { setupMs: 0, sessionMs: 0, checksMs: 0 };
  const started = Date.now();
  let sandbox: Sandbox;
  try {
    sandbox = await (deps.createSandbox ?? createSandbox)(repoDir);
  } catch (error) {
    // Infrastructure failure before any attempt was possible: the only path to 'failed'.
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    log({ type: 'harness', phase: 'sandbox-error', message });
    return {
      taskId: task.id,
      outcome: 'failed',
      diff: '',
      checks: [],
      costUsd: ledger.spentUsd,
      transcriptPath,
      prBody: `The harness could not create a sandbox: ${message}`,
      models,
      promptVersion: PROMPT_VERSION,
      recipeIds: [],
      agentChecks: [],
      summary: `# ${task.id}: failed\nThe harness could not create a sandbox: ${message}\n`,
    };
  }

  let baselineSandbox: Promise<Sandbox> | undefined;
  const agentChecks: CheckCommand[] = [];
  try {
    const loadPack = (provider: string) =>
      (deps.loadToolPack ?? emptyToolPack)(provider).catch(() => emptyToolPack(provider));
    const toolPack = isRepoTask(task)
      ? mergePacks(await Promise.all(providersOf(task).map(loadPack)))
      : await loadPack(task.change.provider);
    const retrieveRecipes = deps.retrieveRecipes ?? noRecipes;
    const recipes = await retrieveRecipes(task).catch(() => []);

    const { pm, pmVersion, install, checks, preparation, before } = await prepareBaseline(
      sandbox,
      ledger,
      deps.planPreparation,
      ownerOf(task.repo),
    );
    log({
      type: 'harness',
      phase: 'baseline',
      pm,
      pmVersion,
      install,
      preparation,
      checks,
      before,
    });

    // Agent-named checks get their baseline from a second, untouched copy of the repo.
    const addCheck = async (named: CheckCommand): Promise<CheckRun> => {
      // The agent's checks get the same placeholder env as the detected ones.
      const check = { ...named, command: withEnv(named.command, preparation.env) };
      baselineSandbox ??= (async () => {
        const box = await (deps.createSandbox ?? createSandbox)(repoDir);
        if (pm !== 'none') {
          await installWithLayer(box, {
            pm,
            version: pmVersion,
            command: installCommand(pm, pmVersion),
            scope: ownerOf(task.repo),
          });
        }
        await runSteps(box, preparation);
        return box;
      })();
      const [run] = await runChecks(await baselineSandbox, [check]);
      checks.push(check);
      agentChecks.push(check);
      before.push(run);
      log({ type: 'harness', phase: 'agent-check', check, before: run });
      return run;
    };

    // Only a check the agent added can go: an attempt it gave up on shouldn't count against it.
    const removeCheck = (name: string): boolean => {
      const at = agentChecks.findIndex((check) => check.name === name);
      if (at < 0) return false;
      agentChecks.splice(at, 1);
      checks.splice(
        checks.findIndex((check) => check.name === name),
        1,
      );
      const run = before.findIndex((candidate) => candidate.name === name);
      if (run >= 0) before.splice(run, 1);
      return true;
    };

    let report: FinishReport | undefined;
    let finishedThisIteration = false;
    const validatorRuns: ValidatorRun[] = [];
    // Every tool call of the current iteration, for the run summary.
    let steps: Step[] = [];
    const iterations: IterationSummary[] = [];
    const tools = buildTools({
      sandbox,
      task,
      toolPack,
      retrieveRecipes,
      checks,
      onFinish: (finished) => {
        report = finished;
        finishedThisIteration = true;
      },
      addCheck,
      removeCheck,
      onToolPackCall: (run) => validatorRuns.push(run),
      fetch: deps.fetch,
    }).map((tool) => ({
      ...tool,
      run: async (input: unknown, context: { repoDir: string }) => {
        const output = await tool.run(input, context);
        steps.push({ tool: tool.name, input, output });
        return output;
      },
    }));
    const sandboxNote = sandboxEnvNote(sandbox);
    const systemPrompt = buildSystemPrompt({
      task,
      toolPack,
      recipes,
      tools,
      budgetUsd: ledger.capUsd,
      sandboxNote,
    });
    const installOutput = install && `${install.stdout}\n${install.stderr}`.trim();

    timing.setupMs = Date.now() - started;
    let after = before;
    let comparisons = compareChecks(before, after);
    let rescan: ScanResult | undefined;
    let provenEntries: string[] = [];
    // A proven fix runs first. It still answers to the checks and the rescan: one that breaks a check
    // is rolled back, and what it leaves goes to Claude, so it can never block an attempt.
    const proven = isRepoTask(task) && sandbox.reset ? await deps.provenFixes?.(task) : undefined;
    if (proven?.length && isRepoTask(task)) {
      const applied = await applyProvenFixes(sandbox.dir, task, proven);
      if (applied.files.length) {
        const checked = await runChecksAfter(sandbox, checks, before);
        const failed = newFailureCount(compareChecks(before, checked)) > 0;
        log({ type: 'harness', phase: 'proven-fix', applied, failed });
        if (failed) await sandbox.reset?.();
        else {
          provenEntries = applied.entryIds;
          after = checked;
          comparisons = compareChecks(before, after);
          rescan = await deps.rescan?.(sandbox.dir);
        }
      }
    }
    const left = rescan ? liveFindings(rescan) : [];
    const provenDone = provenEntries.length > 0 && rescan !== undefined && left.length === 0;
    // What a proven fix left is the session's list.
    const sessionTask: RepoTask | undefined = !isRepoTask(task)
      ? undefined
      : rescan
        ? {
            ...task,
            findings: left,
            entries: task.entries.filter((e) => left.some((f) => f.entryId === e.id)),
          }
        : task;
    const session = deps.session ?? claudeAgentSession;
    let model = deps.model ?? MODEL;
    let prompt = buildKickoffMessage(
      before,
      installOutput,
      packageManagerNote(pm, pmVersion),
      [...preparationNotes(preparation), ...(deps.habitNotes ?? [])],
      sessionTask,
    );
    let sessionId: string | undefined;
    let previousNewFailures = Infinity;
    let silentErrors = 0;
    let rescanRetries = 0;
    if (provenDone) {
      report = {
        verdict: 'migrated',
        summary: `Plain-code proven fixes handled ${provenEntries.join(', ')}. No model ran.`,
        why: 'The list marks these APIs dead, and these fixes have a record of merged PRs.',
        validators: [],
        unproven: [],
        behaviourChanges: [],
        noProofTestReason: 'A proven fix has no session to write a test.',
      };
    }

    // Ends when the checks pass, the agent finishes with an explanation, or the budget runs out.
    const reserveUsd = deps.turnReserveUsd ?? TURN_RESERVE_USD;
    for (
      let iteration = 0;
      !provenDone && iteration < (deps.maxIterations ?? Infinity);
      iteration++
    ) {
      const callReserveUsd =
        model === ESCALATION_MODEL ? reserveUsd * ESCALATED_RESERVE_FACTOR : reserveUsd;
      if (ledger.remainingUsd <= callReserveUsd) break;
      if (!models.includes(model)) models.push(model);
      finishedThisIteration = false;
      steps = [];
      const spentBefore = ledger.spentUsd;
      const sessionStarted = Date.now();
      let result: SessionResult;
      try {
        result = await session({
          model,
          systemPrompt,
          prompt,
          tools,
          sandbox,
          ledger,
          budgetUsd: ledger.remainingUsd - callReserveUsd,
          resume: sessionId,
          maxTurns: 80,
          log,
        });
      } catch (error) {
        result = { finalText: '', stopReason: 'error', error: String(error) };
      }
      sessionId = result.sessionId ?? sessionId;
      const checksStarted = Date.now();
      timing.sessionMs += checksStarted - sessionStarted;
      after = await runChecksAfter(sandbox, checks, before);
      timing.checksMs += Date.now() - checksStarted;
      comparisons = compareChecks(before, after);
      const newFailures = newFailureCount(comparisons);
      rescan = await deps.rescan?.(sandbox.dir);
      const left = (rescan ? liveFindings(rescan) : []).filter(
        (finding) =>
          !(report as FinishReport | undefined)?.falseAlarms?.some(
            (alarm) => alarm.entryId === finding.entryId && alarm.file === finding.file,
          ),
      );
      log({
        type: 'harness',
        phase: 'iteration',
        iteration,
        model,
        result,
        after,
        comparisons,
        rescan,
      });
      iterations.push({ model, stopReason: result.stopReason, steps, comparisons });
      const retryRescan = left.length > 0 && rescanRetries < MAX_RESCAN_RETRIES;
      if (newFailures === 0 && report && !retryRescan) break;
      const finished = report as FinishReport | undefined;
      // Plain code feeds a failure back at least once: a session rarely runs the checks itself.
      const toldOnce = iteration > 0 || newFailures === 0;
      if (toldOnce && !retryRescan && finishedThisIteration && finished?.unproven.length) break;
      // Loop-safety net: a model call that keeps erroring without spending anything is down, not stuck.
      silentErrors =
        result.stopReason === 'error' && ledger.spentUsd === spentBefore ? silentErrors + 1 : 0;
      if (silentErrors >= 3) break;

      // Opus only after a failed check that did not get better. Green checks with only the report
      // missing are not that, and neither is a session that errored: caches are per model, so Opus
      // would re-read the whole session uncached (about $0.75 at 150k tokens) to no end.
      const stuck =
        newFailures > 0 && (result.stopReason !== 'done' || newFailures >= previousNewFailures);
      // Haiku steps up to Sonnet first, and only Sonnet to Opus.
      const escalated = stuck && model !== ESCALATION_MODEL;
      if (escalated) model = model === MODEL ? ESCALATION_MODEL : MODEL;
      previousNewFailures = newFailures;
      if (retryRescan) {
        rescanRetries += 1;
        report = undefined;
      }
      prompt = buildRetryMessage({
        comparisons,
        after,
        hasReport: report !== undefined,
        escalated,
        left: retryRescan
          ? left.map(({ entryId, file, line }) => `${entryId} at ${file}:${line}`)
          : [],
      });
    }

    const diff = redactSecrets(await sandbox.diff());
    const finalReport = report as FinishReport | undefined;
    const proofTest =
      finalReport?.proofTest && after.some((run) => run.name === finalReport.proofTest)
        ? finalReport.proofTest
        : undefined;
    const fixLabel =
      rescan && isRepoTask(task) && !(finalReport?.verdict === 'not-affected' && !diff.trim())
        ? labelFix({
            findings: task.findings,
            rescan,
            newFailures: newFailureCount(comparisons),
            changed: diff.trim() !== '',
            touched: checksTouchChange(
              filesFromDiff(diff),
              after.filter((run) => run.ok).map((run) => run.name),
              proofTest,
            ),
          })
        : undefined;
    const smoke =
      isRepoTask(task) && fixLabel && fixLabel.outcome !== 'failed'
        ? await deps.smoke?.(task).catch(() => undefined)
        : undefined;
    const refused = smoke?.filter((result) => result.outcome === 'refused') ?? [];
    const label =
      fixLabel?.outcome === 'verified' && refused.length
        ? {
            outcome: 'needs-review' as const,
            reason: `The rescan is clean, but ${refused.map((r) => r.model).join(', ')} refused a live call.`,
          }
        : fixLabel;
    const outcome =
      label?.outcome ??
      decideOutcome({ diff, report: finalReport, comparisons, after, validatorRuns });
    const notes =
      ledger.remainingUsd <= reserveUsd
        ? [`The run hit its AI budget of $${ledger.capUsd.toFixed(2)} before the agent finished.`]
        : [];
    const prBody = writePrBody({
      task,
      outcome,
      report: finalReport,
      comparisons,
      validatorRuns,
      agentChecks,
      diff,
      costUsd: ledger.spentUsd,
      models,
      promptVersion: PROMPT_VERSION,
      sandboxNote,
      notes,
      prepared: preparationNotes(preparation),
      proofTest,
      rescan,
      labelReason: label?.reason,
      smoke,
    });
    const summary = summarizeRun({
      task,
      outcome,
      costUsd: ledger.spentUsd,
      before,
      iterations,
      report: finalReport,
      files: filesFromDiff(diff),
    });
    const record: HarnessRunRecord = {
      taskId: task.id,
      outcome,
      diff,
      checks: comparisons.map(({ name, before, after }) => ({ name, before, after })),
      costUsd: ledger.spentUsd,
      transcriptPath,
      prBody,
      models,
      promptVersion: PROMPT_VERSION,
      recipeIds: recipes.map((recipe) => recipe.id),
      agentChecks: agentChecks.map(({ name, command }) => {
        const comparison = comparisons.find((c) => c.name === name);
        return {
          name,
          command: redactSecrets(command),
          before: comparison?.before ?? 'not run',
          after: comparison?.after ?? 'not run',
        };
      }),
      summary,
      preparation,
      ...(label ? { note: label.reason } : {}),
      ...(provenEntries.length ? { provenFixes: provenEntries } : {}),
      ...(finalReport ? { report: finalReport } : {}),
      ...(rescan ? { rescan } : {}),
      ...(smoke?.length ? { smoke } : {}),
      cache: ledger.cache,
      timing,
    };
    log({ type: 'harness', phase: 'done', outcome, ledger: ledger.entries });
    await writeFile(join(outDir, 'diff.patch'), diff);
    await writeFile(join(outDir, 'pr-body.md'), prBody);
    await writeFile(join(outDir, 'summary.md'), summary);
    await writeFile(join(outDir, 'record.json'), JSON.stringify(record, null, 2));
    return record;
  } finally {
    await sandbox.dispose();
    await baselineSandbox?.then((box) => box.dispose()).catch(() => {});
  }
}

runTask satisfies RunTask;

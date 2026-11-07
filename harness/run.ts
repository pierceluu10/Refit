// runTask (API migrations) and runExternalTask (upgrades and any other external change):
// sandbox → baseline checks → agent → re-check → iterate (escalating when stuck) → record.
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpgradeTools, upgradePlaybook } from '../providers/upgrades/index.ts';
import type {
  ExternalTask,
  MigrationTask,
  Recipe,
  RunExternalTask,
  RunTask,
  ToolPack,
} from '../shared/types.ts';
import { claudeAgentSession } from './agent.ts';
import {
  compareChecks,
  detectChecks,
  detectPackageManager,
  installCommand,
  packageManagerVersion,
  runChecks,
} from './checks.ts';
import { BudgetLedger, budgetFromEnv } from './ledger.ts';
import { filesFromDiff, prTitle, writePrBody } from './pr.ts';
import { buildProofTools } from './proof/index.ts';
import {
  PROMPT_VERSION,
  isExternalTask,
  baselineRuntime,
  targetRuntime,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
  packageManagerNote,
} from './prompt.ts';
import { createSandbox, sandboxEnvNote } from './sandbox.ts';
import { redactOutbound, redactSecrets } from './secrets.ts';
import { summarizeRun, type IterationSummary, type Step } from './summary.ts';
import { buildTools, runtimeLabel, runtimesFor } from './tools.ts';
import type {
  CheckCommand,
  CheckComparison,
  CheckRun,
  FinishReport,
  HarnessDeps,
  HarnessRunRecord,
  HarnessTask,
  Runtime,
  Sandbox,
  SessionResult,
  UpgradeKit,
  ValidatorRun,
} from './types.ts';
import { failingCheckers, gradeValidators } from './validators.ts';

export const MODEL = 'claude-sonnet-5-5';
export const ESCALATION_MODEL = 'claude-opus-5-5';
// The Agent SDK enforces maxBudgetUsd only between turns; one turn overshot by about $0.80 on
// 2026-11-01's dev run, so a query is given the remainder minus this and none starts below it.
export const TURN_RESERVE_USD = 1;

// Callers without a ToolPack or memory (the CLI, tests) get neither; the orchestrator passes the real ones.
const emptyToolPack = async (provider: string): Promise<ToolPack> => ({
  provider,
  tools: [],
  playbooks: {},
});
const noRecipes = async (): Promise<Recipe[]> => [];

// F2's upgrade tools, and its playbook for the task's kind and dependency.
export async function loadUpgradeKit(
  task: ExternalTask,
  fetch?: typeof globalThis.fetch,
): Promise<UpgradeKit> {
  const { kind, dependency } = task.change;
  return {
    tools: createUpgradeTools({ fetch }),
    playbooks: { [kind]: upgradePlaybook(kind, dependency) },
  };
}

const newFailureCount = (comparisons: CheckComparison[]) =>
  comparisons.reduce((sum, comparison) => sum + comparison.newFailures.length, 0);

export function decideOutcome(input: {
  diff: string;
  report?: FinishReport;
  comparisons: CheckComparison[];
  after: CheckRun[];
  validatorRuns: ValidatorRun[];
  // What the harness itself could not prove, such as the target runtime; any keeps it in needs-review.
  harnessUnproven?: string[];
}): HarnessRunRecord['outcome'] {
  const { diff, report, comparisons, after, validatorRuns } = input;
  const changed = diff.trim() !== '';
  if (!changed && report?.verdict === 'not-affected') return 'not-affected';
  // No edit and no word from the agent means no attempt happened (budget or model down).
  if (!changed && !report) return 'failed';
  const proven =
    changed &&
    report !== undefined &&
    // Checks that fail alike before and after add no new failures, but they prove nothing either.
    after.some((run) => run.ok) &&
    newFailureCount(comparisons) === 0 &&
    gradeValidators(report.validators, validatorRuns).every((grade) => grade.passed) &&
    failingCheckers(validatorRuns).length === 0 &&
    report.unproven.length === 0 &&
    (input.harnessUnproven ?? []).length === 0;
  return proven ? 'verified' : 'needs-review';
}

export async function runTask(
  task: MigrationTask,
  repoDir: string,
  deps: HarnessDeps = {},
): Promise<HarnessRunRecord> {
  return runHarness(task, repoDir, deps);
}

// Any external change: runtime, framework, library, advisory, base image, CI, AI model or API.
export async function runExternalTask(
  task: ExternalTask,
  repoDir: string,
  deps: HarnessDeps = {},
): Promise<HarnessRunRecord> {
  return runHarness(task, repoDir, deps);
}

async function runHarness(
  task: HarnessTask,
  repoDir: string,
  deps: HarnessDeps,
): Promise<HarnessRunRecord> {
  const ledger = new BudgetLedger(deps.budgetUsd ?? budgetFromEnv(), deps.chargeRun);
  const outDir =
    deps.outDir ?? (await mkdtemp(join(tmpdir(), `refit-run-${task.id.replace(/\W+/g, '-')}-`)));
  await mkdir(outDir, { recursive: true });
  const transcriptPath = join(outDir, 'transcript.jsonl');
  const log = (event: unknown) =>
    appendFileSync(
      transcriptPath,
      redactSecrets(JSON.stringify({ at: new Date().toISOString(), event })) + '\n',
    );
  const models: string[] = [];
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
      prTitle: prTitle(task),
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
    const toolPack = await (deps.loadToolPack ?? emptyToolPack)(task.change.provider).catch(() =>
      emptyToolPack(task.change.provider),
    );
    const external = isExternalTask(task) ? task : undefined;
    const retrieveRecipes = (
      external ? (deps.retrieveExternalRecipes ?? noRecipes) : (deps.retrieveRecipes ?? noRecipes)
    ) as (task: HarnessTask) => Promise<Recipe[]>;
    const recipes = await retrieveRecipes(task).catch(() => []);
    const kit: UpgradeKit = external
      ? await (deps.loadUpgradeKit?.(external) ?? loadUpgradeKit(external, deps.fetch)).catch(
          () => ({ tools: [], playbooks: {} }),
        )
      : { tools: [], playbooks: {} };
    const runtimes = deps.runtimes ?? runtimesFor(sandbox);

    const pm = await detectPackageManager(sandbox.dir);
    const pmVersion = await packageManagerVersion(sandbox.dir, pm);
    const install = pm === 'none' ? undefined : await sandbox.exec(installCommand(pm, pmVersion));
    const checks = await detectChecks(sandbox.dir, pm, pmVersion);
    // When the change moves a runtime, the checks after the change run on the new one: before on the
    // old version, after on the new. If the sandbox cannot provide one, the PR says so.
    const old = baselineRuntime(task);
    const oldProbe = old && (await runtimes.probe(sandbox, old));
    const baselineOn = oldProbe && oldProbe.ok ? old : undefined;
    const baselineChecks = (box: Sandbox, list: CheckCommand[]) =>
      baselineOn ? runtimes.runChecks(box, baselineOn, list) : runChecks(box, list);
    const before = await baselineChecks(sandbox, checks);
    log({ type: 'harness', phase: 'baseline', pm, pmVersion, install, checks, before, oldProbe });

    const target = targetRuntime(task);
    let checksRuntime: Runtime | undefined;
    const kickoffNotes: string[] = [];
    let runtimeProblem: string | undefined;
    if (target) {
      const probe = await runtimes.probe(sandbox, target);
      log({ type: 'harness', phase: 'runtime-probe', target, probe });
      if (probe.ok) {
        checksRuntime = target;
        kickoffNotes.push(
          `The baseline checks ran on ${baselineOn ? runtimeLabel(baselineOn) : "the sandbox's default runtime"}, on the original code. After your change the harness runs them on ${runtimeLabel(target)} (${probe.detail}).`,
        );
      } else {
        runtimeProblem = `The checks could not run on ${runtimeLabel(target)} in this sandbox (${probe.detail}); they ran on its default runtime.`;
        kickoffNotes.push(
          `${runtimeProblem} Try \`run_checks\` with another \`runtime\` version of ${target.name}; if none works, the PR lists the runtime as unproven.`,
        );
      }
    }
    const afterChecks = (list: CheckCommand[]) =>
      checksRuntime ? runtimes.runChecks(sandbox, checksRuntime, list) : runChecks(sandbox, list);

    // Agent-named checks and proof checks get their baseline from a second, untouched, installed copy.
    const installedSandbox = async (dir: string) => {
      const box = await (deps.createSandbox ?? createSandbox)(dir);
      if (pm !== 'none') await box.exec(installCommand(pm, pmVersion));
      return box;
    };
    const addCheck = async (check: CheckCommand): Promise<CheckRun> => {
      baselineSandbox ??= installedSandbox(repoDir);
      const [run] = await baselineChecks(await baselineSandbox, [check]);
      checks.push(check);
      agentChecks.push(check);
      before.push(run);
      log({ type: 'harness', phase: 'agent-check', check, before: run });
      return run;
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
      upgradeTools: kit.tools,
      proofTools: buildProofTools({
        sandbox,
        baselineDir: repoDir,
        createSandbox: installedSandbox,
      }),
      runtimes,
      onRuntime: (runtime) => {
        // The agent found a working runtime; the final checks use it if it is the one that moves.
        if (!target || runtime.name === target.name) {
          checksRuntime = runtime;
          if (!target || runtime.version.split('.')[0] === target.version.split('.')[0]) {
            runtimeProblem = undefined;
          }
        }
      },
      onFinish: (finished) => {
        report = finished;
        finishedThisIteration = true;
      },
      addCheck,
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
      upgradePlaybooks: kit.playbooks,
    });
    const installOutput = install && `${install.stdout}\n${install.stderr}`.trim();

    const session = deps.session ?? claudeAgentSession;
    let model = MODEL;
    let prompt = buildKickoffMessage(
      before,
      installOutput,
      packageManagerNote(pm, pmVersion),
      kickoffNotes,
    );
    let sessionId: string | undefined;
    let after: CheckRun[] = before;
    let comparisons = compareChecks(before, after);
    let previousNewFailures = Infinity;
    let silentErrors = 0;

    // Ends when the checks pass, the agent finishes with an explanation, or the budget runs out.
    const reserveUsd = deps.turnReserveUsd ?? TURN_RESERVE_USD;
    for (let iteration = 0; iteration < (deps.maxIterations ?? Infinity); iteration++) {
      if (ledger.remainingUsd <= reserveUsd) break;
      if (!models.includes(model)) models.push(model);
      finishedThisIteration = false;
      steps = [];
      const spentBefore = ledger.spentUsd;
      let result: SessionResult;
      try {
        result = await session({
          model,
          systemPrompt,
          prompt,
          tools,
          sandbox,
          ledger,
          budgetUsd: ledger.remainingUsd - reserveUsd,
          resume: sessionId,
          maxTurns: 80,
          log,
        });
      } catch (error) {
        result = { finalText: '', stopReason: 'error', error: String(error) };
      }
      sessionId = result.sessionId ?? sessionId;
      after = await afterChecks(checks);
      comparisons = compareChecks(before, after);
      const newFailures = newFailureCount(comparisons);
      log({ type: 'harness', phase: 'iteration', iteration, model, result, after, comparisons });
      iterations.push({ model, stopReason: result.stopReason, steps, comparisons });
      if (newFailures === 0 && report) break;
      const finished = report as FinishReport | undefined;
      if (finishedThisIteration && finished && finished.unproven.length > 0) break;
      // Loop-safety net: a model call that keeps erroring without spending anything is down, not stuck.
      silentErrors =
        result.stopReason === 'error' && ledger.spentUsd === spentBefore ? silentErrors + 1 : 0;
      if (silentErrors >= 3) break;

      // Stuck: the session failed, or new failures remain and did not go down. Green checks with only
      // the report missing are not: caches are per model, so Opus would re-read the whole session
      // uncached (about $0.75 at 150k tokens) just to call finish.
      const stuck =
        result.stopReason === 'error' ||
        (newFailures > 0 && (result.stopReason !== 'done' || newFailures >= previousNewFailures));
      const escalated = stuck && model === MODEL;
      if (escalated) model = ESCALATION_MODEL;
      previousNewFailures = newFailures;
      prompt = buildRetryMessage({
        comparisons,
        after,
        hasReport: report !== undefined,
        escalated,
      });
    }

    const { text: diff, note: diffSecretsNote } = redactOutbound('diff', await sandbox.diff());
    const finalReport = report as FinishReport | undefined;
    const harnessUnproven = runtimeProblem ? [runtimeProblem] : [];
    const outcome = decideOutcome({
      diff,
      report: finalReport,
      comparisons,
      after,
      validatorRuns,
      harnessUnproven,
    });
    const notes = [
      ...harnessUnproven,
      ...(diffSecretsNote ? [diffSecretsNote] : []),
      ...(ledger.remainingUsd <= reserveUsd
        ? [`The run hit its AI budget of $${ledger.capUsd.toFixed(2)} before the agent finished.`]
        : []),
    ];
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
      checksRuntime: checksRuntime && runtimeLabel(checksRuntime),
      baselineRuntime: baselineOn && runtimeLabel(baselineOn),
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
      prTitle: prTitle(task),
      checksRuntime: checksRuntime && runtimeLabel(checksRuntime),
      baselineRuntime: baselineOn && runtimeLabel(baselineOn),
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
runExternalTask satisfies RunExternalTask;

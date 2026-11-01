// runTask: sandbox → baseline checks → agent → re-check → iterate (escalating when stuck) → record.
import { appendFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationTask, RetrieveRecipes, RunTask, ToolPack } from '../shared/types.ts';
import { claudeAgentSession } from './agent.ts';
import {
  compareChecks,
  detectChecks,
  detectPackageManager,
  installCommand,
  runChecks,
} from './checks.ts';
import { BudgetLedger, budgetFromEnv } from './ledger.ts';
import { writePrBody } from './pr.ts';
import {
  PROMPT_VERSION,
  buildKickoffMessage,
  buildRetryMessage,
  buildSystemPrompt,
} from './prompt.ts';
import { createSandbox, sandboxEnvNote } from './sandbox.ts';
import { redactSecrets } from './secrets.ts';
import { buildTools } from './tools.ts';
import type {
  CheckComparison,
  CheckRun,
  FinishReport,
  HarnessDeps,
  HarnessRunRecord,
  Sandbox,
  SessionResult,
} from './types.ts';

export const MODEL = 'claude-sonnet-5-5';
export const ESCALATION_MODEL = 'claude-opus-5-5';

// shortcut: stubs until providers/ (F2) and memory/ (O3) land; the orchestrator passes the real ones.
const emptyToolPack = async (provider: string): Promise<ToolPack> => ({
  provider,
  tools: [],
  playbooks: {},
});
const noRecipes: RetrieveRecipes = async () => [];

const newFailureCount = (comparisons: CheckComparison[]) =>
  comparisons.reduce((sum, comparison) => sum + comparison.newFailures.length, 0);

export function decideOutcome(input: {
  diff: string;
  report?: FinishReport;
  comparisons: CheckComparison[];
  after: CheckRun[];
}): HarnessRunRecord['outcome'] {
  const { diff, report, comparisons, after } = input;
  const changed = diff.trim() !== '';
  if (!changed && report?.verdict === 'not-affected') return 'not-affected';
  const proven =
    changed &&
    report !== undefined &&
    after.length > 0 &&
    newFailureCount(comparisons) === 0 &&
    report.validators.every((validator) => validator.passed) &&
    report.unproven.length === 0;
  return proven ? 'verified' : 'needs-review';
}

export async function runTask(
  task: MigrationTask,
  repoDir: string,
  deps: HarnessDeps = {},
): Promise<HarnessRunRecord> {
  const ledger = new BudgetLedger(deps.budgetUsd ?? budgetFromEnv());
  const outDir =
    deps.outDir ?? (await mkdtemp(join(tmpdir(), `aptitude-run-${task.id.replace(/\W+/g, '-')}-`)));
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
      models,
      promptVersion: PROMPT_VERSION,
    };
  }

  try {
    const toolPack = await (deps.loadToolPack ?? emptyToolPack)(task.change.provider).catch(() =>
      emptyToolPack(task.change.provider),
    );
    const retrieveRecipes = deps.retrieveRecipes ?? noRecipes;
    const recipes = await retrieveRecipes(task).catch(() => []);

    const pm = await detectPackageManager(sandbox.dir);
    const install =
      pm === 'none' ? undefined : await sandbox.exec(installCommand(pm, sandbox.mode));
    const checks = await detectChecks(sandbox.dir, pm);
    const before = await runChecks(sandbox, checks);
    log({ type: 'harness', phase: 'baseline', pm, install, checks, before });

    let report: FinishReport | undefined;
    const tools = buildTools({
      sandbox,
      task,
      toolPack,
      retrieveRecipes,
      checks,
      onFinish: (finished) => {
        report = finished;
      },
      fetch: deps.fetch,
    });
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

    const session = deps.session ?? claudeAgentSession;
    let model = MODEL;
    let prompt = buildKickoffMessage(before, installOutput);
    let sessionId: string | undefined;
    let after = before;
    let comparisons = compareChecks(before, after);
    let previousNewFailures = Infinity;

    for (let iteration = 0; iteration < (deps.maxIterations ?? 4); iteration++) {
      if (ledger.exhausted) break;
      if (!models.includes(model)) models.push(model);
      let result: SessionResult;
      try {
        result = await session({
          model,
          systemPrompt,
          prompt,
          tools,
          sandbox,
          ledger,
          resume: sessionId,
          maxTurns: 80,
          log,
        });
      } catch (error) {
        result = { finalText: '', stopReason: 'error', error: String(error) };
      }
      sessionId = result.sessionId ?? sessionId;
      after = await runChecks(sandbox, checks);
      comparisons = compareChecks(before, after);
      const newFailures = newFailureCount(comparisons);
      log({ type: 'harness', phase: 'iteration', iteration, model, result, after, comparisons });
      if (newFailures === 0 && report) break;

      // Stuck: the session ended abnormally or the new failures did not go down.
      const stuck = result.stopReason !== 'done' || newFailures >= previousNewFailures;
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

    const diff = redactSecrets(await sandbox.diff());
    const finalReport = report as FinishReport | undefined;
    const outcome = decideOutcome({ diff, report: finalReport, comparisons, after });
    const notes = ledger.exhausted
      ? [`The run hit its AI budget of $${ledger.capUsd.toFixed(2)} before the agent finished.`]
      : [];
    const prBody = writePrBody({
      task,
      outcome,
      report: finalReport,
      comparisons,
      validators: finalReport?.validators,
      diff,
      costUsd: ledger.spentUsd,
      models,
      promptVersion: PROMPT_VERSION,
      sandboxNote,
      notes,
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
    };
    log({ type: 'harness', phase: 'done', outcome, ledger: ledger.entries });
    await writeFile(join(outDir, 'diff.patch'), diff);
    await writeFile(join(outDir, 'pr-body.md'), prBody);
    await writeFile(join(outDir, 'record.json'), JSON.stringify(record, null, 2));
    return record;
  } finally {
    await sandbox.dispose();
  }
}

runTask satisfies RunTask;

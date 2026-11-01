import { redactSecrets } from '../harness/secrets.ts';
import type { RunRecord, RunView } from '../shared/types.ts';
import type { HumanVerdict, StoredRun } from './types.ts';

const MAX_SUMMARY_CHARS = 200;
const NO_REPORT = 'The agent did not report a summary.';

const VERDICTS: Record<HumanVerdict, string> = {
  merged: 'A human merged the PR.',
  closed: 'A human closed the PR without merging.',
  edited: 'A human pushed changes to the PR.',
};

// What the loop and the harness store beside RunRecord's own fields (LoopRecord.note, HarnessRunRecord.prBody).
type Written = RunRecord & { note?: string; prBody?: string };

export function toRunView(run: StoredRun): RunView {
  const { task, record } = run;
  return {
    id: run.id,
    repo: task.repo,
    taskId: record.taskId,
    provider: task.change.provider,
    changeId: task.change.id,
    outcome: record.outcome,
    ...(record.pr && { pr: record.pr }),
    costUsd: record.costUsd,
    summary: summarise(run),
    finishedAt: run.recordedAt,
  };
}

// One line in the agent's own words where it left any: the summary from its finish report (the PR
// body's Change section) and the loop's note (the match agent's not-affected reasoning, or why the run
// failed), the note first when the run failed; else a harness message such as a sandbox failure.
// Then what a human did with the PR.
function summarise({ task, record }: StoredRun): string {
  const { note, prBody, diff, outcome, humanVerdict } = record as Written;
  const section = prBody?.match(/^### Change\n\n(.*)/m)?.[1];
  const report = section === NO_REPORT ? undefined : section;
  const files = diff.match(/^diff --git /gm)?.length ?? 0;
  const said =
    (outcome === 'failed' ? note || report : report || note) ||
    (prBody && !prBody.startsWith('## ') && prBody) ||
    (files && `Changed ${files} file${files === 1 ? '' : 's'} for "${task.change.title}".`) ||
    (outcome === 'not-affected'
      ? `Not affected by "${task.change.title}"; no reasoning was recorded.`
      : `Nothing changed for "${task.change.title}", and no reason was recorded.`);
  // The dashboard is a page people share, so secrets never reach it, even inside an error message.
  // Redacted before it is cut down, since a secret split by truncation or rewrapping no longer matches.
  const line = redactSecrets(said)
    .replace(/^[\s#>*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const short =
    line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : line;
  return humanVerdict ? `${short} ${VERDICTS[humanVerdict]}` : short;
}

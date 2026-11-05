// The PR body: change, why, proof, unproven, behaviour changes. It states only facts passed in.
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { isRepoTask, leftOf, type RepoTask, type ScanResult } from './findings.ts';
import { redactSecrets } from './secrets.ts';
import type { SmokeResult } from './smoke.ts';
import type { CheckCommand, CheckComparison, FinishReport, ValidatorRun } from './types.ts';
import {
  claimMatches,
  failingCheckers,
  gradeValidators,
  type ValidatorGrade,
} from './validators.ts';

export type PrBodyInput = {
  task: MigrationTask;
  outcome: RunRecord['outcome'];
  report?: FinishReport;
  comparisons: CheckComparison[];
  validatorRuns?: ValidatorRun[]; // ToolPack calls the harness recorded
  agentChecks?: CheckCommand[]; // checks the agent registered; they count toward proof
  diff: string;
  costUsd: number;
  models: string[];
  promptVersion: string;
  sandboxNote: string;
  notes?: string[]; // harness facts a reviewer must know, listed under Unproven
  prepared?: string[]; // the codegen and placeholder env the harness used before the baseline
  proofTest?: string; // the registered check that tests the change
  rescan?: ScanResult; // a repo session's proof
  labelReason?: string; // why it got its label
  smoke?: SmokeResult[]; // the optional live smoke calls
};

const BADGE: Record<RunRecord['outcome'], string> = {
  verified: 'Verified',
  'needs-review': 'Needs review',
  'not-affected': 'Not affected',
  failed: 'Failed',
};

export function filesFromDiff(diff: string): string[] {
  const files = [...diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((match) => match[1]);
  return [...new Set(files)];
}

const LABEL: Record<RunRecord['outcome'], string> = {
  verified: 'Fixed',
  'needs-review': 'Needs a look',
  'not-affected': 'Not affected',
  failed: "Couldn't fix",
};

const isPass = (summary: string) => /^pass/i.test(summary.trim());
const notRun = (summary: string) => /not run/i.test(summary);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');

function unprovenItems(input: PrBodyInput, grades: ValidatorGrade[]): string[] {
  const items = [...(input.report?.unproven ?? []), ...(input.notes ?? [])];
  if (!input.report) items.push('The agent did not call finish, so there is no report from it.');
  if (input.report && input.outcome !== 'not-affected' && !input.proofTest) {
    items.push(
      input.report.noProofTestReason
        ? `No test of this change was written: ${input.report.noProofTestReason}`
        : 'The agent wrote no test of this change and gave no reason why none can be written.',
    );
  }
  if (!input.comparisons.length) items.push('No checks were run.');
  for (const c of input.comparisons) {
    if (notRun(c.before)) items.push(`${c.name} was not run before the change.`);
    if (notRun(c.after)) items.push(`${c.name} was not run after the change.`);
    for (const failure of c.newFailures) items.push(`${c.name}: new failure \`${failure}\``);
    const preExisting = [c.before, c.after].every(
      (summary) => !isPass(summary) && !notRun(summary),
    );
    if (preExisting) items.push(`${c.name} was already failing before the change and still fails.`);
  }
  if (!grades.some((grade) => grade.ran) && input.outcome !== 'not-affected') {
    items.push('No provider validator was run.');
  }
  for (const grade of grades.filter((g) => !g.ran)) {
    items.push(`Validator ${grade.name} was ${grade.detail}.`);
  }
  for (const grade of grades.filter((g) => g.ran && !g.passed)) {
    items.push(`Validator ${grade.name} failed: ${grade.detail}`);
  }
  const claims = input.report?.validators ?? [];
  for (const tool of failingCheckers(input.validatorRuns ?? [])) {
    if (!claims.some((claim) => claimMatches(claim.name, tool))) {
      items.push(
        `Provider check ${tool} reported problems on its last call; the agent did not list it.`,
      );
    }
  }
  return items;
}

// A repo session's PR, built to be easy to accept: what died, the source, what changed, what was
// proven, and what a person must do.
function writeRepoBody(input: PrBodyInput, task: RepoTask, proof: string[], unproven: string[]) {
  const { report } = input;
  const left = input.rescan ? leftOf(task.findings, input.rescan) : [];
  const died = task.entries.map((entry) => {
    const found = task.findings.filter((finding) => finding.entryId === entry.id);
    return `| ${cell(entry.what)} | ${entry.diedOn} | ${entry.source.url} (checked ${entry.source.checkedOn}) | ${found.length} |`;
  });
  const files = filesFromDiff(input.diff);
  const rescan = input.rescan
    ? [
        left.length
          ? `Rescan: ${left.length} use${left.length === 1 ? '' : 's'} still found:\n${list(left.map(({ entryId, file, line }) => `${entryId} at \`${file}:${line}\``))}`
          : 'Rescan: clean. The same scan that found these no longer finds them.',
        'A clean rescan shows the dead thing is gone, not that a live call succeeds.',
      ]
    : ['No rescan ran.'];
  const smoke = input.smoke?.length
    ? list(
        input.smoke.map(({ model, outcome, detail }) =>
          outcome === 'answered'
            ? `Live smoke: \`${model}\` answered a one-line call (${detail}). This shows the model is live, not that this code's call works.`
            : outcome === 'refused'
              ? `Live smoke: \`${model}\` refused a one-line call (${detail}).`
              : `Live smoke for \`${model}\` didn't run: ${detail}.`,
        ),
      )
    : 'No live provider call was made.';
  const mustDo = report?.personMustDo ?? [];
  const alarms = report?.falseAlarms ?? [];
  return [
    `## ${task.change.title} [${LABEL[input.outcome]}]`,
    input.labelReason ?? '',
    [
      '### What died',
      '| What | Died | Source | Uses found |',
      '| --- | --- | --- | --- |',
      ...died,
    ].join('\n'),
    [
      '### What changed',
      report?.summary ?? 'The session did not report a summary.',
      files.length
        ? `Files touched:\n${list(files.map((file) => `\`${file}\``))}`
        : 'No files changed.',
    ].join('\n\n'),
    ['### What was proven', ...rescan, smoke, ...proof.filter(Boolean)].join('\n\n'),
    ['### What a person must do', mustDo.length ? list(mustDo) : 'Nothing to set.'].join('\n\n'),
    alarms.length
      ? [
          '### Findings left alone as false alarms',
          list(alarms.map(({ entryId, file, why }) => `${entryId} in \`${file}\`: ${why}`)),
        ].join('\n\n')
      : '',
    ['### Unproven', unproven.length ? list(unproven) : 'Nothing known.'].join('\n\n'),
    [
      '### Behaviour changes',
      report?.behaviourChanges.length ? list(report.behaviourChanges) : 'None intended.',
    ].join('\n\n'),
    [
      '---',
      `Prompt ${input.promptVersion} · Models: ${input.models.join(', ') || 'none'} · AI cost: $${input.costUsd.toFixed(4)}`,
    ].join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function writePrBody(input: PrBodyInput): string {
  const { task, report, comparisons } = input;
  const claims = report?.validators ?? [];
  const runs = input.validatorRuns ?? [];
  const grades = gradeValidators(claims, runs);
  const agentChecks = input.agentChecks ?? [];
  const files = filesFromDiff(input.diff);
  const newFailures = comparisons.reduce((sum, c) => sum + c.newFailures.length, 0);
  const unproven = unprovenItems(input, grades);
  const behaviour = report?.behaviourChanges ?? [];

  const proof = [
    comparisons.length
      ? [
          '| Check | Before | After | New failures |',
          '| --- | --- | --- | --- |',
          ...comparisons.map(
            (c) =>
              `| ${cell(c.name)} | ${cell(c.before)} | ${cell(c.after)} | ${c.newFailures.length} |`,
          ),
        ].join('\n')
      : 'No checks were run.',
    `New failures: ${newFailures}`,
    agentChecks.length
      ? [
          'Checks added by the agent (they count toward proof; check that each command really tests the change):',
          list(
            agentChecks.map((check) => {
              const c = comparisons.find((comparison) => comparison.name === check.name);
              return `${check.name}, added by the agent: \`${check.command}\` (${c?.before ?? 'not run'} → ${c?.after ?? 'not run'})`;
            }),
          ),
        ].join('\n')
      : '',
    runs.length
      ? [
          'Provider tool calls recorded by the harness:',
          list(runs.map((run) => `\`${run.tool}\`: ${run.passed ? 'pass' : 'fail'}`)),
        ].join('\n')
      : 'Provider validators: none run.',
    claims.length
      ? [
          "The agent's validator claims (not proof; graded against the recorded calls):",
          list(
            claims.map(
              (v) => `${v.name}: ${v.passed ? 'pass' : 'fail'}${v.detail ? ` (${v.detail})` : ''}`,
            ),
          ),
        ].join('\n')
      : '',
    input.prepared?.length
      ? ['Prepared before the baseline:', list(input.prepared)].join('\n')
      : '',
    input.proofTest
      ? `Test of this change: \`${input.proofTest}\`, written by the agent and run with the checks.`
      : '',
    `Where checks ran: ${input.sandboxNote}`,
  ];

  if (isRepoTask(task)) {
    return redactSecrets(`${writeRepoBody(input, task, proof, unproven)}\n`);
  }

  const sections = [
    `## ${task.change.title} [${BADGE[input.outcome]}]`,
    [
      '### Change',
      report?.summary ?? 'The agent did not report a summary.',
      files.length
        ? `Files touched:\n${list(files.map((file) => `\`${file}\``))}`
        : 'No files changed.',
    ].join('\n\n'),
    [
      '### Why',
      report?.why ?? 'The agent did not report why.',
      task.change.source.quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
      `Source: ${task.change.source.url}`,
    ].join('\n\n'),
    ['### Proof', ...proof.filter(Boolean)].join('\n\n'),
    ['### Unproven', unproven.length ? list(unproven) : 'Nothing known.'].join('\n\n'),
    ['### Behaviour changes', behaviour.length ? list(behaviour) : 'None intended.'].join('\n\n'),
    [
      '---',
      `Prompt ${input.promptVersion} · Models: ${input.models.join(', ') || 'none'} · AI cost: $${input.costUsd.toFixed(4)}`,
    ].join('\n\n'),
  ];

  return redactSecrets(sections.join('\n\n') + '\n');
}

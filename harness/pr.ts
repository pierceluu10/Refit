// The PR body: change, why, proof, unproven, behaviour changes. It states only facts passed in.
import type { MigrationTask, RunRecord } from '../shared/types.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckComparison, FinishReport, ValidatorRun } from './types.ts';
import { gradeValidators, type ValidatorGrade } from './validators.ts';

export type PrBodyInput = {
  task: MigrationTask;
  outcome: RunRecord['outcome'];
  report?: FinishReport;
  comparisons: CheckComparison[];
  validatorRuns?: ValidatorRun[]; // ToolPack calls the harness recorded
  diff: string;
  costUsd: number;
  models: string[];
  promptVersion: string;
  sandboxNote: string;
  notes?: string[]; // harness facts a reviewer must know, listed under Unproven
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

const isPass = (summary: string) => /^pass/i.test(summary.trim());
const notRun = (summary: string) => /not run/i.test(summary);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');

function unprovenItems(input: PrBodyInput, grades: ValidatorGrade[]): string[] {
  const items = [...(input.report?.unproven ?? []), ...(input.notes ?? [])];
  if (!input.report) items.push('The agent did not call finish, so there is no report from it.');
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
  return items;
}

export function writePrBody(input: PrBodyInput): string {
  const { task, report, comparisons } = input;
  const claims = report?.validators ?? [];
  const runs = input.validatorRuns ?? [];
  const grades = gradeValidators(claims, runs);
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
    `Where checks ran: ${input.sandboxNote}`,
  ];

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

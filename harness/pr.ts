// The PR body: change, why, proof, unproven, behaviour changes. It states only facts passed in.
import type { ExternalTask, RunRecord } from '../shared/types.ts';
import { isExternalTask, isUpgrade } from './prompt.ts';
import { redactSecrets } from './secrets.ts';
import type {
  CheckCommand,
  CheckComparison,
  FinishReport,
  HarnessTask,
  ValidatorRun,
} from './types.ts';
import {
  claimMatches,
  failingCheckers,
  gradeValidators,
  type ValidatorGrade,
} from './validators.ts';

export type PrBodyInput = {
  task: HarnessTask;
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
  checksRuntime?: string; // the runtime the after-checks ran on, e.g. "node 22"
  baselineRuntime?: string; // the runtime the before-checks ran on, e.g. "node 18"
};

const SANDBOX_DEFAULT = 'the sandbox default';

// The version the dependency moves from: the inventory's, else the change's affected versions.
function fromVersion(task: ExternalTask): string | undefined {
  const dep =
    task.dependencies.find((d) => d.name === task.change.dependency) ?? task.dependencies[0];
  return dep?.version ?? task.change.fromVersions?.join(', ');
}

// "Upgrade <dependency> <from> → <to>" for upgrades; the change's own title otherwise.
export function prTitle(task: HarnessTask): string {
  if (!isUpgrade(task)) return task.change.title;
  const external = task as ExternalTask;
  const from = fromVersion(external);
  const to = external.change.toVersion;
  const versions = from && to ? ` ${from} → ${to}` : to ? ` to ${to}` : '';
  return `Upgrade ${external.change.dependency}${versions}`;
}

const BADGE: Record<RunRecord['outcome'], string> = {
  verified: 'Verified',
  'needs-review': 'Needs review',
  'not-affected': 'Not affected',
  failed: 'Failed',
  'waiting-budget': 'Waiting on budget',
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
    `Where checks ran: ${input.sandboxNote}`,
    input.checksRuntime || input.baselineRuntime
      ? `Runtime: before on ${input.baselineRuntime ?? SANDBOX_DEFAULT} with the original code, after on ${input.checksRuntime ?? SANDBOX_DEFAULT}.`
      : '',
  ];

  const external = isExternalTask(task) ? task : undefined;
  const deadline = task.deadline ?? task.change.effectiveDate;
  const sections = [
    `## ${prTitle(task)} [${BADGE[input.outcome]}]`,
    external
      ? list(
          [
            prTitle(task) !== task.change.title ? `Change: ${task.change.title}` : '',
            `Kind: ${task.change.kind}`,
            deadline ? `Deadline: ${deadline}` : '',
            external.change.severity ? `Severity: ${external.change.severity}` : '',
            `Source: ${task.change.source.url}`,
          ].filter(Boolean),
        )
      : '',
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
      !external && deadline ? `Deadline: ${deadline}` : '',
      task.change.source.quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
      `Source: ${task.change.source.url}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    ['### Proof', ...proof.filter(Boolean)].join('\n\n'),
    ['### Unproven', unproven.length ? list(unproven) : 'Nothing known.'].join('\n\n'),
    ['### Behaviour changes', behaviour.length ? list(behaviour) : 'None intended.'].join('\n\n'),
    [
      '---',
      `Prompt ${input.promptVersion} · Models: ${input.models.join(', ') || 'none'} · AI cost: $${input.costUsd.toFixed(4)}`,
    ].join('\n\n'),
  ];

  return redactSecrets(sections.filter(Boolean).join('\n\n') + '\n');
}

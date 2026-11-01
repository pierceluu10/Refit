// A short account of a run for memory's recipe extraction: every tool call in order with what it
// returned, and the checks after each iteration, so dead ends survive where a long transcript's
// middle gets cut. Built from what the harness saw, at no AI cost.
import type { MigrationTask } from '../shared/types.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckComparison, CheckRun, FinishReport } from './types.ts';

export type Step = { tool: string; input: unknown; output: string };

export type IterationSummary = {
  model: string;
  stopReason: string;
  steps: Step[];
  comparisons: CheckComparison[];
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// One line of arguments; long strings such as file contents and edit bodies show only their size.
function args(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${text.length > 80 ? `<${text.length} chars>` : text}`;
    })
    .join(' ');
}

function checks(comparisons: CheckComparison[]): string {
  const lines = comparisons.map((c) => {
    const news = c.newFailures.slice(0, 3).join('; ');
    return `${c.name} ${c.before} → ${c.after}${news ? ` (new: ${clip(news, 300)})` : ''}`;
  });
  return lines.join(', ') || 'none';
}

export function summarizeRun(input: {
  task: MigrationTask;
  outcome: string;
  costUsd: number;
  before: CheckRun[];
  iterations: IterationSummary[];
  report?: FinishReport;
  files: string[];
}): string {
  const { task, report } = input;
  const baseline = input.before.map(
    (run) => `${run.name} ${run.ok ? 'pass' : `fail (${run.failures.length})`}`,
  );
  const lines = [
    `# ${task.id}: ${input.outcome}, $${input.costUsd.toFixed(4)}`,
    `Change: ${task.change.title} (${task.change.provider}, ${task.change.kind})`,
    `Baseline checks: ${baseline.join(', ') || 'none'}`,
  ];
  input.iterations.forEach((iteration, index) => {
    lines.push('', `## Iteration ${index + 1} (${iteration.model}, ${iteration.stopReason})`);
    iteration.steps.forEach((step, n) => {
      const output = clip(step.output.trim().split('\n')[0] ?? '', 160);
      lines.push(`${n + 1}. ${step.tool} ${args(step.input)} → ${output}`);
    });
    lines.push(`Checks after: ${checks(iteration.comparisons)}`);
  });
  lines.push('', '## Result', `Files changed: ${input.files.join(', ') || 'none'}`);
  if (report) {
    lines.push(`Verdict: ${report.verdict}. ${report.summary}`);
    if (report.unproven.length) lines.push(`Unproven: ${report.unproven.join('; ')}`);
  } else {
    lines.push('The agent did not call finish.');
  }
  return redactSecrets(lines.join('\n') + '\n');
}

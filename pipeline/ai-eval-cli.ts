import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { evalCases, type EvalCase, type EvalSet } from './ai-eval-cases.ts';
import { prepareCase, runCaseAttempt, type EvalAttempt } from './ai-eval.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: npm run eval:ai -- --output <new-directory> [--env .env] [--repeat 3] [--set tuning|held-out|all] [--case <id-substring>]';
const MAX_REPEAT = 10;

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    env: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    case: { type: 'string' },
    set: { type: 'string', default: 'tuning' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.output) throw new PipelineInputError(`An output directory is required.\n${USAGE}`);
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT)
  throw new PipelineInputError(`--repeat must be an integer from 1 to ${MAX_REPEAT}.`);
if (values.env) process.loadEnvFile(values.env);
const ai = assessmentConfiguration(true, process.env)!;
if (!['tuning', 'held-out', 'all'].includes(values.set!))
  throw new PipelineInputError('--set must be tuning, held-out or all.');
const cases = evalCases(values.set as EvalSet).filter(
  (testCase) => !values.case || testCase.id.includes(values.case),
);
if (!cases.length) throw new PipelineInputError('No evaluation case matches --case.');

await mkdir(values.output);
const workspace = join(values.output, 'workspace');
const results: EvalAttempt[] = [];
const started = new Date();
let index = 0;
for (const testCase of cases) {
  const prepared = await prepareCase(testCase, workspace);
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const result = await runCaseAttempt(testCase, prepared, ai, attempt, workspace);
    results.push(result);
    index++;
    console.error(
      `[${index}/${cases.length * repeat}] ${testCase.id} #${attempt}: ${result.outcome}${result.critical ? ' (CRITICAL)' : ''}`,
    );
  }
}
await rm(workspace, { recursive: true, force: true });

const metadata = {
  date: started.toISOString(),
  refitCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  configuredModel: ai.model,
  reportedModel: results.find((result) => result.model)?.model ?? null,
  repeat,
  cases: cases.length,
  set: values.set,
};
await writeFile(
  join(values.output, 'results.json'),
  `${JSON.stringify({ metadata, results }, null, 2)}\n`,
);
await writeFile(join(values.output, 'report.md'), renderReport(metadata, cases, results));
const passed = results.filter((result) => result.pass).length;
const critical = results.filter((result) => result.critical).length;
console.log(
  `${passed}/${results.length} attempts passed; ${critical} critical. Report: ${join(values.output, 'report.md')}`,
);

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : 'n/a';
}

function renderReport(
  meta: typeof metadata,
  evaluated: EvalCase[],
  attempts: EvalAttempt[],
): string {
  const count = (filter: (result: EvalAttempt) => boolean) => attempts.filter(filter).length;
  const sum = (field: 'inputTokens' | 'outputTokens' | 'costUsd') =>
    attempts.reduce((total, result) => total + (result[field] ?? 0), 0);
  const categories = ['fix', 'decline', 'ambiguous'] as const;
  const outcomes = [
    'fixed',
    'declined',
    'rejected',
    'wrong-fix',
    'invented',
    'guessed',
    'not-sent',
    'error',
  ] as const;
  const scenarios = [...new Set(evaluated.map((testCase) => testCase.scenario))];
  const lines = [
    '# Refit AI migration evaluation results',
    '',
    `- **Date:** ${meta.date}`,
    `- **Refit commit:** \`${meta.refitCommit}\``,
    `- **Model:** \`${meta.configuredModel}\` (reported \`${meta.reportedModel}\`)`,
    `- **Cases:** ${meta.cases} (${meta.set} set) × ${meta.repeat} attempts = ${attempts.length} AI runs`,
    `- **Tokens:** ${sum('inputTokens').toLocaleString('en-US')} input, ${sum('outputTokens').toLocaleString('en-US')} output`,
    `- **Recorded cost:** $${sum('costUsd').toFixed(4)}`,
    '',
    'All API changes are simulated. None are real or announced OpenAI changes.',
    '',
    '## Headline',
    '',
    `- **Passed:** ${count((r) => r.pass)}/${attempts.length} attempts (${percent(
      count((r) => r.pass),
      attempts.length,
    )})`,
    `- **Critical failures (invented a migration it should not have):** ${count((r) => r.critical)}`,
    `- **Invented migrations stopped by the substitution guard:** ${count((r) => r.outcome === 'rejected' && r.pass)}; false positives on fixable cases: ${count((r) => r.outcome === 'rejected' && !r.pass)}`,
    `- **Correct fixes on fixable cases:** ${count((r) => r.category === 'fix' && r.outcome === 'fixed')}/${count((r) => r.category === 'fix')} (${percent(
      count((r) => r.category === 'fix' && r.outcome === 'fixed'),
      count((r) => r.category === 'fix'),
    )})`,
    `- **Unfixable cases kept safe (declined or rejected):** ${count((r) => r.category === 'decline' && r.pass)}/${count((r) => r.category === 'decline')} (${percent(
      count((r) => r.category === 'decline' && r.pass),
      count((r) => r.category === 'decline'),
    )}); the model itself declined ${count((r) => r.category === 'decline' && r.outcome === 'declined')}`,
    '',
    '## Outcomes by category',
    '',
    `| Category | Attempts | Pass rate | ${outcomes.join(' | ')} |`,
    `|---|---|---|${outcomes.map(() => '---').join('|')}|`,
    ...categories.map((category) => {
      const inCategory = attempts.filter((result) => result.category === category);
      return `| ${category} | ${inCategory.length} | ${percent(inCategory.filter((r) => r.pass).length, inCategory.length)} | ${outcomes.map((outcome) => inCategory.filter((r) => r.outcome === outcome).length).join(' | ')} |`;
    }),
    '',
    '## Results by scenario',
    '',
    'Each cell shows passing attempts out of total for that resource.',
    '',
    '| Scenario | Expected | models | files | batches | Pass rate |',
    '|---|---|---|---|---|---|',
    ...scenarios.map((scenario) => {
      const inScenario = attempts.filter((result) => result.scenario === scenario);
      const cell = (resource: string) => {
        const forResource = inScenario.filter((result) => result.resource === resource);
        return forResource.length
          ? `${forResource.filter((r) => r.pass).length}/${forResource.length}`
          : '—';
      };
      return `| \`${scenario}\` | ${inScenario[0].category} | ${cell('models')} | ${cell('files')} | ${cell('batches')} | ${percent(inScenario.filter((r) => r.pass).length, inScenario.length)} |`;
    }),
    '',
    '## Every non-passing attempt',
    '',
  ];
  const failures = attempts.filter((result) => !result.pass);
  if (!failures.length) lines.push('None.', '');
  for (const result of failures) {
    lines.push(
      `### \`${result.id}\` attempt ${result.attempt}: ${result.outcome}${result.critical ? ' (critical)' : ''}`,
      '',
      result.detail,
      '',
    );
    if (result.changedLines?.length)
      lines.push('Changed lines:', '', '```js', ...result.changedLines, '```', '');
    if (result.summary) lines.push(`AI summary: ${result.summary}`, '');
    if (result.uncertainties?.length)
      lines.push('AI-stated uncertainties:', '', ...result.uncertainties.map((u) => `- ${u}`), '');
  }
  lines.push(
    '## Sample passing attempts',
    '',
    ...scenarios.flatMap((scenario) => {
      const sample = attempts.find((result) => result.scenario === scenario && result.pass);
      if (!sample) return [];
      return [
        `### \`${sample.id}\`: ${sample.outcome}`,
        '',
        ...(sample.changedLines?.length ? ['```js', ...sample.changedLines, '```', ''] : []),
        ...(sample.summary ? [`AI summary: ${sample.summary}`, ''] : []),
      ];
    }),
  );
  return `${lines.join('\n')}\n`;
}

import { isDeepStrictEqual } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffLines } from 'diff';
import type { AiOptions } from './ai-budget.ts';
import { FAKE_SDK, evalAdapter, evalContract, type EvalCase } from './ai-eval-cases.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';

// proposeAiPatch() prepends three fixed review warnings before the model's own uncertainties.
const FIXED_WARNINGS = 3;
const SOURCE_FILE = 'src/client.js';

export type EvalOutcome =
  'fixed' | 'declined' | 'wrong-fix' | 'invented' | 'guessed' | 'not-sent' | 'error';

export interface EvalAttempt {
  id: string;
  scenario: string;
  resource: string;
  category: EvalCase['category'];
  attempt: number;
  outcome: EvalOutcome;
  pass: boolean;
  critical: boolean;
  detail: string;
  summary?: string;
  uncertainties?: string[];
  changedLines?: string[];
  forbiddenReads?: string[];
  collateral?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface PreparedCase {
  repository: string;
  before: string;
  after: string;
  adapter: string;
  notes: string[];
}

export async function prepareCase(testCase: EvalCase, root: string): Promise<PreparedCase> {
  const directory = join(root, testCase.id.replace('/', '--'));
  const repository = join(directory, 'repository');
  await mkdir(join(repository, 'src'), { recursive: true });
  await writeFile(join(repository, SOURCE_FILE), testCase.source);
  await writeFile(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'refit-eval-app', private: true, type: 'module', dependencies: { openai: '7.32.0' } }, null, 2)}\n`,
  );
  const prepared: PreparedCase = {
    repository,
    before: join(directory, 'before.json'),
    after: join(directory, 'after.json'),
    adapter: join(directory, 'adapter.json'),
    notes: [],
  };
  await writeFile(prepared.before, JSON.stringify(evalContract(testCase, 'before'), null, 2));
  await writeFile(prepared.after, JSON.stringify(evalContract(testCase, 'after'), null, 2));
  await writeFile(prepared.adapter, JSON.stringify(evalAdapter(testCase), null, 2));
  if (testCase.note) {
    const hash = digest(testCase.note);
    const note = join(directory, `${hash}.json`);
    await writeFile(
      note,
      `${JSON.stringify({
        formatVersion: 1,
        kind: 'refit-documentation-snapshot',
        label: 'Simulated OpenAI changelog',
        url: 'https://docs.example.com/openai-simulated-changelog',
        revision: hash,
        hash,
        content: testCase.note,
        contentType: 'text/markdown',
      })}\n`,
    );
    prepared.notes.push(note);
  }
  return prepared;
}

let executions = 0;

// Runs the case's exported function against the after-contract response using a stand-in SDK.
export async function executeSource(testCase: EvalCase, sourceText: string, root: string) {
  const directory = join(root, `execution-${++executions}`);
  await mkdir(join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'node_modules', 'openai'), { recursive: true });
  await writeFile(
    join(directory, 'node_modules', 'openai', 'package.json'),
    '{"name":"openai","type":"module","main":"index.js"}\n',
  );
  await writeFile(join(directory, 'node_modules', 'openai', 'index.js'), FAKE_SDK);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  const file = join(directory, SOURCE_FILE);
  await writeFile(file, sourceText);
  (globalThis as Record<string, unknown>).__REFIT_EVAL_RESPONSE__ = testCase.response;
  try {
    const module = (await import(pathToFileURL(file).href)) as Record<
      string,
      (id: string) => Promise<unknown>
    >;
    const actual = await module[testCase.functionName]('eval-id');
    return { ok: isDeepStrictEqual(actual, testCase.expected), actual };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function changedLines(original: string, patched: string) {
  return diffLines(original, patched)
    .filter((part) => part.added)
    .flatMap((part) => part.value.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);
}

export function forbiddenReads(testCase: EvalCase, lines: string[]) {
  return testCase.forbidden.filter((property) =>
    lines.some((line) =>
      new RegExp(`\\.${property.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line),
    ),
  );
}

// renderPatch() writes whole-file hunks, so the patched file is every added line in order.
export function patchedSource(diff: string) {
  const lines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  return `${lines.join('\n')}\n`;
}

function base(testCase: EvalCase, attempt: number) {
  return {
    id: testCase.id,
    scenario: testCase.scenario,
    resource: testCase.resource,
    category: testCase.category,
    attempt,
  };
}

export async function runCaseAttempt(
  testCase: EvalCase,
  prepared: PreparedCase,
  ai: AiOptions,
  attempt: number,
  scratch: string,
): Promise<EvalAttempt> {
  const inputs = {
    repository: prepared.repository,
    before: prepared.before,
    after: prepared.after,
    providerConfig: prepared.adapter,
    apiVersion: '2.3.0',
  };
  const scan = await runPipeline(inputs);
  if (!scan.findings.some((finding) => finding.confidence === 'confirmed'))
    return {
      ...base(testCase, attempt),
      outcome: 'not-sent',
      pass: false,
      critical: false,
      detail: `Scanner found no confirmed usage (${scan.findings.length} review findings); the AI was not asked.`,
    };
  let report;
  try {
    report = await runPipeline({
      ...inputs,
      aiPatch: ai,
      ...(prepared.notes.length ? { documentationSnapshots: prepared.notes } : {}),
    });
  } catch (error) {
    return {
      ...base(testCase, attempt),
      outcome: 'error',
      pass: false,
      critical: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const patch = report.patch;
  if (!('generator' in patch) || patch.generator !== 'openai')
    return {
      ...base(testCase, attempt),
      outcome: 'error',
      pass: false,
      critical: false,
      detail: `No AI proposal was produced (patch status ${patch.status}).`,
    };
  const usage = {
    summary: patch.summary,
    uncertainties: patch.warnings.slice(FIXED_WARNINGS),
    model: patch.model,
    inputTokens: patch.usage?.inputTokens,
    outputTokens: patch.usage?.outputTokens,
    costUsd: patch.budget?.costUsd,
  };
  if (!patch.edits) {
    const pass = testCase.category !== 'fix';
    return {
      ...base(testCase, attempt),
      ...usage,
      outcome: 'declined',
      pass,
      critical: false,
      detail: pass
        ? 'Returned zero edits as expected.'
        : 'Returned zero edits although a correct migration was available.',
    };
  }
  const patched = patchedSource(patch.diff);
  const lines = changedLines(testCase.source, patched);
  const forbidden = forbiddenReads(testCase, lines);
  const collateral = !patched.includes(untouchedBlock(testCase));
  const evidence = { ...usage, changedLines: lines, forbiddenReads: forbidden, collateral };
  if (testCase.category === 'decline')
    return {
      ...base(testCase, attempt),
      ...evidence,
      outcome: 'invented',
      pass: false,
      critical: true,
      detail: 'Proposed a migration where the correct behavior was to decline.',
    };
  if (testCase.category === 'ambiguous')
    return {
      ...base(testCase, attempt),
      ...evidence,
      outcome: 'guessed',
      pass: false,
      critical: forbidden.length > 0,
      detail: 'Chose a replacement although two undocumented candidates were equally plausible.',
    };
  if (forbidden.length)
    return {
      ...base(testCase, attempt),
      ...evidence,
      outcome: 'invented',
      pass: false,
      critical: true,
      detail: `Read a forbidden substitute field: ${forbidden.join(', ')}.`,
    };
  const execution = await executeSource(testCase, patched, scratch);
  return {
    ...base(testCase, attempt),
    ...evidence,
    outcome: execution.ok && !collateral ? 'fixed' : 'wrong-fix',
    pass: execution.ok && !collateral,
    critical: false,
    detail: execution.ok
      ? collateral
        ? 'Returned the expected value but changed unrelated code.'
        : 'Patched code returned the expected value against the new contract.'
      : `Patched code ${'error' in execution ? `threw: ${execution.error}` : `returned ${JSON.stringify(execution.actual)} instead of ${JSON.stringify(testCase.expected)}`}.`,
  };
}

// Every case source ends with an unaffected id function that a migration must leave intact.
function untouchedBlock(testCase: EvalCase) {
  const name = /export async function (\w+Id)\(/.exec(testCase.source)![1];
  return testCase.source.slice(testCase.source.indexOf(`export async function ${name}`)).trim();
}

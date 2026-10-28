import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { structuredPatch } from 'diff';
import ts from 'typescript-compiler';
import { STRIPE_IMPORT, type BehaviourEvidence } from './check-selection.ts';
import {
  generatedEnvironment,
  generatedImportMap,
  MOCK_PORT,
  sandboxTranspile,
  writeHarness,
} from './generated-checks.ts';
import { signedEventRecords, type DeliveryRecord } from './signed-events.ts';
import { digest } from './specifications.ts';
import { PipelineInputError, type Finding, type Repository } from './types.ts';
import type { CheckResult } from './validation.ts';

// Behaviour tests are node:test files a person or the behaviour-test generator writes. The same
// files run on the original code against the before-version stripe-mock and on the patched code
// against the after-version stripe-mock, in the offline validation sandbox.
export const BEHAVIOUR_DIRECTORY = 'refit-behaviour';
const TEST_PATH = /^refit-behaviour\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;
const MAX_TESTS = 20;
const MAX_TEST_BYTES = 256 * 1024;
const TEST_TIMEOUT_MS = 20_000;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

export interface BehaviourTest {
  path: string;
  content: string;
}

export type LinesByFile = Record<string, number[]>;
type Side = 'original' | 'patched';

// Test files are written into the sandbox's copy of the repository, so their paths are checked.
export function validateBehaviourTests(tests: readonly BehaviourTest[]) {
  if (!tests.length || tests.length > MAX_TESTS)
    throw new PipelineInputError(`Behaviour tests need 1 to ${MAX_TESTS} test files.`);
  for (const test of tests) {
    if (!TEST_PATH.test(test.path))
      throw new PipelineInputError(
        `Behaviour test ${JSON.stringify(test.path)} must be a ${BEHAVIOUR_DIRECTORY}/<name>.test.mjs file.`,
      );
    if (Buffer.byteLength(test.content) > MAX_TEST_BYTES)
      throw new PipelineInputError(`Behaviour test ${test.path} exceeds ${MAX_TEST_BYTES} bytes.`);
  }
  if (new Set(tests.map((test) => test.path)).size !== tests.length)
    throw new PipelineInputError('Behaviour test paths must be unique.');
}

// Lines the patch changes in Stripe code, per side: the original line numbers of lines it removes or
// replaces, and the patched line numbers of lines it adds. Refit writes whole-file hunks, so the
// lines come from a line diff of the two versions. Stripe code is a changed source file that
// imports the stripe package or where Refit traced Stripe usage (a finding); package manifests and
// Refit's generated helper module are not, since the helper runs through the changed call sites.
export function changedStripeLines(
  original: Repository,
  patched: Repository,
  findings: readonly Pick<Finding, 'file'>[] = [],
) {
  const traced = new Set(findings.map((finding) => finding.file));
  const before = new Map(original.files.map((file) => [file.path, file.content]));
  const after = new Map(patched.files.map((file) => [file.path, file.content]));
  const lines: Record<Side, LinesByFile> = { original: {}, patched: {} };
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path) ?? '';
    const next = after.get(path) ?? '';
    if (old === next || !SOURCE_FILE.test(path)) continue;
    if (!traced.has(path) && !STRIPE_IMPORT.test(old) && !STRIPE_IMPORT.test(next)) continue;
    const removed: number[] = [];
    const added: number[] = [];
    for (const hunk of structuredPatch(path, path, old, next, '', '', { context: 0 }).hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const line of hunk.lines)
        if (line.startsWith('-')) removed.push(oldLine++);
        else if (line.startsWith('+')) added.push(newLine++);
    }
    if (removed.length) lines.original[path] = removed;
    if (added.length) lines.patched[path] = added;
  }
  return lines;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Source map v3 mappings as (generated line, generated column, original line), all 0-based.
function sourceMapSegments(mappings: string) {
  const segments: { line: number; column: number; sourceLine: number }[] = [];
  let sourceLine = 0;
  mappings.split(';').forEach((group, line) => {
    let column = 0;
    for (const segment of group.split(',')) {
      if (!segment) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const character of segment) {
        const digit = BASE64.indexOf(character);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value % 2 ? -Math.floor(value / 2) : value / 2);
          value = 0;
          shift = 0;
        }
      }
      column += values[0];
      if (values.length < 4) continue;
      sourceLine += values[2];
      segments.push({ line, column, sourceLine });
    }
  });
  return segments;
}

// Where code starts on each 1-based source line, as offsets into what the sandbox ran: for
// TypeScript, the transpiled offsets the inline source map maps back to the line; for JavaScript,
// which runs as written, the start of every syntax node on the line. A line without one (a comment,
// a type, a closing brace) is not executable.
export function executableOffsets(path: string, content: string) {
  const offsets = new Map<number, number[]>();
  const add = (line: number, offset: number) =>
    (offsets.get(line) ?? offsets.set(line, []).get(line)!).push(offset);
  if (TYPESCRIPT_FILE.test(path)) {
    const output = sandboxTranspile(content, path);
    const map = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(
      output,
    );
    if (!map) throw new Error(`${path} has no inline source map.`);
    const starts = [0];
    for (let index = 0; index < output.length; index++)
      if (output[index] === '\n') starts.push(index + 1);
    const { mappings } = JSON.parse(Buffer.from(map[1], 'base64').toString('utf8')) as {
      mappings: string;
    };
    for (const segment of sourceMapSegments(mappings))
      add(segment.sourceLine + 1, starts[segment.line] + segment.column);
    return { offsets, length: output.length };
  }
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const start = node.getStart(source);
    add(source.getLineAndCharacterOfPosition(start).line + 1, start);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return { offsets, length: content.length };
}

// One process's V8 block coverage of a script, as [start, end, count] ranges.
type Ranges = [number, number, number][];

// Whether `offset` ran: the innermost range holding it decides, because block ranges nest inside
// function ranges and a function never called has a count-0 range of its own.
function ran(ranges: Ranges, offset: number) {
  let best: [number, number, number] | undefined;
  for (const range of ranges)
    if (
      range[0] <= offset &&
      offset < range[1] &&
      (!best || range[1] - range[0] <= best[1] - best[0])
    )
      best = range;
  return Boolean(best && best[2] > 0);
}

// Which of a file's changed lines ran in any of the processes that loaded it. A process whose
// script length differs from Refit's own transpile ran other code, and its coverage is not used.
export function lineCoverage(path: string, content: string, lines: number[], processes: Ranges[]) {
  const { offsets, length } = executableOffsets(path, content);
  const usable = processes.filter((ranges) =>
    ranges.some((range) => range[0] === 0 && range[1] === length),
  );
  const result = {
    executed: [] as number[],
    missing: [] as number[],
    notExecutable: [] as number[],
    ...(usable.length < processes.length
      ? { mismatch: `${processes.length - usable.length} process(es) ran a different ${path}.` }
      : {}),
  };
  for (const line of lines) {
    const candidates = offsets.get(line) ?? [];
    if (!candidates.length) result.notExecutable.push(line);
    else if (usable.some((ranges) => candidates.some((offset) => ran(ranges, offset))))
      result.executed.push(line);
    else result.missing.push(line);
  }
  return result;
}

// The node:test reporter inside the sandbox: one line per test (suites are not tests), Node's error
// line for a test file that failed before its tests ran, and each test's path of suite names.
const REPORTER = `import { relative } from 'node:path';
const stacks = new Map();
const describe = (error) => {
  if (error instanceof Error || typeof error !== 'object' || error === null) return String(error);
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
};
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    const file = data?.file ? relative(process.cwd(), data.file) : undefined;
    if (type === 'test:stderr' && file) {
      const line = String(data.message).split('\\n').map((text) => text.trim()).find((text) => /^[A-Za-z]*Error\\b/.test(text));
      if (line) yield 'REFIT_BEHAVIOUR_STDERR=' + JSON.stringify({ file, line: line.slice(0, 500) }) + '\\n';
    }
    if (type === 'test:start' && file) {
      const stack = stacks.get(file) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      stacks.set(file, stack);
    }
    if ((type !== 'test:pass' && type !== 'test:fail') || data.details?.type === 'suite') continue;
    const fileLevel = data.nesting === 0 && (data.name === file || data.name === data.file);
    if (fileLevel && type === 'test:pass') continue;
    const error = data.details?.error;
    const phase = fileLevel ? 'load' : ['testTimeoutFailure', 'cancelledByParent'].includes(error?.failureType) ? 'timeout' : 'test';
    const path = [file, ...(stacks.get(file) ?? []).slice(0, data.nesting), data.name];
    yield 'REFIT_BEHAVIOUR_TEST=' + JSON.stringify({
      file,
      id: path.join(' > '),
      ok: type === 'test:pass',
      ...(data.skip ? { skip: true } : {}),
      ...(data.todo ? { todo: true } : {}),
      ...(type === 'test:fail' ? { phase, error: describe(error?.cause ?? error?.message ?? error).slice(0, 500) } : {}),
    }) + '\\n';
  }
}
`;

// Runs the behaviour tests with node --test under the generated checks' hooks (api.stripe.com to
// stripe-mock, TypeScript transpiled, the side's import map) and V8 coverage, then prints the
// coverage ranges of the changed files only.
const RUNNER = `import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
const port = Number(process.env.REFIT_STRIPE_MOCK_PORT ?? ${MOCK_PORT});
const root = process.env.REFIT_GENERATED_ROOT ?? '/workspace/';
const side = process.env.REFIT_GENERATED_SIDE === 'after' ? 'after' : 'before';
const tool = (name) => fileURLToPath(new URL(name, import.meta.url));
for (let attempt = 0; ; attempt++) {
  const ready = await new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (ready) break;
  if (attempt > 100) throw new Error('stripe-mock did not start');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const tests = readdirSync(root + '${BEHAVIOUR_DIRECTORY}').filter((name) => name.endsWith('.test.mjs')).sort().map((name) => '${BEHAVIOUR_DIRECTORY}/' + name);
const coverage = root + '.refit-coverage';
const run = spawnSync(process.execPath, ['--import', tool('redirect.mjs'), '--test', '--test-concurrency=1', '--test-timeout=${TEST_TIMEOUT_MS}', '--test-reporter=' + tool('reporter.mjs'), ...tests], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: coverage },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(run.stdout ?? '');
process.stderr.write(String(run.stderr ?? '').slice(-4000));
if (run.error) console.error(String(run.error));
console.log('REFIT_BEHAVIOUR_EXIT=' + JSON.stringify(run.status));
const files = JSON.parse(readFileSync(tool('behaviour-' + side + '.json'), 'utf8'));
const wanted = new Map(files.flatMap((file) => [[pathToFileURL(root + file).href, file], [root + file, file]]));
const scripts = {};
for (const name of existsSync(coverage) ? readdirSync(coverage) : []) {
  for (const script of JSON.parse(readFileSync(coverage + '/' + name, 'utf8')).result ?? []) {
    const file = wanted.get(script.url);
    if (file) (scripts[file] ??= []).push(script.functions.flatMap((entry) => entry.ranges.map((range) => [range.startOffset, range.endOffset, range.count])));
  }
}
console.log('REFIT_BEHAVIOUR_COVERAGE=' + JSON.stringify(scripts));
// Signed-event deliveries (signed-events.ts) write one record each.
const records = root + '.refit-webhooks';
for (const name of existsSync(records) ? readdirSync(records).sort() : [])
  console.log('REFIT_WEBHOOK_RECORD=' + readFileSync(records + '/' + name, 'utf8'));
console.log('REFIT_BEHAVIOUR_DONE');
`;

// Behaviour tests may import code with the repository's own aliases and extensionless paths.
function behaviourImportMap(repository: Repository, tests: readonly BehaviourTest[]) {
  return generatedImportMap({
    ...repository,
    files: [
      ...repository.files,
      ...tests.map((test) => ({ path: test.path, content: test.content })),
    ],
  } as Repository);
}

export async function writeBehaviourHarness(
  directory: string,
  tests: readonly BehaviourTest[],
  changed: Record<Side, LinesByFile>,
  sources: Record<Side, Repository>,
) {
  await writeHarness(
    directory,
    [],
    behaviourImportMap(sources.original, tests),
    behaviourImportMap(sources.patched, tests),
    generatedEnvironment(sources.original, sources.patched),
  );
  await writeFile(join(directory, 'reporter.mjs'), REPORTER, { mode: 0o444 });
  await writeFile(join(directory, 'behaviour.mjs'), RUNNER, { mode: 0o444 });
  for (const [side, file] of [
    ['original', 'behaviour-before.json'],
    ['patched', 'behaviour-after.json'],
  ] as const)
    await writeFile(join(directory, file), JSON.stringify(Object.keys(changed[side])), {
      mode: 0o444,
    });
  await mkdir(join(directory, 'tests'), { mode: 0o755 });
  for (const test of tests)
    await writeFile(
      join(directory, 'tests', test.path.slice(BEHAVIOUR_DIRECTORY.length + 1)),
      test.content,
      {
        mode: 0o444,
      },
    );
}

export function behaviourCommand(side: 'before' | 'after') {
  return [
    'sh',
    '-c',
    `(/refit/stripe-mock -http-addr 127.0.0.1:${MOCK_PORT} -spec /refit/spec.json -fixtures /refit/fixtures.json >/tmp/refit-stripe-mock.log 2>&1 &); ` +
      `mkdir -p /workspace/${BEHAVIOUR_DIRECTORY} && cp /refit/generated/tests/*.test.mjs /workspace/${BEHAVIOUR_DIRECTORY}/ && ` +
      `STRIPE_SECRET_KEY=sk_test_123 STRIPE_API_KEY=sk_test_123 STRIPE_KEY=sk_test_123 REFIT_GENERATED_SIDE=${side} ` +
      'exec node /refit/generated/behaviour.mjs',
  ];
}

interface TestResult {
  file: string;
  id: string;
  ok: boolean;
  skip?: true;
  todo?: true;
  phase?: 'load' | 'test' | 'timeout';
  error?: string;
}

// What one side's sandbox printed: per-test results, the exit code of node --test, the changed
// files' coverage, and whether the runner reached its end.
export function behaviourOutput(stdout: string) {
  const tests: TestResult[] = [];
  const stderr = new Map<string, string>();
  let exit: number | null = null;
  let coverage: Record<string, Ranges[]> = {};
  let done = false;
  const value = (line: string) => JSON.parse(line.slice(line.indexOf('=') + 1)) as unknown;
  for (const line of stdout.split('\n'))
    if (line.startsWith('REFIT_BEHAVIOUR_TEST=')) tests.push(value(line) as TestResult);
    else if (line.startsWith('REFIT_BEHAVIOUR_STDERR=')) {
      const { file, line: text } = value(line) as { file: string; line: string };
      if (!stderr.has(file)) stderr.set(file, text);
    } else if (line.startsWith('REFIT_BEHAVIOUR_EXIT=')) exit = value(line) as number | null;
    else if (line.startsWith('REFIT_BEHAVIOUR_COVERAGE='))
      coverage = value(line) as Record<string, Ranges[]>;
    else if (line === 'REFIT_BEHAVIOUR_DONE') done = true;
  return {
    // Node reports a file that failed to load as "test failed"; its own error is on stderr.
    tests: tests.map((test) =>
      test.phase === 'load' && stderr.has(test.file)
        ? { ...test, error: stderr.get(test.file) }
        : test,
    ),
    exit,
    coverage,
    done,
    records: signedEventRecords(stdout),
  };
}

const lineList = (lines: number[]) =>
  lines.length > 8
    ? `${lines.slice(0, 8).join(', ')} and ${lines.length - 8} more`
    : lines.join(', ');
const sideText = {
  original: 'the original code against the before-version stripe-mock',
  patched: 'the patched code against the after-version stripe-mock',
};

// What the two runs prove. A test that passed on the original side and fails an assertion on the
// patched side counts against the patch, as a regression: the file is the same on both sides, so
// only the patch and the API version differ. A side that did not finish, a test that cannot pass on
// the original code, and a test file that does not load or a test that times out on the patched
// side are reported and never counted. Grade A needs every test to pass on both sides and every
// changed executable Stripe line to have run on both sides.
export function compareBehaviourRuns(options: {
  tests: readonly BehaviourTest[];
  changed: Record<Side, LinesByFile>;
  sources: Record<Side, Repository>;
  original: CheckResult;
  patched: CheckResult;
}) {
  const sides = (['original', 'patched'] as const).map((side) => {
    const check = options[side];
    const output = behaviourOutput(check.stdout);
    const error = check.stderr
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^[A-Za-z]*Error\b/.test(line));
    const broken =
      check.status === 'error'
        ? `The ${side} run did not finish: ${check.error ?? 'the container failed'}`
        : !output.done
          ? `The behaviour harness on ${sideText[side]} stopped before finishing (exit code ${check.exitCode ?? 'none'})${error ? `: ${error.slice(0, 300)}` : '.'}`
          : undefined;
    const content = (path: string) =>
      options.sources[side].files.find((file) => file.path === path)?.content ?? '';
    const coverage = Object.fromEntries(
      Object.entries(options.changed[side]).map(([path, lines]) => [
        path,
        lineCoverage(path, content(path), lines, output.coverage[path] ?? []),
      ]),
    );
    return { side, check, output, broken, coverage };
  });
  const [original, patched] = sides;
  const byId = (side: (typeof sides)[number]) =>
    new Map(side.output.tests.map((test) => [test.id, test]));
  const before = byId(original);
  const after = byId(patched);
  const passing = (test?: TestResult) => Boolean(test?.ok && !test.skip && !test.todo);
  const broken = original.broken ?? patched.broken;
  const regressions = broken
    ? []
    : [...before.values()]
        .filter((test) => passing(test) && after.get(test.id)?.ok === false)
        .filter((test) => after.get(test.id)!.phase === 'test')
        .map((test) => ({ id: test.id, error: after.get(test.id)!.error ?? 'No error recorded.' }));
  const missing: string[] = [];
  if (broken) missing.push(broken);
  // The same files must run the same tests on both sides.
  const oneSided = broken
    ? []
    : [
        ...[...before.keys()].filter((id) => !after.has(id)),
        ...[...after.keys()].filter((id) => !before.has(id)),
      ];
  for (const id of oneSided) missing.push(`${id} ran on one side only.`);
  for (const side of sides) {
    if (side.broken) continue;
    if (!side.output.tests.length) missing.push(`No test ran on ${sideText[side.side]}.`);
    for (const test of side.output.tests)
      if (!passing(test))
        missing.push(
          `${test.id} ${test.ok ? (test.skip ? 'was skipped' : 'is a todo') : `failed (${test.phase})`} on ${sideText[side.side]}${test.error ? `: ${test.error}` : '.'}`,
        );
  }
  const lines = (pick: (coverage: ReturnType<typeof lineCoverage>) => number[]) =>
    Object.fromEntries(
      sides.map((side) => [
        side.side,
        Object.fromEntries(
          Object.entries(side.coverage)
            .map(([path, coverage]) => [path, pick(coverage)] as const)
            .filter(([, values]) => values.length),
        ),
      ]),
    ) as Record<Side, LinesByFile>;
  const coverage = {
    changedLines: lines((file) => [...file.executed, ...file.missing].sort((a, b) => a - b)),
    covered: lines((file) => file.executed),
    missing: lines((file) => file.missing),
    notExecutable: lines((file) => file.notExecutable),
  };
  for (const side of sides) {
    for (const [path, file] of Object.entries(side.coverage)) {
      if (file.mismatch) missing.push(`${file.mismatch} on ${sideText[side.side]}`);
      if (file.missing.length)
        missing.push(
          `${path} line${file.missing.length === 1 ? '' : 's'} ${lineList(file.missing)} did not run on ${sideText[side.side]}.`,
        );
    }
  }
  const changedCount = sides.reduce(
    (count, side) => count + Object.values(coverage.changedLines[side.side]).flat().length,
    0,
  );
  if (!changedCount) missing.push('The patch changes no executable Stripe line.');
  const allPass =
    !oneSided.length &&
    sides.every(
      (side) => !side.broken && side.output.tests.length > 0 && side.output.tests.every(passing),
    );
  const status = broken
    ? ('unavailable' as const)
    : regressions.length
      ? ('regression' as const)
      : allPass
        ? ('passed' as const)
        : ('not-passing' as const);
  return {
    engine: 'node-test+stripe-mock' as const,
    status,
    ...(broken ? { reason: broken } : {}),
    grade: status === 'passed' && !missing.length ? ('A' as const) : null,
    missing,
    // The source stays with the result, so a reviewer can read the tests behind a grade.
    tests: options.tests.map((test) => ({
      path: test.path,
      sha256: digest(test.content),
      content: test.content,
    })),
    coverage,
    regressions,
    sides: Object.fromEntries(
      sides.map((side) => [
        side.side,
        {
          status: side.check.status,
          exitCode: side.check.exitCode,
          ...(side.check.error ? { error: side.check.error } : {}),
          testExitCode: side.output.exit,
          tests: side.output.tests,
          stderr: side.check.stderr.slice(-2000),
          ...(side.output.records.length ? { records: side.output.records } : {}),
        },
      ]),
    ) as Record<
      Side,
      {
        status: CheckResult['status'];
        exitCode: number | null;
        error?: string;
        testExitCode: number | null;
        tests: TestResult[];
        stderr: string;
        records?: DeliveryRecord[];
      }
    >,
  };
}

// Grade A's input for check-selection's gradeEvidence: the tests passed on both sides and every
// changed Stripe line ran on both. Anything less keeps the checks' own grade.
export function behaviourGrade(result: {
  status: string;
  grade: 'A' | null;
  missing: string[];
  tests: { path: string }[];
  coverage?: { changedLines: Record<Side, LinesByFile> };
}): BehaviourEvidence {
  const count = (side: Side) =>
    Object.values(result.coverage?.changedLines[side] ?? {}).flat().length;
  return {
    passed: result.status === 'passed',
    coversEveryChangedLine: result.grade === 'A',
    reason:
      result.grade === 'A'
        ? `Behaviour tests (${result.tests.map((test) => test.path).join(', ')}) passed on ${sideText.original} and on ${sideText.patched}, and ran every changed Stripe line on both sides (${count('original')} original, ${count('patched')} patched).`
        : `Behaviour tests did not give grade A: ${result.missing[0] ?? 'no reason recorded.'}`,
  };
}

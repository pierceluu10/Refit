import { TESTS_FAILED } from './check-selection.ts';

// The tests a run failed and how many passed, read from the default output of the test runners
// Refit's checks start (Vitest, Jest, Mocha and Node's test runner). A failing baseline is then
// compared test by test: every test that passed on the original code must pass on the patch, and
// the tests that already failed are reported, never counted as passing. Output Refit cannot read
// answers undefined, and the baseline failure stands.

export interface TestOutcomes {
  runner: 'vitest' | 'jest' | 'mocha' | 'node';
  // A test's full title, or a whole file that failed to load (`file <path>`).
  failed: Set<string>;
  passed: number;
}

// Terminal colours and the ANSI cursor codes some reporters print.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function vitest(text: string): TestOutcomes | undefined {
  const summary =
    /^\s*Tests\s+(?:(\d+) failed)?(?:\s*\|\s*)?(?:(\d+) passed)?.*\((\d+)\)\s*$/m.exec(text);
  if (!summary || !/^\s*Test Files\s/m.test(text)) return undefined;
  const failed = new Set<string>();
  for (const match of text.matchAll(/^\s*FAIL\s+(\S[^\n]*?)\s*$/gm)) {
    const title = match[1].replace(/\s+\[[^\]]*\]$/, '');
    failed.add(title.includes(' > ') ? title : `file ${title}`);
  }
  // A failed count Refit cannot match to titles means the failures are not all named.
  if (Number(summary[1] ?? 0) > [...failed].filter((title) => !title.startsWith('file ')).length)
    return undefined;
  return { runner: 'vitest', failed, passed: Number(summary[2] ?? 0) };
}

function jest(text: string): TestOutcomes | undefined {
  const summary =
    /^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(?:(\d+) passed, )?(\d+) total$/m.exec(
      text,
    );
  if (!summary) return undefined;
  const failed = new Set<string>();
  let file = '';
  for (const line of text.split('\n')) {
    const suite = /^FAIL\s+(\S+)/.exec(line);
    if (suite) file = suite[1];
    const test = /^ {2}● (.+)$/.exec(line);
    if (test)
      failed.add(test[1] === 'Test suite failed to run' ? `file ${file}` : `${file} › ${test[1]}`);
  }
  if (Number(summary[1] ?? 0) > [...failed].filter((title) => !title.startsWith('file ')).length)
    return undefined;
  return { runner: 'jest', failed, passed: Number(summary[2] ?? 0) };
}

function mocha(text: string): TestOutcomes | undefined {
  const passing = /^\s+(\d+) passing\b/m.exec(text);
  if (!passing) return undefined;
  const count = Number(/^\s+(\d+) failing\b/m.exec(text)?.[1] ?? 0);
  const failed = new Set<string>();
  // Each failure: `  1) suite` then deeper-indented title lines, the last ending in `:`.
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const start = /^ {2}\d+\) (.+)$/.exec(lines[index]);
    if (!start) continue;
    const parts = [start[1].trim()];
    while (
      index + 1 < lines.length &&
      /^ {5,}\S/.test(lines[index + 1]) &&
      !parts.at(-1)!.endsWith(':')
    )
      parts.push(lines[++index].trim());
    failed.add(parts.join(' ').replace(/:$/, ''));
  }
  if (failed.size !== count) return undefined;
  return { runner: 'mocha', failed, passed: Number(passing[1]) };
}

function node(text: string): TestOutcomes | undefined {
  const pass = /^[ℹ#] pass (\d+)$/m.exec(text);
  const fail = /^[ℹ#] fail (\d+)$/m.exec(text);
  if (!pass || !fail) return undefined;
  const failed = new Set<string>();
  for (const match of text.matchAll(/^\s*(?:not ok \d+ - |✖ )(.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm))
    failed.add(match[1].trim());
  if (failed.size < Number(fail[1])) return undefined;
  return { runner: 'node', failed, passed: Number(pass[1]) };
}

// The test part of a run: in a check chain, the output before its failed-tests marker.
export function testOutcomes(run: { stdout: string; stderr: string }) {
  const end = run.stdout.indexOf(TESTS_FAILED);
  const text = `${end >= 0 ? run.stdout.slice(0, end) : run.stdout}\n${run.stderr}`.replace(
    ANSI,
    '',
  );
  const read = [vitest, jest, mocha, node].map((parse) => parse(text)).filter(Boolean);
  // Two runners' summaries in one output cannot be told apart.
  return read.length === 1 ? read[0] : undefined;
}

export type BaselineTests =
  | { status: 'kept'; runner: string; alreadyFailing: string[]; passed: number }
  | { status: 'unreadable' | 'regressed'; reason: string };

// Whether the patch kept every test that passed on the original code.
export function compareBaselineTests(
  baseline: { stdout: string; stderr: string },
  patched: { stdout: string; stderr: string },
): BaselineTests {
  const before = testOutcomes(baseline);
  const after = testOutcomes(patched);
  if (!before || !after || before.runner !== after.runner || !before.failed.size)
    return {
      status: 'unreadable',
      reason: 'Refit could not read which tests failed on both the original code and the patch.',
    };
  const newly = [...after.failed].filter((title) => !before.failed.has(title));
  if (newly.length)
    return {
      status: 'regressed',
      reason: `The patch fails ${newly.length} test${newly.length === 1 ? '' : 's'} that passed on the original code, first ${newly[0]}.`,
    };
  if (after.passed < before.passed)
    return {
      status: 'regressed',
      reason: `${before.passed} tests passed on the original code and ${after.passed} on the patch.`,
    };
  return {
    status: 'kept',
    runner: before.runner,
    alreadyFailing: [...before.failed].sort(),
    passed: after.passed,
  };
}

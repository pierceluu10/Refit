import { expect, it } from 'vitest';
import { BoundedOutput, runBounded } from './check-output.ts';
import { newTestFailures } from './check-failures.ts';

const tap = (count: number, failing: Set<number>) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${failing.has(index) ? 'not ok' : 'ok'} ${index + 1} - case ${index + 1}\n  ---\n  duration_ms: 1.5\n  type: 'test'\n  ${'detail '.repeat(20)}\n  ...\n`,
  ).join('');

it('keeps the head, the tail and every result line of a suite too long to keep whole', () => {
  const output = new BoundedOutput();
  const failing = new Set([3, 9_000, 19_990]);
  const text = `${tap(20_000, failing)}# pass 19997\n# fail 3\n`;
  // Chunks that split lines anywhere.
  for (let start = 0; start < text.length; start += 7_919)
    output.write(text.slice(start, start + 7_919));
  const kept = output.text();
  expect(text.length).toBeGreaterThan(4 * 1024 * 1024);
  expect(kept.length).toBeLessThan(1024 * 1024);
  expect(kept.startsWith('ok 1 - case 1\n')).toBe(true);
  expect(kept.endsWith('# pass 19997\n# fail 3\n')).toBe(true);
  for (const index of failing) expect(kept).toContain(`not ok ${index + 1} - case ${index + 1}\n`);
  expect(kept).toMatch(/\[Refit omitted \d+ characters of output here\]/);
  // Every kept line is a whole line of the original, in order.
  const lines = kept.split('\n').filter((line) => !line.startsWith('[Refit omitted'));
  let position = 0;
  for (const line of lines) {
    const found = text.indexOf(`${line}\n`, position);
    if (line) expect(found).toBeGreaterThanOrEqual(position);
    if (line) position = found + line.length;
  }
});

it('keeps short output unchanged and cuts an endless line', () => {
  const short = new BoundedOutput();
  short.write('one\ntwo');
  expect(short.text()).toBe('one\ntwo');
  const endless = new BoundedOutput();
  for (let index = 0; index < 400; index += 1) endless.write('y'.repeat(10_000));
  expect(endless.text().length).toBeLessThan(1024 * 1024);
});

it('compares the failures of a long run by the tests it names, not by the cap', () => {
  const run = (failing: Set<number>) => {
    const output = new BoundedOutput();
    output.write(
      `${tap(20_000, failing)}# pass ${20_000 - failing.size}\n# fail ${failing.size}\n`,
    );
    return { status: 'failed' as const, exitCode: 1, stdout: output.text(), stderr: '' };
  };
  const before = run(new Set([3, 9_000]));
  expect(newTestFailures(before, run(new Set([3, 9_000])))).toEqual([]);
  expect(newTestFailures(before, run(new Set([3, 9_000, 15_000])))).toContain(
    'not ok 15001 - case 15001',
  );
});

it('runs a command to its exit code with bounded output and stops it at the time limit', async () => {
  const flood = await runBounded(
    process.execPath,
    [
      '-e',
      'for (let i = 0; i < 300000; i++) console.log("ok " + i + " - line"); console.error("Error: boom"); process.exitCode = 3',
    ],
    { timeout: 30_000 },
  );
  expect(flood).toMatchObject({ exitCode: 3, timedOut: false });
  expect(flood.stdout.length).toBeLessThan(1024 * 1024);
  expect(flood.stdout).toContain('ok 299999 - line');
  expect(flood.stderr).toBe('Error: boom\n');
  const slow = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 300,
  });
  expect(slow).toMatchObject({ exitCode: null, timedOut: true });
  const missing = await runBounded('refit-no-such-binary', [], { timeout: 1_000 });
  expect(missing.error?.message).toMatch(/ENOENT/);
});

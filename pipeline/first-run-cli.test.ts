import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// What a new user sees from the installed binary before any repository is set up
// (docs/FIRST-RUN.md). Each assertion pins the text that replaced a vaguer one.
const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const refit = (...args: string[]) =>
  execute(process.execPath, [bin, ...args]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );

it('starts the top-level help with the four commands a new user runs, in order', async () => {
  const { stdout } = await refit();
  expect(stdout.split('\n').slice(0, 8)).toEqual([
    'Refit: reviewable API migrations',
    '',
    'Start in your repository:',
    '  refit agents              See which provider agents apply',
    '  refit agents --add <id>   Write .refit.json for one and list the contracts to save',
    '  refit doctor              Check the setup without running any code',
    '  refit run                 Scan, propose and validate a migration',
    '',
  ]);
});

it('says which stripe-snapshot argument is missing and how to choose a revision', async () => {
  const output = await refit('stripe-snapshot', '--latest');
  expect(output.code).toBe(1);
  expect(output.stderr.split('\n')[0]).toBe(
    'refit stripe-snapshot: --output <new-snapshot.json> is required.',
  );
  expect((await refit('stripe-snapshot', '--output', 'x.json')).stderr.split('\n')[0]).toBe(
    'refit stripe-snapshot: choose --latest or --revision <full-commit-sha>.',
  );
  expect((await refit('stripe-snapshot', '--help')).stdout).toContain(
    "--revision with the stripe/openapi commit whose spec has your code's pinned API version",
  );
});

it('prints mistakes as sentences instead of error class names', async () => {
  // Before: "TypeError: Unknown option '--bogus'" and "Error: ENOENT: ... realpath '/...'".
  expect((await refit('doctor', '--bogus')).stderr.trim()).toBe(
    "refit doctor: Unknown option '--bogus'. Run refit doctor --help for its options.",
  );
  expect(
    (await refit('deadlines', '--repository', '/refit-missing-repository')).stderr.trim(),
  ).toBe('refit deadlines: /refit-missing-repository does not exist.');
});

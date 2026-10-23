import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { distribution, installSeconds, parseTime } from '../scripts/capacity-helpers.mjs';

// Captured from macOS `/usr/bin/time -l -o <file> node -e 0`.
const BSD = `        0.05 real         0.04 user         0.00 sys
            47185920  maximum resident set size
                   0  average shared memory size
                3140  page reclaims
            14616208  peak memory footprint
`;
// GNU time `-v -o <file>` format (Linux), written from its documented fields, not captured.
const GNU = `\tCommand being timed: "node bin/refit.mjs deadlines --json --repository /work/r"
\tUser time (seconds): 1.42
\tSystem time (seconds): 0.31
\tPercent of CPU this job got: 104%
\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.66
\tMaximum resident set size (kbytes): 183244
\tExit status: 0
`;

it('reads CPU seconds and peak memory from BSD and GNU time, in bytes', () => {
  expect(parseTime(BSD)).toEqual({ userSeconds: 0.04, systemSeconds: 0, maxRssBytes: 47185920 });
  expect(parseTime(GNU)).toEqual({
    userSeconds: 1.42,
    systemSeconds: 0.31,
    maxRssBytes: 183244 * 1024,
  });
  // Truncated or foreign output is not guessed at.
  expect(parseTime(BSD.split('\n')[0])).toBeNull();
  expect(parseTime('Command terminated by signal 9')).toBeNull();
});

it('reports nearest-rank percentiles and ignores missing values', () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  expect(distribution([...values, Number.NaN])).toEqual({
    count: 100,
    p50: 50,
    p90: 90,
    p99: 99,
    max: 100,
  });
  expect(distribution([7])).toEqual({ count: 1, p50: 7, p90: 7, p99: 7, max: 7 });
  expect(distribution([])).toBeNull();
});

it('reads the install time each package manager prints, flagging npm whole minutes', () => {
  expect(installSeconds('added 1484 packages, and audited 1485 packages in 33s')).toEqual({
    seconds: 33,
    rounded: false,
  });
  expect(installSeconds('added 1 package in 545ms')).toEqual({ seconds: 0.545, rounded: false });
  expect(installSeconds('added 2210 packages in 2m')).toEqual({ seconds: 120, rounded: true });
  expect(installSeconds('Done in 1m 2.5s using pnpm v10.34.7')).toEqual({
    seconds: 62.5,
    rounded: false,
  });
  expect(installSeconds('Done in 8.7s.')).toEqual({ seconds: 8.7, rounded: false });
  // The last report wins; a log without one is not guessed at.
  expect(installSeconds('added 3 packages in 1s\nadded 9 packages in 4s')?.seconds).toBe(4);
  expect(installSeconds('npm error code ETIMEDOUT')).toBeNull();
});

it('reproduces the committed capacity model from the committed measurements', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/capacity-model.mjs']);
  const committed = JSON.parse(
    await readFile('docs/benchmarks/2026-10-22-capacity-model.json', 'utf8'),
  );
  const model = JSON.parse(stdout);
  expect(model).toEqual(committed);
  // The size fly.toml runs today leaves under half a GiB beside a full validation container.
  const today = model.sizes.find((size: { name: string }) => size.name === 'shared-cpu-2x');
  expect(today).toMatchObject({ memoryGb: 4, usdPerMonth: 25.39, sustainedCpuPerSecond: 0.125 });
  expect(today.memoryHeadroomGib).toBeLessThan(0.5);
});

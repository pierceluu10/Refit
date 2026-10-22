import { expect, it } from 'vitest';
import { distribution, parseTime } from '../scripts/capacity-helpers.mjs';

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

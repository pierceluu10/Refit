import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseCpuTimes, readCpuTimes, stealShare, THROTTLED_STEAL } from './hosted-cpu.ts';

// Two samples of /proc/stat on refit-hosted (shared-cpu-2x) taken 10 s apart at 08:07Z, while job
// 254 installed dependencies and later hit the 300 s preparation limit.
const BEFORE =
  'cpu  144021 0 20061 1751870 1986 0 1117 468098 0 0\ncpu0 72010 0 10030 875935 993 0 558 234049 0 0\n';
const AFTER =
  'cpu  144095 0 20121 1753031 1986 0 1117 469392 0 0\ncpu0 72047 0 10060 876515 993 0 558 234696 0 0\n';

it('reads the steal share of the machine line, ignoring guest time and per-CPU lines', () => {
  expect(parseCpuTimes(BEFORE)).toEqual({
    steal: 468098,
    total: 144021 + 20061 + 1751870 + 1986 + 1117 + 468098,
  });
  const share = stealShare(parseCpuTimes(BEFORE), parseCpuTimes(AFTER));
  console.log(`steal share during job 254: ${share}`);
  expect(share).toBeCloseTo(1294 / 2589, 6);
  expect(share).toBeGreaterThanOrEqual(THROTTLED_STEAL);
  expect(parseCpuTimes('cpu 1 0 2 3 0 0 0 4').total).toBe(10);
  // No time passed: no share rather than a division by zero.
  expect(stealShare(parseCpuTimes(AFTER), parseCpuTimes(AFTER))).toBe(0);
});

it('refuses a file that does not start with the machine cpu line', () => {
  for (const stat of ['cpu0 1 2 3 4 5 6 7 8\n', 'cpu 1 2 3 4\n', 'cpu 1 2 3 4 5 6 7 x\n', ''])
    expect(() => parseCpuTimes(stat)).toThrow(
      "/proc/stat does not start with the machine's cpu line.",
    );
});

it('reads the file and measures nothing where the platform has none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-cpu-'));
  try {
    await writeFile(join(directory, 'stat'), AFTER);
    expect(await readCpuTimes(join(directory, 'stat'))).toEqual(parseCpuTimes(AFTER));
    expect(await readCpuTimes(join(directory, 'missing'))).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

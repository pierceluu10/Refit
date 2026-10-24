import { readFile } from 'node:fs/promises';
import { hasErrorCode } from './state-files.ts';
import { PipelineInputError } from './types.ts';

// The machine's CPU time since boot, in ticks. On Fly's shared vCPUs, time a job wanted beyond the
// CPU quota is reported as steal.
const PROC_STAT = '/proc/stat';
// user nice system idle iowait irq softirq steal; guest time is already counted in user and nice.
const CPU_FIELDS = 8;
const STEAL_FIELD = 7;
// Job 254 on shared-cpu-2x ran its install at about 50% steal and hit the 300 s limit
// (docs/overnight/P1.md). From a quarter on, installs and checks run several times slower.
export const THROTTLED_STEAL = 0.25;
// A cached poll lasts a few seconds, too few ticks for a reliable share.
export const MIN_THROTTLE_SECONDS = 30;

export interface CpuTimes {
  steal: number;
  total: number;
}

export function parseCpuTimes(stat: string): CpuTimes {
  const [label, ...fields] = stat.split('\n', 1)[0].trim().split(/\s+/);
  const values = fields.slice(0, CPU_FIELDS).map(Number);
  if (label !== 'cpu' || values.length < CPU_FIELDS || !values.every(Number.isSafeInteger))
    throw new PipelineInputError(`${PROC_STAT} does not start with the machine's cpu line.`);
  return { steal: values[STEAL_FIELD], total: values.reduce((sum, value) => sum + value, 0) };
}

// Null where the platform has no /proc/stat, such as a developer's macOS machine.
export async function readCpuTimes(path = PROC_STAT): Promise<CpuTimes | null> {
  try {
    return parseCpuTimes(await readFile(path, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export function stealShare(before: CpuTimes, after: CpuTimes) {
  const total = after.total - before.total;
  return total > 0 ? (after.steal - before.steal) / total : 0;
}

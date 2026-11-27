// Parses runner options. The dollar cap and concurrency have no defaults: the runner refuses
// to start unless both are given explicitly.
import type { RunConfig } from './types.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseFlags(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument "${arg}"`);
    const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[index + 1];
    if (inline !== undefined) flags[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else flags[key] = true;
  }
  return flags;
}

function requiredNumber(flags: Record<string, string | true>, key: string): number {
  const raw = flags[key];
  if (raw === undefined || raw === true || raw.trim() === '') {
    throw new ConfigError(`--${key} is required; the runner never picks a default`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`--${key} must be a number (got "${raw}")`);
  return value;
}

export function parseRunConfig(flags: Record<string, string | true>): RunConfig {
  const set = flags.set;
  if (typeof set !== 'string') throw new ConfigError('--set <dev set name> is required');
  const budgetUsd = requiredNumber(flags, 'budget-usd');
  if (budgetUsd <= 0) throw new ConfigError('--budget-usd must be above zero');
  const concurrency = requiredNumber(flags, 'concurrency');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ConfigError('--concurrency must be a positive integer');
  }
  let shard: number | undefined;
  if (flags.shard !== undefined) {
    shard = requiredNumber(flags, 'shard');
    if (!Number.isInteger(shard) || shard < 0) {
      throw new ConfigError('--shard must be a repo index');
    }
  }
  let limit: number | undefined;
  if (flags.limit !== undefined) {
    limit = requiredNumber(flags, 'limit');
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConfigError('--limit must be a positive integer');
    }
  }
  const outDir = typeof flags.out === 'string' ? flags.out : 'evals/results';
  const watchCache = typeof flags['watch-cache'] === 'string' ? flags['watch-cache'] : undefined;
  return {
    set,
    budgetUsd,
    concurrency,
    shard,
    ...(limit ? { limit } : {}),
    outDir,
    ...(watchCache ? { watchCache } : {}),
  };
}

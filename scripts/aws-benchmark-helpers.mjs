// Pure helpers for scripts/aws-benchmark.mjs, kept separate so they are testable without AWS.
import { readFileSync } from 'node:fs';

export const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const PLACEHOLDER = /\{(offset|limit|shard|run)\}/g;

export function bucketName(account, region) {
  return `refit-benchmarks-${account}-${region}`;
}

// Splits `total` items into `shards` contiguous slices, larger slices first, none empty.
export function shardSlices(total, shards) {
  if (!Number.isInteger(total) || total < 1) throw new Error('--total must be a positive integer.');
  if (!Number.isInteger(shards) || shards < 1 || shards > total)
    throw new Error('--shards must be between 1 and --total.');
  const base = Math.floor(total / shards);
  const extra = total % shards;
  const slices = [];
  for (let shard = 0, offset = 0; shard < shards; shard++) {
    const limit = base + (shard < extra ? 1 : 0);
    slices.push({ shard, offset, limit });
    offset += limit;
  }
  return slices;
}

export function fillCommand(template, values) {
  return template.replace(PLACEHOLDER, (_, name) => String(values[name]));
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// Prepends the shard's settings to the boot script as shell variables.
export function bootScript(
  settings,
  template = readFileSync(new URL('./aws-benchmark-boot.sh', import.meta.url), 'utf8'),
) {
  const [shebang, ...rest] = template.split('\n');
  const variables = Object.entries(settings).map(([name, value]) => `${name}=${quote(value)}`);
  return [shebang, ...variables, ...rest].join('\n');
}

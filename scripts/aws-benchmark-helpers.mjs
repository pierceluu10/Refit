// Pure helpers for scripts/aws-benchmark.mjs, kept separate so they are testable without AWS.
import { readFileSync } from 'node:fs';

export const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const PLACEHOLDER = /\{(offset|limit|shard|run)\}/g;
const COUNT = /^\d+$/;
const RUNNING_STATES = ['pending', 'running'];
// "ExpiredToken" and "token ... expired" come from STS, EC2 and S3; "session has expired" from an
// `aws login` session whose refresh failed; "Unable to locate credentials" from no session at all.
const CREDENTIALS_FAILURE =
  /ExpiredToken|token (?:included in the request is|has) expired|session has expired|Unable to locate credentials/i;
// `ec2 run-instances --dry-run` reports a launch it would allow as a DryRunOperation error.
const DRY_RUN_ALLOWED = /\(DryRunOperation\)/;
// AWS errors name the account (also inside the bucket name), the organization's policy ARN and an
// encoded authorization message; none of them may reach output that lanes paste into PRs.
const ACCOUNT_ID = /\b\d{12}\b/g;
const ORGANIZATION_ARN = /arn:aws:organizations::[\w:/-]+/g;
const ENCODED_AUTHORIZATION = /Encoded authorization failure message: \S+/g;
// A validating benchmark holds the harness, a `refit run` child and a 3 GiB validation container at
// once; under this much memory a c7i.large shard can be starved.
const VALIDATE_MEMORY_MIB = 8 * 1024;
const VALIDATE = /--validate\b/;
const MILLISECONDS_PER_HOUR = 3_600_000;
// EC2 bills Linux on-demand instances per second with a one-minute minimum.
const MINIMUM_BILLED_HOURS = 1 / 60;
// The average month that EBS GB-month prices are prorated against.
const HOURS_PER_MONTH = 730;
const USD_DECIMALS = 4;

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

function count(value, flag) {
  if (!COUNT.test(value)) throw new Error(`${flag} must be a non-negative integer.`);
  return Number(value);
}

// One shard's part of a frozen list, from the setup scripts' --offset and --limit strings.
export function listSlice(items, offset, limit) {
  const start = offset === undefined ? 0 : count(offset, '--offset');
  return items.slice(start, limit === undefined ? undefined : start + count(limit, '--limit'));
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

// A shard's exit-code object holds "<status> <stage>". Runs launched before stages were recorded
// hold only the status.
export function parseExit(text) {
  const [status, stage] = text.trim().split(/\s+/);
  return { exit: Number(status), stage };
}

// Each shard's state from run.json's slices, its uploaded exit-code texts by shard and the run's
// EC2 instances. An uploaded exit code means finished even while the instance still shuts down; no
// exit code and no pending or running instance means lost (deadman, crash or never launched).
export function shardStates(slices, exits, instances) {
  return slices.map(({ shard }) => {
    if (exits.has(shard)) return { shard, state: 'finished', ...parseExit(exits.get(shard)) };
    const instance = instances.find(
      (candidate) => candidate.shard === shard && RUNNING_STATES.includes(candidate.state),
    );
    if (instance)
      return { shard, state: 'running', instance: instance.id, launched: instance.launched };
    return { shard, state: 'lost' };
  });
}

// Shard counts for `list`: succeeded, failed (any non-zero exit), running and lost.
export function stateCounts(states) {
  const counts = { succeeded: 0, failed: 0, running: 0, lost: 0 };
  for (const state of states) {
    if (state.state !== 'finished') counts[state.state] += 1;
    else counts[state.exit === 0 ? 'succeeded' : 'failed'] += 1;
  }
  return counts;
}

export function credentialsFailed(stderr) {
  return CREDENTIALS_FAILURE.test(stderr);
}

export function dryRunAllowed(stderr) {
  return DRY_RUN_ALLOWED.test(stderr);
}

export function redactAws(text) {
  return text
    .replace(ORGANIZATION_ARN, '[organization policy]')
    .replace(ACCOUNT_ID, '[account]')
    .replace(ENCODED_AUTHORIZATION, 'Encoded authorization failure message omitted.');
}

export function memoryWarning(command, instanceType, memoryMib) {
  if (!VALIDATE.test(command) || memoryMib >= VALIDATE_MEMORY_MIB) return undefined;
  return `Warning: ${instanceType} has ${memoryMib / 1024} GiB of memory; a --validate run needs at least ${VALIDATE_MEMORY_MIB / 1024} GiB, or the harness, refit run and the validation container compete for it.`;
}

function round(usd) {
  return Number(usd.toFixed(USD_DECIMALS));
}

// Instance and volume cost of every launch of a run. A launch ends at its recorded end, else at its
// shard's uploaded exit code when it is that shard's latest launch, else now while it runs.
// Otherwise its end is unknown, so it is charged up to its deadman shutdown and marked estimated.
// Spot launches are charged the on-demand price, also an upper bound.
export function runCost(run, launches, exitTimes, runningIds, now, prices) {
  const hourly = prices.onDemandUsdPerHour[run.instanceType];
  if (hourly === undefined)
    throw new Error(`No price for ${run.instanceType}; add it to the cost table.`);
  const perHour = hourly + (run.diskGib * prices.gp3UsdPerGibMonth) / HOURS_PER_MONTH;
  // In launch order per shard, so each shard's last launch is the one its exit code belongs to.
  const ordered = [...launches].sort(
    (a, b) => a.shard - b.shard || Date.parse(a.launchedAt) - Date.parse(b.launchedAt),
  );
  const rows = ordered.map((launch, index) => {
    const latest = ordered[index + 1]?.shard !== launch.shard;
    const exited = latest ? exitTimes.get(launch.shard) : undefined;
    const running = !launch.endedAt && !exited && runningIds.has(launch.instance);
    const end = launch.endedAt ?? exited ?? (running ? now : undefined);
    const estimated = end === undefined;
    const elapsed = estimated
      ? run.hours
      : (Date.parse(end) - Date.parse(launch.launchedAt)) / MILLISECONDS_PER_HOUR;
    const hours = Math.max(elapsed, MINIMUM_BILLED_HOURS);
    return {
      shard: launch.shard,
      instance: launch.instance,
      hours: round(hours),
      usd: hours * perHour,
      ...(running ? { running } : {}),
      ...(estimated || run.market === 'spot' ? { estimated: true } : {}),
    };
  });
  return {
    instanceType: run.instanceType,
    market: run.market,
    launches: rows.map((row) => ({ ...row, usd: round(row.usd) })),
    usd: round(rows.reduce((sum, row) => sum + row.usd, 0)),
  };
}

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  RUN_ID,
  bootScript,
  bucketName,
  credentialsFailed,
  dryRunAllowed,
  fillCommand,
  listSlice,
  memoryWarning,
  parseExit,
  runCost,
  shardSlices,
  shardStates,
  stateCounts,
} from '../scripts/aws-benchmark-helpers.mjs';

const execute = promisify(execFile);

it('splits a frozen list into contiguous, non-empty shards that cover every repository once', () => {
  const slices = shardSlices(381, 8);
  expect(slices).toHaveLength(8);
  expect(slices.map((slice) => slice.limit)).toEqual([48, 48, 48, 48, 48, 47, 47, 47]);
  expect(slices.reduce((sum, slice) => sum + slice.limit, 0)).toBe(381);
  for (const [index, slice] of slices.entries())
    expect(slice.offset).toBe(index ? slices[index - 1].offset + slices[index - 1].limit : 0);
  expect(shardSlices(3, 3).map((slice) => slice.limit)).toEqual([1, 1, 1]);
  expect(() => shardSlices(2, 3)).toThrow('--shards must be between 1 and --total.');
  expect(() => shardSlices(0, 1)).toThrow('--total must be a positive integer.');
});

it('fills shard placeholders and keeps run ids to safe names', () => {
  expect(
    fillCommand(
      'setup --offset {offset} --limit {limit} --output /work/out/{run}-{shard} {other}',
      {
        shard: 2,
        offset: 96,
        limit: 48,
        run: 'stripe-fresh-1',
      },
    ),
  ).toBe('setup --offset 96 --limit 48 --output /work/out/stripe-fresh-1-2 {other}');
  expect(RUN_ID.test('stripe-fresh-2026-10-22')).toBe(true);
  expect(RUN_ID.test('Stripe Fresh')).toBe(false);
  expect(RUN_ID.test('../escape')).toBe(false);
  expect(bucketName('123456789012', 'us-east-2')).toBe('refit-benchmarks-123456789012-us-east-2');
});

it('prepends shard settings to the boot script as shell-safe variables', async () => {
  const command = `echo "it's" && printf '%s' $HOME`;
  const script = bootScript({ SHARD: 1, COMMAND: command }, '#!/bin/bash\necho "$SHARD"\n');
  expect(script.split('\n')[0]).toBe('#!/bin/bash');
  const { stdout } = await execute('bash', ['-c', `${script}\nprintf '%s' "$COMMAND"`]);
  expect(stdout).toBe(`1\n${command}`);
  expect(bootScript({ SHARD: 0 })).toContain('trap finish EXIT');
});

it('builds a boot script bash accepts, with every boot stage before the command', async () => {
  const script = bootScript({
    BUCKET: 'bucket',
    RUN: 'smoke-1',
    SHARD: 0,
    MINUTES: 60,
    SOURCE_SHA256: 'a'.repeat(64),
    IMAGES: 'node:22-alpine',
    COMMAND: 'echo done > /work/out/done.txt',
  });
  await expect(execute('bash', ['-n', '-c', script])).resolves.toBeDefined();
  const stages = [...script.matchAll(/^stage (\S+) (\d+)$/gm)].map((match) => [
    match[1],
    Number(match[2]),
  ]);
  expect(stages).toEqual([
    ['packages', 70],
    ['node', 71],
    ['oasdiff', 72],
    ['source', 73],
    ['npm-ci', 74],
    ['images', 75],
    ['command', 0],
    ['upload', 76],
    ['command', 0],
  ]);
  expect(script).toContain('echo "${SOURCE_SHA256}  /work/source.tar.gz" | sha256sum -c -');
  expect(script).toContain('UPLOAD_SECONDS=600');
});

it('slices a frozen list for one shard and rejects counts that are not whole numbers', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  expect(listSlice(items, undefined, undefined)).toEqual(items);
  expect(listSlice(items, '1', '2')).toEqual(['b', 'c']);
  expect(listSlice(items, '3', undefined)).toEqual(['d', 'e']);
  expect(listSlice(items, undefined, '0')).toEqual([]);
  expect(listSlice(items, '4', '9')).toEqual(['e']);
  for (const bad of ['abc', '-1', '1.5', '', ' 2'])
    expect(() => listSlice(items, bad, undefined)).toThrow(
      '--offset must be a non-negative integer.',
    );
  expect(() => listSlice(items, '0', 'ten')).toThrow('--limit must be a non-negative integer.');
});

it('writes the selected slice of a Shopify frozen list for the benchmark to read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-setup-'));
  try {
    const repos = ['a/one', 'b/two', 'c/three', 'd/four'].map((repo) => ({
      repo,
      stars: 1,
      commit: 'f'.repeat(40),
    }));
    const list = join(root, 'frozen.json');
    await writeFile(list, JSON.stringify({ schemas: { versions: [] }, repos }));
    // Existing clones are reused, so the script needs no network.
    for (const { repo } of repos)
      await mkdir(join(root, 'repos', repo.replace('/', '__'), '.git'), { recursive: true });
    const { stdout } = await execute(process.execPath, [
      'scripts/shopify-benchmark-setup.mjs',
      '--root',
      root,
      '--list',
      list,
      '--offset',
      '1',
      '--limit',
      '2',
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ repos: 2, failures: [] });
    const selected = JSON.parse(await readFile(join(root, 'list.json'), 'utf8'));
    expect(selected.schemas).toEqual({ versions: [] });
    expect(selected.repos.map((entry: { repo: string }) => entry.repo)).toEqual([
      'b/two',
      'c/three',
    ]);
    await expect(
      execute(process.execPath, [
        'scripts/shopify-benchmark-setup.mjs',
        '--root',
        root,
        '--list',
        list,
        '--offset',
        'one',
      ]),
    ).rejects.toThrow('--offset must be a non-negative integer.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reports each shard as finished, running or lost, and finished wins over a shutting-down instance', () => {
  const slices = shardSlices(8, 4);
  const exits = new Map([
    [0, '0 command\n'],
    [1, '74 npm-ci\n'],
  ]);
  const instances = [
    { id: 'i-0', state: 'shutting-down', shard: 0, launched: '2026-10-22T08:00:00Z' },
    { id: 'i-2', state: 'running', shard: 2, launched: '2026-10-22T08:00:00Z' },
    { id: 'i-3', state: 'shutting-down', shard: 3, launched: '2026-10-22T08:00:00Z' },
  ];
  const states = shardStates(slices, exits, instances);
  expect(states).toEqual([
    { shard: 0, state: 'finished', exit: 0, stage: 'command' },
    { shard: 1, state: 'finished', exit: 74, stage: 'npm-ci' },
    { shard: 2, state: 'running', instance: 'i-2', launched: '2026-10-22T08:00:00Z' },
    { shard: 3, state: 'lost' },
  ]);
  expect(stateCounts(states)).toEqual({ succeeded: 1, failed: 1, running: 1, lost: 1 });
  expect(parseExit('143 command')).toEqual({ exit: 143, stage: 'command' });
  expect(parseExit('0\n')).toEqual({ exit: 0, stage: undefined });
});

it('recognises expired or missing AWS credentials and nothing else', () => {
  for (const stderr of [
    "Your session has expired. Please reauthenticate using 'aws login'.",
    'aws: [ERROR]: An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired',
    'upload failed: An error occurred (ExpiredToken) when calling the PutObject operation: The provided token has expired.',
    'aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. You can configure credentials by running "aws login".',
    'Error when retrieving token from sso: Token has expired and refresh failed',
  ])
    expect(credentialsFailed(stderr), stderr).toBe(true);
  for (const stderr of [
    'aws: [ERROR]: An error occurred (AccessDenied) when calling the RunInstances operation: not authorized',
    'fatal error: An error occurred (404) when calling the HeadObject operation: Key "runs/x/run.json" does not exist',
    'aws: [ERROR]: An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation',
  ])
    expect(credentialsFailed(stderr), stderr).toBe(false);
});

it('charges each launch from launch to exit, now or its deadman, with a one-minute minimum', () => {
  const prices = { onDemandUsdPerHour: { 'c7i.xlarge': 0.1785 }, gp3UsdPerGibMonth: 0.08 };
  const run = { instanceType: 'c7i.xlarge', market: 'on-demand', hours: 1, diskGib: 100 };
  const perHour = 0.1785 + (100 * 0.08) / 730;
  const launches = [
    { shard: 0, instance: 'i-a', launchedAt: '2026-10-22T08:00:00.000Z' },
    // Shard 1 failed after 30 minutes and was retried; the retry, listed first, still runs.
    { shard: 1, instance: 'i-c', launchedAt: '2026-10-22T08:40:00.000Z' },
    {
      shard: 1,
      instance: 'i-b',
      launchedAt: '2026-10-22T08:00:00.000Z',
      endedAt: '2026-10-22T08:30:00.000Z',
    },
    // Shard 2 never uploaded an exit code and its instance is gone.
    { shard: 2, instance: 'i-d', launchedAt: '2026-10-22T08:00:00.000Z' },
    // Shard 3 failed within seconds.
    { shard: 3, instance: 'i-e', launchedAt: '2026-10-22T08:00:00.000Z' },
  ];
  const exitTimes = new Map([
    [0, '2026-10-22T08:15:00.000Z'],
    // retry deleted shard 1's exit code after recording it as i-b's end.
    [3, '2026-10-22T08:00:20.000Z'],
  ]);
  const cost = runCost(
    run,
    launches,
    exitTimes,
    new Set(['i-c']),
    '2026-10-22T09:10:00.000Z',
    prices,
  );
  expect(cost.launches).toEqual([
    { shard: 0, instance: 'i-a', hours: 0.25, usd: Number((0.25 * perHour).toFixed(4)) },
    { shard: 1, instance: 'i-b', hours: 0.5, usd: Number((0.5 * perHour).toFixed(4)) },
    {
      shard: 1,
      instance: 'i-c',
      hours: 0.5,
      usd: Number((0.5 * perHour).toFixed(4)),
      running: true,
    },
    { shard: 2, instance: 'i-d', hours: 1, usd: Number(perHour.toFixed(4)), estimated: true },
    { shard: 3, instance: 'i-e', hours: 0.0167, usd: Number((perHour / 60).toFixed(4)) },
  ]);
  expect(cost.usd).toBe(Number(((0.25 + 0.5 + 0.5 + 1 + 1 / 60) * perHour).toFixed(4)));
  expect(
    runCost({ ...run, market: 'spot' }, launches.slice(0, 1), exitTimes, new Set(), '', prices)
      .launches[0].estimated,
  ).toBe(true);
  expect(() =>
    runCost({ ...run, instanceType: 'm7i.large' }, [], exitTimes, new Set(), '', prices),
  ).toThrow('No price for m7i.large; add it to the cost table.');
});

// From the AWS CLI 2.38.4 on 2026-10-22; account, organization and policy ids replaced.
const REFUSED_LAUNCH =
  'aws: [ERROR]: An error occurred (UnauthorizedOperation) when calling the RunInstances operation: You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/AccountFullAccessRole/session is not authorized to perform: ec2:RunInstances on resource: arn:aws:ec2:us-east-2:123456789012:instance/* with an explicit deny in a service control policy: arn:aws:organizations::123456789012:policy/o-example/service_control_policy/p-example. Encoded authorization failure message: encoded';
const ALLOWED_LAUNCH =
  'aws: [ERROR]: An error occurred (DryRunOperation) when calling the RunInstances operation: Request would have succeeded, but DryRun flag is set.';

it('treats only a DryRunOperation answer as a launch EC2 would allow', () => {
  expect(dryRunAllowed(ALLOWED_LAUNCH)).toBe(true);
  for (const stderr of [
    REFUSED_LAUNCH,
    'aws: [ERROR]: An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation',
    'aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials.',
    '',
  ])
    expect(dryRunAllowed(stderr), stderr).toBe(false);
});

it('warns about --validate runs only on instances under 8 GiB', () => {
  const validate =
    'npm run benchmark:stripe -- --root /work/root --output /work/out/run --validate';
  expect(memoryWarning(validate, 'c7i.large', 4096)).toBe(
    'Warning: c7i.large has 4 GiB of memory; a --validate run needs at least 8 GiB, or the harness, refit run and the validation container compete for it.',
  );
  expect(memoryWarning(validate, 'c7i.xlarge', 8192)).toBeUndefined();
  expect(memoryWarning('npm run benchmark:stripe -- --root /work/root', 'c7i.large', 4096)).toBe(
    undefined,
  );
  expect(memoryWarning('refit run --validated-only', 'c7i.large', 4096)).toBeUndefined();
});

// Runs `launch` of `command` against a fake `aws` on PATH whose instance type has `memoryMib` and
// which answers the dry run with `dryRun`. Returns every call, the uploaded run.json and how the
// script ended.
async function fakeLaunch(dryRun: string, command = 'true', memoryMib = 16384) {
  const bin = await mkdtemp(join(tmpdir(), 'refit-fake-aws-'));
  const log = join(bin, 'calls.log');
  const runFile = join(bin, 'run.json');
  try {
    await writeFile(
      join(bin, 'aws'),
      `#!/bin/sh
echo "$*" >> "$AWS_CALLS"
case "$*" in
  "sts get-caller-identity"*) echo '{"Account":"123456789012"}' ;;
  "ec2 describe-instances"*) echo '{"Reservations":[]}' ;;
  "ec2 describe-instance-types"*) echo "{\\"InstanceTypes\\":[{\\"VCpuInfo\\":{\\"DefaultVCpus\\":4},\\"MemoryInfo\\":{\\"SizeInMiB\\":$AWS_MEMORY_MIB}}]}" ;;
  "service-quotas get-service-quota"*) echo '{"Quota":{"Value":16}}' ;;
  "ec2 describe-vpcs"*) echo '{"Vpcs":[{"VpcId":"vpc-1"}]}' ;;
  "ec2 describe-security-groups"*) echo '{"SecurityGroups":[{"GroupId":"sg-1"}]}' ;;
  "ssm get-parameter"*) echo '{"Parameter":{"Value":"ami-1"}}' ;;
  "ec2 run-instances --dry-run"*) echo "$AWS_DRY_RUN" >&2; exit 254 ;;
  "ec2 run-instances"*) echo '{"Instances":[{"InstanceId":"i-1","LaunchTime":"2026-10-22T00:00:00Z"}]}' ;;
  "s3 cp "*/run.json*) cp "$3" "$AWS_RUN_FILE" ;;
esac
`,
    );
    await chmod(join(bin, 'aws'), 0o755);
    const ended = await execute(
      process.execPath,
      [
        'scripts/aws-benchmark.mjs',
        'launch',
        '--run',
        'fake-1',
        '--total',
        '2',
        '--shards',
        '2',
        '--market',
        'on-demand',
        '--',
        command,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AWS_CALLS: log,
          AWS_DRY_RUN: dryRun,
          AWS_MEMORY_MIB: String(memoryMib),
          AWS_RUN_FILE: runFile,
          AWS_PROFILE: 'fake',
        },
      },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout, warnings: stderr }),
      (error) => ({ code: error.code as number, output: String(error.stderr), warnings: '' }),
    );
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    const run = await readFile(runFile, 'utf8').then(JSON.parse, () => undefined);
    return { ...ended, calls, run };
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

it('asks EC2 for a dry run before uploading anything, and stops there when it is refused', async () => {
  const refused = await fakeLaunch(REFUSED_LAUNCH);
  expect(refused.code).toBe(1);
  expect(refused.output).toContain('The launch dry run failed, so nothing was uploaded or changed');
  expect(refused.output).toContain('(UnauthorizedOperation)');
  expect(refused.calls.filter((call) => /^s3 |run-instances (?!--dry-run)/.test(call))).toEqual([]);
  expect(refused.run).toBeUndefined();

  const allowed = await fakeLaunch(ALLOWED_LAUNCH);
  expect(allowed.code, allowed.output).toBe(0);
  const dryRun = allowed.calls.findIndex((call) => call.startsWith('ec2 run-instances --dry-run'));
  const firstUpload = allowed.calls.findIndex((call) => call.startsWith('s3 cp'));
  expect(dryRun).toBeGreaterThanOrEqual(0);
  expect(firstUpload).toBeGreaterThan(dryRun);
  // The dry run carries the same instance settings as the real launches, minus the boot script.
  const launches = allowed.calls.filter((call) => /^ec2 run-instances --image-id/.test(call));
  expect(launches).toHaveLength(2);
  expect(launches[0]).toContain(
    allowed.calls[dryRun].replace('ec2 run-instances --dry-run ', '').replace(/ --region .*/, ''),
  );
});

it('records the instance memory in run.json and warns when a --validate run gets too little', async () => {
  const command = 'npm run benchmark:stripe -- --root /work/root --output /work/out/run --validate';
  const small = await fakeLaunch(ALLOWED_LAUNCH, command, 4096);
  expect(small.code, small.output).toBe(0);
  expect(small.run).toMatchObject({ instanceType: 'c7i.2xlarge', memoryMib: 4096, command });
  expect(small.warnings).toContain('Warning: c7i.2xlarge has 4 GiB of memory');
  const large = await fakeLaunch(ALLOWED_LAUNCH, command, 16384);
  expect(large.run).toMatchObject({ memoryMib: 16384 });
  expect(large.warnings).not.toContain('Warning');
});

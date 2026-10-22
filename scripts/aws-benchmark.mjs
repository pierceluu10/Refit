// Runs benchmark shards on EC2 instances that terminate themselves. Uses the AWS CLI with the
// caller's AWS_PROFILE and AWS_REGION. See docs/AWS-BENCHMARKS.md.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  RUN_ID,
  bootScript,
  bucketName,
  credentialsFailed,
  dryRunAllowed,
  fillCommand,
  memoryWarning,
  redactAws,
  runCost,
  shardSlices,
  shardStates,
  stateCounts,
} from './aws-benchmark-helpers.mjs';

const execute = promisify(execFile);
const DEFAULT_REGION = 'us-east-2';
const ROLE = 'refit-benchmark-instance';
const SECURITY_GROUP = 'refit-benchmark-no-inbound';
const TAG = 'refit-benchmark-run';
const SHARD_TAG = 'refit-benchmark-shard';
const AMI_PARAMETER = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';
// Standard-family vCPU quotas. The AWS free plan denies spot launches, so on-demand is an option.
const VCPU_QUOTAS = { spot: 'L-34B43A08', 'on-demand': 'L-1216C47A' };
const SPOT_OPTIONS =
  'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}';
const DEFAULT_INSTANCE_TYPE = 'c7i.2xlarge';
const DEFAULT_HOURS = 2;
const MAX_HOURS = 6;
const MINUTES_PER_HOUR = 60;
const DISK_GIB = 100;
const RUN_RETENTION_DAYS = 30;
const DEFAULT_IMAGES = 'node:22-alpine';
const ACTIVE_STATES = ['pending', 'running', 'stopping', 'shutting-down'];
const RUN_FILE = /^runs\/([^/]+)\/run\.json$/;
const EXIT_CODE = /^runs\/[^/]+\/shard-(\d+)\/exit-code$/;
const LAUNCH_FILE = /^runs\/[^/]+\/launches\/[^/]+\.json$/;
// On-demand Linux and gp3 prices in us-east-2 (https://aws.amazon.com/ec2/pricing/on-demand/,
// https://aws.amazon.com/ebs/pricing/), read through the AWS Price List API on 2026-10-22; in
// effect since 2026-10-01.
const PRICE_REGION = 'us-east-2';
const PRICES = {
  onDemandUsdPerHour: { 'c7i.large': 0.08925, 'c7i.xlarge': 0.1785, 'c7i.2xlarge': 0.357 },
  gp3UsdPerGibMonth: 0.08,
};
const USAGE = `Usage: node scripts/aws-benchmark.mjs <command>
  setup                                     create the bucket, instance role and security group (idempotent)
  launch --run <id> --total N --shards K [--commit <ref>] [--instance-type ${DEFAULT_INSTANCE_TYPE}] [--market spot|on-demand]
         [--hours ${DEFAULT_HOURS}] [--images "${DEFAULT_IMAGES}"] [--env <file>] -- <command>
                                            {offset} {limit} {shard} {run} are replaced per shard;
                                            write results to /work/out
  list                                      every run with its shard counts, newest first
  status --run <id>                         each shard's state, exit code and stage, and the run's instances
  retry --run <id> --shard N [--env <file>] relaunch a failed or lost shard with the same slice and commit
  cost --run <id>                           instance and disk cost of each of the run's launches
  collect --run <id> --to <dir>             download results and delete the uploaded .env
  stop --run <id>                           terminate the run's instances and delete the uploaded .env
Requires AWS_PROFILE (signed in with \`aws login\`); AWS_REGION defaults to ${DEFAULT_REGION}.`;

const region = process.env.AWS_REGION ?? DEFAULT_REGION;

class CredentialsError extends Error {}

async function cli(args) {
  try {
    const { stdout } = await execute('aws', [...args, '--region', region], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = redactAws(String(error.stderr ?? '').trim());
    error.stderr = stderr;
    error.message = redactAws(error.message);
    if (credentialsFailed(stderr))
      throw new CredentialsError(
        `AWS credentials expired or missing: ${stderr}\nSign in again with \`aws login --region ${region}\` for profile ${process.env.AWS_PROFILE ?? 'default'}. This command may have stopped partway: check \`status\` (or \`list\`) before rerunning it.`,
      );
    throw error;
  }
}

async function aws(...args) {
  const stdout = (await cli([...args, '--output', 'json'])).trim();
  return stdout ? JSON.parse(stdout) : null;
}

async function missing(operation) {
  try {
    await operation();
    return false;
  } catch (error) {
    if (/NoSuchEntity|NotFound|404|does not exist/i.test(String(error.stderr ?? error.message)))
      return true;
    throw error;
  }
}

async function bucket() {
  const { Account } = await aws('sts', 'get-caller-identity');
  return bucketName(Account, region);
}

async function objects(name, prefix) {
  return (
    (await aws('s3api', 'list-objects-v2', '--bucket', name, '--prefix', prefix))?.Contents ?? []
  );
}

function readObject(name, key) {
  return cli(['s3', 'cp', `s3://${name}/${key}`, '-']);
}

async function writeObject(name, key, value) {
  const work = await mkdtemp(join(tmpdir(), 'refit-aws-'));
  try {
    const path = join(work, 'object.json');
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    await aws('s3', 'cp', path, `s3://${name}/${key}`, '--only-show-errors');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function uploadEnv(name, run, path) {
  await aws('s3', 'cp', resolve(path), `s3://${name}/runs/${run}/env`, '--only-show-errors');
}

async function defaultVpc() {
  const { Vpcs } = await aws('ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true');
  if (!Vpcs[0]) throw new Error(`No default VPC in ${region}.`);
  return Vpcs[0].VpcId;
}

async function securityGroup() {
  const { SecurityGroups } = await aws(
    'ec2',
    'describe-security-groups',
    '--filters',
    `Name=group-name,Values=${SECURITY_GROUP}`,
    `Name=vpc-id,Values=${await defaultVpc()}`,
  );
  return SecurityGroups[0]?.GroupId;
}

async function setup() {
  const name = await bucket();
  if (await missing(() => aws('s3api', 'head-bucket', '--bucket', name))) {
    await aws(
      's3api',
      'create-bucket',
      '--bucket',
      name,
      '--create-bucket-configuration',
      `LocationConstraint=${region}`,
    );
    console.log(`Created bucket ${name}`);
  }
  await aws(
    's3api',
    'put-public-access-block',
    '--bucket',
    name,
    '--public-access-block-configuration',
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
  );
  await aws(
    's3api',
    'put-bucket-lifecycle-configuration',
    '--bucket',
    name,
    '--lifecycle-configuration',
    JSON.stringify({
      Rules: [
        {
          ID: 'expire-runs',
          Status: 'Enabled',
          Filter: { Prefix: 'runs/' },
          Expiration: { Days: RUN_RETENTION_DAYS },
        },
      ],
    }),
  );

  if (await missing(() => aws('iam', 'get-role', '--role-name', ROLE))) {
    await aws(
      'iam',
      'create-role',
      '--role-name',
      ROLE,
      '--assume-role-policy-document',
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      }),
    );
    console.log(`Created role ${ROLE}`);
  }
  // Instances may read and write run objects in this bucket and nothing else.
  await aws(
    'iam',
    'put-role-policy',
    '--role-name',
    ROLE,
    '--policy-name',
    'benchmark-bucket',
    '--policy-document',
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: `arn:aws:s3:::${name}/runs/*`,
        },
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${name}` },
      ],
    }),
  );
  if (await missing(() => aws('iam', 'get-instance-profile', '--instance-profile-name', ROLE))) {
    await aws('iam', 'create-instance-profile', '--instance-profile-name', ROLE);
    await aws(
      'iam',
      'add-role-to-instance-profile',
      '--instance-profile-name',
      ROLE,
      '--role-name',
      ROLE,
    );
    console.log(`Created instance profile ${ROLE}`);
  }

  if (!(await securityGroup())) {
    await aws(
      'ec2',
      'create-security-group',
      '--group-name',
      SECURITY_GROUP,
      '--vpc-id',
      await defaultVpc(),
      '--description',
      'Refit benchmark instances: no inbound access',
    );
    console.log(`Created security group ${SECURITY_GROUP}`);
  }
  console.log(
    `Ready: bucket ${name}, role ${ROLE}, security group ${SECURITY_GROUP} in ${region}.`,
  );
}

// A run's instances, or every active instance in the account when no run is given.
async function instances(run) {
  const filters = ['--filters', `Name=instance-state-name,Values=${ACTIVE_STATES.join(',')}`];
  if (run) filters.push(`Name=tag:${TAG},Values=${run}`);
  const { Reservations } = await aws('ec2', 'describe-instances', ...filters);
  return Reservations.flatMap((reservation) => reservation.Instances).map((instance) => {
    const tag = (key) => instance.Tags?.find((candidate) => candidate.Key === key)?.Value;
    return {
      id: instance.InstanceId,
      state: instance.State.Name,
      type: instance.InstanceType,
      spot: instance.InstanceLifecycle === 'spot',
      run: tag(TAG),
      shard: Number(tag(SHARD_TAG)),
      launched: instance.LaunchTime,
    };
  });
}

async function describeType(instanceType) {
  const {
    InstanceTypes: [type],
  } = await aws('ec2', 'describe-instance-types', '--instance-types', instanceType);
  return { vcpus: type.VCpuInfo.DefaultVCpus, memoryMib: type.MemoryInfo.SizeInMiB };
}

// Every active instance of the same market counts against its vCPU quota, including ones other
// people launched by hand.
async function checkQuota(market, instanceType, count) {
  if (!(market in VCPU_QUOTAS)) throw new Error('--market must be spot or on-demand.');
  const [active, perInstance, quota] = await Promise.all([
    instances(),
    describeType(instanceType).then((type) => type.vcpus),
    aws(
      'service-quotas',
      'get-service-quota',
      '--service-code',
      'ec2',
      '--quota-code',
      VCPU_QUOTAS[market],
    ),
  ]);
  const sameMarket = active.filter((instance) => instance.spot === (market === 'spot'));
  const used = (
    await Promise.all(sameMarket.map(async (instance) => (await describeType(instance.type)).vcpus))
  ).reduce((sum, count) => sum + count, 0);
  const needed = perInstance * count;
  if (used + needed > quota.Quota.Value)
    throw new Error(
      `Needs ${needed} ${market} vCPUs but ${used} of ${quota.Quota.Value} are in use. Use fewer shards or wait.`,
    );
}

// The security group and machine image every launch uses.
async function launchTarget() {
  const group = await securityGroup();
  if (!group) throw new Error('Run `node scripts/aws-benchmark.mjs setup` first.');
  const image = (await aws('ssm', 'get-parameter', '--name', AMI_PARAMETER)).Parameter.Value;
  return { group, image };
}

// `run-instances` arguments for one shard, except its user data.
function instanceArguments(run, shard, { group, image }) {
  return [
    '--image-id',
    image,
    '--instance-type',
    run.instanceType,
    '--iam-instance-profile',
    `Name=${ROLE}`,
    '--security-group-ids',
    group,
    ...(run.market === 'spot' ? ['--instance-market-options', SPOT_OPTIONS] : []),
    '--instance-initiated-shutdown-behavior',
    'terminate',
    '--block-device-mappings',
    `DeviceName=/dev/xvda,Ebs={VolumeSize=${run.diskGib},VolumeType=gp3,DeleteOnTermination=true}`,
    '--metadata-options',
    'HttpTokens=required',
    '--tag-specifications',
    `ResourceType=instance,Tags=[{Key=${TAG},Value=${run.run}},{Key=${SHARD_TAG},Value=${shard}},{Key=Name,Value=refit-${run.run}-${shard}}]`,
    `ResourceType=volume,Tags=[{Key=${TAG},Value=${run.run}}]`,
  ];
}

// Asks EC2 whether it would launch the shard, so a refused launch (missing permission, a service
// control policy, an unavailable instance type) stops before anything is uploaded or deleted.
async function checkLaunch(run, shard, target) {
  try {
    await cli(['ec2', 'run-instances', '--dry-run', ...instanceArguments(run, shard, target)]);
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    if (dryRunAllowed(stderr)) return;
    if (!stderr) throw error;
    throw new Error(`The launch dry run failed, so nothing was uploaded or changed: ${stderr}`);
  }
}

// Launches one instance per slice and records each launch for `cost`.
async function launchShards(name, run, slices, target) {
  const work = await mkdtemp(join(tmpdir(), 'refit-aws-'));
  try {
    for (const slice of slices) {
      const userData = join(work, `shard-${slice.shard}.sh`);
      await writeFile(
        userData,
        bootScript({
          BUCKET: name,
          RUN: run.run,
          SHARD: slice.shard,
          MINUTES: Math.round(run.hours * MINUTES_PER_HOUR),
          SOURCE_SHA256: run.sourceSha256,
          IMAGES: run.images,
          COMMAND: fillCommand(run.command, { ...slice, run: run.run }),
        }),
      );
      const {
        Instances: [instance],
      } = await aws(
        'ec2',
        'run-instances',
        ...instanceArguments(run, slice.shard, target),
        '--user-data',
        `file://${userData}`,
      );
      await writeObject(name, `runs/${run.run}/launches/${instance.InstanceId}.json`, {
        shard: slice.shard,
        instance: instance.InstanceId,
        launchedAt: instance.LaunchTime,
      });
      console.log(
        `shard ${slice.shard}: offset ${slice.offset}, limit ${slice.limit} -> ${instance.InstanceId}`,
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function launch(values, command) {
  if (!values.run || !RUN_ID.test(values.run))
    throw new Error('--run needs 3-41 lowercase letters, digits or dashes.');
  if (!command) throw new Error('Give the shard command after --.');
  const hours = Number(values.hours ?? DEFAULT_HOURS);
  if (!(hours > 0 && hours <= MAX_HOURS))
    throw new Error(`--hours must be above 0 and at most ${MAX_HOURS}.`);
  const slices = shardSlices(Number(values.total), Number(values.shards));
  const instanceType = values['instance-type'] ?? DEFAULT_INSTANCE_TYPE;
  const market = values.market ?? 'spot';
  const name = await bucket();
  if ((await instances(values.run)).length)
    throw new Error(`Run ${values.run} already has active instances.`);
  if (
    (
      await aws(
        's3api',
        'list-objects-v2',
        '--bucket',
        name,
        '--prefix',
        `runs/${values.run}/`,
        '--max-keys',
        '1',
      )
    )?.Contents
  )
    throw new Error(`Run ${values.run} already exists; pick a new run id.`);
  await checkQuota(market, instanceType, slices.length);

  const commit = (await execute('git', ['rev-parse', values.commit ?? 'HEAD'])).stdout.trim();
  const { memoryMib } = await describeType(instanceType);
  const warning = memoryWarning(command, instanceType, memoryMib);
  if (warning) console.warn(warning);
  const settings = {
    run: values.run,
    commit,
    command,
    instanceType,
    memoryMib,
    market,
    hours,
    images: values.images ?? DEFAULT_IMAGES,
    diskGib: DISK_GIB,
    env: Boolean(values.env),
    slices,
  };
  const target = await launchTarget();
  await checkLaunch(settings, slices[0].shard, target);
  const work = await mkdtemp(join(tmpdir(), 'refit-aws-'));
  let run;
  try {
    const archive = join(work, 'source.tar.gz');
    await execute('git', ['archive', '--format=tar.gz', '--output', archive, commit]);
    // Each instance checks the tarball it downloads against this before building it.
    const sourceSha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await aws(
      's3',
      'cp',
      archive,
      `s3://${name}/runs/${values.run}/source.tar.gz`,
      '--only-show-errors',
    );
    if (values.env) await uploadEnv(name, values.run, values.env);
    run = { ...settings, sourceSha256 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await writeObject(name, `runs/${values.run}/run.json`, run);
  await launchShards(name, run, slices, target);
  console.log(
    `Launched ${slices.length} ${market} ${instanceType} shards of ${values.run} from ${commit.slice(0, 12)}; each terminates within ${hours} h.`,
  );
}

// Exit-code texts by shard from one run's object listing.
async function exitCodes(name, listing) {
  const entries = await Promise.all(
    listing.flatMap((object) => {
      const match = EXIT_CODE.exec(object.Key);
      return match ? [readObject(name, object.Key).then((text) => [Number(match[1]), text])] : [];
    }),
  );
  return new Map(entries);
}

async function runState(name, run) {
  const [listing, active] = await Promise.all([objects(name, `runs/${run}/`), instances(run)]);
  if (!listing.some((object) => object.Key === `runs/${run}/run.json`))
    throw new Error(`No run ${run}.`);
  const settings = JSON.parse(await readObject(name, `runs/${run}/run.json`));
  const states = shardStates(settings.slices, await exitCodes(name, listing), active);
  return { settings, listing, active, states };
}

async function readLaunches(name, listing) {
  return Promise.all(
    listing
      .filter((object) => LAUNCH_FILE.test(object.Key))
      .map(async (object) => ({
        key: object.Key,
        ...JSON.parse(await readObject(name, object.Key)),
      })),
  );
}

async function status(run) {
  const { settings, active, states } = await runState(await bucket(), run);
  console.log(
    JSON.stringify(
      {
        commit: settings.commit,
        shards: states,
        instances: active.map(({ id, state, shard, launched }) => ({
          id,
          state,
          shard,
          launched,
        })),
      },
      null,
      2,
    ),
  );
}

async function list() {
  const name = await bucket();
  const [listing, active] = await Promise.all([objects(name, 'runs/'), instances()]);
  const rows = await Promise.all(
    listing
      .filter((object) => RUN_FILE.test(object.Key))
      .map(async (object) => {
        const run = RUN_FILE.exec(object.Key)[1];
        const settings = JSON.parse(await readObject(name, object.Key));
        const exits = await exitCodes(
          name,
          listing.filter((entry) => entry.Key.startsWith(`runs/${run}/`)),
        );
        const states = shardStates(
          settings.slices,
          exits,
          active.filter((instance) => instance.run === run),
        );
        return {
          run,
          launched: object.LastModified,
          commit: settings.commit.slice(0, 12),
          instanceType: settings.instanceType,
          shards: settings.slices.length,
          ...stateCounts(states),
        };
      }),
  );
  console.log(
    JSON.stringify(
      rows.sort((a, b) => b.launched.localeCompare(a.launched)),
      null,
      2,
    ),
  );
}

// Relaunches one shard with run.json's slice, commit and settings, replacing its earlier output.
async function retry(run, shardOption, env) {
  const name = await bucket();
  const { settings, listing, active, states } = await runState(name, run);
  const slice = settings.slices.find((candidate) => String(candidate.shard) === shardOption);
  if (!slice) throw new Error(`retry needs --shard between 0 and ${settings.slices.length - 1}.`);
  const { shard } = slice;
  if (active.some((instance) => instance.shard === shard))
    throw new Error(
      `Shard ${shard} of ${run} still has an instance; wait until it terminates or stop the run.`,
    );
  const state = states.find((candidate) => candidate.shard === shard);
  if (state.state === 'finished' && state.exit === 0)
    throw new Error(`Shard ${shard} of ${run} succeeded; nothing to retry.`);
  if (settings.env && !env)
    throw new Error(`Run ${run} was launched with --env; pass --env again.`);
  await checkQuota(settings.market, settings.instanceType, 1);
  const target = await launchTarget();
  await checkLaunch(settings, shard, target);

  // The earlier launch's end is its exit code's upload time; keep it before deleting the exit code
  // so `cost` still counts that launch.
  const exit = listing.find((object) => object.Key === `runs/${run}/shard-${shard}/exit-code`);
  const [previous] = (await readLaunches(name, listing))
    .filter((launch) => launch.shard === shard)
    .sort((a, b) => Date.parse(b.launchedAt) - Date.parse(a.launchedAt));
  if (exit && previous && !previous.endedAt) {
    const { key, ...launch } = previous;
    await writeObject(name, key, { ...launch, endedAt: exit.LastModified });
  }
  await aws(
    's3',
    'rm',
    `s3://${name}/runs/${run}/shard-${shard}/`,
    '--recursive',
    '--only-show-errors',
  );
  if (env) await uploadEnv(name, run, env);
  await launchShards(name, settings, [slice], target);
  console.log(`Relaunched shard ${shard} of ${run} from ${settings.commit.slice(0, 12)}.`);
}

async function cost(run) {
  if (region !== PRICE_REGION) throw new Error(`The cost table has ${PRICE_REGION} prices only.`);
  const name = await bucket();
  const { settings, listing, active } = await runState(name, run);
  const launches = (await readLaunches(name, listing)).map(({ key, ...launch }) => launch);
  const exitTimes = new Map(
    listing.flatMap((object) => {
      const match = EXIT_CODE.exec(object.Key);
      return match ? [[Number(match[1]), object.LastModified]] : [];
    }),
  );
  const running = new Set(active.map((instance) => instance.id));
  console.log(
    JSON.stringify(
      {
        run,
        ...runCost(settings, launches, exitTimes, running, new Date().toISOString(), PRICES),
      },
      null,
      2,
    ),
  );
}

async function deleteEnv(run) {
  await aws('s3', 'rm', `s3://${await bucket()}/runs/${run}/env`, '--only-show-errors');
}

const SHARD_RESULTS = /^shard-\d+\/out\/(.*results\.json)$/;

// Concatenates each shard's results.json arrays into merged/<same path>, so compare scripts read
// one file per run.
async function mergeResults(directory) {
  const groups = new Map();
  for (const path of await readdir(directory, { recursive: true })) {
    const match = SHARD_RESULTS.exec(path.replaceAll('\\', '/'));
    if (match) groups.set(match[1], [...(groups.get(match[1]) ?? []), path]);
  }
  for (const [relative, paths] of groups) {
    const parts = await Promise.all(
      paths.sort().map(async (path) => JSON.parse(await readFile(join(directory, path), 'utf8'))),
    );
    if (!parts.every(Array.isArray)) continue;
    const target = join(directory, 'merged', relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(parts.flat(), null, 2)}\n`);
    console.log(`Merged ${paths.length} shard(s) into ${target}`);
  }
}

async function collect(run, to) {
  if (!to) throw new Error('collect needs --to <dir>.');
  const name = await bucket();
  await aws(
    's3',
    'sync',
    `s3://${name}/runs/${run}`,
    resolve(to),
    '--exclude',
    'env',
    '--exclude',
    'source.tar.gz',
    '--only-show-errors',
  );
  await deleteEnv(run);
  await mergeResults(resolve(to));
  const counts = stateCounts((await runState(name, run)).states);
  console.log(
    `Downloaded ${run} to ${resolve(to)}: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.running} running, ${counts.lost} lost.`,
  );
}

async function stop(run) {
  const active = await instances(run);
  if (active.length)
    await aws(
      'ec2',
      'terminate-instances',
      '--instance-ids',
      ...active.map((instance) => instance.id),
    );
  await deleteEnv(run);
  console.log(`Terminated ${active.length} instance(s) of ${run}.`);
}

const separator = process.argv.indexOf('--');
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, separator === -1 ? undefined : separator),
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    total: { type: 'string' },
    shards: { type: 'string' },
    shard: { type: 'string' },
    commit: { type: 'string' },
    'instance-type': { type: 'string' },
    market: { type: 'string' },
    hours: { type: 'string' },
    images: { type: 'string' },
    env: { type: 'string' },
    to: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const command = separator === -1 ? '' : process.argv.slice(separator + 1).join(' ');
const [action] = positionals;
try {
  if (values.help || !action) console.log(USAGE);
  else if (action === 'setup') await setup();
  else if (action === 'launch') await launch(values, command);
  else if (action === 'list') await list();
  else if (!values.run || !RUN_ID.test(values.run)) throw new Error(USAGE);
  else if (action === 'status') await status(values.run);
  else if (action === 'retry') await retry(values.run, values.shard, values.env);
  else if (action === 'cost') await cost(values.run);
  else if (action === 'collect') await collect(values.run, values.to);
  else if (action === 'stop') await stop(values.run);
  else throw new Error(USAGE);
} catch (error) {
  console.error(redactAws(error.stderr?.trim() || error.message));
  process.exitCode = 1;
}

// Runs benchmark shards on EC2 instances that terminate themselves. Uses the AWS CLI with the
// caller's AWS_PROFILE and AWS_REGION. See docs/AWS-BENCHMARKS.md.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  RUN_ID,
  bootScript,
  bucketName,
  fillCommand,
  shardSlices,
} from './aws-benchmark-helpers.mjs';

const execute = promisify(execFile);
const DEFAULT_REGION = 'us-east-2';
const ROLE = 'refit-benchmark-instance';
const SECURITY_GROUP = 'refit-benchmark-no-inbound';
const TAG = 'refit-benchmark-run';
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
const USAGE = `Usage: node scripts/aws-benchmark.mjs <command>
  setup                                     create the bucket, instance role and security group (idempotent)
  launch --run <id> --total N --shards K [--commit <ref>] [--instance-type ${DEFAULT_INSTANCE_TYPE}] [--market spot|on-demand]
         [--hours ${DEFAULT_HOURS}] [--images "${DEFAULT_IMAGES}"] [--env <file>] -- <command>
                                            {offset} {limit} {shard} {run} are replaced per shard;
                                            write results to /work/out
  status --run <id>                         instances and finished shards
  collect --run <id> --to <dir>             download results and delete the uploaded .env
  stop --run <id>                           terminate the run's instances and delete the uploaded .env
Requires AWS_PROFILE (signed in with \`aws login\`); AWS_REGION defaults to ${DEFAULT_REGION}.`;

const region = process.env.AWS_REGION ?? DEFAULT_REGION;

async function aws(...args) {
  const { stdout } = await execute('aws', [...args, '--region', region, '--output', 'json'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
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

async function instances(run) {
  const filters = ['--filters', `Name=instance-state-name,Values=${ACTIVE_STATES.join(',')}`];
  if (run) filters.push(`Name=tag:${TAG},Values=${run}`);
  else filters.push(`Name=tag-key,Values=${TAG}`);
  const { Reservations } = await aws('ec2', 'describe-instances', ...filters);
  return Reservations.flatMap((reservation) => reservation.Instances);
}

async function vcpus(instanceType) {
  const { InstanceTypes } = await aws(
    'ec2',
    'describe-instance-types',
    '--instance-types',
    instanceType,
  );
  return InstanceTypes[0].VCpuInfo.DefaultVCpus;
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
  const name = await bucket();
  if ((await instances(values.run)).length)
    throw new Error(`Run ${values.run} already has active instances.`);
  const prefix = `s3://${name}/runs/${values.run}`;
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
    throw new Error(`Run ${values.run} already exists in ${prefix}; pick a new run id.`);

  const market = values.market ?? 'spot';
  if (!(market in VCPU_QUOTAS)) throw new Error('--market must be spot or on-demand.');
  // Every running benchmark shard, from any agent, counts against the chosen vCPU quota.
  const [active, perInstance, quota] = await Promise.all([
    instances(),
    vcpus(instanceType),
    aws(
      'service-quotas',
      'get-service-quota',
      '--service-code',
      'ec2',
      '--quota-code',
      VCPU_QUOTAS[market],
    ),
  ]);
  const used = (await Promise.all(active.map((instance) => vcpus(instance.InstanceType)))).reduce(
    (sum, count) => sum + count,
    0,
  );
  const needed = perInstance * slices.length;
  if (used + needed > quota.Quota.Value)
    throw new Error(
      `Needs ${needed} ${market} vCPUs but ${used} of ${quota.Quota.Value} are in use. Use fewer shards or wait.`,
    );

  const commit = (await execute('git', ['rev-parse', values.commit ?? 'HEAD'])).stdout.trim();
  const work = await mkdtemp(join(tmpdir(), 'refit-aws-'));
  try {
    const archive = join(work, 'source.tar.gz');
    await execute('git', ['archive', '--format=tar.gz', '--output', archive, commit]);
    await aws('s3', 'cp', archive, `${prefix}/source.tar.gz`, '--only-show-errors');
    if (values.env)
      await aws('s3', 'cp', resolve(values.env), `${prefix}/env`, '--only-show-errors');
    await writeFile(
      join(work, 'run.json'),
      JSON.stringify({ run: values.run, commit, command, instanceType, hours, slices }, null, 2),
    );
    await aws('s3', 'cp', join(work, 'run.json'), `${prefix}/run.json`, '--only-show-errors');

    const image = (await aws('ssm', 'get-parameter', '--name', AMI_PARAMETER)).Parameter.Value;
    const group = await securityGroup();
    if (!group) throw new Error('Run `node scripts/aws-benchmark.mjs setup` first.');
    for (const slice of slices) {
      const userData = join(work, `shard-${slice.shard}.sh`);
      await writeFile(
        userData,
        bootScript({
          BUCKET: name,
          RUN: values.run,
          SHARD: slice.shard,
          MINUTES: Math.round(hours * MINUTES_PER_HOUR),
          IMAGES: values.images ?? DEFAULT_IMAGES,
          COMMAND: fillCommand(command, { ...slice, run: values.run }),
        }),
      );
      const tags = `ResourceType=instance,Tags=[{Key=${TAG},Value=${values.run}},{Key=Name,Value=refit-${values.run}-${slice.shard}}]`;
      const { Instances } = await aws(
        'ec2',
        'run-instances',
        '--image-id',
        image,
        '--instance-type',
        instanceType,
        '--iam-instance-profile',
        `Name=${ROLE}`,
        '--security-group-ids',
        group,
        ...(market === 'spot' ? ['--instance-market-options', SPOT_OPTIONS] : []),
        '--instance-initiated-shutdown-behavior',
        'terminate',
        '--block-device-mappings',
        `DeviceName=/dev/xvda,Ebs={VolumeSize=${DISK_GIB},VolumeType=gp3,DeleteOnTermination=true}`,
        '--metadata-options',
        'HttpTokens=required',
        '--tag-specifications',
        tags,
        `ResourceType=volume,Tags=[{Key=${TAG},Value=${values.run}}]`,
        '--user-data',
        `file://${userData}`,
      );
      console.log(
        `shard ${slice.shard}: offset ${slice.offset}, limit ${slice.limit} -> ${Instances[0].InstanceId}`,
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(
    `Launched ${slices.length} ${market} ${instanceType} shards of ${values.run} from ${commit.slice(0, 12)}; each terminates within ${hours} h.`,
  );
}

async function finished(run) {
  const name = await bucket();
  const listing = await aws(
    's3api',
    'list-objects-v2',
    '--bucket',
    name,
    '--prefix',
    `runs/${run}/`,
  );
  const codes = (listing?.Contents ?? []).filter((object) => object.Key.endsWith('/exit-code'));
  return Promise.all(
    codes.map(async (object) => {
      const { stdout } = await execute('aws', [
        's3',
        'cp',
        `s3://${name}/${object.Key}`,
        '-',
        '--region',
        region,
      ]);
      return { shard: object.Key.split('/').at(-2), exit: Number(stdout.trim()) };
    }),
  );
}

async function status(run) {
  const [active, done] = await Promise.all([instances(run), finished(run)]);
  console.log(
    JSON.stringify(
      {
        running: active.map((instance) => ({
          id: instance.InstanceId,
          state: instance.State.Name,
          shard: instance.Tags.find((tag) => tag.Key === 'Name')?.Value,
          launched: instance.LaunchTime,
        })),
        finished: done,
      },
      null,
      2,
    ),
  );
}

async function deleteEnv(run) {
  await aws('s3', 'rm', `s3://${await bucket()}/runs/${run}/env`, '--only-show-errors');
}

async function collect(run, to) {
  if (!to) throw new Error('collect needs --to <dir>.');
  await aws(
    's3',
    'sync',
    `s3://${await bucket()}/runs/${run}`,
    resolve(to),
    '--exclude',
    'env',
    '--exclude',
    'source.tar.gz',
    '--only-show-errors',
  );
  await deleteEnv(run);
  const active = await instances(run);
  console.log(
    `Downloaded ${run} to ${resolve(to)}.${active.length ? ` ${active.length} shard(s) still running.` : ''}`,
  );
}

async function stop(run) {
  const active = await instances(run);
  if (active.length)
    await aws(
      'ec2',
      'terminate-instances',
      '--instance-ids',
      ...active.map((instance) => instance.InstanceId),
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
  else if (!values.run || !RUN_ID.test(values.run)) throw new Error(USAGE);
  else if (action === 'status') await status(values.run);
  else if (action === 'collect') await collect(values.run, values.to);
  else if (action === 'stop') await stop(values.run);
  else throw new Error(USAGE);
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}

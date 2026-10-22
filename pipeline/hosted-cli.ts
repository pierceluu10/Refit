import { parseArgs } from 'node:util';
import type { Pool } from 'pg';
import { assessmentConfiguration } from './assessment.ts';
import { flyMachines } from './fly-machines.ts';
import { githubAppConfiguration } from './github-app.ts';
import { openHostedPool } from './hosted-database.ts';
import { hostedSchemaStatus, migrateHostedSchema } from './hosted-migrations.ts';
import { UNINSTALL_GRACE_DAYS } from './hosted-retention.ts';
import { runHostedJob } from './hosted-runner.ts';
import {
  checkHostedHealth,
  hostedLogging,
  hostedRedactor,
  JOB_STATUSES,
  JOBS_SHOWN,
  listHostedJobs,
  listHostedTargets,
  readHostedReceipt,
} from './hosted-ops.ts';
import { runHostedService } from './hosted-service.ts';
import { openHostedStore } from './hosted-store.ts';
import { hostedContact } from './hosted-setup.ts';
import { hostedTenancy } from './hosted-tenancy.ts';
import { openInventoryStore } from './inventory-store.ts';
import { hostedAlerts } from './monitoring.ts';
import { validateServiceSecret } from './local-service.ts';
import { readRepositoryApproval } from './repository-enrollment.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const JOB_ID = /^[1-9]\d{0,15}$/;
const USAGE = `Usage: refit hosted serve --state <directory> [--host <address>] [--port <number>] [--interval <seconds>] [--ai-patch --repair-attempts 0|1|2] [--publish-draft] [--job-machines] [--purge-uninstalled]
       refit hosted approve --approval <receipt.json> --approved-by <github-login>
       refit hosted retry --target <id>
       refit hosted inventory --repository <owner/name>
       refit hosted migrate [--dry-run]
       refit hosted accounts
       refit hosted job
       refit hosted jobs [--target <id>] [--status ${JOB_STATUSES.join('|')}] [--since <iso>]
       refit hosted receipt <job>
       refit hosted targets
       refit hosted health
Requires REFIT_DATABASE_URL (PostgreSQL). serve also requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, REFIT_WEBHOOK_SECRET, a different REFIT_SERVICE_TOKEN and REFIT_HOSTED_ACCOUNTS, the comma-separated GitHub accounts whose installations may enroll (default: REFIT_HOSTED_OWNER alone). Other accounts' installations are recorded as not allowed and nothing is cloned. Each installation runs one job at a time, at most REFIT_HOSTED_DAILY_JOBS (default 1440) jobs and REFIT_HOSTED_DAILY_INVENTORIES (default 500) inventories per UTC day. --ai-patch uses OPENAI_API_KEY and OPENAI_MODEL with a separate REFIT_AI_BUDGET_USD ledger per installation in PostgreSQL.
approve stores a receipt made by refit enroll. Installing the App on an approved repository enrolls it: the worker runs refit doctor, then scans and validates with the approved checks, and stores a job receipt. Installed repositories without an approval never run. Removing the repository or the installation cancels its targets and stops running jobs. --publish-draft opens draft PRs as Refit Agent; Refit never merges.
retry queues one fresh attempt for an enrolled target, permitting a cached failed job to run again; successful jobs remain cached. Approval and access gates still apply.
migrate applies pending schema migrations, which serve also does on start; --dry-run lists them without applying anything. serve keeps running through PostgreSQL outages. With --purge-uninstalled it deletes an uninstalled installation's targets, jobs and evidence ${UNINSTALL_GRACE_DAYS} days after the uninstall; without it, nothing is deleted.
With REFIT_HOSTED_APPROVAL_ISSUES=1, serve opens one issue on each installed repository of an allowed account that has no approval, showing what refit enroll shows (or a proposed .refit.json), and handles /refit approve <fingerprint-prefix> and /refit revoke comments from users with the admin or maintain role. It needs the App's Issues permission and issue_comment event.
accounts lists every recorded installation, whether the serving worker allowed it, and today's usage against the caps. Run it with the worker's REFIT_HOSTED_ACCOUNTS (or REFIT_HOSTED_OWNER) and cap settings.
inventory queues a read-only inventory of a repository installed by an allowed account, approved or not, and prints the stored one as JSON. The running worker takes it within its polling interval; an unchanged revision is not scanned again. Installing the App queues one for every repository it can read.
--job-machines runs each job on its own Fly Machine in REFIT_JOB_APP, a separate Fly app with no secrets, using FLY_API_TOKEN for that app, REFIT_JOB_IMAGE (default FLY_IMAGE_REF), REFIT_JOB_REGION (default FLY_REGION) and the validation images in REFIT_HOSTED_IMAGES. It cannot be combined with --ai-patch or --publish-draft. job runs on such a machine: it reads REFIT_JOB_URL, REFIT_JOB_ID and REFIT_JOB_SECRET, runs that one job and reports to the control process.
jobs lists the newest ${JOBS_SHOWN} matching jobs. receipt prints one job's stored receipt and, on the machine that holds the evidence volume, its evidence files. targets lists each target's state, last job and last stored receipt. These commands only read PostgreSQL.
health checks PostgreSQL, the Refit tables, the Docker daemon and every image in REFIT_HOSTED_IMAGES, and exits 1 if any check fails.
REFIT_HOSTED_ALERTS=1 (off by default) makes serve monitor every inventoried repository: it takes a new inventory after a default-branch push, a registry change or 24 hours (at most once per 10 minutes), and opens or updates one GitHub issue per repository and deadline 90, 30 and 7 days before it and when it passes. REFIT_HOSTED_ALERT_DIGEST=1 adds a weekly digest issue per repository listing every exposed deadline. It needs the App's Issues write permission, and push re-scans need the App's push event.
serve logs one JSON object per line to stderr with secrets redacted. With REFIT_SLACK_WEBHOOK_URL set it posts the same notices as refit serve, plus each failed job at most once per target per hour.
serve also answers GET /github/setup (the App's Setup URL), /github/uninstalled and /.well-known/security.txt. REFIT_HOSTED_CONTACT, a mailto: or https: URI, is shown for data deletion and served as the security.txt contact.`;

function jobMachines(environment: NodeJS.ProcessEnv) {
  const app = environment.REFIT_JOB_APP?.trim();
  const image = environment.REFIT_JOB_IMAGE?.trim() || environment.FLY_IMAGE_REF?.trim();
  const region = environment.REFIT_JOB_REGION?.trim() || environment.FLY_REGION?.trim();
  if (!app || !image || !region)
    throw new PipelineInputError(
      '--job-machines requires REFIT_JOB_APP, FLY_API_TOKEN, and REFIT_JOB_IMAGE and REFIT_JOB_REGION unless Fly sets FLY_IMAGE_REF and FLY_REGION.',
    );
  // Fly gives every Machine in an app that app's secrets, so jobs never share the control app.
  if (app === environment.FLY_APP_NAME)
    throw new PipelineInputError('REFIT_JOB_APP must be a separate Fly app with no secrets.');
  return {
    machines: flyMachines({ token: environment.FLY_API_TOKEN ?? '', app }),
    image,
    region,
    images: (environment.REFIT_HOSTED_IMAGES ?? '').split(/\s+/).filter(Boolean),
  };
}

function database() {
  const connectionString = process.env.REFIT_DATABASE_URL;
  if (!connectionString) throw new PipelineInputError('REFIT_DATABASE_URL is required.');
  return openHostedPool(connectionString, (error) =>
    console.error(`[refit] PostgreSQL connection error: ${terminalText(error.message)}`),
  );
}

const time = (value: Date | null) => value?.toISOString() ?? '-';

async function printJobs(pool: Pool, filter: Parameters<typeof listHostedJobs>[1]) {
  const { jobs, total } = await listHostedJobs(pool, filter);
  if (!jobs.length) {
    console.log('No matching hosted jobs.');
    return;
  }
  console.log(
    `${'Job'.padEnd(8)}${'Status'.padEnd(11)}${'Outcome'.padEnd(18)}${'Tries'.padEnd(7)}${'Created'.padEnd(26)}${'Target'.padEnd(26)}Repository`,
  );
  for (const job of jobs)
    console.log(
      `${job.id.padEnd(8)}${job.status.padEnd(11)}${terminalText(job.outcome ?? '-').padEnd(18)}${`${job.attempts}${job.retry ? 'r' : ''}`.padEnd(7)}${time(job.createdAt).padEnd(26)}${job.targetId.padEnd(26)}${terminalText(job.repository)}`,
    );
  if (total > jobs.length)
    console.log(
      `Showing the newest ${jobs.length} of ${total} matching jobs; narrow with --target, --status or --since.`,
    );
}

async function printReceipt(pool: Pool, id: string) {
  const job = await readHostedReceipt(pool, id);
  const target = [job.base, job.integration].filter(Boolean).join(', ');
  console.log(
    `Job       ${job.id} (${job.status}, attempt ${job.attempts}${job.retry ? ', operator retry' : ''})`,
  );
  console.log(
    `Target    ${job.targetId}  ${terminalText(job.repository)} (${terminalText(target)})`,
  );
  console.log(`Created   ${time(job.createdAt)}\nFinished  ${time(job.finishedAt)}`);
  if (job.leaseOwner)
    console.log(`Lease     ${terminalText(job.leaseOwner)} until ${time(job.leaseExpiresAt)}`);
  if (!job.receipt) {
    console.log('Receipt   none stored yet');
    return;
  }
  console.log(`Status    ${terminalText(job.receipt.status)}`);
  if (job.receipt.message) console.log(`Message   ${terminalText(job.receipt.message)}`);
  if (job.receipt.revision) console.log(`Revision  ${terminalText(job.receipt.revision)}`);
  if (job.receipt.readiness) console.log(`Doctor    ${terminalText(job.receipt.readiness)}`);
  if (!job.receipt.output) return;
  console.log(
    `Evidence  ${terminalText(job.receipt.output)}${job.evidence ? '' : ' (not on this machine)'}`,
  );
  for (const file of job.evidence ?? []) console.log(`  ${terminalText(file)}`);
}

async function printTargets(pool: Pool) {
  const targets = await listHostedTargets(pool);
  if (!targets.length) console.log('No hosted targets.');
  for (const target of targets) {
    console.log(
      `\n${target.id}  ${terminalText(target.repository)} (${terminalText(target.base)}), installation ${target.installationId}`,
    );
    console.log(
      `State     ${target.status}${target.message ? ` (${terminalText(target.message)})` : ''}`,
    );
    console.log(
      target.lastJob
        ? `Last job  ${target.lastJob} ${target.lastJobStatus}, created ${time(target.lastJobAt)}`
        : 'Last job  none',
    );
    console.log(
      target.receiptJob
        ? `Receipt   job ${target.receiptJob} ${terminalText(target.receiptStatus ?? '-')} at ${time(target.receiptAt)}${target.receiptMessage ? `: ${terminalText(target.receiptMessage)}` : ''}`
        : 'Receipt   none stored yet',
    );
  }
}

let logging: ReturnType<typeof hostedLogging> | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      interval: { type: 'string' },
      'ai-patch': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      'job-machines': { type: 'boolean' },
      'purge-uninstalled': { type: 'boolean' },
      approval: { type: 'string' },
      'approved-by': { type: 'string' },
      target: { type: 'string' },
      repository: { type: 'string' },
      'dry-run': { type: 'boolean' },
      status: { type: 'string' },
      since: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > (command === 'receipt' ? 1 : 0)) throw new PipelineInputError(USAGE);
  if (values.help || !command) console.log(USAGE);
  else if (command === 'approve') {
    const login = values['approved-by'];
    if (!values.approval || !login) throw new PipelineInputError(USAGE);
    if (!GITHUB_LOGIN.test(login))
      throw new PipelineInputError('--approved-by requires a GitHub login.');
    const approval = await readRepositoryApproval(values.approval);
    const pool = database();
    try {
      const enrolled = await (await openHostedStore(pool)).approve(approval, login.toLowerCase());
      console.log(
        `Approved ${approval.repository} (${approval.base}) at ${approval.fingerprint.slice(0, 12)}.`,
      );
      console.log(
        enrolled.length
          ? `Enrolled and queued: ${enrolled.join(', ')}`
          : 'Not installed yet; installing the App on this repository enrolls it.',
      );
    } finally {
      await pool.end();
    }
  } else if (command === 'retry') {
    if (!values.target) throw new PipelineInputError(USAGE);
    const pool = database();
    try {
      const job = await (await openHostedStore(pool)).retry(values.target);
      console.log(`Queued retry job ${job} for ${values.target}.`);
    } finally {
      await pool.end();
    }
  } else if (command === 'inventory') {
    const repository = values.repository;
    if (!repository) throw new PipelineInputError(USAGE);
    if (!REPOSITORY.test(repository))
      throw new PipelineInputError('--repository requires owner/name.');
    const pool = database();
    try {
      await openHostedStore(pool);
      const inventories = openInventoryStore(pool);
      const installation = await inventories.requestRepository(repository);
      console.error(`Queued an inventory of ${repository} (installation ${installation}).`);
      console.log(JSON.stringify((await inventories.read(repository))[0], null, 2));
    } finally {
      await pool.end();
    }
  } else if (command === 'job') {
    const url = process.env.REFIT_JOB_URL;
    const job = process.env.REFIT_JOB_ID;
    const secret = process.env.REFIT_JOB_SECRET;
    if (!url || !job || !JOB_ID.test(job) || !secret)
      throw new PipelineInputError(
        'refit hosted job runs on a job machine and requires REFIT_JOB_URL, REFIT_JOB_ID and REFIT_JOB_SECRET.',
      );
    // Nothing the job starts needs the channel secret.
    delete process.env.REFIT_JOB_SECRET;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const outcome = await runHostedJob({
        url,
        job: Number(job),
        secret,
        signal: controller.signal,
        onProgress: (message) => console.error(`[refit] ${terminalText(message)}`),
      });
      console.log(`Job ${job} reported ${outcome.receipt.status}.`);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } else if (command === 'migrate') {
    const pool = database();
    try {
      if (values['dry-run']) {
        const status = await hostedSchemaStatus(pool);
        console.log(
          `Applied: ${status.applied.map((migration) => migration.version).join(', ') || 'none'}`,
        );
        for (const migration of status.unknown)
          console.log(
            `Applied by a newer worker: ${migration.version} ${terminalText(migration.name)}`,
          );
        if (!status.pending.length) console.log('No pending migrations.');
        for (const migration of status.pending)
          console.log(`Pending: ${migration.version} ${migration.name}`);
      } else {
        const applied = await migrateHostedSchema(pool);
        if (!applied.length) console.log('No pending migrations.');
        for (const migration of applied)
          console.log(`Applied: ${migration.version} ${migration.name}`);
      }
    } finally {
      await pool.end();
    }
  } else if (command === 'accounts') {
    const tenancy = hostedTenancy(process.env);
    const pool = database();
    try {
      const { installations } = await (await openHostedStore(pool, tenancy)).read();
      const { dailyJobs, dailyInventories } = tenancy.limits;
      console.log(
        `Allowed accounts: ${tenancy.accounts.join(', ')}. Daily caps per installation (UTC): ${dailyJobs} jobs, ${dailyInventories} inventories.`,
      );
      if (!installations.length) console.log('No installations recorded.');
      for (const installation of installations)
        console.log(
          `Installation ${installation.id} (${installation.owner}): ${installation.status}, ${installation.allowed ? 'allowed' : 'not allowed'}; ${installation.repositories.length} ${installation.repositories.length === 1 ? 'repository' : 'repositories'}; today ${installation.jobsToday}/${dailyJobs} jobs, ${installation.inventoriesToday}/${dailyInventories} inventories; refusals: ${installation.refusals.join(', ') || 'none'}.`,
        );
    } finally {
      await pool.end();
    }
  } else if (command === 'jobs' || command === 'receipt' || command === 'targets') {
    if (command === 'receipt' && !extra[0]) throw new PipelineInputError(USAGE);
    const pool = database();
    try {
      if (command === 'jobs')
        await printJobs(pool, {
          target: values.target,
          status: values.status,
          since: values.since,
        });
      else if (command === 'receipt') await printReceipt(pool, extra[0]);
      else await printTargets(pool);
    } finally {
      await pool.end();
    }
  } else if (command === 'health') {
    const pool = database();
    try {
      const checks = await checkHostedHealth(
        pool,
        (process.env.REFIT_HOSTED_IMAGES ?? '').split(/\s+/).filter(Boolean),
      );
      const redact = hostedRedactor(process.env);
      for (const { check, status, detail } of checks)
        console.log(`${status.padEnd(8)}${check.padEnd(10)}${terminalText(redact(detail))}`);
      if (checks.some((check) => check.status === 'failed')) process.exitCode = 1;
    } finally {
      await pool.end();
    }
  } else if (command === 'serve') {
    if (!values.state) throw new PipelineInputError(USAGE);
    logging = hostedLogging(process.env);
    const { log, notify, redact } = logging;
    const app = githubAppConfiguration(process.env);
    const webhookSecret = validateServiceSecret(
      process.env.REFIT_WEBHOOK_SECRET,
      'REFIT_WEBHOOK_SECRET',
    );
    const controlToken = validateServiceSecret(
      process.env.REFIT_SERVICE_TOKEN,
      'REFIT_SERVICE_TOKEN',
    );
    const pool = database();
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await runHostedService({
        database: pool,
        app,
        directory: values.state,
        webhookSecret,
        controlToken,
        tenancy: hostedTenancy(process.env),
        alerts: hostedAlerts(process.env) ?? undefined,
        aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
        repairAttempts: Number(values['repair-attempts'] ?? 0),
        publishDraft: values['publish-draft'],
        contact: hostedContact(process.env.REFIT_HOSTED_CONTACT),
        jobMachines: values['job-machines'] ? jobMachines(process.env) : undefined,
        purgeUninstalled: values['purge-uninstalled'],
        approvalIssues: process.env.REFIT_HOSTED_APPROVAL_ISSUES === '1',
        notify,
        redact,
        host: values.host,
        port: values.port === undefined ? undefined : Number(values.port),
        intervalSeconds: values.interval === undefined ? undefined : Number(values.interval),
        signal: controller.signal,
        onReady: (url) => log(`Listening at ${url}; webhook: /github/webhook`),
        onProgress: log,
      });
      log('Refit hosted service stopped');
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await pool.end();
    }
  } else throw new PipelineInputError(USAGE);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  const message = `${error.name}: ${error.message}`;
  if (logging) logging.log(message, { level: 'error' });
  else console.error(terminalText(hostedRedactor(process.env)(message)));
  process.exitCode = 1;
}

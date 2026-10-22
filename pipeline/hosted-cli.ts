import { parseArgs } from 'node:util';
import pg from 'pg';
import { assessmentConfiguration } from './assessment.ts';
import { githubAppConfiguration } from './github-app.ts';
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
import { validateServiceSecret } from './local-service.ts';
import { readRepositoryApproval } from './repository-enrollment.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const HEALTH_TIMEOUT_MS = 10_000;
const USAGE = `Usage: refit hosted serve --state <directory> [--host <address>] [--port <number>] [--interval <seconds>] [--ai-patch --repair-attempts 0|1|2] [--publish-draft]
       refit hosted approve --approval <receipt.json> --approved-by <github-login>
       refit hosted retry --target <id>
       refit hosted jobs [--target <id>] [--status ${JOB_STATUSES.join('|')}] [--since <iso>]
       refit hosted receipt <job>
       refit hosted targets
       refit hosted health
Requires REFIT_DATABASE_URL (PostgreSQL). serve also requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, REFIT_WEBHOOK_SECRET, a different REFIT_SERVICE_TOKEN and REFIT_HOSTED_OWNER, the only GitHub account whose installations enroll until jobs run in per-job microVMs. --ai-patch uses OPENAI_API_KEY and OPENAI_MODEL with a separate REFIT_AI_BUDGET_USD ledger per installation under REFIT_AI_BUDGET_DIRECTORY.
approve stores a receipt made by refit enroll. Installing the App on an approved repository enrolls it: the worker runs refit doctor, then scans and validates with the approved checks, and stores a job receipt. Installed repositories without an approval never run. Removing the repository or the installation cancels its targets and stops running jobs. --publish-draft opens draft PRs as Refit Agent; Refit never merges.
retry queues one fresh attempt for an enrolled target, permitting a cached failed job to run again; successful jobs remain cached. Approval and access gates still apply.
jobs lists the newest ${JOBS_SHOWN} matching jobs. receipt prints one job's stored receipt and, on the machine that holds the evidence volume, its evidence files. targets lists each target's state, last job and last stored receipt. These commands only read PostgreSQL.
health checks PostgreSQL, the Refit tables, the Docker daemon and every image in REFIT_HOSTED_IMAGES, and exits 1 if any check fails.
serve logs one JSON object per line to stderr with secrets redacted. With REFIT_SLACK_WEBHOOK_URL set it posts the same notices as refit serve, plus each failed job at most once per target per hour.`;

function database(config: pg.PoolConfig = {}) {
  const connectionString = process.env.REFIT_DATABASE_URL;
  if (!connectionString) throw new PipelineInputError('REFIT_DATABASE_URL is required.');
  return new pg.Pool({ connectionString, ...config });
}

const time = (value: Date | null) => value?.toISOString() ?? '-';

async function printJobs(pool: pg.Pool, filter: Parameters<typeof listHostedJobs>[1]) {
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

async function printReceipt(pool: pg.Pool, id: string) {
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

async function printTargets(pool: pg.Pool) {
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
      approval: { type: 'string' },
      'approved-by': { type: 'string' },
      target: { type: 'string' },
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
    const pool = database({ connectionTimeoutMillis: HEALTH_TIMEOUT_MS });
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
        owner: process.env.REFIT_HOSTED_OWNER ?? '',
        aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
        repairAttempts: Number(values['repair-attempts'] ?? 0),
        publishDraft: values['publish-draft'],
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

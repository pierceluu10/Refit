import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { githubAppConfiguration } from './github-app.ts';
import { openHostedPool } from './hosted-database.ts';
import { hostedSchemaStatus, migrateHostedSchema } from './hosted-migrations.ts';
import { UNINSTALL_GRACE_DAYS } from './hosted-retention.ts';
import { runHostedService } from './hosted-service.ts';
import { openHostedStore } from './hosted-store.ts';
import { validateServiceSecret } from './local-service.ts';
import { readRepositoryApproval } from './repository-enrollment.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const USAGE = `Usage: refit hosted serve --state <directory> [--host <address>] [--port <number>] [--interval <seconds>] [--ai-patch --repair-attempts 0|1|2] [--publish-draft] [--purge-uninstalled]
       refit hosted approve --approval <receipt.json> --approved-by <github-login>
       refit hosted retry --target <id>
       refit hosted migrate [--dry-run]
Requires REFIT_DATABASE_URL (PostgreSQL). serve also requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, REFIT_WEBHOOK_SECRET, a different REFIT_SERVICE_TOKEN and REFIT_HOSTED_OWNER, the only GitHub account whose installations enroll until jobs run in per-job microVMs. --ai-patch uses OPENAI_API_KEY and OPENAI_MODEL with a separate REFIT_AI_BUDGET_USD ledger per installation under REFIT_AI_BUDGET_DIRECTORY.
approve stores a receipt made by refit enroll. Installing the App on an approved repository enrolls it: the worker runs refit doctor, then scans and validates with the approved checks, and stores a job receipt. Installed repositories without an approval never run. Removing the repository or the installation cancels its targets and stops running jobs. --publish-draft opens draft PRs as Refit Agent; Refit never merges.
retry queues one fresh attempt for an enrolled target, permitting a cached failed job to run again; successful jobs remain cached. Approval and access gates still apply.
migrate applies pending schema migrations, which serve also does on start; --dry-run lists them without applying anything. serve keeps running through PostgreSQL outages. With --purge-uninstalled it deletes an uninstalled installation's targets, jobs and evidence ${UNINSTALL_GRACE_DAYS} days after the uninstall; without it, nothing is deleted.`;

function database() {
  const connectionString = process.env.REFIT_DATABASE_URL;
  if (!connectionString) throw new PipelineInputError('REFIT_DATABASE_URL is required.');
  return openHostedPool(connectionString, (error) =>
    console.error(`[refit] PostgreSQL connection error: ${terminalText(error.message)}`),
  );
}

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
      'purge-uninstalled': { type: 'boolean' },
      approval: { type: 'string' },
      'approved-by': { type: 'string' },
      target: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length) throw new PipelineInputError(USAGE);
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
  } else if (command === 'serve') {
    if (!values.state) throw new PipelineInputError(USAGE);
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
        purgeUninstalled: values['purge-uninstalled'],
        host: values.host,
        port: values.port === undefined ? undefined : Number(values.port),
        intervalSeconds: values.interval === undefined ? undefined : Number(values.interval),
        signal: controller.signal,
        onReady: (url) => console.error(`[refit] Listening at ${url}; webhook: /github/webhook`),
        onProgress: (message) => console.error(`[refit] ${terminalText(message)}`),
      });
      console.log('Refit hosted service stopped');
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await pool.end();
    }
  } else throw new PipelineInputError(USAGE);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

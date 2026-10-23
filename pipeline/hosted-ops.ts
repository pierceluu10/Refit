import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { resolveDockerImage } from './docker-sandbox.ts';
import { WebhookInputError } from './github-webhooks.ts';
import { hostedFailureNotice, slackNotifier, type SlackSend } from './slack.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
export const JOB_STATUSES = ['queued', 'running', 'finished', 'failed', 'cancelled'];
export const JOBS_SHOWN = 50;
const DOCKER_TIMEOUT_MS = 10_000;
const NOTICE_INTERVAL_MS = 60 * 60 * 1000;
// Shorter values are too common in ordinary text to redact safely, and no Refit secret is this short.
const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';
const SECRET_VARIABLES = [
  'GITHUB_APP_PRIVATE_KEY',
  'REFIT_WEBHOOK_SECRET',
  'REFIT_SERVICE_TOKEN',
  'REFIT_DATABASE_URL',
  'OPENAI_API_KEY',
  'REFIT_SLACK_WEBHOOK_URL',
];
// Credentials that may reach a log line without passing through the environment.
const SECRET_PATTERNS: [RegExp, string][] = [
  // A truncated key is redacted to the end of the message.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*)/g,
    REDACTED,
  ],
  [/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/https:\/\/hooks\.slack\.com\/services\/\S+/g, REDACTED],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
  [/(Authorization:\s*token\s+)[^\s"',;]+/gi, `$1${REDACTED}`],
  // Short words after Bearer or Basic are ordinary text, not credentials.
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/-]{16,}=*/g, `$1 ${REDACTED}`],
];
// The six tables the worker creates on boot; there is no recorded schema version yet.
const TABLES = [
  'refit_installations',
  'refit_installation_repositories',
  'refit_deliveries',
  'refit_approvals',
  'refit_targets',
  'refit_jobs',
];

export interface HostedLogContext {
  level?: 'info' | 'error';
  job?: number;
  target?: string;
  installation?: number;
  delivery?: string;
}

export function hostedRedactor(env: NodeJS.ProcessEnv) {
  const secrets = new Set<string>();
  for (const name of SECRET_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    secrets.add(value);
    // A secret may reach a message base64-encoded, as in an HTTP Basic header.
    secrets.add(Buffer.from(value).toString('base64'));
    // Each line of a multi-line secret such as a PEM key is redacted on its own.
    for (const line of value.split('\n')) secrets.add(line.trim());
    if (name === 'REFIT_DATABASE_URL' && URL.canParse(value)) {
      const { password } = new URL(value);
      secrets.add(password);
      secrets.add(decodeURIComponent(password));
    }
  }
  const values = [...secrets]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text: string) =>
    SECRET_PATTERNS.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      values.reduce((result, secret) => result.replaceAll(secret, REDACTED), text),
    );
}

// One JSON object per line on stderr, so `fly logs` output can be filtered by job, target or
// installation. Every message passes through the redactor first.
export function hostedLogging(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
) {
  const redact = hostedRedactor(env);
  const log = (message: string, { level = 'info', ...ids }: HostedLogContext = {}) =>
    write(
      JSON.stringify({ time: new Date().toISOString(), level, message: redact(message), ...ids }),
    );
  const slack = slackNotifier(env, (message) => log(message, { level: 'error' }));
  const notify: SlackSend | undefined = slack && ((text) => slack(redact(text)));
  return { log, redact, notify };
}

function isoTime(value: string, flag: string) {
  if (!/^\d{4}-\d{2}-\d{2}(T\S+)?$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new PipelineInputError(`${flag} requires an ISO 8601 date or time.`);
  return new Date(value).toISOString();
}

export async function listHostedJobs(
  pool: Pool,
  filter: { target?: string; status?: string; since?: string },
) {
  if (filter.status !== undefined && !JOB_STATUSES.includes(filter.status))
    throw new PipelineInputError(`--status must be one of ${JOB_STATUSES.join(', ')}.`);
  const since = filter.since === undefined ? null : isoTime(filter.since, '--since');
  const { rows } = await pool.query<{
    id: string;
    targetId: string;
    repository: string;
    status: string;
    attempts: number;
    retry: boolean;
    outcome: string | null;
    createdAt: Date;
    finishedAt: Date | null;
    total: string;
  }>(
    `SELECT j.id::text, j.target_id AS "targetId", t.repository, j.status, j.attempts, j.retry,
       j.receipt->>'status' AS outcome, j.created_at AS "createdAt", j.finished_at AS "finishedAt",
       count(*) OVER ()::text AS total
     FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id
     WHERE ($1::text IS NULL OR j.target_id = $1) AND ($2::text IS NULL OR j.status = $2)
       AND ($3::timestamptz IS NULL OR j.created_at >= $3)
     ORDER BY j.id DESC LIMIT $4`,
    [filter.target ?? null, filter.status ?? null, since, JOBS_SHOWN],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    jobs: rows.map(({ total: _total, ...job }) => job),
  };
}

export async function readHostedReceipt(pool: Pool, job: string) {
  if (!/^[1-9]\d{0,17}$/.test(job)) throw new PipelineInputError('A job id is required.');
  const { rows } = await pool.query<{
    id: string;
    targetId: string;
    repository: string;
    base: string;
    integration: string | null;
    status: string;
    attempts: number;
    retry: boolean;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    createdAt: Date;
    finishedAt: Date | null;
    receipt: {
      status: string;
      output: string | null;
      message: string | null;
      revision?: string | null;
      readiness?: string | null;
    } | null;
  }>(
    `SELECT j.id::text, j.target_id AS "targetId", t.repository, t.base, t.integration, j.status,
       j.attempts, j.retry, j.lease_owner AS "leaseOwner", j.lease_expires_at AS "leaseExpiresAt",
       j.created_at AS "createdAt", j.finished_at AS "finishedAt", j.receipt
     FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id WHERE j.id = $1`,
    [job],
  );
  if (!rows[0]) throw new PipelineInputError(`No hosted job ${job}.`);
  const output = rows[0].receipt?.output;
  // Evidence stays on the worker's volume; elsewhere only the stored path is known.
  let evidence: string[] | null = null;
  if (output)
    try {
      evidence = (await readdir(output)).sort().map((name) => join(output, name));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  return { ...rows[0], evidence };
}

export async function listHostedTargets(pool: Pool) {
  const { rows } = await pool.query<{
    id: string;
    repository: string;
    base: string;
    integration: string | null;
    installationId: string;
    status: string;
    message: string | null;
    lastJob: string | null;
    lastJobStatus: string | null;
    lastJobAt: Date | null;
    receiptJob: string | null;
    receiptAt: Date | null;
    receiptStatus: string | null;
    receiptMessage: string | null;
  }>(
    `SELECT t.id, t.repository, t.base, t.integration, t.installation_id::text AS "installationId",
       t.status, t.message, last.id::text AS "lastJob", last.status AS "lastJobStatus",
       last.created_at AS "lastJobAt", stored.id::text AS "receiptJob",
       stored.finished_at AS "receiptAt", stored.receipt->>'status' AS "receiptStatus",
       stored.receipt->>'message' AS "receiptMessage"
     FROM refit_targets t
     LEFT JOIN LATERAL (SELECT id, status, created_at FROM refit_jobs
       WHERE target_id = t.id ORDER BY id DESC LIMIT 1) last ON true
     LEFT JOIN LATERAL (SELECT id, finished_at, receipt FROM refit_jobs
       WHERE target_id = t.id AND receipt IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1)
       stored ON true
     ORDER BY t.repository, t.id`,
  );
  return rows;
}

// `/status?target=<id>` narrows the registry to one target, its installation and its jobs.
export function filterHostedStatus<
  Registry extends {
    installations: { id: string }[];
    targets: { id: string; installationId: string }[];
    jobs: { targetId: string }[];
  },
>(registry: Registry, query: URLSearchParams) {
  if ([...query.keys()].some((key) => key !== 'target') || query.getAll('target').length > 1)
    throw new WebhookInputError(400, 'Only one target query parameter is supported.');
  const id = query.get('target');
  if (id === null) return registry;
  const target = registry.targets.find((candidate) => candidate.id === id);
  if (!target) throw new WebhookInputError(404, 'No hosted target with that id.');
  return {
    ...registry,
    installations: registry.installations.filter(
      (installation) => installation.id === target.installationId,
    ),
    targets: [target],
    jobs: registry.jobs.filter((job) => job.targetId === id),
  };
}

// Sends one notice per failed job, at most one per target per hour. Failures already stored when
// the worker starts are not sent again. shortcut: the hourly limit is in memory, so a restart can
// send one more notice per target; move it to PostgreSQL when more than one worker runs.
// Notices cut and escape their text, so secrets are redacted from job fields before the notice
// is built: a secret split by the cut would otherwise survive redaction of the finished text.
export function failedJobNotifier(
  pool: Pool,
  send: SlackSend,
  redact: (text: string) => string = (text) => text,
) {
  let cursor: string | undefined;
  const sent = new Map<string, number>();
  return async () => {
    if (cursor === undefined) {
      cursor = (await pool.query<{ now: string }>('SELECT now()::text AS now')).rows[0].now;
      return;
    }
    const { rows } = await pool.query<{
      id: string;
      targetId: string;
      repository: string;
      finishedAt: string;
      outcome: string | null;
      message: string | null;
    }>(
      `SELECT j.id::text, j.target_id AS "targetId", t.repository,
         j.finished_at::text AS "finishedAt", j.receipt->>'status' AS outcome,
         j.receipt->>'message' AS message
       FROM refit_jobs j JOIN refit_targets t ON t.id = j.target_id
       WHERE j.status = 'failed' AND j.finished_at > $1::timestamptz
       ORDER BY j.finished_at, j.id`,
      [cursor],
    );
    for (const job of rows) {
      cursor = job.finishedAt;
      const last = sent.get(job.targetId);
      if (last !== undefined && Date.now() - last < NOTICE_INTERVAL_MS) continue;
      sent.set(job.targetId, Date.now());
      await send(
        hostedFailureNotice({
          ...job,
          repository: redact(job.repository),
          message: job.message && redact(job.message),
        }),
      );
    }
  };
}

type HealthCheck = { check: string; status: 'ok' | 'failed'; detail: string };

function failure(check: string, error: unknown): HealthCheck {
  if (!(error instanceof Error)) throw error;
  const detail =
    ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) || error.message;
  return { check, status: 'failed', detail: detail.split('\n')[0] };
}

async function databaseHealth(pool: Pool): Promise<HealthCheck[]> {
  let rows: { name: string; present: boolean; writable: boolean }[];
  try {
    ({ rows } = await pool.query(
      // A comma-separated privilege list means any of them, so each one is checked separately.
      `SELECT name, to_regclass(name) IS NOT NULL AS present,
         to_regclass(name) IS NOT NULL AND has_table_privilege(name, 'SELECT')
           AND has_table_privilege(name, 'INSERT') AND has_table_privilege(name, 'UPDATE')
           AND has_table_privilege(name, 'DELETE') AS writable
       FROM unnest($1::text[]) AS name`,
      [TABLES],
    ));
  } catch (error) {
    return [
      failure('postgres', error),
      { check: 'schema', status: 'failed', detail: 'Not checked: PostgreSQL is unreachable.' },
    ];
  }
  const missing = rows.filter((row) => !row.present).map((row) => row.name);
  const readOnly = rows.filter((row) => row.present && !row.writable).map((row) => row.name);
  return [
    { check: 'postgres', status: 'ok', detail: 'Connected.' },
    missing.length || readOnly.length
      ? {
          check: 'schema',
          status: 'failed',
          detail: [
            ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
            ...(readOnly.length ? [`not writable by this role: ${readOnly.join(', ')}`] : []),
          ].join('; '),
        }
      : {
          check: 'schema',
          status: 'ok',
          detail: `All ${TABLES.length} Refit tables are present and writable.`,
        },
  ];
}

async function dockerHealth(images: string[]): Promise<HealthCheck[]> {
  try {
    const { stdout } = await execute('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: DOCKER_TIMEOUT_MS,
    });
    const daemon: HealthCheck = {
      check: 'docker',
      status: 'ok',
      detail: `Docker daemon ${stdout.trim()}.`,
    };
    if (!images.length)
      return [
        daemon,
        {
          check: 'images',
          status: 'failed',
          detail: 'REFIT_HOSTED_IMAGES names no validation image.',
        },
      ];
    const checks = await Promise.all(
      images.map(async (image) => {
        try {
          return {
            check: 'images',
            status: 'ok' as const,
            detail: `${image} ${(await resolveDockerImage(image)).slice(0, 19)}`,
          };
        } catch (error) {
          const result = failure('images', error);
          return { ...result, detail: `${image}: ${result.detail}` };
        }
      }),
    );
    return [daemon, ...checks];
  } catch (error) {
    return [
      failure('docker', error),
      { check: 'images', status: 'failed', detail: 'Not checked: Docker is unreachable.' },
    ];
  }
}

// Read-only checks of what the worker needs before it can run a job.
export async function checkHostedHealth(pool: Pool, images: string[]) {
  return [...(await databaseHealth(pool)), ...(await dockerHealth(images))];
}

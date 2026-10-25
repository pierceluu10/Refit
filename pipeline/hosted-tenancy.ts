import type { PoolClient } from 'pg';
import { PipelineInputError } from './types.ts';

const GITHUB_ACCOUNT = /^[a-z0-9][a-z0-9-]{0,38}$/;
// Five targets polled at the default 300-second interval.
const DEFAULT_DAILY_JOBS = 1440;
const DEFAULT_DAILY_INVENTORIES = 500;
const DEFAULT_INSTALLATION_JOBS = 1;
const MAX_LIMIT = 100_000;
// Usage resets at midnight UTC.
export const USAGE_DAY = `(now() AT TIME ZONE 'UTC')::date`;

export const TENANCY_REFUSALS = {
  notAllowed: 'account-not-allowed',
  jobRunning: 'installation-job-running',
  dailyJobs: 'daily-job-cap',
  dailyInventories: 'daily-inventory-cap',
} as const;
export type TenancyRefusal = (typeof TENANCY_REFUSALS)[keyof typeof TENANCY_REFUSALS];

export interface TenancyLimits {
  dailyJobs: number;
  dailyInventories: number;
  // Jobs of one installation that may run at once, across all workers.
  installationJobs: number;
}
export interface HostedTenancy {
  accounts: string[];
  limits: TenancyLimits;
}
export const DEFAULT_TENANCY_LIMITS: TenancyLimits = {
  dailyJobs: DEFAULT_DAILY_JOBS,
  dailyInventories: DEFAULT_DAILY_INVENTORIES,
  installationJobs: DEFAULT_INSTALLATION_JOBS,
};

function tenancyLimit(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!/^\d+$/.test(value.trim()) || limit < 1 || limit > MAX_LIMIT)
    throw new PipelineInputError(`${name} must be a whole number from 1 to ${MAX_LIMIT}.`);
  return limit;
}

// REFIT_HOSTED_ACCOUNTS lists the GitHub accounts whose installations may enroll; without it, only
// REFIT_HOSTED_OWNER's do.
export function hostedTenancy(environment: NodeJS.ProcessEnv): HostedTenancy {
  const listed = environment.REFIT_HOSTED_ACCOUNTS ?? environment.REFIT_HOSTED_OWNER ?? '';
  const accounts = [
    ...new Set(
      listed
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((account) => account.toLowerCase()),
    ),
  ];
  if (!accounts.length || accounts.some((account) => !GITHUB_ACCOUNT.test(account)))
    throw new PipelineInputError(
      'REFIT_HOSTED_ACCOUNTS (or REFIT_HOSTED_OWNER) requires comma-separated GitHub account logins.',
    );
  return {
    accounts,
    limits: {
      dailyJobs: tenancyLimit(
        environment.REFIT_HOSTED_DAILY_JOBS,
        DEFAULT_DAILY_JOBS,
        'REFIT_HOSTED_DAILY_JOBS',
      ),
      dailyInventories: tenancyLimit(
        environment.REFIT_HOSTED_DAILY_INVENTORIES,
        DEFAULT_DAILY_INVENTORIES,
        'REFIT_HOSTED_DAILY_INVENTORIES',
      ),
      installationJobs: tenancyLimit(
        environment.REFIT_HOSTED_INSTALLATION_JOBS,
        DEFAULT_INSTALLATION_JOBS,
        'REFIT_HOSTED_INSTALLATION_JOBS',
      ),
    },
  };
}

// Counts one job or inventory against the installation's cap for today; false once it is reached.
export async function reserveUsage(
  client: PoolClient,
  installationId: number,
  kind: 'jobs' | 'inventories',
  cap: number,
) {
  const { rowCount } = await client.query(
    `INSERT INTO refit_installation_usage AS u (installation_id, day, ${kind})
     VALUES ($1, ${USAGE_DAY}, 1)
     ON CONFLICT (installation_id, day) DO UPDATE SET ${kind} = u.${kind} + 1 WHERE u.${kind} < $2`,
    [installationId, cap],
  );
  return Boolean(rowCount);
}

// Why an installation cannot start more work right now, as shown in status.
export function installationRefusals(
  installation: {
    allowed: boolean;
    status: string;
    jobsToday: number;
    inventoriesToday: number;
    // Jobs of this installation running with a live lease.
    running: number;
  },
  limits: TenancyLimits,
) {
  const refusals: TenancyRefusal[] = [];
  if (!installation.allowed) refusals.push(TENANCY_REFUSALS.notAllowed);
  if (installation.running >= limits.installationJobs) refusals.push(TENANCY_REFUSALS.jobRunning);
  if (installation.jobsToday >= limits.dailyJobs) refusals.push(TENANCY_REFUSALS.dailyJobs);
  if (installation.inventoriesToday >= limits.dailyInventories)
    refusals.push(TENANCY_REFUSALS.dailyInventories);
  return refusals;
}

// The eligibility screen (evals only, never the product): each repo's own checks, in the sandbox,
// before any edit, after the same install and codegen the harness runs. A red baseline can't prove
// any fix, so it is left out of the score and logged with its class and a one-line reason.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetLedger, createSandbox, prepareBaseline } from '../../harness/index.ts';
import type { Budget } from '../../orchestrator/budget.ts';
import type { ModelClient } from '../reviewer/model.ts';
import type { DevSet, RepoEntry } from '../sets/index.ts';
import type { CheckoutRepo } from './types.ts';

/** The two classes the round-3 README fixes. They can't be widened mid-run. */
export type ExclusionClass = 'red-baseline' | 'outside-authority';

export type BaselineRecord = {
  set: string;
  repo: string;
  commit: string;
  provider: string;
  /** Every detected check passed before any edit (true when none was detected). */
  green: boolean;
  noChecks: boolean;
  checks: { name: string; command: string; ok: boolean; failures: string[]; tail: string }[];
  install?: { code: number; tail: string };
  preparation?: { steps: { command: string; why: string; code: number }[]; env: string[] };
  exclusion?: { class: ExclusionClass; reason: string };
  error?: string;
  costUsd: number;
  durationMs: number;
};

export type Exclusion = {
  set: string;
  repo: string;
  commit: string;
  class: ExclusionClass;
  reason: string;
};

const CLASSIFY_SYSTEM = `A code repository's own checks failed in a sandbox before anyone edited it. Sort it into exactly one class:

- "outside-authority": passing needs something we can't or shouldn't touch: real credentials or a live paid service in its tests, a private dependency or registry, a toolchain the sandbox can't run (for example a native SDK, a GPU, a database server or another service the tests connect to, or a platform other than Linux), or an archived or read-only repo.
- "red-baseline": anything else: the repo's own code, types, tests or build fail as they stand.

Give a one-line reason naming the failing check and the cause.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string', enum: ['red-baseline', 'outside-authority'] },
    reason: { type: 'string' },
  },
  required: ['class', 'reason'],
  additionalProperties: false,
};

const tail = (text: string, chars = 1500) => text.trim().slice(-chars);

export function screenFile(dir: string, set: string, entry: RepoEntry): string {
  return join(dir, set, `${entry.repo.replace('/', '__')}@${entry.commit.slice(0, 12)}.json`);
}

export function readScreen(dir: string): BaselineRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((set) =>
    set.isDirectory()
      ? readdirSync(join(dir, set.name))
          .filter((file) => file.endsWith('.json'))
          .map(
            (file) => JSON.parse(readFileSync(join(dir, set.name, file), 'utf8')) as BaselineRecord,
          )
      : [],
  );
}

export function exclusionsOf(records: BaselineRecord[]): Exclusion[] {
  return records
    .filter((record) => record.exclusion)
    .map((record) => ({
      set: record.set,
      repo: record.repo,
      commit: record.commit,
      class: record.exclusion!.class,
      reason: record.exclusion!.reason,
    }))
    .sort((a, b) => `${a.set}/${a.repo}`.localeCompare(`${b.set}/${b.repo}`));
}

/** Checks one repo's baseline. Never throws: a repo the screen can't build is a red baseline. */
export async function screenRepo(
  entry: RepoEntry,
  set: Pick<DevSet, 'name' | 'provider'>,
  deps: { checkout: CheckoutRepo; budget: Budget; classify: ModelClient },
): Promise<BaselineRecord> {
  const started = Date.now();
  const provider = typeof entry.provider === 'string' ? entry.provider : set.provider;
  const record: BaselineRecord = {
    set: set.name,
    repo: entry.repo,
    commit: entry.commit,
    provider,
    green: false,
    noChecks: false,
    checks: [],
    costUsd: 0,
    durationMs: 0,
  };
  const before = deps.budget.spentUsd();
  const hold = await deps.budget.reserve(`the ${entry.repo} screen`, 1);
  const ledger = new BudgetLedger(hold.usd);
  let copy: Awaited<ReturnType<CheckoutRepo>> | undefined;
  try {
    copy = await deps.checkout(entry);
    const sandbox = await createSandbox(copy.repoDir);
    try {
      const baseline = await prepareBaseline(sandbox, ledger);
      record.install = baseline.install && {
        code: baseline.install.code,
        tail: tail(`${baseline.install.stdout}\n${baseline.install.stderr}`),
      };
      record.preparation = {
        steps: baseline.preparation.steps.map(({ command, why, code }) => ({ command, why, code })),
        env: Object.keys(baseline.preparation.env),
      };
      record.checks = baseline.before.map((run) => ({
        name: run.name,
        command: run.command,
        ok: run.ok,
        failures: run.failures.slice(0, 10),
        tail: run.ok ? '' : tail(run.output),
      }));
      record.noChecks = record.checks.length === 0;
      record.green = record.checks.every((check) => check.ok);
    } finally {
      await sandbox.dispose();
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    hold.settle(ledger.spentUsd);
    await copy?.cleanup().catch(() => undefined);
  }
  if (!record.green) record.exclusion = await classify(record, deps.classify);
  record.costUsd = deps.budget.spentUsd() - before;
  record.durationMs = Date.now() - started;
  return record;
}

async function classify(
  record: BaselineRecord,
  model: ModelClient,
): Promise<{ class: ExclusionClass; reason: string }> {
  const failing = record.checks.filter((check) => !check.ok);
  const prompt = [
    `Repository: ${record.repo} at ${record.commit}`,
    record.error ? `The screen could not build it: ${record.error}` : '',
    record.install ? `Install exit ${record.install.code}:\n${record.install.tail}` : '',
    ...failing.map(
      (check) =>
        `Check ${check.name} (\`${check.command}\`) failed:\n${check.failures.join('\n')}\n${check.tail}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const reply = await model.complete({
      system: CLASSIFY_SYSTEM,
      prompt,
      maxTokens: 400,
      jsonSchema: CLASSIFY_SCHEMA,
    });
    const parsed = JSON.parse(reply.text) as { class: ExclusionClass; reason: string };
    if (parsed.class === 'red-baseline' || parsed.class === 'outside-authority') return parsed;
  } catch {
    // An unclassified red baseline stays red-baseline, the narrower exclusion.
  }
  const first = failing[0];
  return {
    class: 'red-baseline',
    reason: record.error
      ? `screen could not build it: ${record.error.slice(0, 200)}`
      : `${first?.name ?? 'a check'} fails before any edit: ${first?.failures[0] ?? 'see the screen record'}`,
  };
}

/** Screens a set's repos (cached per repo and commit) with bounded concurrency. */
export async function screenSet(
  set: DevSet,
  outDir: string,
  concurrency: number,
  deps: { checkout: CheckoutRepo; budget: Budget; classify: ModelClient },
  log: (line: string) => void = console.log,
): Promise<BaselineRecord[]> {
  mkdirSync(join(outDir, set.name), { recursive: true });
  const records: BaselineRecord[] = [];
  let next = 0;
  const worker = async () => {
    while (next < set.repos.length) {
      const entry = set.repos[next++] as RepoEntry;
      const file = screenFile(outDir, set.name, entry);
      if (existsSync(file)) {
        records.push(JSON.parse(readFileSync(file, 'utf8')) as BaselineRecord);
        continue;
      }
      const record = await screenRepo(entry, set, deps);
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      records.push(record);
      log(
        `${set.name} ${entry.repo}: ${record.green ? 'green' : `${record.exclusion?.class}: ${record.exclusion?.reason}`} ($${record.costUsd.toFixed(3)}, ${Math.round(record.durationMs / 1000)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, set.repos.length) }, worker));
  return records;
}

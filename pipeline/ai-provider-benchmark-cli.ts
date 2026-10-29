// The AI-provider benchmark (docs/benchmarks/AI-PROVIDER-SETS.md): on a frozen OpenAI, Anthropic or
// Gemini list, each repository is fetched at its recorded commit, scanned with
// `refit deadlines --propose-model-fixes` (findings, proposed replacements, stops and alerts), and,
// with --validate, a JS/TS repository with replacements is checked the way `refit serve
// --model-fixes` checks it: its own tests or build before and after the patch, in offline Docker,
// with nothing published. Python is reported, never edited by the rules (docs/PYTHON-MODELS.md).
// With --ai in Actions, every row Refit leaves open goes to the AI fallback (pipeline/ai-fallback.ts),
// Python included; each open item becomes a miss record either way. Each row gets one outcome; the
// output is rewritten after every repository, so --resume continues a run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkoutError, json, startRun } from '../scripts/benchmark-harness.mjs';
import {
  aiUnavailable,
  fallbackEligible,
  openItems,
  quotedSources,
  type ScanBundle,
} from './ai-fallback.ts';
import { exposureSites, loadSourceContext } from './ai-fallback-run.ts';
import { missRecords } from './ai-misses.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { runModelFixes } from './model-fixes.ts';
import { DEFAULT_MODEL_PARAMETERS, loadModelParameters } from './model-parameters.ts';

const execute = promisify(execFile);
const REFIT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 180_000;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const USAGE =
  'Usage: npx tsx pipeline/ai-provider-benchmark-cli.ts --list <frozen.json> --root <dir> --output <results.json> [--image node:22-alpine --validate] [--ai --env <file>] [--parameter-changes <file>] [--resume]';

// One outcome per row, in the order a reader asks about them.
export type Outcome =
  | 'validated' // a JS/TS fix passed the repository's own checks before and after
  | 'ai-validated' // the AI fallback's patch passed every gate (still a draft for review)
  | 'validation-failed' // a fix was proposed and its checks failed or could not run
  | 'no-checks' // a fix was proposed but the repository has no test or build script
  | 'proposed' // a fix was proposed and --validate was off
  | 'needs-review' // affected, but every use was a stop, or only alerts were raised
  | 'optional-upgrade' // only an SDK upgrade that is available, not required (would change outputs)
  | 'report-only' // only informational review items (status `report`), nothing to fix or review
  | 'detection-only' // affected Python: reported, never edited
  | 'unaffected' // no live finding and no alert
  | 'error' // Refit failed on the repository
  | 'infrastructure'; // the repository could not be fetched

interface Entry {
  repo: string;
  commit: string;
  language?: 'js' | 'py';
  changeTypes?: string[];
}
interface Scan {
  exposures: Array<{
    deadline: {
      id: string;
      provider: string;
      date: string;
      kind: string;
      replacement: string | null;
    };
    evidence?: Array<{ file: string; line: number; version: string; text: string }>;
  }>;
  replacements: Array<Record<string, unknown>>;
  stops: Array<Record<string, unknown>>;
  unresolved: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
}

// A fix lane's status: `refit deadlines` model fixes (runModelFixes) or `refit ai-migrations
// --validate`. no-change proposes nothing; needs-review found uses but proposes no safe edit.
export type LaneStatus =
  | 'no-change'
  | 'needs-review'
  | 'no-checks'
  | 'validated'
  | 'validation-failed'
  | 'proposed'
  | 'optional-upgrade';

export function outcomeOf(row: {
  error?: string;
  infrastructure?: unknown;
  language?: string;
  // Live findings, stops, alerts and review items that need review, from every lane.
  findings: number;
  // Informational review items (status `report`).
  reports?: number;
  lanes: LaneStatus[];
}): Outcome {
  if (row.infrastructure) return 'infrastructure';
  if (row.error) return 'error';
  const fixes = row.lanes.filter(
    (lane) => !['no-change', 'needs-review', 'optional-upgrade'].includes(lane),
  );
  const optional = row.lanes.includes('optional-upgrade');
  const review = row.findings > 0 || row.lanes.includes('needs-review');
  if (!review && !fixes.length && !optional && !row.reports) return 'unaffected';
  if (row.language === 'py') return 'detection-only';
  if (!fixes.length) return review ? 'needs-review' : optional ? 'optional-upgrade' : 'report-only';
  if (fixes.includes('validation-failed')) return 'validation-failed';
  if (fixes.includes('proposed')) return 'proposed';
  if (fixes.every((lane) => lane === 'validated')) return 'validated';
  return 'no-checks';
}

interface MigrationResult {
  review: Array<{ status?: string }>;
  proposal: {
    edits: unknown[];
    stops: Array<{ blocking?: boolean; category?: string }>;
  } | null;
  validation: Record<string, unknown> | null;
  ai?: { status?: string; lane?: { edits?: unknown[] } } | null;
}

// The lane a migration result adds: its validation status, or, scan-only, whether it proposed
// edits. An upgrade blocked only by optional-upgrade stops (decision A: sampling parameters the
// new SDK's models treat differently) is available, not required.
export function migrationLane(migrated: MigrationResult | null | undefined): LaneStatus | null {
  if (!migrated) return null;
  if (migrated.validation) {
    const status = String((migrated.validation as { status?: string }).status);
    return status === 'upgrade-optional' ? 'optional-upgrade' : (status as LaneStatus);
  }
  const proposal = migrated.proposal;
  if (!proposal) return null;
  const blocking = proposal.stops.filter((stop) => stop.blocking);
  if (blocking.some((stop) => stop.category !== 'optional-upgrade')) return 'needs-review';
  if (blocking.length) return 'optional-upgrade';
  return proposal.edits.length ? 'proposed' : proposal.stops.length ? 'needs-review' : null;
}

// A stored row's outcome, from its own fields, so earlier runs can be recounted the same way.
export function rowOutcome(row: {
  error?: string;
  infrastructure?: unknown;
  language?: string;
  exposures?: unknown[];
  replacements?: unknown[];
  stops?: unknown[];
  alerts?: unknown[];
  validation?: { status: string } | null;
  migrations?: MigrationResult;
  fallback?: { status: string } | null;
}): Outcome {
  if (!row.error && !row.infrastructure && row.fallback?.status === 'validated')
    return 'ai-validated';
  const lanes: LaneStatus[] = [];
  if (row.validation) lanes.push(row.validation.status as LaneStatus);
  else if (row.replacements?.length)
    lanes.push(row.language === 'py' ? 'needs-review' : 'proposed');
  const lane = migrationLane(row.migrations);
  if (lane) lanes.push(lane);
  // The AI lane counts only when it proposed edits; a published draft counts as validated.
  const ai = row.migrations?.ai;
  if (ai?.lane?.edits?.length)
    lanes.push(ai.status === 'draft-created' ? 'validated' : (ai.status as LaneStatus));
  const review = row.migrations?.review ?? [];
  return outcomeOf({
    error: row.error,
    infrastructure: row.infrastructure,
    language: row.language,
    findings:
      (row.exposures?.length ?? 0) +
      (row.stops?.length ?? 0) +
      (row.alerts?.length ?? 0) +
      review.filter((item) => item.status !== 'report').length,
    reports: review.filter((item) => item.status === 'report').length,
    lanes,
  });
}

// One line for a failed Refit command: a timeout or a crash by name, else Refit's own last error
// line. A Node crash prints a native stack whose last line names no cause.
export function errorSummary(error: unknown) {
  const failure = error as { killed?: boolean; signal?: string; stderr?: string; message?: string };
  if (failure?.killed || failure?.signal === 'SIGKILL')
    return 'timed out (killed after the scan limit)';
  const text = String(failure?.stderr || failure?.message || error);
  if (/heap out of memory|Allocation failed/i.test(text)) return 'Node ran out of memory';
  const lines = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cause = lines.find((line) => /^(?:refit [\w-]+:|Error:|TypeError:|RangeError:)/.test(line));
  if (cause) return cause.slice(0, 500);
  if (lines.some((line) => /^\d+: 0x[0-9a-f]+ /.test(line)))
    return 'Node crashed (native stack, no message)';
  return (lines.at(-1) ?? 'unknown error').slice(0, 500);
}

// KEY=value lines, for the AI env file the benchmark workflow writes. Never logged.
export function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

// What the AI fallback did over a run's rows.
export function fallbackCounts(rows: Array<Record<string, unknown>>) {
  const statuses = rows.map((row) => (row.fallback as { status?: string } | null)?.status);
  const eligible = rows.filter(
    (row, index) =>
      (Array.isArray(row.misses) && row.misses.length) || statuses[index] === 'ai-unavailable',
  ).length;
  return {
    // Rows Refit left open (each has miss records, unless the AI was unavailable).
    eligible,
    // Rows where a model answered (validated or kept as a suggestion).
    attempted: statuses.filter((status) => status === 'validated' || status === 'needs-review')
      .length,
    validated: statuses.filter((status) => status === 'validated').length,
    suggestions: rows.filter((row) => (row.fallback as { suggestion?: boolean } | null)?.suggestion)
      .length,
    noAttempt: statuses.filter((status) => status === 'no-attempt').length,
    // Key, access or quota refusals (401, 403, 429): neither attempts nor misses.
    unavailable: statuses.filter((status) => status === 'ai-unavailable').length,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'string' },
      root: { type: 'string' },
      output: { type: 'string' },
      image: { type: 'string' },
      validate: { type: 'boolean' },
      ai: { type: 'boolean' },
      env: { type: 'string' },
      'parameter-changes': { type: 'string' },
      resume: { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.list || !values.root || !values.output) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (values.validate && !values.image) throw new Error('--validate needs --image');
  if (values.ai && !values.env) throw new Error('--ai needs --env');
  // Provider keys reach Refit's child processes only; they are never written to the output.
  const aiEnvironment = values.ai ? parseEnvFile(await readFile(values.env!, 'utf8')) : {};
  const childEnvironment = { ...process.env, ...aiEnvironment };
  Object.assign(process.env, aiEnvironment);

  const frozen = JSON.parse(await readFile(values.list, 'utf8')) as {
    provider?: string;
    repos: Entry[];
  };
  const provider = frozen.provider;
  const root = resolve(values.root);
  await mkdir(root, { recursive: true });
  const now = new Date();
  const registry = await loadDeadlineRegistry(undefined, now);
  const parameters = await loadModelParameters(DEFAULT_MODEL_PARAMETERS, now);
  const harness = await startRun({
    format: 'ai-model-results',
    refitRoot: REFIT,
    list: { path: values.list, file: values.list },
    options: {
      validate: values.validate,
      ai: values.ai,
      parameterChanges: values['parameter-changes'],
    },
    environment: ['OPENAI_MODEL', 'REFIT_AI_BUDGET_USD'],
    image: values.validate ? values.image : undefined,
    allowDirty: values['allow-dirty'],
  });
  const previous =
    values.resume && existsSync(values.output)
      ? (JSON.parse(await readFile(values.output, 'utf8')).results as Array<{
          repo: string;
          commit: string;
        }>)
      : [];

  async function checkout(entry: Entry) {
    const directory = join(root, entry.repo.replace('/', '__'));
    if (!(await checkoutError(directory, entry.commit))) return directory;
    await rm(directory, { recursive: true, force: true });
    await execute('git', ['init', '-q', directory]);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
    await execute(
      'git',
      [
        '-C',
        directory,
        'fetch',
        '-q',
        '--depth',
        '1',
        `https://github.com/${entry.repo}`,
        entry.commit,
      ],
      { timeout: GIT_TIMEOUT_MS, env },
    );
    await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD'], { env });
    const wrong = await checkoutError(directory, entry.commit);
    if (wrong) throw new Error(wrong);
    return directory;
  }

  async function refit(args: string[]) {
    const { stdout } = await execute(
      process.execPath,
      [join(REFIT, 'bin', 'refit.mjs'), ...args, '--json'],
      {
        cwd: REFIT,
        env: childEnvironment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: SCAN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    return JSON.parse(stdout);
  }

  // ai-migrations exists only on commits that have it (SDK majors, API surfaces, betas).
  const help = await execute(
    process.execPath,
    [join(REFIT, 'bin', 'refit.mjs'), 'ai-migrations', '--help'],
    { cwd: REFIT },
  )
    .then(({ stdout }) => stdout)
    .catch(() => null);
  const migrations = help !== null;
  // The AI lane for OpenAI legacy Completions and Assistants runs only in Actions with --ai, and
  // only on commits that have it; the command itself refuses outside GITHUB_ACTIONS.
  const aiSurfaces =
    Boolean(help?.includes('--ai-surfaces')) &&
    Boolean(values.ai && values.validate) &&
    process.env.GITHUB_ACTIONS === 'true';
  // The AI fallback on every row Refit leaves open, on commits that have it; Actions only.
  const fallback =
    Boolean(help?.includes('--ai-fallback')) &&
    Boolean(values.ai && values.validate) &&
    process.env.GITHUB_ACTIONS === 'true';
  const sourceContext = await loadSourceContext(now);
  // After one key, access or quota refusal the shard stops asking: every later row would fail the
  // same way and none of it is a miss.
  let unavailable: string | null = null;
  const PACKAGE: Record<string, string> = {
    openai: 'openai',
    anthropic: '@anthropic-ai/sdk',
    gemini: '@google/genai',
  };
  const MIGRATION_TIMEOUT_MS = 45 * 60 * 1000;
  async function migrate(directory: string, entry: Entry) {
    if (!migrations) return null;
    const review = (
      (await refit(['ai-migrations', '--review', '--repository', directory])) as Array<{
        provider?: string;
      }>
    ).filter(counted);
    if (entry.language === 'py') return { review, proposal: null, validation: null, ai: null };
    const pkg = provider && PACKAGE[provider] ? ['--package', PACKAGE[provider]] : [];
    // Without --validate, only the edits and stops (no Docker); with it, the patch is checked.
    const proposal = values.validate
      ? null
      : ((await refit(['ai-migrations', '--edits-only', '--repository', directory, ...pkg])) as {
          edits: unknown[];
          stops: Array<{ blocking?: boolean }>;
        } | null);
    let validation: Record<string, unknown> | null = null;
    if (values.validate) {
      const { stdout } = await execute(
        process.execPath,
        [
          join(REFIT, 'bin', 'refit.mjs'),
          'ai-migrations',
          '--validate',
          '--repository',
          directory,
          ...pkg,
          '--image',
          values.image!,
          '--json',
        ],
        {
          cwd: REFIT,
          env: childEnvironment,
          maxBuffer: 64 * 1024 * 1024,
          timeout: MIGRATION_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      validation = JSON.parse(stdout);
    }
    let ai: Record<string, unknown> | null = null;
    if (aiSurfaces && provider === 'openai') {
      const { stdout } = await execute(
        process.execPath,
        [
          join(REFIT, 'bin', 'refit.mjs'),
          'ai-migrations',
          '--ai-surfaces',
          '--repository',
          directory,
          '--image',
          values.image!,
          '--json',
        ],
        {
          cwd: REFIT,
          env: childEnvironment,
          maxBuffer: 64 * 1024 * 1024,
          timeout: MIGRATION_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      ai = JSON.parse(stdout);
    }
    return { review, proposal, validation, ai };
  }
  const counted = (item: { provider?: string; deadline?: { provider?: string } }) =>
    !provider || (item.provider ?? item.deadline?.provider) === provider;

  async function scan(directory: string): Promise<Scan> {
    const deadlines = await refit(['deadlines', '--repository', directory]);
    const extra = values['parameter-changes']
      ? ['--parameter-changes', resolve(values['parameter-changes'])]
      : [];
    const proposal = await refit([
      'deadlines',
      '--propose-model-fixes',
      '--repository',
      directory,
      ...extra,
    ]);
    return {
      exposures: (deadlines.exposures ?? []).filter(counted),
      replacements: (proposal.replacements ?? []).filter(counted),
      stops: (proposal.stops ?? []).filter(counted),
      unresolved: (proposal.unresolved ?? []).filter(counted),
      alerts: (proposal.alerts ?? []).filter(counted),
    };
  }

  async function checks(directory: string) {
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
    );
    const scripts = manifest.scripts ?? {};
    const command =
      typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)
        ? ['npm', 'test']
        : typeof scripts.build === 'string'
          ? ['npm', 'run', 'build']
          : undefined;
    return {
      command,
      prepareDependencies: LOCKFILES.some((name) => existsSync(join(directory, name))),
    };
  }

  const results: Array<Record<string, unknown>> = [];
  const document = () => {
    const counts: Record<string, number> = {};
    for (const row of results)
      counts[row.outcome as string] = (counts[row.outcome as string] ?? 0) + 1;
    return {
      formatVersion: 1,
      list: values.list,
      provider,
      ranAt: new Date().toISOString(),
      harness,
      summary: counts,
      // What the AI lane's responses report, summed over rows (USD).
      aiCostUsd: results.reduce((total, row) => {
        const ai = (row.migrations as { ai?: { ai?: { costUsd?: number } } } | undefined)?.ai;
        const own = (row.fallback as { ai?: { costUsd?: number | null } } | undefined)?.ai;
        return total + (ai?.ai?.costUsd ?? 0) + (own?.costUsd ?? 0);
      }, 0),
      aiFallback: fallbackCounts(results),
      missRecords: results.reduce(
        (total, row) => total + ((row.misses as unknown[] | undefined)?.length ?? 0),
        0,
      ),
      results,
    };
  };
  for (const [index, entry] of frozen.repos.entries()) {
    const label = `[${index + 1}/${frozen.repos.length}] ${entry.repo}`;
    const done = previous[index];
    if (done && done.repo === entry.repo && done.commit === entry.commit) {
      results.push(done);
      continue;
    }
    console.error(label);
    const base = {
      repo: entry.repo,
      commit: entry.commit,
      language: entry.language,
      changeTypes: entry.changeTypes ?? [],
    };
    let row: Record<string, unknown>;
    let directory: string;
    try {
      directory = await checkout(entry);
    } catch (error) {
      row = {
        ...base,
        infrastructure: { kind: 'clone', message: String((error as Error).message).slice(0, 300) },
      };
      results.push({ ...row, outcome: 'infrastructure' });
      await writeFile(values.output, json(document()));
      continue;
    }
    try {
      const found = await scan(directory);
      let validation: Record<string, unknown> | null = null;
      if (values.validate && found.replacements.length && entry.language !== 'py') {
        const { command, prepareDependencies } = await checks(directory);
        if (!command) validation = { status: 'no-checks', reason: 'No test or build script.' };
        else {
          const result = await runModelFixes({
            repository: directory,
            registry,
            parameters,
            now,
            checks: { image: values.image!, command, prepareDependencies },
            onProgress: (message) => console.error(`  ${message}`),
          });
          validation = {
            status: result.status,
            reason: result.reason,
            command,
            prepareDependencies,
            replacements: result.replacements.length,
          };
        }
      }
      const migrated = await migrate(directory, entry);
      row = {
        ...base,
        exposures: found.exposures.map((item) => item.deadline.id),
        replacements: found.replacements,
        stops: found.stops,
        unresolved: found.unresolved,
        alerts: found.alerts,
        validation,
        ...(migrated ? { migrations: migrated } : {}),
        exposureSites: exposureSites(found.exposures),
      };
      row.outcome = rowOutcome(row as Parameters<typeof rowOutcome>[0]);
      // Whatever Refit left open: the AI fallback when it can run, a miss record per item always.
      const bundle = { ...row, provider } as ScanBundle;
      const items = openItems(bundle);
      if (fallbackEligible(row.outcome as string, items)) {
        const sources = quotedSources(items, {
          ...sourceContext,
          findings: (migrated?.review ?? []) as never,
        });
        let attempt: { fallback: Record<string, unknown>; misses: unknown[] } | null = null;
        if (fallback && unavailable)
          attempt = {
            fallback: {
              status: 'ai-unavailable',
              reason: unavailable,
              ai: null,
              gates: [],
              patterns: [],
            },
            misses: [],
          };
        else if (fallback) {
          const file = join(root, `${entry.repo.replace('/', '__')}.row.json`);
          await writeFile(
            file,
            JSON.stringify({ ...bundle, repo: entry.repo, commit: entry.commit }),
          );
          try {
            const { stdout } = await execute(
              process.execPath,
              [
                join(REFIT, 'bin', 'refit.mjs'),
                'ai-migrations',
                '--ai-fallback',
                '--row',
                file,
                '--repository',
                directory,
                '--image',
                values.image!,
                ...(values['parameter-changes']
                  ? ['--parameter-changes', resolve(values['parameter-changes'])]
                  : []),
                '--json',
              ],
              {
                cwd: REFIT,
                env: childEnvironment,
                maxBuffer: 64 * 1024 * 1024,
                timeout: MIGRATION_TIMEOUT_MS,
                killSignal: 'SIGKILL',
              },
            );
            attempt = JSON.parse(stdout);
          } catch (error) {
            const reason = errorSummary(error);
            attempt = {
              fallback: {
                status: aiUnavailable(reason) ? 'ai-unavailable' : 'no-attempt',
                reason,
                ai: null,
                gates: [],
                patterns: [],
              },
              misses: [],
            };
          } finally {
            await rm(file, { force: true });
          }
          if (attempt?.fallback.status === 'ai-unavailable')
            unavailable = String(attempt.fallback.reason);
        }
        row.fallback = attempt?.fallback ?? null;
        row.misses =
          attempt?.fallback.status === 'ai-unavailable'
            ? []
            : attempt?.misses.length
              ? attempt.misses
              : missRecords(
                  {
                    repo: entry.repo,
                    commit: entry.commit,
                    provider: provider ?? '',
                    language: entry.language,
                  },
                  items,
                  sources,
                  (attempt?.fallback as never) ?? null,
                );
        row.outcome = rowOutcome(row as Parameters<typeof rowOutcome>[0]);
      }
    } catch (error) {
      row = {
        ...base,
        error: errorSummary(error),
        outcome: 'error',
      };
    }
    results.push(row);
    await writeFile(values.output, json(document()));
  }
  await writeFile(values.output, json(document()));
  console.error(JSON.stringify(document().summary));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

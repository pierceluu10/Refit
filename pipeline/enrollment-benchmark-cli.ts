// Measures the first run a stranger's repository gets: enrollment, then refit doctor, with no hand
// edits. Reads shallow benchmark clones (scripts/stripe-benchmark-setup.mjs); it runs no repository
// code, installs nothing and contacts no service.
//
// --mode generated: the configuration Refit generates when no .refit.json is committed.
// --mode scaffold: the path before generation, run from a checkout of that code: the configuration
// `refit agents --add` proposes, committed verbatim, then each hand edit a customer had to make.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { addable, addAgents, detectProviders, scaffoldChecks } from './agent-catalog.ts';
import { inspectRepositoryReadiness, type ReadinessReport } from './readiness.ts';
import { inspectRepositoryEnrollment } from './repository-enrollment.ts';
import { PipelineInputError } from './types.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:enrollment -- --root <benchmark-root> --list <list.json> --mode generated|scaffold --output <results.json> [--contracts <dir>]';
const GITHUB_BASE = 'main';
const SCAFFOLD_CONTRACTS = { before: 'refit/stripe-before.json', after: 'refit/stripe-after.json' };

interface Entry {
  repo: string;
  commit: string;
  before: string;
  packageManager: string;
  set?: string;
}

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string' },
    mode: { type: 'string' },
    output: { type: 'string' },
    contracts: { type: 'string' },
  },
});
if (
  !values.root ||
  !values.list ||
  !values.output ||
  (values.mode !== 'generated' && values.mode !== 'scaffold')
)
  throw new PipelineInputError(USAGE);
const root = values.root;
const contracts = values.contracts;
const list = JSON.parse(await readFile(values.list, 'utf8')) as { repos: Entry[] };
const latest = JSON.parse(
  await readFile(new URL('../data/stripe-openapi-versions.json', import.meta.url), 'utf8'),
).versions.at(-1).version as string;

function doctorSummary(report: ReadinessReport) {
  return {
    status: report.status,
    blocked: report.checks
      .filter((check) => check.status === 'blocked')
      .map(({ id, detail, action }) => ({ id, detail, action })),
    review: report.checks.filter((check) => check.status === 'review').map((check) => check.id),
    ...(report.generated ? { generated: report.generated } : {}),
  };
}

async function enroll(directory: string, repo: string) {
  try {
    const enrollment = await inspectRepositoryEnrollment({
      repository: directory,
      github: repo,
      base: GITHUB_BASE,
      ...(contracts ? { contracts } : {}),
    });
    return { ok: true, fingerprint: enrollment.fingerprint };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { ok: false, error: `${error.name}: ${error.message}` };
  }
}

async function doctor(directory: string) {
  return doctorSummary(
    await inspectRepositoryReadiness({
      repository: directory,
      ...(contracts ? { contracts } : {}),
    }),
  );
}

async function commit(directory: string, message: string) {
  const git = (...argumentsList: string[]) => execute('git', ['-C', directory, ...argumentsList]);
  await git('add', '-A');
  await git(
    '-c',
    'user.name=Refit measurement',
    '-c',
    'user.email=measurement@refit.invalid',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    message,
  );
}

// The configuration the hosted approval issue proposed (pipeline/hosted-approval.ts), committed as
// is, then with the contracts saved and then with apiVersion added by hand.
async function scaffold(source: string, entry: Entry) {
  const work = await mkdtemp(join(tmpdir(), 'refit-enrollment-'));
  const directory = join(work, 'repository');
  try {
    await cp(source, directory, { recursive: true, verbatimSymlinks: true });
    const detections = await detectProviders(directory);
    const ids = detections.filter(addable).map((detection) => detection.agent.id);
    if (!ids.includes('stripe')) return { proposal: 'no-stripe-agent', detected: ids, rungs: [] };
    const proposal = addAgents({
      configuration: undefined,
      v1Id: 'stripe',
      detections,
      ids: ['stripe'],
      ...(await scaffoldChecks(directory)),
    });
    const configuration = proposal.configuration as { integrations: Record<string, unknown>[] };
    const write = () =>
      writeFile(
        join(directory, REPOSITORY_CONFIGURATION),
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
    const rungs = [];
    await write();
    await commit(directory, 'test: commit the proposed configuration');
    rungs.push({
      edit: 'none',
      enrollment: await enroll(directory, entry.repo),
      doctor: await doctor(directory),
    });
    await mkdir(join(directory, 'refit'), { recursive: true });
    await cp(
      join(root, 'specs', `${entry.before}.json`),
      join(directory, SCAFFOLD_CONTRACTS.before),
    );
    await cp(join(root, 'specs', `${latest}.json`), join(directory, SCAFFOLD_CONTRACTS.after));
    await commit(directory, 'test: save the contracts');
    rungs.push({
      edit: 'contracts',
      enrollment: await enroll(directory, entry.repo),
      doctor: await doctor(directory),
    });
    configuration.integrations[0].apiVersion = entry.before;
    await write();
    await commit(directory, 'test: add apiVersion');
    rungs.push({
      edit: 'apiVersion',
      enrollment: await enroll(directory, entry.repo),
      doctor: await doctor(directory),
    });
    return { proposal: 'stripe', command: configuration.integrations[0].command, rungs };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const results = [];
for (const [index, entry] of list.repos.entries()) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const started = Date.now();
  const row: Record<string, unknown> = {
    repo: entry.repo,
    set: entry.set,
    packageManager: entry.packageManager,
    listBefore: entry.before,
  };
  try {
    if (values.mode === 'generated') {
      row.enrollment = await enroll(directory, entry.repo);
      row.doctor = await doctor(directory);
    } else Object.assign(row, await scaffold(directory, entry));
  } catch (error) {
    row.crash = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  row.seconds = Math.round((Date.now() - started) / 100) / 10;
  results.push(row);
  const outcome =
    (row.doctor as { status?: string } | undefined)?.status ?? row.crash ?? 'scaffold';
  console.error(`[${index + 1}/${list.repos.length}] ${entry.repo}: ${outcome}`);
}
await writeFile(values.output, `${JSON.stringify(results, null, 2)}\n`);

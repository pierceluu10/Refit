import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { runDeprecationPipeline } from '../pipeline/deprecated-models.ts';
import { RESULT_COLUMNS, RUN_COLUMNS, type ResultRow, type RunRow, writeCsv } from './results.ts';

const execute = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ADAPTER = resolve(root, '../pipeline/fixtures/openai/provider.json');
const BUNDLED_SNAPSHOT = resolve(root, '../pipeline/fixtures/openai/deprecation-snapshot.json');

export type EvaluationOptions = {
  repositories: string[];
  output: string;
  runsOutput?: string;
  reportsDirectory?: string;
  log?: (message: string) => void;
};

export function parseRepositoryList(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function assertPublicGitHubUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Repository must be a public HTTPS GitHub URL: ${url}`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    !/^\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`Repository must be a public HTTPS GitHub URL: ${url}`);
}

function runLedgerPath(resultsPath: string) {
  const extension = resultsPath.toLowerCase().endsWith('.csv') ? '.csv' : '';
  return `${resultsPath.slice(0, extension ? -extension.length : undefined)}.runs.csv`;
}

function reportName(url: string, index: number) {
  const parsed = new URL(url);
  const slug = parsed.pathname
    .replace(/\.git\/?$/, '')
    .replace(/^\/|\/$/g, '')
    .replaceAll('/', '--')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return `${String(index + 1).padStart(3, '0')}-${slug}.json`;
}

export async function runEvaluation(options: EvaluationOptions) {
  const log = options.log ?? ((message: string) => console.error(message));
  const results: ResultRow[] = [];
  const runs: RunRow[] = [];
  const reportsDirectory =
    options.reportsDirectory ?? join(dirname(resolve(options.output)), 'reports');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'refit-openai-eval-'));
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await mkdir(reportsDirectory, { recursive: true });

  try {
    for (const [index, repository] of options.repositories.entries()) {
      const checkout = join(temporaryRoot, `repository-${String(index + 1).padStart(3, '0')}`);
      let commit = '';
      try {
        await execute('git', ['clone', '--depth', '1', '--no-tags', repository, checkout]);
      } catch (error) {
        const notes = error instanceof Error ? error.message : String(error);
        runs.push({ repo: repository, commit, status: 'clone-failed', findingCount: '', notes });
        log(`clone failed; skipped ${repository}: ${notes}`);
        continue;
      }

      try {
        commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
        const report = await runDeprecationPipeline({
          repository: checkout,
          providerConfig: BUNDLED_ADAPTER,
          snapshot: BUNDLED_SNAPSHOT,
        });
        await writeFile(
          join(reportsDirectory, reportName(repository, index)),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        for (const finding of report.findings)
          results.push({
            repo: repository,
            commit,
            file: finding.location.file,
            line: String(finding.location.line),
            modelId: finding.modelId,
            confidence: finding.confidence,
            label: '',
            notes: '',
          });
        runs.push({
          repo: repository,
          commit,
          status: 'scanned',
          findingCount: String(report.findings.length),
          notes: '',
        });
      } catch (error) {
        const notes = error instanceof Error ? error.message : String(error);
        runs.push({ repo: repository, commit, status: 'scan-failed', findingCount: '', notes });
        log(`scan failed; skipped ${repository}: ${notes}`);
      } finally {
        await rm(checkout, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const runsOutput = options.runsOutput ?? runLedgerPath(resolve(options.output));
  await writeCsv(resolve(options.output), RESULT_COLUMNS, results);
  await writeCsv(runsOutput, RUN_COLUMNS, runs);
  return { results, runs, output: resolve(options.output), runsOutput, reportsDirectory };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repos: { type: 'string', default: resolve(root, 'repos.txt') },
      output: { type: 'string', default: resolve(root, 'results.csv') },
      'runs-output': { type: 'string' },
      'reports-directory': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npx tsx eval/runner.ts [--repos <repos.txt>] [--output <results.csv>] [--runs-output <runs.csv>] [--reports-directory <directory>]',
    );
    return;
  }
  const repositories = parseRepositoryList(await readFile(values.repos, 'utf8'));
  repositories.forEach(assertPublicGitHubUrl);
  const outcome = await runEvaluation({
    repositories,
    output: values.output,
    runsOutput: values['runs-output'],
    reportsDirectory: values['reports-directory'],
  });
  console.log(
    `Scanned ${outcome.runs.filter((run) => run.status === 'scanned').length} repositories; wrote ${outcome.results.length} findings to ${outcome.output}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

export const defaultRunLedgerPath = runLedgerPath;
export const bundledAdapter = BUNDLED_ADAPTER;
export const bundledSnapshot = BUNDLED_SNAPSHOT;

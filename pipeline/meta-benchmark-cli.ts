import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  checkoutError,
  classifyRow,
  finishedRow,
  json,
  openRunDirectory,
  startRun,
} from '../scripts/benchmark-harness.mjs';
import { assertResults } from '../scripts/benchmark-results.mjs';
import { summarizeAiLedger } from './ai-budget.ts';
import { assessmentConfiguration } from './assessment.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { metaResult, metaRow, summaryTable } from './meta-benchmark.ts';
import { META_SDK } from './deadline-exposure.ts';
import { reconstructGraphCalls } from './meta-graph-ai.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';
import { DEFAULT_META_GRAPH_CHANGES, loadMetaGraphChanges } from './meta-graph-changes.ts';
import { proposeVersionMoves } from './meta-graph-moves.ts';
import { writeMetaGraphRun } from './meta-graph-workflow.ts';
import { readEvidence } from './state-files.ts';
import { HOSTED_REPAIR_ATTEMPTS, validateRepairAttempts } from './validation-options.ts';
import { readRepository } from './repository.ts';
import { PipelineInputError } from './types.ts';

// Runs Refit's Meta Graph engine on a frozen Meta list (docs/benchmarks/subsets/meta-*.json):
// the request scan and the version-move proposal to the list's target, per repository. With
// --validate, a repository with a patch, or with --ai one whose pins the moves leave behind, then
// runs `refit run` as a customer's would (writeMetaGraphRun): the agent fixer on what the moves
// leave (meta-graph-agent.ts), its checks offline in Docker, and the draft artifacts. Each row ends
// validated, needs-review, no-change or infrastructure (metaResult). Meta is never contacted.
const USAGE =
  'Usage: npm run benchmark:meta -- --root <benchmark-dir> --list <frozen.json> --output <new-dir> [--validate [--env .env] [--ai [--repair-attempts 0-4]]] [--resume] [--allow-dirty] [--limit N]';
const VALIDATION_TIMEOUT_MS = 30 * 60 * 1000;
const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    list: { type: 'string' },
    limit: { type: 'string' },
    resume: { type: 'boolean' },
    validate: { type: 'boolean' },
    ai: { type: 'boolean' },
    'repair-attempts': { type: 'string' },
    env: { type: 'string' },
    'allow-dirty': { type: 'boolean' },
  },
});
if (!values.root || !values.output || !values.list) throw new PipelineInputError(USAGE);
if (values.ai && !values.validate) throw new PipelineInputError('--ai needs --validate.');
const repairAttempts = validateRepairAttempts(
  Number(values['repair-attempts'] ?? (values.ai ? HOSTED_REPAIR_ATTEMPTS : 0)),
  Boolean(values.ai),
);
if (values.env) process.loadEnvFile(values.env);
// Fails before any repository runs when the key or model is missing. With --ai the scan's
// unreadable requests are read by AI (meta-graph-ai.ts) and every child run gets --ai-patch; one
// ledger caps the run, with no per-repository cap.
const ai = assessmentConfiguration(values.ai, process.env);
// The ledger's recorded spend, read around each stage so the row records what each one cost.
async function spentUsd() {
  const directory = process.env.REFIT_AI_BUDGET_DIRECTORY;
  if (!ai || !directory) return 0;
  const stored = await readFile(join(directory, 'budget.json'), 'utf8').catch(() => undefined);
  return stored ? summarizeAiLedger(JSON.parse(stored)).spentUsd : 0;
}
// Benchmark runs never send Slack notices.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.REFIT_SLACK_WEBHOOK_URL;
const root = resolve(values.root);
const output = resolve(values.output);
const list = values.list;
const pinned = JSON.parse(await readFile(list, 'utf8')) as {
  provider?: string;
  specs?: { target?: string; changes?: { sha256?: string } };
  repos: { repo: string; stars: number; commit: string }[];
};
const target = pinned.specs?.target;
if (pinned.provider !== 'meta-graph' || !target)
  throw new PipelineInputError(`${list} is not a Meta Graph list with specs.target.`);
const repos = pinned.repos.slice(0, values.limit ? Number(values.limit) : undefined);
const { rows: previous } = await openRunDirectory(
  output,
  await startRun({
    format: 'meta-graph-results',
    refitRoot: fileURLToPath(new URL('..', import.meta.url)),
    list: { path: list, file: list },
    options: { target, limit: values.limit, validate: values.validate, ai: values.ai },
    environment: ai
      ? [
          'REFIT_AI_PROVIDER',
          'OPENAI_MODEL',
          'ANTHROPIC_MODEL',
          'OPENAI_REASONING_EFFORT',
          'REFIT_AI_BUDGET_USD',
        ]
      : [],
    allowDirty: values['allow-dirty'],
  }),
  { resume: values.resume },
);
const now = new Date();
const changesText = await readFile(DEFAULT_META_GRAPH_CHANGES, 'utf8');
// The change list grows as rules are reviewed; the summary says when it differs from the frozen one.
const changesSha256 = createHash('sha256').update(changesText).digest('hex');
const changes = await loadMetaGraphChanges(DEFAULT_META_GRAPH_CHANGES, now);
const registry = await loadDeadlineRegistry(undefined, now);
const recorded = new Set(changes.versions.map((record) => record.version));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];

// `refit run` on the repository, as a customer's worker runs it, and what it ended with.
async function validate(directory: string, work: string, before: string, version: string) {
  const { config, selection } = await writeMetaGraphRun({
    repository: directory,
    directory: work,
    before,
    target: version,
  });
  const bundle = join(work, 'run');
  try {
    await execute(
      process.execPath,
      [
        fileURLToPath(new URL('../bin/refit.mjs', import.meta.url)),
        'run',
        '--config',
        config,
        '--output',
        bundle,
        '--quiet',
        '--json',
        ...(values.ai ? ['--ai-patch', '--repair-attempts', String(repairAttempts)] : []),
      ],
      { env: CHILD_ENV, timeout: VALIDATION_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // Non-zero exits are recorded outcomes (needs-review, validation-failed, error).
  }
  const manifest = JSON.parse(
    await readFile(join(bundle, 'manifest.json'), 'utf8').catch(() => '{}'),
  );
  const report = JSON.parse((await readEvidence(bundle, 'report.json')) ?? '{}');
  return {
    status: String(manifest.status ?? 'missing-manifest'),
    ...(manifest.stage ? { stage: String(manifest.stage) } : {}),
    ...(manifest.reason ? { reason: String(manifest.reason) } : {}),
    ...(manifest.error?.message ? { error: String(manifest.error.message) } : {}),
    checks: selection.kind ?? 'none',
    ...(report.validation?.status ? { validation: String(report.validation.status) } : {}),
    ...(report.validation?.grade?.letter ? { grade: String(report.validation.grade.letter) } : {}),
    ...(report.validation?.metaGraph?.proof
      ? { proven: Boolean(report.validation.metaGraph.proof.proven) }
      : {}),
    unresolved: Number(report.patch?.unresolvedFindings ?? 0),
    ...(report.patch?.generator ? { generator: String(report.patch.generator) } : {}),
    ...(report.patch?.agent
      ? {
          agent: {
            outcome: String(report.patch.agent.outcome),
            costUsd: Number(report.patch.agent.costUsd ?? 0),
            errors: (report.patch.agent.errors ?? []).length,
          },
        }
      : {}),
    ...(report.metaGraph?.reconstructed?.length
      ? {
          reconstructed: report.metaGraph.reconstructed.filter(
            (item: { status: string }) => item.status === 'kept',
          ).length,
        }
      : {}),
    pullRequest: await readFile(join(bundle, 'pull-request.md'), 'utf8').then(
      () => true,
      () => false,
    ),
  };
}

for (const [index, entry] of repos.entries()) {
  if (finishedRow(previous[index], entry)) {
    results[index] = previous[index]!;
    continue;
  }
  const started = Date.now();
  const result: Record<string, unknown> = {
    repo: entry.repo,
    stars: entry.stars,
    commit: entry.commit,
  };
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const work = join(output, 'repos', entry.repo.replace('/', '__'));
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const checkout = await checkoutError(directory, entry.commit);
  if (checkout) result.error = `checkout: ${checkout}`;
  else
    try {
      const repository = await readRepository(directory, META_SDK);
      const spentBefore = await spentUsd();
      const reconstructions = ai
        ? await reconstructGraphCalls(
            repository.files,
            (await scanGraphCalls(directory, { repository })).calls,
            ai,
          )
        : [];
      const scan = await scanGraphCalls(directory, { repository, reconstructions });
      const proposal = await proposeVersionMoves(
        directory,
        target,
        changes,
        registry,
        now,
        reconstructions,
      );
      if (ai)
        result.ai = {
          scan: {
            sites: reconstructions.length,
            kept: reconstructions.filter((item) => item.status === 'kept').length,
            refused: reconstructions
              .filter((item) => item.status !== 'kept')
              .map((item) => `${item.file}:${item.line}: ${item.reason}`),
            costUsd: (await spentUsd()) - spentBefore,
          },
        };
      // The row's total, which benchmark-merge.mjs sums into the run's AI spend.
      if (ai) (result.ai as { costUsd: number }).costUsd = (await spentUsd()) - spentBefore;
      const { patch, ...row } = metaRow(scan, proposal);
      Object.assign(result, row, { patch: patch !== null });
      await writeFile(join(work, 'scan.json'), json(scan));
      await writeFile(join(work, 'proposal.json'), json(proposal));
      if (patch) await writeFile(join(work, 'moves.patch'), patch);
      // With AI, no stop ends a row: the agent fixer takes what the moves leave.
      if (values.validate && (patch || (ai && row.outcome === 'needs-review'))) {
        const runBefore = await spentUsd();
        result.workflow = await validate(
          directory,
          work,
          row.versions.find((version) => recorded.has(version)) ?? target,
          target,
        );
        if (ai) {
          const spent = await spentUsd();
          Object.assign(result.ai as object, {
            run: { costUsd: spent - runBefore },
            costUsd: spent - spentBefore,
          });
        }
      }
    } catch (error) {
      result.error = message(error);
    }
  result.seconds = Math.round((Date.now() - started) / 1000);
  Object.assign(result, classifyRow('meta-graph-results', result));
  result.result = metaResult(result);
  results[index] = result;
  console.error(
    `[${index + 1}/${repos.length}] ${entry.repo}: ${String(result.result)}${result.error ? ` (${String(result.error)})` : ''}`,
  );
  await writeFile(join(output, 'results.json'), json(results));
}
assertResults('meta-graph-results', results);
await writeFile(join(output, 'results.json'), json(results));
await writeFile(
  join(output, 'summary.md'),
  [
    `# Meta Graph benchmark: ${results.length} repositories, target ${target}`,
    '',
    changesSha256 === pinned.specs?.changes?.sha256
      ? 'Change list: as frozen with the list.'
      : `Change list: ${changesSha256}, not the frozen ${pinned.specs?.changes?.sha256 ?? 'unknown'}.`,
    '',
    summaryTable(results),
  ].join('\n'),
);
console.log(`Results: ${join(output, 'results.json')}`);

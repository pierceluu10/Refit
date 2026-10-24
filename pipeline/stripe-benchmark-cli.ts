import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
import { assessmentConfiguration } from './assessment.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { PASSING_REACH } from './operation-reach.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { measureCoverage } from './sdk-coverage.ts';
import {
  forkAtCommit,
  PUBLISH_BASE,
  repositoryAdapter,
  stripeOperations,
  summaryTable,
  workflowExitReason,
  workflowScanStop,
} from './stripe-benchmark.ts';
import { FieldSubstitutionError } from './substitution-guard.ts';
import { AiPolicyStop } from './ai-patches.ts';
import { githubAppConfiguration } from './github-app.ts';
import { publicationConfiguration, publishDraft } from './publication.ts';
import { PipelineInputError, type Repository } from './types.ts';
import { proposalReviewReason, scanReviewReason } from './workflow.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:stripe -- --root <benchmark-dir> --output <new-dir> [--resume] [--allow-dirty] [--env .env] [--ai] [--validate] [--offset N] [--limit N] [--concurrency N] [--stripe-package <dir>] [--publish <github-org> [--publish-unresolved]]';
const VALIDATION_IMAGE = 'node:22-alpine';
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1000;
// Unmapped oasdiff changes recorded per scan; multi-year jumps can report hundreds.
const MAX_RECORDED_CHANGES = 500;
// `file(line,col): error TSxxxx: message`, keyed without the position so moved lines still match.
const TYPE_ERROR = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;

function typeErrors(output: unknown) {
  return new Set(
    String(output ?? '')
      .split('\n')
      .map((line) => TYPE_ERROR.exec(line.trim()))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => `${match[1]} ${match[2]} ${match[3]}`),
  );
}

interface Selected {
  repo: string;
  stars: number;
  commit: string;
  before: string;
  beforeSource: string;
  stripeDependency: string;
  packageManager: string;
}

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    env: { type: 'string' },
    ai: { type: 'boolean' },
    validate: { type: 'boolean' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string' },
    split: { type: 'string' },
    publish: { type: 'string' },
    'publish-unresolved': { type: 'boolean' },
    // <dir>/<owner__repo> is the `types` directory of the stripe package that repository uses.
    'stripe-package': { type: 'string' },
    // What-if runs: every repository opts in to keep listed payment methods.
    'keep-listed-payment-methods': { type: 'boolean' },
    // Continue an interrupted run in the same --output; see docs/BENCHMARK-HARNESS.md.
    resume: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
  },
});
if (!values.root || !values.output) throw new PipelineInputError(USAGE);
if (values.publish && !values.validate)
  throw new PipelineInputError('--publish needs --validate: only validated runs are published.');
if (values.env) process.loadEnvFile(values.env);
// Copied after --env loads, so children get its keys. Benchmark runs never send Slack notices.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.REFIT_SLACK_WEBHOOK_URL;
const root = resolve(values.root);
const output = resolve(values.output);
const ai = values.ai ? assessmentConfiguration(true, process.env)! : undefined;
// --split labelled|heldOut restricts the run to the ground-truth or held-out repositories.
const split = values.split
  ? new Set(
      (JSON.parse(await readFile(join(root, 'split.json'), 'utf8')) as Record<string, string[]>)[
        values.split
      ] ?? [],
    )
  : undefined;
const selected = (JSON.parse(await readFile(join(root, 'selected.json'), 'utf8')) as Selected[])
  .filter((entry) => !split || split.has(entry.repo))
  // --offset and --limit select a slice, so one list can be split across processes.
  .slice(Number(values.offset ?? 0))
  .slice(0, values.limit ? Number(values.limit) : undefined);
const specs = JSON.parse(await readFile(join(root, 'needed-specs.json'), 'utf8')) as Array<{
  version: string;
}>;
const latest = specs
  .map((spec) => spec.version)
  .sort()
  .at(-1)!;
const sdkSpec = JSON.parse(
  await readFile(join(root, 'specs', `sdk-${latest}.json`), 'utf8'),
) as Record<string, unknown>;
const operationsByVersion = new Map<string, ReturnType<typeof stripeOperations>>();
// Pinned Stripe changelog pages, attached as AI vendor notes for the changes each repository hits.
const CHANGELOG = resolve('docs/benchmarks/stripe-changelog');
const changelogPages = (
  JSON.parse(await readFile(join(CHANGELOG, 'index.json'), 'utf8')) as {
    changes: Record<string, string>;
  }
).changes;
const productionFailures = new Map<string, string>();
// Every option but the paths that only locate inputs and outputs, and the harness's own flags.
const {
  root: _root,
  output: _output,
  env: _env,
  resume,
  'allow-dirty': allowDirty,
  ...options
} = values;
const { rows: previous } = await openRunDirectory(
  output,
  await startRun({
    format: 'stripe-results',
    refitRoot: fileURLToPath(new URL('..', import.meta.url)),
    list: { path: 'selected.json', file: join(root, 'selected.json') },
    options,
    environment: [
      'REFIT_VALIDATION_WORKSPACE',
      'REFIT_DEPENDENCY_TIMEOUT_SECONDS',
      ...(values.ai ? ['OPENAI_MODEL'] : []),
    ],
    ...(values.validate ? { image: VALIDATION_IMAGE } : {}),
    allowDirty,
  }),
  { resume },
);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];
// Saves [Needs review] artifacts for waivable stops (removed request parameters) instead of stopping.
const leaveRequestParameters = Boolean(values['publish-unresolved']) && !ai;
// The stop the workflow applies before running any repository code, as `refit run` decides it.
const scanStop = (scan: Awaited<ReturnType<typeof runPipeline>>) =>
  scanReviewReason(scan, Boolean(ai), leaveRequestParameters) ??
  proposalReviewReason(scan, Boolean(ai));

async function benchmark(entry: Selected, index: number) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const work = join(output, 'repos', entry.repo.replace('/', '__'));
  await mkdir(work, { recursive: true });
  const before = join(root, 'specs', `${entry.before}.json`);
  const after = join(root, 'specs', `${latest}.json`);
  const result: Record<string, unknown> = {
    repo: entry.repo,
    stars: entry.stars,
    commit: entry.commit,
    before: entry.before,
    beforeSource: entry.beforeSource,
    after: latest,
    packageManager: entry.packageManager,
  };
  results[index] = result;
  const log = (stage: string) =>
    console.error(`[${index + 1}/${selected.length}] ${entry.repo}: ${stage}`);
  const checkout = await checkoutError(directory, entry.commit);
  if (checkout) {
    result.infrastructure = { kind: 'clone', message: checkout };
    log(`clone failure: ${checkout}`);
    return;
  }
  // Seconds per harness stage, each measured from the end of the previous one.
  const stageSeconds: Record<string, number> = {};
  result.stageSeconds = stageSeconds;
  let lapStarted = Date.now();
  const lap = (stage: string) => {
    stageSeconds[stage] = Math.round((Date.now() - lapStarted) / 100) / 10;
    lapStarted = Date.now();
  };
  let repository: Repository;
  try {
    repository = await readRepository(directory, 'stripe');
    result.read = 'ok';
  } catch (error) {
    result.read = message(error);
    log('Refit cannot read repository');
    return;
  }
  lap('read');
  try {
    const sites = measureCoverage(repository, 'stripe').filter((site) => site.likelySdk);
    result.sdkCalls = sites.length;
    result.tracedCalls = sites.filter((site) => site.traced).length;
  } catch (error) {
    result.scanCrash = message(error);
    log('scanner crashed');
    return;
  }
  lap('coverage');
  if (!operationsByVersion.has(entry.before))
    operationsByVersion.set(
      entry.before,
      stripeOperations(sdkSpec, JSON.parse(await readFile(before, 'utf8'))),
    );
  const { adapter, calledMethods, mappedMethods } = repositoryAdapter(
    repository,
    operationsByVersion.get(entry.before)!,
  );
  result.calledMethods = calledMethods;
  result.mappedMethods = mappedMethods;
  const adapterPath = join(work, 'adapter.json');
  await writeFile(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`);
  const inputs = {
    repository: directory,
    before,
    after,
    apiVersion: entry.before,
    ...(values['stripe-package']
      ? { stripePackage: join(resolve(values['stripe-package']), entry.repo.replace('/', '__')) }
      : {}),
    ...(values['keep-listed-payment-methods'] ? { keepListedPaymentMethods: true } : {}),
  };
  const webhookFiles = new Set(
    repository.files
      .filter((file) => /webhooks\.constructEvent/.test(file.content))
      .map((file) => file.path),
  );
  result.webhookHandlers = webhookFiles.size;
  const summarize = (report: Awaited<ReturnType<typeof runPipeline>>) => ({
    status: report.status,
    removedFields: report.changes.length,
    confirmed: report.findings.filter((finding) => finding.confidence === 'confirmed').length,
    review: report.findings.filter((finding) => finding.confidence === 'review').length,
    findings: report.findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      property: finding.expression.replace(/^\??\./, ''),
      confidence: finding.confidence,
      // A signed-webhook payload read: the rule that migrates it, or `unmigrated`.
      ...(finding.webhook ? { webhook: finding.webhook.migration?.rule ?? 'unmigrated' } : {}),
    })),
    confirmedFields: [
      ...new Set(
        report.findings
          .filter((finding) => finding.confidence === 'confirmed')
          .map((finding) => report.changes.find((change) => change.id === finding.changeId))
          .map((change) => (change ? `${change.schema}.${change.property}` : undefined)),
      ),
    ].filter((field): field is string => Boolean(field)),
    affectedFields: [
      ...new Set(
        report.findings.map(
          (finding) => report.changes.find((change) => change.id === finding.changeId)?.pointer,
        ),
      ),
    ]
      .filter(Boolean)
      .map((pointer) =>
        String(pointer).replace('/components/schemas/', '').replace('/properties/', '.'),
      ),
    operationImpacts: report.operationImpacts.length,
    ...(report.operationImpacts.length
      ? {
          impacts: report.operationImpacts.map((impact) => ({
            operationId: impact.operationId,
            method: impact.httpMethod,
            path: impact.path,
            usages: impact.usages.map((usage) => `${usage.file}:${usage.line}`),
            changes: impact.changes.map(({ id, text, reachReason }) => ({
              id,
              text,
              ...(reachReason ? { reachReason } : {}),
            })),
          })),
        }
      : {}),
    ...(report.specificationDiff.engine === 'oasdiff'
      ? (() => {
          const unmapped = unmappedBreakingChanges(
            report.specificationDiff,
            report.changes,
            report.findings,
            report.operationChanges,
            report.requestChanges,
            report.expandedFields,
          ) as Record<string, unknown>[];
          return {
            unmappedChanges: unmapped.length,
            unmapped: unmapped.slice(0, MAX_RECORDED_CHANGES).map((change) => ({
              id: change.id,
              operation: change.operation,
              path: change.path,
              text: change.text,
              ...(change.reachReason ? { reachReason: change.reachReason } : {}),
            })),
            // Breaking changes the reach gate let through, by reach.
            passed: Object.fromEntries(
              [...PASSING_REACH].map((reach) => [
                String(reach),
                (report.specificationDiff.changes as Record<string, unknown>[]).filter(
                  (change) => change.reach === reach && Number(change.level) >= 2,
                ).length,
              ]),
            ),
          };
        })()
      : {}),
    reviewReasons: Object.fromEntries(
      Object.entries(
        report.findings
          .filter((finding) => finding.confidence === 'review')
          .reduce<Record<string, number>>((counts, finding) => {
            counts[finding.reason] = (counts[finding.reason] ?? 0) + 1;
            return counts;
          }, {}),
      ).sort(([left], [right]) => left.localeCompare(right)),
    ),
    webhookFileFindings: report.findings.filter((finding) => webhookFiles.has(finding.file)).length,
    apiVersion: report.apiVersion.applicability,
  });
  try {
    result.shippedAdapter = summarize(await runPipeline(inputs));
  } catch (error) {
    result.shippedAdapter = { error: message(error) };
  }
  lap('shippedAdapter');
  // What a customer's hosted run sees before validation: the built-in adapter with the full
  // contract diff, which workers default to.
  try {
    const scan = await runPipeline({
      ...inputs,
      fullDiff: true,
      proposePatch: true,
      leaveRequestParameters,
    });
    result.customerMode = { ...summarize(scan), stop: scanStop(scan) ?? null };
  } catch (error) {
    result.customerMode = { error: message(error) };
  }
  lap('customerMode');
  if (!mappedMethods) {
    log('no mapped Stripe methods');
    return;
  }
  try {
    result.fullAdapter = summarize(await runPipeline({ ...inputs, providerConfig: adapterPath }));
  } catch (error) {
    result.fullAdapter = { error: message(error) };
    log('full-adapter scan failed');
    return;
  }
  lap('fullAdapter');
  // The oasdiff comparison depends only on the contract pair; a failure applies to every
  // repository on the same before version, so it is attempted once per version. A timeout depends
  // on machine load, not the pair, so it is not reused. A reused failure is recorded exactly like
  // the first, so a row does not depend on which repository --concurrency reached first.
  const failed = productionFailures.get(entry.before);
  if (failed) result.productionMode = { error: failed };
  else
    try {
      const scan = await runPipeline({
        ...inputs,
        providerConfig: adapterPath,
        fullDiff: true,
        proposePatch: true,
        leaveRequestParameters,
      });
      result.productionMode = { ...summarize(scan), stop: scanStop(scan) ?? null };
    } catch (error) {
      if (!/time limit/.test(message(error))) productionFailures.set(entry.before, message(error));
      result.productionMode = { error: message(error) };
    }
  lap('productionMode');
  const full = result.fullAdapter as { confirmed: number; confirmedFields: string[] };
  const production = result.productionMode as { error?: string; stop?: string | null };
  const notes = [
    ...new Set(full.confirmedFields?.map((field) => changelogPages[field]).filter(Boolean)),
  ].map((page) => join(CHANGELOG, page));
  result.changelogNotes = notes.map((path) => path.slice(CHANGELOG.length + 1));
  if (!full.confirmed) {
    log('not affected');
    return;
  }
  const manifest = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const testScript: unknown = manifest.scripts?.test;
  const hasTests = typeof testScript === 'string' && !PLACEHOLDER_TEST.test(testScript);
  const typescript = existsSync(join(directory, 'tsconfig.json')) && Boolean(declared.typescript);
  // Root npm, pnpm or Yarn projects with stripe can be prepared for checks; others are
  // proposal-only. Refit's own preparation refuses layouts it does not support, and that is recorded.
  const pnpm = existsSync(join(directory, 'pnpm-lock.yaml'));
  const yarn = existsSync(join(directory, 'yarn.lock'));
  const checkable =
    (existsSync(join(directory, 'package-lock.json')) || pnpm || yarn) && Boolean(declared.stripe);
  result.validatable = checkable && hasTests;
  result.checks = !checkable
    ? 'none'
    : hasTests
      ? 'tests'
      : typescript
        ? 'typecheck'
        : 'generated-only';
  if (values.validate && checkable) {
    const fixtures = (version: string) => join(root, 'fixtures', `${version}.json`);
    const generatedChecks =
      existsSync(fixtures(entry.before)) && existsSync(fixtures(latest))
        ? {
            stripeMockImage: 'stripe/stripe-mock:latest',
            beforeFixtures: fixtures(entry.before),
            afterFixtures: fixtures(latest),
          }
        : undefined;
    // Without tests, TypeScript repositories typecheck; compareTypeErrors fails the patched check
    // only on errors the patch introduced, which then go to AI repair.
    const command = hasTests
      ? [pnpm ? 'pnpm' : yarn ? 'yarn' : 'npm', 'test']
      : typescript
        ? ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false', '-p', '.']
        : // Refit refuses empty command arguments, so the no-op evaluates `0`.
          ['node', '-e', '0'];
    const config = join(work, 'run.json');
    // A customer's worker runs the full contract diff. When it stops before validation, the
    // workflow runs without it (benchmark mode) to measure what the rules alone would do; when it
    // does not stop, the diff adds nothing else, so the workflow below is the customer's run.
    const productionPasses = !production.error && !production.stop;
    await writeFile(
      config,
      `${JSON.stringify({ formatVersion: 1, repository: directory, apiVersion: entry.before, before, after, providerConfig: adapterPath, image: VALIDATION_IMAGE, prepareDependencies: true, command, ...(productionPasses ? { fullDiff: true } : {}), ...(result.checks === 'typecheck' ? { compareTypeErrors: true } : {}), ...(generatedChecks ? { generatedChecks } : {}), ...(values['keep-listed-payment-methods'] ? { stripePaymentMethodTypes: 'keep-listed' } : {}) }, null, 2)}\n`,
    );
    const bundle = join(work, 'run');
    // Scan-stage stops run no repository code, so `refit run` starts only for repositories past them.
    const stop = await workflowScanStop(
      {
        repository: directory,
        before,
        after,
        apiVersion: entry.before,
        providerConfig: adapterPath,
        ...(values['keep-listed-payment-methods'] ? { keepListedPaymentMethods: true } : {}),
      },
      Boolean(ai),
      leaveRequestParameters,
    );
    lap('workflowScan');
    let exit: string | undefined;
    if (!stop) {
      const validationStarted = Date.now();
      try {
        await execute(
          process.execPath,
          [
            resolve('bin/refit.mjs'),
            'run',
            '--config',
            config,
            '--output',
            bundle,
            ...(ai
              ? [
                  '--ai-patch',
                  ...notes.flatMap((path) => ['--documentation-snapshot', path]),
                  '--repair-attempts',
                  '1',
                ]
              : []),
            // Saves [Needs review] artifacts for waivable stops so they can be published below.
            ...(values['publish-unresolved'] ? ['--publish-unresolved'] : []),
            '--quiet',
            '--json',
          ],
          { env: CHILD_ENV, timeout: VALIDATION_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (error) {
        // Non-zero exits are recorded outcomes (needs-review, validation-failed, error).
        exit = workflowExitReason(error, VALIDATION_TIMEOUT_MS);
      }
      result.validationSeconds = Math.round((Date.now() - validationStarted) / 1000);
      lap('workflow');
    }
    const outcome = stop
      ? { status: 'needs-review', stage: 'scan', reason: stop }
      : JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8').catch(() => '{}'));
    const report = stop
      ? {}
      : JSON.parse(await readFile(join(bundle, 'report.json'), 'utf8').catch(() => '{}'));
    const generated = report.validation?.generated;
    result.workflow = {
      status: outcome.status ?? 'missing-manifest',
      stage: outcome.stage,
      reason: outcome.reason,
      error: outcome.status ? outcome.error?.message : exit,
      checks: result.checks,
      patch: report.patch?.status,
      generator: report.patch?.generator,
      summary: report.patch?.summary,
      unresolvedFindings: report.patch?.unresolvedFindings,
      sdkUpgrade: report.patch?.sdkUpgrade,
      validation: report.validation?.status,
      baseline: report.validation?.baseline?.status,
      patched: report.validation?.patched?.status,
      ...(result.checks === 'typecheck' && report.validation?.patched
        ? {
            typeErrors: {
              baseline: typeErrors(report.validation.baseline?.stdout).size,
              patched: typeErrors(report.validation.patched.stdout).size,
              introduced: [...typeErrors(report.validation.patched.stdout)].filter(
                (error) => !typeErrors(report.validation.baseline?.stdout).has(error),
              ),
            },
          }
        : {}),
      ...(generated
        ? {
            generated: {
              baseline: generated.baseline?.status,
              patched: generated.patched?.status,
              entryPoints: generated.entryPoints?.length ?? 0,
              uncoveredFindings: generated.uncoveredFindings?.length ?? 0,
            },
          }
        : {}),
      repairAttempts: report.validation?.repair?.requested ?? 0,
      aiCostUsd: report.patch?.budget?.costUsd,
      diff: report.patch?.diff?.slice(0, 8000),
      pullRequest: existsSync(join(bundle, 'pull-request.md')),
    };
    const workflow = result.workflow as Record<string, unknown>;
    workflow.fullDiff = productionPasses;
    result.production = production.error
      ? { status: 'error', stage: 'scan', error: production.error }
      : production.stop
        ? { status: 'needs-review', stage: 'scan', reason: production.stop }
        : {
            status: workflow.status,
            stage: workflow.stage,
            reason: workflow.reason,
            error: workflow.error,
            validation: workflow.validation,
          };
    log(
      `workflow ${String(workflow.status)}, production ${String((result.production as { status: string }).status)}`,
    );
    // publishDraft decides which untested reports --publish-unresolved may publish.
    if (
      values.publish &&
      (report.validation?.status === 'passed' ||
        (values['publish-unresolved'] && report.validation?.status === 'untested'))
    )
      try {
        const fork = await forkAtCommit(
          values.publish,
          entry.repo,
          entry.commit,
          process.env.GITHUB_TOKEN,
        );
        const published = await publishDraft(report, {
          ...publicationConfiguration(
            fork,
            PUBLISH_BASE,
            undefined,
            githubAppConfiguration(process.env),
          ),
          ...(values['publish-unresolved'] ? { allowUnresolved: true } : {}),
        });
        result.publication = published;
        log(`published ${String((published as { url?: string }).url ?? published.status)}`);
      } catch (error) {
        result.publication = { status: 'error', error: message(error) };
        log(`publication error: ${message(error)}`);
      }
  } else if (!ai) {
    log(`affected (${full.confirmed} usages), AI not requested`);
    return;
  } else {
    try {
      const report = await runPipeline({
        ...inputs,
        providerConfig: adapterPath,
        aiPatch: ai,
        documentationSnapshots: notes,
      });
      const patch = report.patch as {
        status: string;
        edits?: number;
        summary?: string;
        diff?: string;
      };
      if (patch.diff) await writeFile(join(work, 'proposal.patch'), patch.diff);
      result.ai = {
        outcome: patch.edits
          ? 'proposed'
          : patch.status === 'not-generated'
            ? 'blocked'
            : 'declined',
        generator: (patch as { generator?: string }).generator,
        reason: (patch as { reason?: string }).reason,
        costUsd: (patch as { budget?: { costUsd?: number } }).budget?.costUsd,
        summary: patch.summary,
        diff: patch.diff?.slice(0, 4000),
      };
    } catch (error) {
      result.ai = {
        outcome:
          error instanceof FieldSubstitutionError || error instanceof AiPolicyStop
            ? 'rejected-by-guard'
            : 'error',
        detail: message(error),
      };
    }
    log(`AI ${String((result.ai as { outcome: string }).outcome)}`);
  }
}
// Repositories are independent; each validation container may use up to 3 GiB, so keep this
// within the Docker host's memory (2 on an 8 GiB host).
const concurrency = Math.max(1, Number(values.concurrency ?? 1));
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      const entry = selected[index];
      if (finishedRow(previous[index], entry)) {
        results[index] = previous[index]!;
        console.error(`[${index + 1}/${selected.length}] ${entry.repo}: finished before resuming`);
        continue;
      }
      // Evidence an interrupted attempt left for this repository is replaced, not mixed in.
      if (previous.length)
        await rm(join(output, 'repos', entry.repo.replace('/', '__')), {
          recursive: true,
          force: true,
        });
      // Timed here so early returns (not affected, unreadable) are measured too.
      const started = Date.now();
      await benchmark(entry, index);
      results[index].seconds = Math.round((Date.now() - started) / 1000);
      Object.assign(results[index], classifyRow('stripe-results', results[index]));
      await writeFile(join(output, 'results.json'), json(results));
    }
  }),
);
assertResults('stripe-results', results);
await writeFile(join(output, 'results.json'), json(results));
await writeFile(join(output, 'summary.md'), summaryTable(results));
console.log(`Results: ${join(output, 'results.json')}`);
console.log(`Summary: ${join(output, 'summary.md')}`);

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
import { selectCheck, ungradedEvidence } from './check-selection.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { PASSING_REACH } from './operation-reach.ts';
import { sdkPackageDirectory } from './preparation-packages.ts';
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
  workflowScan,
} from './stripe-benchmark.ts';
import { FieldSubstitutionError } from './substitution-guard.ts';
import { validationProfile } from './docker-sandbox.ts';
import { lockfileResolutionEnabled } from './lockfile-resolution.ts';
import { HOSTED_REPAIR_ATTEMPTS, validateRepairAttempts } from './validation-options.ts';
import { AiPolicyStop } from './ai-patches.ts';
import { stripeTestMode } from './stripe-test-mode.ts';
import { behaviourTestSkip, DRY_RUN_MODEL } from './behaviour-test-writer.ts';
import { githubAppConfiguration } from './github-app.ts';
import {
  publicationConfiguration,
  publicationWaiver,
  publishDraft,
  publishUnresolved,
} from './publication.ts';
import { PipelineInputError, type Repository } from './types.ts';
import { typeErrorKeys } from './type-errors.ts';
import { proposalReviewReason, scanReviewReason } from './workflow.ts';
import { readEvidence } from './state-files.ts';
import { NO_OP_CHECK } from './review.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:stripe -- --root <benchmark-dir> --output <new-dir> [--resume] [--allow-dirty] [--env .env] [--ai [--repair-attempts 0-4] [--ai-effort low|medium|high|xhigh|max]] [--behaviour-tests [--stripe-test-mode] | --behaviour-tests-dry-run | --no-behaviour-tests] [--validate] [--offset N] [--limit N] [--concurrency N] [--stripe-package <dir>] [--validation-workspace 4g|2g|1g|512m] [--resolve-lockfiles] [--publish <github-org>] [--publish-unresolved | --publish-validated-only]';
const VALIDATION_IMAGE = 'node:22-alpine';
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1000;
// Unmapped oasdiff changes recorded per scan; multi-year jumps can report hundreds.
const MAX_RECORDED_CHANGES = 500;
const reportedTypeErrorKeys = (check: { stdout?: string; stderr?: string } | undefined) =>
  typeErrorKeys({ stdout: check?.stdout ?? '', stderr: check?.stderr ?? '' });

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
    // Defaults with --ai to what the hosted worker runs (HOSTED_REPAIR_ATTEMPTS).
    'repair-attempts': { type: 'string' },
    // Writes behaviour tests during validation with one model request per repository; it needs
    // --env with OPENAI_API_KEY and OPENAI_MODEL and never turns on AI patches.
    'behaviour-tests': { type: 'boolean' },
    // Builds each behaviour-test request without sending it, and records per repository whether
    // the real run would send it, why not, and its estimated tokens and cost. No key needed.
    'behaviour-tests-dry-run': { type: 'boolean' },
    // Runs the behaviour tests against Stripe test mode with STRIPE_TEST_KEY (provider-sandbox.ts).
    'stripe-test-mode': { type: 'boolean' },
    // --ai writes behaviour tests with the same model by default; this turns them off.
    'no-behaviour-tests': { type: 'boolean' },
    // OPENAI_REASONING_EFFORT for every AI request (low, medium, high, xhigh or max).
    'ai-effort': { type: 'string' },
    validate: { type: 'boolean' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string' },
    split: { type: 'string' },
    publish: { type: 'string' },
    'publish-unresolved': { type: 'boolean' },
    'publish-validated-only': { type: 'boolean' },
    // <dir>/<owner__repo> is the `types` directory of the stripe package that repository uses.
    'stripe-package': { type: 'string' },
    // What-if runs: every repository opts in to keep listed payment methods.
    'keep-listed-payment-methods': { type: 'boolean' },
    // Continue an interrupted run in the same --output; see docs/BENCHMARK-HARNESS.md.
    resume: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
    // Sandbox profile for every repository (REFIT_VALIDATION_WORKSPACE), e.g. 4g on a large runner.
    'validation-workspace': { type: 'string' },
    // Resolves refused or missing npm lockfiles for validation (REFIT_LOCKFILE_RESOLUTION=on).
    'resolve-lockfiles': { type: 'boolean' },
  },
});
if (!values.root || !values.output) throw new PipelineInputError(USAGE);
if (values.publish && !values.validate)
  throw new PipelineInputError('--publish needs --validate: only validated runs are published.');
if (values.ai) values['repair-attempts'] ??= String(HOSTED_REPAIR_ATTEMPTS);
const repairAttempts = validateRepairAttempts(
  Number(values['repair-attempts'] ?? 0),
  Boolean(values.ai),
);
if (values.env) process.loadEnvFile(values.env);
if (values['ai-effort']) process.env.OPENAI_REASONING_EFFORT = values['ai-effort'];
if (values['validation-workspace']) {
  validationProfile(values['validation-workspace']);
  process.env.REFIT_VALIDATION_WORKSPACE = values['validation-workspace'];
}
if (values['resolve-lockfiles']) process.env.REFIT_LOCKFILE_RESOLUTION = 'on';
if (values['behaviour-tests'] && (!values.env || !values.validate))
  throw new PipelineInputError(
    '--behaviour-tests needs --validate and --env with OPENAI_API_KEY and OPENAI_MODEL.',
  );
// Fails before any repository runs when the key or model is missing.
if (values['behaviour-tests']) assessmentConfiguration(true, process.env);
if (values['behaviour-tests-dry-run'] && (!values.validate || values['behaviour-tests']))
  throw new PipelineInputError(
    '--behaviour-tests-dry-run needs --validate and replaces --behaviour-tests.',
  );
const writer = values['behaviour-tests'] || values['behaviour-tests-dry-run'];
// Refuses a missing, live or malformed STRIPE_TEST_KEY before any repository runs.
stripeTestMode(values['stripe-test-mode'], values['behaviour-tests']);
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
      // Rows may then carry baseline results an earlier run recorded (workflow.baselineReused).
      'REFIT_BASELINE_CHECK_CACHE_DIRECTORY',
      ...(values.ai || writer
        ? [
            'OPENAI_MODEL',
            'OPENAI_REASONING_EFFORT',
            'OPENAI_ESCALATION_MODEL',
            'OPENAI_ESCALATION_EFFORT',
          ]
        : []),
    ],
    ...(values.validate ? { image: VALIDATION_IMAGE } : {}),
    allowDirty,
  }),
  { resume },
);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];
// Owner decision 1: the workflow's stops become [Needs review] drafts, as `refit run` does, unless
// --publish-validated-only.
const leaveReviewedFindings = publishUnresolved(values);
// The stop the workflow applies before running any repository code, as `refit run` decides it.
const scanStop = (scan: Awaited<ReturnType<typeof runPipeline>>) =>
  scanReviewReason(scan, Boolean(ai), leaveReviewedFindings) ??
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
      leaveReviewedFindings,
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
  let fullReport: Awaited<ReturnType<typeof runPipeline>>;
  try {
    fullReport = await runPipeline({ ...inputs, providerConfig: adapterPath });
    result.fullAdapter = summarize(fullReport);
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
        leaveReviewedFindings,
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
  // Stripe code in one nested package with its own lockfile is prepared and checked there, with
  // that package's own checks, as validation does (pipeline/preparation-packages.ts).
  const packageDirectory = sdkPackageDirectory(fullReport, (path) =>
    existsSync(join(directory, path)),
  );
  if (packageDirectory) result.packageDirectory = packageDirectory;
  const checkRoot = join(directory, packageDirectory ?? '');
  const manifest = JSON.parse(
    await readFile(join(checkRoot, 'package.json'), 'utf8').catch(() => '{}'),
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  // Root npm, pnpm or Yarn projects with stripe can be prepared for checks; others are
  // proposal-only. Refit's own preparation refuses layouts it does not support, and that is recorded.
  // A bun.lock is installed through its npm translation (bun-lock.ts).
  const locked = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'].some((lockfile) =>
    existsSync(join(checkRoot, lockfile)),
  );
  const checkable = (locked || lockfileResolutionEnabled()) && Boolean(declared.stripe);
  // Owner decision 1: a project that commits no lockfile runs the workflow as a customer's generated
  // configuration does; preparation refuses, and the patch is kept untested, graded D.
  const unlocked = !locked && Boolean(declared.stripe);
  // The check a customer's generated configuration runs (pipeline/check-selection.ts). Without one,
  // the patch is still proposed and graded D.
  const selection = await selectCheck(repository, packageDirectory);
  result.checkSelection = {
    kind: selection.kind,
    ...(selection.typeCheck ? { typeCheck: selection.typeCheck } : {}),
    reason: selection.reason,
    stripeFiles: selection.stripeFiles.length,
    testedStripeFiles: selection.testedStripeFiles.length,
    typeCheckedStripeFiles: selection.typeCheckedStripeFiles.length,
  };
  result.validatable = checkable && Boolean(selection.command);
  result.checks = !checkable ? 'none' : (selection.kind ?? 'generated-only');
  if (values.validate && (checkable || unlocked)) {
    const fixtures = (version: string) => join(root, 'fixtures', `${version}.json`);
    const generatedChecks =
      existsSync(fixtures(entry.before)) && existsSync(fixtures(latest))
        ? {
            stripeMockImage: 'stripe/stripe-mock:latest',
            beforeFixtures: fixtures(entry.before),
            afterFixtures: fixtures(latest),
          }
        : undefined;
    // compareTypeErrors fails a patched type check only on errors the patch introduced, which then
    // go to AI repair.
    const command = checkable ? selection.command : (selection.command ?? NO_OP_CHECK.split(' '));
    const config = join(work, 'run.json');
    // A customer's worker runs the full contract diff. When it stops before validation, the
    // workflow runs without it (benchmark mode) to measure what the rules alone would do; when it
    // does not stop, the diff adds nothing else, so the workflow below is the customer's run.
    const productionPasses = !production.error && !production.stop;
    await writeFile(
      config,
      `${JSON.stringify({ formatVersion: 1, repository: directory, apiVersion: entry.before, before, after, providerConfig: adapterPath, image: VALIDATION_IMAGE, prepareDependencies: true, command, ...(productionPasses ? { fullDiff: true } : {}), ...(selection.compareTypeErrors ? { compareTypeErrors: true } : {}), ...(generatedChecks ? { generatedChecks } : {}), ...(values['keep-listed-payment-methods'] ? { stripePaymentMethodTypes: 'keep-listed' } : {}) }, null, 2)}\n`,
    );
    const bundle = join(work, 'run');
    // Scan-stage stops run no repository code, so `refit run` starts only for repositories past them.
    const scan = await workflowScan(
      {
        repository: directory,
        before,
        after,
        apiVersion: entry.before,
        providerConfig: adapterPath,
        ...(values['keep-listed-payment-methods'] ? { keepListedPaymentMethods: true } : {}),
      },
      Boolean(ai),
      leaveReviewedFindings,
    );
    const stop = scan.stop;
    // A repository with no check keeps its patch, graded D, for a [Needs review] draft.
    const noCheck = !stop && !command;
    lap('workflowScan');
    let exit: string | undefined;
    if (!stop && command) {
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
                  String(repairAttempts),
                ]
              : []),
            ...(values['behaviour-tests']
              ? ['--write-behaviour-tests']
              : values['behaviour-tests-dry-run']
                ? ['--write-behaviour-tests-dry-run']
                : values['no-behaviour-tests']
                  ? ['--no-behaviour-tests']
                  : []),
            ...(values['stripe-test-mode'] ? ['--stripe-test-mode'] : []),
            ...(leaveReviewedFindings ? [] : ['--publish-validated-only']),
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
    // The full patch, which the row truncates, stays in the run's artifact like a workflow's scan.
    if (noCheck && scan.patch) {
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, 'scan.json'), json({ patch: scan.patch }));
    }
    const outcome = stop
      ? { status: 'needs-review', stage: 'scan', reason: stop }
      : noCheck
        ? scan.patch
          ? {
              status: 'needs-review',
              stage: 'checks',
              reason: `No check can run, so the patch is kept as grade D. ${selection.reason}`,
            }
          : { status: 'error', stage: 'scan', error: { message: scan.error } }
        : JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8').catch(() => '{}'));
    const report = stop
      ? {}
      : noCheck
        ? { patch: scan.patch, validation: { grade: ungradedEvidence(selection.reason) } }
        : JSON.parse((await readEvidence(bundle, 'report.json')) ?? '{}');
    const generated = report.validation?.generated;
    result.workflow = {
      status: outcome.status ?? 'missing-manifest',
      stage: outcome.stage,
      reason: outcome.reason,
      error: outcome.status ? outcome.error?.message : exit,
      waivedGates: outcome.waivedGates,
      checks: result.checks,
      patch: report.patch?.status,
      generator: report.patch?.generator,
      summary: report.patch?.summary,
      unresolvedFindings: report.patch?.unresolvedFindings,
      sdkUpgrade: report.patch?.sdkUpgrade,
      validation: report.validation?.status,
      packageDirectory: report.validation?.packageDirectory,
      baseline: report.validation?.baseline?.status,
      ...(report.validation?.baselineReused ? { baselineReused: true } : {}),
      patched: report.validation?.patched?.status,
      grade: report.validation?.grade,
      behaviourTestWriter: report.validation?.behaviourTestWriter,
      stripeOnly: report.validation?.stripeOnly,
      advisoryTypeErrors: report.validation?.advisoryTypeErrors?.length,
      typeCheckUnavailable: report.validation?.typeCheckUnavailable,
      ...(report.validation?.typeOracle
        ? {
            typeOracle: {
              ...report.validation.typeOracle,
              ...Object.fromEntries(
                (['unpatched', 'patched'] as const).map((side) => {
                  const comparison = report.validation!.typeOracle![side];
                  return [
                    side,
                    comparison.status === 'compared'
                      ? {
                          status: comparison.status,
                          count: comparison.introduced.length,
                          introduced: comparison.introduced.slice(0, MAX_RECORDED_CHANGES),
                        }
                      : comparison,
                  ];
                }),
              ),
            },
          }
        : {}),
      ...(report.validation?.dependencyFailure
        ? {
            dependencyFailure: {
              reason: report.validation.dependencyFailure.reason,
              message: String(report.validation.dependencyFailure.message ?? '').slice(0, 500),
            },
          }
        : {}),
      baselineStop: report.validation?.baselineStop?.reason,
      checkErrors: {
        baseline: report.validation?.baseline?.error,
        patched: report.validation?.patched?.error,
      },
      checkFailures: report.validation?.checkFailures,
      timings: report.validation?.timings,
      ...(report.validation?.compareTypeErrors && report.validation?.patched
        ? {
            typeErrors: {
              baseline: reportedTypeErrorKeys(report.validation.baseline).size,
              patched: reportedTypeErrorKeys(report.validation.patched).size,
              introduced: [...reportedTypeErrorKeys(report.validation.patched)].filter(
                (error) => !reportedTypeErrorKeys(report.validation.baseline).has(error),
              ),
            },
          }
        : {}),
      ...(generated
        ? {
            generated: {
              status: generated.status,
              reason: generated.reason,
              baseline: generated.baseline?.status,
              patched: generated.patched?.status,
              entryPoints: generated.entryPoints?.length ?? 0,
              ran: generated.ran,
              uncoveredFindings: generated.uncoveredFindings ?? 0,
              // Per-function errors, so a run's results say why functions could not run.
              notRunnable: generated.notRunnable,
              unavailableEntries: generated.unavailableEntries,
              regressions: generated.regressions,
            },
          }
        : {}),
      ...(report.validation?.behaviour
        ? {
            behaviour: {
              status: report.validation.behaviour.status,
              grade: report.validation.behaviour.grade,
              missing: report.validation.behaviour.missing,
              regressions: report.validation.behaviour.regressions,
              tests: report.validation.behaviour.tests,
              ...(report.validation.behaviour.target
                ? { target: report.validation.behaviour.target }
                : {}),
              ...(report.validation.behaviour.dropped?.length
                ? { dropped: report.validation.behaviour.dropped }
                : {}),
              ...(report.validation.behaviour.sandbox
                ? { sandbox: report.validation.behaviour.sandbox }
                : {}),
            },
          }
        : {}),
      repairAttempts: report.validation?.repair?.requested ?? 0,
      // Why repair stopped early, such as an AI policy stop; a first-request stop is `error`.
      ...(report.validation?.repair?.error ? { repairError: report.validation.repair.error } : {}),
      // Every AI request of the run, refused and repair requests included.
      aiCostUsd: report.validation?.aiCostUsd ?? report.patch?.budget?.costUsd,
      // Founder decision (2026-10-28): untraced reads proven not to read a Stripe object.
      ...(report.validation?.localReads ? { localReads: report.validation.localReads } : {}),
      ...(report.validation?.coverageAi
        ? {
            coverageAi: {
              outcome: report.validation.coverageAi.outcome,
              costUsd: report.validation.coverageAi.costUsd,
              targets: report.validation.coverageAi.targets,
              resolved: report.validation.coverageAi.resolved,
              error: report.validation.coverageAi.error,
              response: report.validation.coverageAi.response,
              repair: report.validation.coverageAi.repair?.stopReason,
              // Owner decision D2: whether the kept proposal publishes validated, and why not.
              gate: report.validation.coverageAi.gate,
              localReads: report.validation.coverageAi.localReads,
              // The proposal its checks refused, which the result leaves out.
              diff: report.validation.coverageAi.attempts?.at(-1)?.diff?.slice(0, 8000),
              check: report.validation.coverageAi.attempts?.at(-1)?.check?.status,
            },
          }
        : {}),
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
    // publicationWaiver decides which reports owner decision 1 publishes unvalidated.
    if (
      values.publish &&
      report.validation &&
      (report.validation.status === 'passed' || publicationWaiver(report, leaveReviewedFindings))
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
          ...(leaveReviewedFindings ? { allowUnresolved: true } : {}),
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
// A row the writer never reached says why, so a dry run accounts for every repository.
function writerSkip(row: Record<string, unknown>) {
  const workflow = row.workflow as Record<string, unknown> | undefined;
  if (workflow?.behaviourTestWriter) return;
  const confirmed = (row.fullAdapter as { confirmed?: number } | undefined)?.confirmed;
  const reason = row.infrastructure
    ? 'The repository could not be cloned.'
    : row.read !== 'ok'
      ? 'Refit could not read the repository.'
      : row.scanCrash
        ? 'The scanner crashed.'
        : !row.mappedMethods
          ? 'No Stripe method is mapped.'
          : !confirmed
            ? 'No confirmed finding.'
            : workflow?.stage === 'scan'
              ? `The workflow stops at the scan: ${String(workflow.reason)}`
              : workflow
                ? `Validation ended before behaviour tests: ${String(workflow.error ?? workflow.reason ?? workflow.status)}`
                : row.checks === 'none'
                  ? 'There is no root lockfile that declares stripe, so validation does not run.'
                  : 'There is no test script or type check, so validation does not run.';
  const record = behaviourTestSkip(
    values['behaviour-tests-dry-run'] ? { model: DRY_RUN_MODEL, dryRun: true } : undefined,
    reason,
  );
  if (workflow) workflow.behaviourTestWriter = record;
  else row.behaviourTestWriter = record;
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
      if (writer) writerSkip(results[index]);
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

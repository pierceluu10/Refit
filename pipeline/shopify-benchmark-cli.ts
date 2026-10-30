import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { assessmentConfiguration } from './assessment.ts';
import { lockfileResolutionEnabled } from './lockfile-resolution.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { scanShopify, SHOPIFY_PACKAGES } from './shopify-analysis.ts';
import { lockedShopifyApi } from './shopify-pipeline.ts';
import {
  enumFromVersion,
  latestApiVersion,
  SHOPIFY_API_ENUM_SINCE,
  sdkHasEnumMember,
} from './shopify-versions.ts';
import { readEvidence } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { HOSTED_REPAIR_ATTEMPTS } from './validation-options.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:shopify -- --root <benchmark-dir> --output <new-dir> [--resume] [--allow-dirty] [--list <frozen.json>] [--env .env] [--ai] [--validate [--assess (AI second opinion, OPENAI_API_KEY)]] [--sdk-upgrade] [--limit N] [--concurrency N]';
const PINNED = 'docs/benchmarks/2026-10-16-shopify-repos.json';
const VALIDATION_IMAGE = 'node:22-alpine';
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1000;
const CODEGEN_CONFIG = /(?:^|\/)\.graphqlrc\.[cm]?[jt]s$/;
const SDK_LIMIT = /first ships in|LATEST_API_VERSION is/;
const LOCKFILE_MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
] as const;

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    list: { type: 'string' },
    validate: { type: 'boolean' },
    assess: { type: 'boolean' },
    // Loaded before anything runs: OPENAI_API_KEY, OPENAI_MODEL and the run's AI ledger
    // (REFIT_AI_BUDGET_USD, REFIT_AI_BUDGET_DIRECTORY), shared by the scan and every child run.
    env: { type: 'string' },
    // AI on every Shopify path: document rewrites and reconstructions, REST mappings, repair of
    // patches that break the build (HOSTED_REPAIR_ATTEMPTS) and the second opinion.
    ai: { type: 'boolean' },
    'sdk-upgrade': { type: 'boolean' },
    limit: { type: 'string' },
    concurrency: { type: 'string' },
    // Continue an interrupted run in the same --output; see docs/BENCHMARK-HARNESS.md.
    resume: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
  },
});
if (!values.root || !values.output) throw new PipelineInputError(USAGE);
if (values.env) process.loadEnvFile(values.env);
// Fails before any repository runs when the key or model is missing. One ledger caps the run;
// there is no per-repository cap.
const ai = assessmentConfiguration(values.ai, process.env);
// Copied after --env loads, so children get its keys. Benchmark runs never send Slack notices.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.REFIT_SLACK_WEBHOOK_URL;
const root = resolve(values.root);
const output = resolve(values.output);
const list = values.list ?? PINNED;
const pinned = JSON.parse(await readFile(list, 'utf8')) as {
  repos: { repo: string; stars: number; commit: string }[];
  schemas: { versions: { version: string }[] };
};
// Supported versions with a pinned schema, oldest first; Shopify serves older pins as the first.
const versions = pinned.schemas.versions.map((entry) => entry.version).sort();
const repos = pinned.repos.slice(0, values.limit ? Number(values.limit) : undefined);
const snapshot = (version: string) => join(root, 'snapshots', `${version}.json`);
const { rows: previous } = await openRunDirectory(
  output,
  await startRun({
    format: 'shopify-results',
    refitRoot: fileURLToPath(new URL('..', import.meta.url)),
    list: { path: list, file: list },
    options: {
      validate: values.validate,
      ai: values.ai,
      sdkUpgrade: values['sdk-upgrade'],
      limit: values.limit,
      concurrency: values.concurrency,
    },
    environment: [
      'REFIT_VALIDATION_WORKSPACE',
      'REFIT_DEPENDENCY_TIMEOUT_SECONDS',
      ...(ai ? ['OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'REFIT_AI_BUDGET_USD'] : []),
    ],
    ...(values.validate ? { image: VALIDATION_IMAGE } : {}),
    allowDirty: values['allow-dirty'],
  }),
  { resume: values.resume },
);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];

async function benchmark(entry: (typeof repos)[number], index: number) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const work = join(output, 'repos', entry.repo.replace('/', '__'));
  await mkdir(work, { recursive: true });
  const result: Record<string, unknown> = {
    repo: entry.repo,
    stars: entry.stars,
    commit: entry.commit,
  };
  results[index] = result;
  const log = (stage: string) =>
    console.error(`[${index + 1}/${repos.length}] ${entry.repo}: ${stage}`);
  const checkout = await checkoutError(directory, entry.commit);
  if (checkout) {
    result.infrastructure = { kind: 'clone', message: checkout };
    log(`clone failure: ${checkout}`);
    return;
  }
  const manifest = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const packageName = SHOPIFY_PACKAGES.find((name) => declared[name]) ?? SHOPIFY_PACKAGES[3];
  let scan: ReturnType<typeof scanShopify>;
  try {
    scan = scanShopify(await readRepository(directory, packageName));
  } catch (error) {
    result.read = message(error);
    log('Refit cannot read repository');
    return;
  }
  const sdk = await lockedShopifyApi(directory);
  const latest =
    sdk && scan.unresolvedVersions.some((pin) => pin.latest) ? latestApiVersion(sdk) : undefined;
  const pins = [
    ...new Set([
      ...scan.versions.filter((pin) => !CODEGEN_CONFIG.test(pin.file)).map((pin) => pin.value),
      ...(latest ? [latest] : []),
    ]),
  ];
  const enumPinned = scan.versions.some(
    (pin) => pin.kind === 'enum' && !CODEGEN_CONFIG.test(pin.file),
  );
  const upgrade = Boolean(values['sdk-upgrade']);
  // With --sdk-upgrade, LATEST_API_VERSION and the enum can name any member a release ships; when
  // the upgrade cannot reach it, the pipeline falls back to the newest version the app can take.
  const sdkNames = (version: string) => {
    const member = enumFromVersion(version)!;
    return Boolean(
      (sdk && sdkHasEnumMember(sdk, member)) || (upgrade && SHOPIFY_API_ENUM_SINCE[member]),
    );
  };
  const sdkLimited = enumPinned || (upgrade && Boolean(latest));
  // The before contract is what Shopify serves for the pin; the target is the newest pinned schema
  // the code can name: any version for strings and URLs, members the locked SDK has for the enum.
  const before =
    pins.length === 1
      ? ([...versions].reverse().find((version) => version <= pins[0]) ?? versions[0])
      : versions[0];
  const reachable = versions.filter((version) => !sdkLimited || sdkNames(version));
  const after = reachable.at(-1);
  Object.assign(result, {
    packageName,
    sdk: sdk ?? null,
    adminCalls: scan.adminCalls,
    documents: scan.documents.length,
    tracedDocuments: scan.documents.filter((document) => document.traced).length,
    unreadable: scan.unreadable.length,
    rest: scan.rest.length,
    restCalls: scan.rest.map((call) => ({
      file: call.file,
      line: call.line,
      method: call.method ?? null,
      path: call.path ?? null,
      resource: call.resource ?? null,
    })),
    pins,
    pinKinds: [...new Set(scan.versions.map((pin) => pin.kind))],
    unresolvedPins: scan.unresolvedVersions.length,
    before,
    after: after ?? null,
    latestNeedsSdkUpgrade: Boolean(
      enumPinned && !(sdk && sdkHasEnumMember(sdk, enumFromVersion(versions.at(-1)!)!)),
    ),
  });
  if (!scan.adminCalls && !scan.documents.length && !scan.versions.length && !scan.rest.length) {
    result.outcome = 'no-admin-usage';
    log('no Admin API usage');
    return;
  }
  const target = after && after > before ? after : versions.at(-1)!;
  result.target = target;
  try {
    const report = (await runPipeline({
      repository: directory,
      before: snapshot(before),
      after: snapshot(target),
      proposePatch: true,
      shopifySdkUpgrade: upgrade,
      ...(ai ? { aiPatch: ai } : {}),
      // As validation does: npm may re-resolve the lockfile for an SDK upgrade, as of the commit.
      ...(upgrade && lockfileResolutionEnabled()
        ? {
            lockfileResolution: {
              image: VALIDATION_IMAGE,
              before: (
                await execute('git', ['-C', directory, 'log', '-1', '--format=%cI'])
              ).stdout.trim(),
            },
          }
        : {}),
    })) as unknown as {
      status: string;
      findings: {
        file: string;
        line: number;
        confidence: string;
        expression: string;
        contractReview?: string;
        changeId: string;
      }[];
      patch: {
        status: string;
        reason?: string;
        diff?: string;
        warnings?: string[];
        shopifySdkUpgrade?: unknown;
      };
      shopify: {
        deprecated: string[];
        ai: unknown[];
        restAi: unknown[];
        reconstructed?: unknown[];
      };
      apiVersion: { applicability: string };
    };
    result.scan = {
      status: report.status,
      applicability: report.apiVersion.applicability,
      patch: report.patch.status,
      reason: report.patch.reason,
      breakingDocuments: report.findings.filter(
        (finding) =>
          finding.changeId.startsWith('shopify-graphql') &&
          !finding.contractReview?.includes('already fails'),
      ).length,
      alreadyFailing: report.findings.filter((finding) =>
        finding.contractReview?.includes('already fails'),
      ).length,
      deprecated: report.shopify.deprecated.length,
      ...(ai
        ? {
            ai: {
              rewrites: report.shopify.ai,
              rest: report.shopify.restAi,
              reconstructed: report.shopify.reconstructed ?? [],
            },
          }
        : {}),
      findings: report.findings.map((finding) => ({
        file: finding.file,
        line: finding.line,
        confidence: finding.confidence,
        expression: finding.expression.slice(0, 200),
        review: finding.contractReview,
      })),
    };
    if (report.patch.shopifySdkUpgrade) result.sdkUpgrade = report.patch.shopifySdkUpgrade;
    if (report.patch.diff) await writeFile(join(work, 'proposal.patch'), report.patch.diff);
    if (report.patch.status !== 'proposed') {
      // Pinned to the newest schema Refit has: nothing to move, whatever else the scan reports.
      result.outcome = pins.length === 1 && pins[0] >= versions.at(-1)! ? 'current' : 'stopped';
      result.onNewestReachable = Boolean(after && pins.length === 1 && pins[0] >= after);
      // Already on the newest version the locked SDK can name, and nothing else stops it: moving
      // further is an SDK upgrade, not a version bump.
      if (
        result.outcome === 'stopped' &&
        result.onNewestReachable &&
        report.findings.every(
          (finding) => !finding.contractReview || SDK_LIMIT.test(finding.contractReview),
        )
      )
        result.outcome = 'current-for-sdk';
      log(`${result.outcome}: ${String(report.patch.reason).slice(0, 100)}`);
      return;
    }
  } catch (error) {
    result.outcome = 'error';
    result.error = message(error);
    log(`error: ${message(error)}`);
    return;
  }
  result.outcome = 'patched';
  const testScript: unknown = manifest.scripts?.test;
  const hasTests = typeof testScript === 'string' && !PLACEHOLDER_TEST.test(testScript);
  const typescript = existsSync(join(directory, 'tsconfig.json')) && Boolean(declared.typescript);
  // The tests run with the root lockfile's manager, in check selection's order. A repository that
  // commits no lockfile runs with npm, as a generated configuration does: preparation refuses it
  // (the patch stays untested, grade D) unless an SDK upgrade's lockfile resolution gives one.
  const manager =
    LOCKFILE_MANAGERS.find(([file]) => existsSync(join(directory, file)))?.[1] ?? 'npm';
  result.checks = !manager ? 'none' : hasTests ? 'tests' : typescript ? 'typecheck' : 'none';
  if (!values.validate || result.checks === 'none') {
    log(`patched (${String(result.checks)} checks)`);
    return;
  }
  const command = hasTests
    ? [manager!, 'test']
    : ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false', '-p', '.'];
  const config = join(work, 'run.json');
  await writeFile(
    config,
    `${JSON.stringify({ formatVersion: 1, repository: directory, before: snapshot(before), after: snapshot(target), image: VALIDATION_IMAGE, prepareDependencies: true, command, ...(result.checks === 'typecheck' ? { compareTypeErrors: true } : {}) }, null, 2)}\n`,
  );
  const bundle = join(work, 'run');
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
        '--quiet',
        '--json',
        ...(upgrade ? ['--shopify-sdk-upgrade'] : []),
        ...(ai
          ? ['--ai-patch', '--repair-attempts', String(HOSTED_REPAIR_ATTEMPTS), '--assess']
          : values.assess
            ? ['--assess']
            : []),
      ],
      { env: CHILD_ENV, timeout: VALIDATION_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // Non-zero exits are recorded outcomes (needs-review, validation-failed, error).
  }
  const outcome = JSON.parse(
    await readFile(join(bundle, 'manifest.json'), 'utf8').catch(() => '{}'),
  );
  const report = JSON.parse((await readEvidence(bundle, 'report.json')) ?? '{}');
  result.workflow = {
    status: outcome.status ?? 'missing-manifest',
    stage: outcome.stage,
    reason: outcome.reason,
    error: outcome.error?.message,
    validation: report.validation?.status,
    baseline: report.validation?.baseline?.status,
    patched: report.validation?.patched?.status,
    grade: report.validation?.grade?.letter,
    schemaProof: report.validation?.shopifyProof?.schema?.status,
    liveProof: report.validation?.shopifyProof?.live?.status,
    aiCostUsd: report.validation?.shopifyProof?.aiCostUsd,
    generator: report.patch?.generator,
    repair: report.validation?.repair,
    pullRequest: existsSync(join(bundle, 'pull-request.md')),
  };
  log(`workflow ${String(outcome.status)}`);
}

const concurrency = Math.max(1, Number(values.concurrency ?? 1));
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, repos.length) }, async () => {
    while (next < repos.length) {
      const index = next++;
      const entry = repos[index];
      if (finishedRow(previous[index], entry)) {
        results[index] = previous[index]!;
        console.error(`[${index + 1}/${repos.length}] ${entry.repo}: finished before resuming`);
        continue;
      }
      // Evidence an interrupted attempt left for this repository is replaced, not mixed in.
      if (previous.length)
        await rm(join(output, 'repos', entry.repo.replace('/', '__')), {
          recursive: true,
          force: true,
        });
      const started = Date.now();
      await benchmark(entry, index);
      results[index].seconds = Math.round((Date.now() - started) / 1000);
      Object.assign(results[index], classifyRow('shopify-results', results[index]));
      await writeFile(join(output, 'results.json'), json(results));
    }
  }),
);
assertResults('shopify-results', results);
await writeFile(join(output, 'results.json'), json(results));
console.log(`Results: ${join(output, 'results.json')}`);

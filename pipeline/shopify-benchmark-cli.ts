import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { scanShopify, SHOPIFY_PACKAGES } from './shopify-analysis.ts';
import { lockedShopifyApi } from './shopify-pipeline.ts';
import { enumFromVersion, latestApiVersion, sdkHasEnumMember } from './shopify-versions.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:shopify -- --root <benchmark-dir> --output <new-dir> [--list <frozen.json>] [--validate] [--limit N] [--concurrency N]';
const PINNED = 'docs/benchmarks/2026-10-16-shopify-repos.json';
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1000;
const CODEGEN_CONFIG = /(?:^|\/)\.graphqlrc\.[cm]?[jt]s$/;
const SDK_LIMIT = /first ships in|LATEST_API_VERSION is/;

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    list: { type: 'string' },
    validate: { type: 'boolean' },
    limit: { type: 'string' },
    concurrency: { type: 'string' },
  },
});
if (!values.root || !values.output) throw new PipelineInputError(USAGE);
const root = resolve(values.root);
const output = resolve(values.output);
const pinned = JSON.parse(await readFile(values.list ?? PINNED, 'utf8')) as {
  repos: { repo: string; stars: number; commit: string }[];
  schemas: { versions: { version: string }[] };
};
// Supported versions with a pinned schema, oldest first; Shopify serves older pins as the first.
const versions = pinned.schemas.versions.map((entry) => entry.version).sort();
const repos = pinned.repos.slice(0, values.limit ? Number(values.limit) : undefined);
const snapshot = (version: string) => join(root, 'snapshots', `${version}.json`);
await mkdir(output);
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
  // The before contract is what Shopify serves for the pin; the target is the newest pinned schema
  // the code can name: any version for strings and URLs, members the locked SDK has for the enum.
  const before =
    pins.length === 1
      ? ([...versions].reverse().find((version) => version <= pins[0]) ?? versions[0])
      : versions[0];
  const reachable = versions.filter(
    (version) => !enumPinned || (sdk && sdkHasEnumMember(sdk, enumFromVersion(version)!)),
  );
  const after = reachable.at(-1);
  Object.assign(result, {
    packageName,
    sdk: sdk ?? null,
    adminCalls: scan.adminCalls,
    documents: scan.documents.length,
    tracedDocuments: scan.documents.filter((document) => document.traced).length,
    unreadable: scan.unreadable.length,
    rest: scan.rest.length,
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
      patch: { status: string; reason?: string; diff?: string; warnings?: string[] };
      shopify: { deprecated: string[] };
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
      findings: report.findings.map((finding) => ({
        file: finding.file,
        line: finding.line,
        confidence: finding.confidence,
        expression: finding.expression.slice(0, 200),
        review: finding.contractReview,
      })),
    };
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
  const checkable = existsSync(join(directory, 'package-lock.json'));
  result.checks = !checkable ? 'none' : hasTests ? 'tests' : typescript ? 'typecheck' : 'none';
  if (!values.validate || result.checks === 'none') {
    log(`patched (${String(result.checks)} checks)`);
    return;
  }
  const command = hasTests
    ? ['npm', 'test']
    : ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false', '-p', '.'];
  const config = join(work, 'run.json');
  await writeFile(
    config,
    `${JSON.stringify({ formatVersion: 1, repository: directory, before: snapshot(before), after: snapshot(target), image: 'node:22-alpine', prepareDependencies: true, command, ...(result.checks === 'typecheck' ? { compareTypeErrors: true } : {}) }, null, 2)}\n`,
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
      ],
      { env: process.env, timeout: VALIDATION_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // Non-zero exits are recorded outcomes (needs-review, validation-failed, error).
  }
  const outcome = JSON.parse(
    await readFile(join(bundle, 'manifest.json'), 'utf8').catch(() => '{}'),
  );
  const report = JSON.parse(await readFile(join(bundle, 'report.json'), 'utf8').catch(() => '{}'));
  result.workflow = {
    status: outcome.status ?? 'missing-manifest',
    stage: outcome.stage,
    reason: outcome.reason,
    error: outcome.error?.message,
    validation: report.validation?.status,
    baseline: report.validation?.baseline?.status,
    patched: report.validation?.patched?.status,
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
      const started = Date.now();
      await benchmark(repos[index], index);
      results[index].seconds = Math.round((Date.now() - started) / 1000);
      await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    }
  }),
);
await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Results: ${join(output, 'results.json')}`);

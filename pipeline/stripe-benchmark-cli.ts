import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { measureCoverage } from './sdk-coverage.ts';
import { repositoryAdapter, stripeOperations } from './stripe-benchmark.ts';
import { FieldSubstitutionError } from './substitution-guard.ts';
import { PipelineInputError, type Repository } from './types.ts';

const execute = promisify(execFile);
const USAGE =
  'Usage: npm run benchmark:stripe -- --root <benchmark-dir> --output <new-dir> [--env .env] [--ai] [--validate] [--limit N]';
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
const VALIDATION_TIMEOUT_MS = 20 * 60 * 1000;

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
    limit: { type: 'string' },
  },
});
if (!values.root || !values.output) throw new PipelineInputError(USAGE);
if (values.env) process.loadEnvFile(values.env);
const root = resolve(values.root);
const output = resolve(values.output);
const ai = values.ai ? assessmentConfiguration(true, process.env)! : undefined;
const selected = (
  JSON.parse(await readFile(join(root, 'selected.json'), 'utf8')) as Selected[]
).slice(0, values.limit ? Number(values.limit) : undefined);
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
const productionFailures = new Map<string, string>();
await mkdir(output);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];

for (const [index, entry] of selected.entries()) {
  const started = Date.now();
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
  results.push(result);
  const log = (stage: string) =>
    console.error(`[${index + 1}/${selected.length}] ${entry.repo}: ${stage}`);
  let repository: Repository;
  try {
    repository = await readRepository(directory, 'stripe');
    result.read = 'ok';
  } catch (error) {
    result.read = message(error);
    log('Refit cannot read repository');
    continue;
  }
  try {
    const sites = measureCoverage(repository, 'stripe').filter((site) => site.likelySdk);
    result.sdkCalls = sites.length;
    result.tracedCalls = sites.filter((site) => site.traced).length;
  } catch (error) {
    result.scanCrash = message(error);
    log('scanner crashed');
    continue;
  }
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
  const inputs = { repository: directory, before, after, apiVersion: entry.before };
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
    reviewReasons: report.findings
      .filter((finding) => finding.confidence === 'review')
      .reduce<Record<string, number>>((counts, finding) => {
        counts[finding.reason] = (counts[finding.reason] ?? 0) + 1;
        return counts;
      }, {}),
    webhookFileFindings: report.findings.filter((finding) => webhookFiles.has(finding.file)).length,
    apiVersion: report.apiVersion.applicability,
  });
  try {
    result.shippedAdapter = summarize(await runPipeline(inputs));
  } catch (error) {
    result.shippedAdapter = { error: message(error) };
  }
  if (!mappedMethods) {
    log('no mapped Stripe methods');
    continue;
  }
  try {
    result.fullAdapter = summarize(await runPipeline({ ...inputs, providerConfig: adapterPath }));
  } catch (error) {
    result.fullAdapter = { error: message(error) };
    log('full-adapter scan failed');
    continue;
  }
  // The oasdiff comparison depends only on the contract pair; a failure applies to every
  // repository on the same before version, so it is attempted once per version.
  const failed = productionFailures.get(entry.before);
  if (failed) result.productionMode = { error: failed, reusedFromSameVersion: true };
  else
    try {
      result.productionMode = summarize(
        await runPipeline({ ...inputs, providerConfig: adapterPath, fullDiff: true }),
      );
    } catch (error) {
      productionFailures.set(entry.before, message(error));
      result.productionMode = { error: message(error) };
    }
  const full = result.fullAdapter as { confirmed: number };
  if (!full.confirmed || !ai) {
    log(full.confirmed ? `affected (${full.confirmed} usages), AI not requested` : 'not affected');
    continue;
  }
  const manifest = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
  );
  const testScript: unknown = manifest.scripts?.test;
  const validatable =
    existsSync(join(directory, 'package-lock.json')) &&
    Boolean({ ...manifest.dependencies, ...manifest.devDependencies }.stripe) &&
    typeof testScript === 'string' &&
    !PLACEHOLDER_TEST.test(testScript);
  result.validatable = validatable;
  if (values.validate && validatable) {
    const config = join(work, 'run.json');
    await writeFile(
      config,
      `${JSON.stringify({ formatVersion: 1, repository: directory, apiVersion: entry.before, before, after, providerConfig: adapterPath, image: 'node:22-alpine', prepareDependencies: true, command: ['npm', 'test'] }, null, 2)}\n`,
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
          '--ai-patch',
          '--repair-attempts',
          '1',
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
    const report = JSON.parse(
      await readFile(join(bundle, 'report.json'), 'utf8').catch(() => '{}'),
    );
    result.workflow = {
      status: outcome.status ?? 'missing-manifest',
      stage: outcome.stage,
      reason: outcome.reason,
      error: outcome.error?.message,
      patch: report.patch?.status,
      summary: report.patch?.summary,
      validation: report.validation?.status,
      pullRequest: existsSync(join(bundle, 'pull-request.md')),
    };
    log(`workflow ${String((result.workflow as { status: string }).status)}`);
  } else {
    try {
      const report = await runPipeline({ ...inputs, providerConfig: adapterPath, aiPatch: ai });
      const patch = report.patch as {
        status: string;
        edits?: number;
        summary?: string;
        diff?: string;
      };
      result.ai = {
        outcome: patch.edits ? 'proposed' : 'declined',
        summary: patch.summary,
        diff: patch.diff?.slice(0, 4000),
      };
    } catch (error) {
      result.ai = {
        outcome: error instanceof FieldSubstitutionError ? 'rejected-by-guard' : 'error',
        detail: message(error),
      };
    }
    log(`AI ${String((result.ai as { outcome: string }).outcome)}`);
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Results: ${join(output, 'results.json')}`);

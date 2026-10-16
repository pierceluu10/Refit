import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findRemovedProperties, readSpecification } from './specifications.ts';
import {
  labelReads,
  readJson,
  stripeClassSchemas,
  stripeParamOperations,
} from './stripe-ground-truth.ts';
import { PipelineInputError } from './types.ts';

const { values } = parseArgs({
  options: { root: { type: 'string' }, output: { type: 'string' }, repo: { type: 'string' } },
});
if (!values.root || !values.output)
  throw new PipelineInputError(
    'Usage: npm run benchmark:stripe-labels -- --root <benchmark-dir> --output <new-dir> [--repo owner/name]',
  );
const root = resolve(values.root);
// Every repository with a recorded stripe SDK version is labelled.
const sdk = readJson(join(root, 'labelled-sdk.json')) as unknown as Array<{
  repo: string;
  before: string;
  version: string;
}>;
const specs = readJson(join(root, 'needed-specs.json')) as unknown as Array<{ version: string }>;
const latest = specs
  .map((spec) => spec.version)
  .sort()
  .at(-1)!;
const sdkSpec = readJson(join(root, 'specs', `sdk-${latest}.json`));
const classSchemas = stripeClassSchemas(sdkSpec);
const operations = stripeParamOperations(sdkSpec);
const after = await readSpecification(join(root, 'specs', `${latest}.json`));
const contracts = new Map<
  string,
  { removed: Map<string, Set<string>>; document: Record<string, unknown> }
>();
await mkdir(values.output, { recursive: true });
const summary: Record<string, unknown>[] = [];
for (const entry of sdk.filter((candidate) => !values.repo || candidate.repo === values.repo)) {
  const repo = entry.repo;
  if (!contracts.has(entry.before)) {
    const before = await readSpecification(join(root, 'specs', `${entry.before}.json`));
    const removed = new Map<string, Set<string>>();
    for (const change of findRemovedProperties(before.schemas, after.schemas))
      removed.set(change.property, (removed.get(change.property) ?? new Set()).add(change.schema));
    contracts.set(entry.before, { removed, document: before.document });
  }
  const contract = contracts.get(entry.before)!;
  const started = Date.now();
  const reads = labelReads({
    repository: join(root, 'repos', repo.replace('/', '__')),
    stripePackage: join(root, 'stripe-types', `stripe@${entry.version}`, 'package'),
    removed: contract.removed,
    classSchemas,
    requests: { before: contract.document, after: after.document, operations },
  });
  const count = (label: string) =>
    reads.filter((read) => !read.request && read.label === label).length;
  const row = {
    repo,
    before: entry.before,
    sdk: entry.version,
    reads: reads.filter((read) => !read.request).length,
    breaking: count('breaking'),
    stripeUnaffected: count('stripe-unaffected'),
    notStripe: count('not-stripe'),
    unknown: count('unknown'),
    removedParameters: reads.filter((read) => read.request).length,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  summary.push(row);
  await writeFile(
    join(values.output, `${repo.replace('/', '__')}.json`),
    `${JSON.stringify({ ...row, reads }, null, 2)}\n`,
  );
  console.error(JSON.stringify(row));
}
await writeFile(join(values.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findRemovedProperties, readSpecification } from './specifications.ts';
import { labelReads, readJson, stripeClassSchemas } from './stripe-ground-truth.ts';
import { PipelineInputError } from './types.ts';

const { values } = parseArgs({
  options: { root: { type: 'string' }, output: { type: 'string' }, repo: { type: 'string' } },
});
if (!values.root || !values.output)
  throw new PipelineInputError(
    'Usage: npm run benchmark:stripe-labels -- --root <benchmark-dir> --output <new-dir> [--repo owner/name]',
  );
const root = resolve(values.root);
const split = readJson(join(root, 'split.json')) as { labelled: string[] };
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
const classSchemas = stripeClassSchemas(readJson(join(root, 'specs', `sdk-${latest}.json`)));
const after = await readSpecification(join(root, 'specs', `${latest}.json`));
const removedByVersion = new Map<string, Map<string, Set<string>>>();
await mkdir(values.output, { recursive: true });
const summary: Record<string, unknown>[] = [];
for (const repo of split.labelled.filter((name) => !values.repo || name === values.repo)) {
  const entry = sdk.find((candidate) => candidate.repo === repo)!;
  if (!removedByVersion.has(entry.before)) {
    const before = await readSpecification(join(root, 'specs', `${entry.before}.json`));
    const removed = new Map<string, Set<string>>();
    for (const change of findRemovedProperties(before.schemas, after.schemas))
      removed.set(change.property, (removed.get(change.property) ?? new Set()).add(change.schema));
    removedByVersion.set(entry.before, removed);
  }
  const started = Date.now();
  const reads = labelReads({
    repository: join(root, 'repos', repo.replace('/', '__')),
    stripeTypes: join(root, 'stripe-types', `stripe@${entry.version}`, 'package', 'types'),
    removed: removedByVersion.get(entry.before)!,
    classSchemas,
  });
  const count = (label: string) => reads.filter((read) => read.label === label).length;
  const row = {
    repo,
    before: entry.before,
    sdk: entry.version,
    reads: reads.length,
    breaking: count('breaking'),
    stripeUnaffected: count('stripe-unaffected'),
    notStripe: count('not-stripe'),
    unknown: count('unknown'),
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

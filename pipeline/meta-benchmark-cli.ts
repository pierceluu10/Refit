import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkoutError,
  classifyRow,
  finishedRow,
  json,
  openRunDirectory,
  startRun,
} from '../scripts/benchmark-harness.mjs';
import { assertResults } from '../scripts/benchmark-results.mjs';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { metaRow, summaryTable } from './meta-benchmark.ts';
import { META_SDK } from './deadline-exposure.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';
import { DEFAULT_META_GRAPH_CHANGES, loadMetaGraphChanges } from './meta-graph-changes.ts';
import { proposeVersionMoves } from './meta-graph-moves.ts';
import { readRepository } from './repository.ts';
import { PipelineInputError } from './types.ts';

// Runs Refit's Meta Graph engine on a frozen Meta list (docs/benchmarks/subsets/meta-*.json):
// the request scan and the version-move proposal to the list's target, per repository. Code is
// read, never installed or run, and Meta is never contacted.
const USAGE =
  'Usage: npm run benchmark:meta -- --root <benchmark-dir> --list <frozen.json> --output <new-dir> [--resume] [--allow-dirty] [--limit N]';
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    list: { type: 'string' },
    limit: { type: 'string' },
    resume: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
  },
});
if (!values.root || !values.output || !values.list) throw new PipelineInputError(USAGE);
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
    options: { target, limit: values.limit },
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
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const results: Record<string, unknown>[] = [];

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
      const scan = await scanGraphCalls(directory, { repository });
      const proposal = await proposeVersionMoves(directory, target, changes, registry, now);
      const { patch, ...row } = metaRow(scan, proposal);
      Object.assign(result, row, { patch: patch !== null });
      await writeFile(join(work, 'scan.json'), json(scan));
      await writeFile(join(work, 'proposal.json'), json(proposal));
      if (patch) await writeFile(join(work, 'moves.patch'), patch);
    } catch (error) {
      result.error = message(error);
    }
  result.seconds = Math.round((Date.now() - started) / 1000);
  Object.assign(result, classifyRow('meta-graph-results', result));
  results[index] = result;
  console.error(
    `[${index + 1}/${repos.length}] ${entry.repo}: ${String(result.error ?? result.outcome)}`,
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

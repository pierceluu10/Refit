import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectCheck, type CheckedCode } from './check-selection.ts';
import { META_SDK } from './deadline-exposure.ts';
import { hasGraphHost } from './meta-graph-calls.ts';
import { metaGraphSnapshot } from './meta-graph-pipeline.ts';
import { readRepository } from './repository.ts';

// The `refit run` configuration for a Meta Graph run: the two change-table snapshots and the check
// a customer's repository would get, chosen by selectCheck over the files that make Graph API
// requests. Benchmarks and the hosted worker write it the same way, so both run what a customer
// gets.

export const META_GRAPH_CODE: CheckedCode = {
  label: 'Meta Graph',
  file: (content) => hasGraphHost(content) || /\bFB\s*\.\s*(?:init|api)\s*\(/.test(content),
  // Graph requests are plain fetch and axios calls, which TypeScript types without an SDK.
  typed: () => true,
};
// Owner decision 1: a repository with no check still gets its patch, validated with the no-op
// check and graded D.
const NO_OP_CHECK = ['node', '-e', '0'];

export async function writeMetaGraphRun(options: {
  repository: string;
  // The directory the snapshots and run.json are written to.
  directory: string;
  // The version the run compares from; informational, since each pin is checked from its own.
  before: string;
  target: string;
  image?: string;
}) {
  const repository = await readRepository(options.repository, META_SDK);
  const selection = await selectCheck(repository, undefined, META_GRAPH_CODE);
  const before = join(options.directory, 'before.json');
  const after = join(options.directory, 'after.json');
  await writeFile(before, `${JSON.stringify(await metaGraphSnapshot(options.before))}\n`);
  await writeFile(after, `${JSON.stringify(await metaGraphSnapshot(options.target))}\n`);
  const config = join(options.directory, 'run.json');
  await writeFile(
    config,
    `${JSON.stringify(
      {
        formatVersion: 1,
        repository: options.repository,
        before,
        after,
        image: options.image ?? 'node:22-alpine',
        prepareDependencies: true,
        command: selection.command ?? NO_OP_CHECK,
        ...(selection.compareTypeErrors ? { compareTypeErrors: true } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return { config, selection };
}

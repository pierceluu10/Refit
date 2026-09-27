import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createArtifactDirectory } from './artifacts.ts';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { digest, readSpecification } from './specifications.ts';
import { runPipeline } from './run.ts';
import { PipelineInputError } from './types.ts';

export async function checkStripe(options: {
  repository: string;
  baseline: string;
  output: string;
  proposePatch?: boolean;
}) {
  const repository = await realpath(options.repository);
  await readSpecification(options.baseline);
  const destination = await createArtifactDirectory(repository, options.output);
  try {
    const beforePath = join(destination, 'before.json');
    const afterPath = join(destination, 'after.json');
    const beforeContent = await readFile(options.baseline, 'utf8');
    await writeFile(beforePath, beforeContent, { flag: 'wx', mode: 0o600 });
    const before = await readSpecification(beforePath);
    if (!before.provenance)
      throw new PipelineInputError(
        'Stripe checks require a pinned Refit snapshot as the baseline.',
      );
    const revision = await discoverStripeRevision();
    const afterContent =
      revision === before.provenance.revision
        ? beforeContent
        : encodeSnapshot(await fetchStripeSnapshot(revision));
    await writeFile(afterPath, afterContent, { flag: 'wx', mode: 0o600 });
    const report = await runPipeline({
      repository,
      before: beforePath,
      after: afterPath,
      proposePatch: options.proposePatch,
    });
    const reportContent = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(join(destination, 'report.json'), reportContent, { flag: 'wx', mode: 0o600 });
    const manifest = {
      formatVersion: 1,
      kind: 'refit-stripe-check',
      upstream: report.snapshots.before === report.snapshots.after ? 'unchanged' : 'changed',
      revisions: { before: before.provenance.revision, after: revision },
      runId: report.runId,
      status: report.status,
      baselineAdvanced: false,
      files: Object.entries({
        'before.json': beforeContent,
        'after.json': afterContent,
        'report.json': reportContent,
      }).map(([path, content]) => ({
        path,
        sha256: digest(content),
        bytes: Buffer.byteLength(content),
      })),
    };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { directory: destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

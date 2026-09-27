import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createArtifactDirectory } from './artifacts.ts';
import { readProviderAdapter } from './providers.ts';
import { publishDraft, type publicationConfiguration } from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { digest, readSpecification } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { validateMigration } from './validation.ts';
import { validateCheckCommand } from './validation-options.ts';

type Stage = 'inputs' | 'scan' | 'validation' | 'publication';
type Status =
  'needs-review' | 'validation-failed' | 'validated' | 'draft-created' | 'existing-pr' | 'error';

export async function runWorkflow(options: {
  repository: string;
  before: string;
  after?: string;
  latestStripe?: boolean;
  output: string;
  image: string;
  command: string[];
  providerConfig?: string;
  assessment?: { apiKey: string; model: string };
  aiPatch?: { apiKey: string; model: string };
  publication?: ReturnType<typeof publicationConfiguration>;
}) {
  if (Boolean(options.after) === Boolean(options.latestStripe))
    throw new PipelineInputError('Choose exactly one of --after or --latest-stripe.');
  if (options.latestStripe && options.providerConfig)
    throw new PipelineInputError('--latest-stripe cannot be combined with a custom provider.');
  validateCheckCommand(options.command);
  const directory = await createArtifactDirectory(options.repository, options.output);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let stage: Stage = 'inputs';
  const save = async (path: string, content: string) => {
    await writeFile(join(directory, path), content, { flag: 'wx', mode: 0o600 });
    files.push({ path, sha256: digest(content), bytes: Buffer.byteLength(content) });
  };
  const finish = async (
    status: Status,
    reason: string,
    runId: string | null,
    error: { name: string; message: string } | null = null,
  ) => {
    const manifest = {
      formatVersion: 1,
      kind: 'refit-workflow',
      status,
      stage,
      reason,
      runId,
      baselineAdvanced: false,
      reviewRequired: true,
      files,
      error,
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { directory, manifest };
  };
  let runId: string | null = null;
  try {
    await readSpecification(options.before);
    await save('before.json', await readFile(options.before, 'utf8'));
    const before = join(directory, 'before.json');
    const baseline = await readSpecification(before);
    if (options.latestStripe) {
      if (!baseline.provenance)
        throw new PipelineInputError('--latest-stripe requires a pinned Refit baseline snapshot.');
      const revision = await discoverStripeRevision();
      await save(
        'after.json',
        revision === baseline.provenance.revision
          ? await readFile(before, 'utf8')
          : encodeSnapshot(await fetchStripeSnapshot(revision)),
      );
    } else {
      await readSpecification(options.after!);
      await save('after.json', await readFile(options.after!, 'utf8'));
    }
    let providerConfig: string | undefined;
    if (options.providerConfig) {
      await save(
        'adapter.json',
        `${JSON.stringify(await readProviderAdapter(options.providerConfig), null, 2)}\n`,
      );
      providerConfig = join(directory, 'adapter.json');
    }
    const inputs = {
      repository: options.repository,
      before,
      after: join(directory, 'after.json'),
      providerConfig,
    };
    stage = 'scan';
    const scan = await runPipeline({ ...inputs, proposePatch: true });
    runId = scan.runId;
    await save('scan.json', `${JSON.stringify(scan, null, 2)}\n`);
    if (!scan.findings.some((finding) => finding.confidence === 'confirmed'))
      return await finish(
        'needs-review',
        'No confirmed supported usage was found. This does not prove no impact; no patch or publication was attempted.',
        runId,
      );
    if (!options.aiPatch && scan.patch.status !== 'proposed')
      return await finish(
        'needs-review',
        'Confirmed usage has no deterministic migration rule. Enable AI patch generation or migrate manually.',
        runId,
      );
    stage = 'validation';
    const report = await validateMigration({
      ...inputs,
      image: options.image,
      command: options.command,
      assessment: options.assessment,
      aiPatch: options.aiPatch,
    });
    runId = report.runId;
    const review = createReviewArtifacts(report);
    for (const [path, content] of Object.entries(review.files)) await save(path, content);
    if (report.validation.status !== 'passed')
      return await finish(
        'validation-failed',
        `Validation returned ${report.validation.status}; publication was not attempted.`,
        runId,
      );
    if (report.patch.unresolvedFindings !== 0)
      return await finish(
        'needs-review',
        'Checks passed but detected findings remain unresolved. Publication was not attempted.',
        runId,
      );
    if (!options.publication)
      return await finish(
        'validated',
        'Baseline and patched checks passed. Review artifacts are ready; publication was not requested.',
        runId,
      );
    stage = 'publication';
    const publication = await publishDraft(report, options.publication);
    await save('publication.json', `${JSON.stringify(publication, null, 2)}\n`);
    return await finish(
      publication.status === 'created' ? 'draft-created' : 'existing-pr',
      publication.url,
      runId,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return await finish(
      'error',
      `Workflow failed during ${stage}. Completed artifacts are retained. Publication errors can leave a remote branch or PR; reconcile before retrying.`,
      runId,
      { name: error.name, message: error.message },
    );
  }
}

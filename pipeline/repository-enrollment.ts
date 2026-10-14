import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { readCommittedFile, readCommittedRepository } from './committed-repository.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { compareApiVersion, validateApiVersion } from './api-version.ts';
import { parseProviderAdapter, STRIPE, validateProviderMappings } from './providers.ts';
import { validateProviderOperationMappings } from './provider-operations.ts';
import { validateGitHubTarget } from './publication.ts';
import {
  digest,
  isObject,
  MAX_SPECIFICATION_BYTES,
  parseObject,
  parseSpecificationInput,
} from './specifications.ts';
import { hasErrorCode, stateDirectoryOutsideRepository } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { inspectArtifactFile } from './verification.ts';
import { analyzeRepository } from './analyzer.ts';
import { readRepository } from './repository.ts';
import {
  MAX_WORKFLOW_CONFIGURATION_BYTES,
  parseWorkflowConfiguration,
  REPOSITORY_CONFIGURATION,
} from './workflow-configuration.ts';

const MAX_APPROVAL_BYTES = 64 * 1024;
const MAX_INPUT_PATH_LENGTH = 1024;
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const ROLES = ['workflow', 'baseline', 'adapter'] as const;
const CACHE_FILES = {
  workflow: 'workflow.json',
  baseline: 'baseline.json',
  adapter: 'adapter.json',
};
type InputRole = (typeof ROLES)[number];

interface ApprovedInput {
  role: InputRole;
  path: string;
  sha256: string;
  bytes: number;
}

export interface RepositoryApproval {
  formatVersion: 1;
  kind: 'refit-repository-approval';
  repository: string;
  base: string;
  fingerprint: string;
  files: ApprovedInput[];
  reviewedRevision: string;
  approvedAt: string;
}

export class RepositoryApprovalError extends PipelineInputError {
  override name = 'RepositoryApprovalError';
}

function inputPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_INPUT_PATH_LENGTH ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '..' || part === '.git')
  )
    throw new PipelineInputError(
      'Repository profile inputs require relative committed paths inside the repository; parent paths, .git and links are unsupported.',
    );
  const path = posix.normalize(value);
  if (path === '.' || path.endsWith('/'))
    throw new PipelineInputError('Repository profile input paths must name files.');
  return path;
}

function fingerprint(repository: string, base: string, files: ApprovedInput[]) {
  return digest(
    JSON.stringify({ formatVersion: 1, repository: repository.toLowerCase(), base, files }),
  );
}

export async function inspectRepositoryEnrollment(options: {
  repository: string;
  github: string;
  base: string;
}) {
  const target = validateGitHubTarget(options.github, options.base);
  const snapshot = await readCommittedRepository(options.repository);
  const contents = new Map<InputRole, string>();
  const configurationContent = await readCommittedFile(
    snapshot,
    REPOSITORY_CONFIGURATION,
    MAX_WORKFLOW_CONFIGURATION_BYTES,
  );
  const raw = parseObject(configurationContent, REPOSITORY_CONFIGURATION);
  if (Object.hasOwn(raw, 'repository'))
    throw new PipelineInputError(
      'A repository .refit.json must not select another repository. The App-managed checkout supplies its root.',
    );
  const workflow = parseWorkflowConfiguration(
    configurationContent,
    join(snapshot.directory, REPOSITORY_CONFIGURATION),
  );
  const baselinePath = inputPath(raw.before);
  const baselineContent = await readCommittedFile(snapshot, baselinePath, MAX_SPECIFICATION_BYTES);
  const baseline = parseSpecificationInput(baselineContent, baselinePath);
  let provider = STRIPE;
  const paths: { role: InputRole; path: string }[] = [
    { role: 'workflow', path: REPOSITORY_CONFIGURATION },
    { role: 'baseline', path: baselinePath },
  ];
  contents.set('workflow', configurationContent);
  contents.set('baseline', baselineContent);
  if (raw.providerConfig !== undefined) {
    const path = inputPath(raw.providerConfig);
    const content = await readCommittedFile(snapshot, path, MAX_WORKFLOW_CONFIGURATION_BYTES);
    provider = parseProviderAdapter(parseObject(content, path));
    paths.push({ role: 'adapter', path });
    contents.set('adapter', content);
  }
  if (baseline.provenance && baseline.provenance.provider !== provider.id)
    throw new PipelineInputError(
      'Repository baseline provenance does not match its provider adapter.',
    );
  validateProviderMappings(provider, baseline.schemas);
  validateProviderOperationMappings(provider, baseline.document);
  const apiVersion = compareApiVersion(
    validateApiVersion(workflow.apiVersion),
    baseline.document,
    {},
    {
      configured: Boolean(provider.apiVersion),
      declarations: analyzeRepository(
        await readRepository(snapshot.directory, provider.packageName),
        [],
        provider,
        baseline.schemas,
      ).apiVersionDeclarations,
    },
    workflow.apiVersionPolicy,
  );
  if (apiVersion.applicability !== 'matches-before')
    throw new PipelineInputError(apiVersion.reason);
  if (workflow.latestStripe && !baseline.provenance)
    throw new PipelineInputError(
      'Latest Stripe discovery requires a pinned Refit baseline snapshot.',
    );
  let source: { kind: 'file'; path: string } | { kind: 'stripe-latest' };
  if (workflow.latestStripe) source = { kind: 'stripe-latest' };
  else {
    const path = inputPath(raw.after);
    const content = await readCommittedFile(snapshot, path, MAX_SPECIFICATION_BYTES);
    const specification = parseSpecificationInput(content, path);
    if (specification.provenance && specification.provenance.provider !== provider.id)
      throw new PipelineInputError(
        'Repository after-contract provenance does not match its provider adapter.',
      );
    source = { kind: 'file', path: join(snapshot.directory, path) };
  }
  const files = paths.map(({ role, path }) => ({
    role,
    path,
    sha256: digest(contents.get(role)!),
    bytes: Buffer.byteLength(contents.get(role)!),
  }));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new PipelineInputError(
      'Repository workflow, baseline and adapter must be separate committed files.',
    );
  return {
    repository: target.repository.toLowerCase(),
    base: target.base,
    reviewedRevision: snapshot.revision,
    fingerprint: fingerprint(target.repository, target.base, files),
    files,
    contents,
    workflow,
    source,
    settings: raw,
    apiVersion,
  };
}

export async function approveRepositoryEnrollment(options: {
  enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>;
  fingerprint: string;
  output: string;
}) {
  if (!HASH.test(options.fingerprint) || options.fingerprint !== options.enrollment.fingerprint)
    throw new RepositoryApprovalError(
      'The supplied approval fingerprint does not match the current committed configuration. Inspect the profile again before approval.',
    );
  const output = resolve(options.output);
  await standaloneStateDirectory(dirname(output));
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await standaloneStateDirectory(await realpath(dirname(output)));
  const approval: RepositoryApproval = {
    formatVersion: 1,
    kind: 'refit-repository-approval',
    repository: options.enrollment.repository,
    base: options.enrollment.base,
    fingerprint: options.enrollment.fingerprint,
    files: options.enrollment.files,
    reviewedRevision: options.enrollment.reviewedRevision,
    approvedAt: new Date().toISOString(),
  };
  await writeFile(output, `${JSON.stringify(approval, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { output, approval };
}

export async function readRepositoryApproval(path: string): Promise<RepositoryApproval> {
  await standaloneStateDirectory(await realpath(dirname(resolve(path))));
  const file = await inspectArtifactFile(path, MAX_APPROVAL_BYTES, true);
  const value = parseObject(file.content, 'Repository approval');
  if (
    Object.keys(value).sort().join(',') !==
      'approvedAt,base,files,fingerprint,formatVersion,kind,repository,reviewedRevision' ||
    value.formatVersion !== 1 ||
    value.kind !== 'refit-repository-approval' ||
    typeof value.repository !== 'string' ||
    value.repository !== value.repository.toLowerCase() ||
    typeof value.base !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !HASH.test(value.fingerprint) ||
    typeof value.reviewedRevision !== 'string' ||
    !REVISION.test(value.reviewedRevision) ||
    typeof value.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    new Date(value.approvedAt).toISOString() !== value.approvedAt ||
    !Array.isArray(value.files) ||
    value.files.length < 2 ||
    value.files.length > ROLES.length
  )
    throw new PipelineInputError('Repository approval has an invalid format or identity.');
  validateGitHubTarget(value.repository, value.base);
  const files = value.files.map((file, index): ApprovedInput => {
    if (
      !isObject(file) ||
      Object.keys(file).sort().join(',') !== 'bytes,path,role,sha256' ||
      file.role !== ROLES[index] ||
      typeof file.path !== 'string' ||
      inputPath(file.path) !== file.path ||
      (file.role === 'workflow' && file.path !== REPOSITORY_CONFIGURATION) ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256) ||
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes >
        (file.role === 'baseline' ? MAX_SPECIFICATION_BYTES : MAX_WORKFLOW_CONFIGURATION_BYTES)
    )
      throw new PipelineInputError('Repository approval contains invalid file evidence.');
    return {
      role: file.role as InputRole,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    };
  });
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    fingerprint(value.repository, value.base, files) !== value.fingerprint
  )
    throw new PipelineInputError(
      'Repository approval fingerprint does not match its file evidence.',
    );
  return {
    formatVersion: 1,
    kind: 'refit-repository-approval',
    repository: value.repository,
    base: value.base,
    fingerprint: value.fingerprint,
    files,
    reviewedRevision: value.reviewedRevision,
    approvedAt: value.approvedAt,
  };
}

async function cacheApprovedInputs(
  enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>,
  stateDirectory: string,
) {
  const parent = resolve(stateDirectory, 'approved-inputs');
  await standaloneStateDirectory(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent)
    throw new PipelineInputError('Approved input cache must not resolve through a symbolic link.');
  const directory = join(parent, enrollment.fingerprint);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new PipelineInputError('Approved input cache must be a physical directory.');
  try {
    if (created)
      for (const file of enrollment.files)
        await writeFile(
          join(directory, CACHE_FILES[file.role]),
          enrollment.contents.get(file.role)!,
          { flag: 'wx', mode: 0o600 },
        );
    const names = enrollment.files.map((file) => CACHE_FILES[file.role]);
    if ((await readdir(directory)).some((name) => !names.includes(name)))
      throw new PipelineInputError('Approved input cache contains unexpected files.');
    for (const file of enrollment.files) {
      const actual = await inspectArtifactFile(join(directory, CACHE_FILES[file.role]), file.bytes);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        throw new PipelineInputError(
          'Approved input cache changed. Inspect the cache before retrying; it will not be overwritten.',
        );
    }
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    if (hasErrorCode(error, 'ENOENT'))
      throw new PipelineInputError(
        'Approved input cache is incomplete. Inspect it before retrying; it will not be recreated automatically.',
        { cause: error },
      );
    throw error;
  }
  return directory;
}

export async function loadApprovedRepository(options: {
  repository: string;
  approval: RepositoryApproval;
  stateDirectory: string;
}) {
  let enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>;
  try {
    enrollment = await inspectRepositoryEnrollment({
      repository: options.repository,
      github: options.approval.repository,
      base: options.approval.base,
    });
  } catch (cause) {
    if (!(cause instanceof PipelineInputError)) throw cause;
    throw new RepositoryApprovalError(`Repository configuration needs review: ${cause.message}`, {
      cause,
    });
  }
  if (enrollment.fingerprint !== options.approval.fingerprint) {
    const changed = enrollment.files
      .filter(
        (file) =>
          !options.approval.files.some(
            (previous) =>
              previous.role === file.role &&
              previous.path === file.path &&
              previous.sha256 === file.sha256,
          ),
      )
      .map((file) => file.path);
    throw new RepositoryApprovalError(
      `Approved repository inputs changed${changed.length ? `: ${changed.join(', ')}` : ''}. Inspect and approve the current profile before execution.`,
    );
  }
  const stateDirectory = await stateDirectoryOutsideRepository(
    options.repository,
    options.stateDirectory,
  );
  const inputs = await cacheApprovedInputs(enrollment, stateDirectory);
  return {
    workflow: {
      ...enrollment.workflow,
      before: join(inputs, CACHE_FILES.baseline),
      providerConfig: enrollment.workflow.providerConfig
        ? join(inputs, CACHE_FILES.adapter)
        : undefined,
    },
    source: enrollment.source,
    fingerprint: enrollment.fingerprint,
  };
}

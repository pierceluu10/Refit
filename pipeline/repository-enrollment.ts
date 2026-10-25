import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { readCommittedFile, readCommittedRepository } from './committed-repository.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { compareApiVersion, declaresVersion, validateApiVersion } from './api-version.ts';
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
  DEFAULT_CONTRACTS_DIRECTORY,
  readStripeContract,
  stripeContractFile,
} from './enrollment-contracts.ts';
import {
  EnrollmentStopError,
  proposalContent,
  proposeStripeConfiguration,
} from './enrollment-proposal.ts';
import {
  MAX_WORKFLOW_CONFIGURATION_BYTES,
  parseWorkflowConfigurations,
  MAX_REPOSITORY_INTEGRATIONS,
  validIntegrationId,
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
  integration?: string;
  role: InputRole;
  path: string;
  sha256: string;
  bytes: number;
}

export interface RepositoryApproval {
  formatVersion: 1 | 2;
  integrations?: string[];
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

function cacheFileName(file: Pick<ApprovedInput, 'role' | 'integration'>) {
  return `${file.integration ? `${file.integration}.` : ''}${CACHE_FILES[file.role]}`;
}

function fingerprint(
  repository: string,
  base: string,
  files: ApprovedInput[],
  integrations?: string[],
) {
  return digest(
    JSON.stringify({
      formatVersion: integrations ? 2 : 1,
      repository: repository.toLowerCase(),
      base,
      files: files.map(({ role, path, sha256, bytes, integration }) => ({
        role,
        path,
        sha256,
        bytes,
        ...(integration ? { integration } : {}),
      })),
      ...(integrations ? { integrations } : {}),
    }),
  );
}

export async function inspectRepositoryEnrollment(options: {
  repository: string;
  github: string;
  base: string;
  contracts?: string;
  // Owner decision 1: generate a configuration whose checks cannot run instead of refusing.
  allowUntested?: boolean;
}) {
  return inspectEnrollmentInputs(options);
}

// The configuration a repository without a committed .refit.json gets, with the saved contracts it
// names, as the files the review and fingerprint read in place of committed ones.
async function generatedInputs(directory: string, contracts: string, allowUntested?: boolean) {
  const { proposal, stops } = await proposeStripeConfiguration(directory, { allowUntested });
  if (!proposal) throw new EnrollmentStopError(stops);
  const contents = new Map([[REPOSITORY_CONFIGURATION, proposalContent(proposal)]]);
  const paths = new Map<string, string>();
  for (const version of new Set([proposal.apiVersion.value, proposal.target])) {
    const contract = await readStripeContract(contracts, version);
    contents.set(stripeContractFile(version), contract.content);
    paths.set(stripeContractFile(version), contract.path);
  }
  return { proposal, contents, paths };
}

async function inspectEnrollmentInputs(options: {
  repository: string;
  github: string;
  base: string;
  integration?: string;
  acceptedApiVersions?: string[];
  contracts?: string;
  allowUntested?: boolean;
}) {
  const target = validateGitHubTarget(options.github, options.base);
  const snapshot = await readCommittedRepository(options.repository);
  const generated = snapshot.entries.some(
    (entry) => entry.slice(entry.indexOf('\t') + 1) === REPOSITORY_CONFIGURATION,
  )
    ? undefined
    : await generatedInputs(
        snapshot.directory,
        options.contracts ?? DEFAULT_CONTRACTS_DIRECTORY,
        options.allowUntested,
      );
  const read = (path: string, maximumBytes: number) => {
    if (!generated) return readCommittedFile(snapshot, path, maximumBytes);
    const content = generated.contents.get(path);
    if (content === undefined)
      throw new PipelineInputError(`The generated configuration has no input ${path}.`);
    return content;
  };
  const contents = new Map<string, string>();
  const configurationContent = await read(
    REPOSITORY_CONFIGURATION,
    MAX_WORKFLOW_CONFIGURATION_BYTES,
  );
  const raw = parseObject(configurationContent, REPOSITORY_CONFIGURATION);
  const configuration = parseWorkflowConfigurations(
    configurationContent,
    join(snapshot.directory, REPOSITORY_CONFIGURATION),
  );
  if (configuration.workflows.some((entry) => Object.hasOwn(entry.settings, 'repository')))
    throw new PipelineInputError(
      'A repository .refit.json must not select another repository. The App-managed checkout supplies its root.',
    );
  if (
    options.integration !== undefined &&
    !configuration.workflows.some((entry) => entry.id === options.integration)
  )
    throw new PipelineInputError(
      'The selected integration is not present in the committed repository profile.',
    );
  const paths: { role: InputRole; path: string; integration?: string }[] = [
    { role: 'workflow', path: REPOSITORY_CONFIGURATION },
  ];
  contents.set(CACHE_FILES.workflow, configurationContent);
  const profiles = [];
  for (const entry of configuration.workflows) {
    const { workflow, settings } = entry;
    const integration = entry.id ?? undefined;
    const baselinePath = inputPath(settings.before);
    const baselineContent = await read(baselinePath, MAX_SPECIFICATION_BYTES);
    const baseline = parseSpecificationInput(baselineContent, baselinePath);
    const baselineInput = {
      role: 'baseline' as const,
      path: baselinePath,
      ...(integration ? { integration } : {}),
    };
    paths.push(baselineInput);
    contents.set(cacheFileName(baselineInput), baselineContent);
    let provider = STRIPE;
    if (settings.providerConfig !== undefined) {
      const adapterPath = inputPath(settings.providerConfig);
      const adapterContent = await read(adapterPath, MAX_WORKFLOW_CONFIGURATION_BYTES);
      provider = parseProviderAdapter(parseObject(adapterContent, adapterPath));
      const adapterInput = {
        role: 'adapter' as const,
        path: adapterPath,
        ...(integration ? { integration } : {}),
      };
      paths.push(adapterInput);
      contents.set(cacheFileName(adapterInput), adapterContent);
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
    if (
      (options.integration === undefined || entry.id === options.integration) &&
      apiVersion.applicability !== 'matches-before' &&
      !options.acceptedApiVersions?.some((version) => declaresVersion(apiVersion.source, version))
    )
      throw new PipelineInputError(
        `${integration ? `Integration ${integration}: ` : ''}${apiVersion.reason}`,
      );
    if (workflow.latestStripe && !baseline.provenance)
      throw new PipelineInputError(
        'Latest Stripe discovery requires a pinned Refit baseline snapshot.',
      );
    let source: { kind: 'file'; path: string } | { kind: 'stripe-latest' };
    if (workflow.latestStripe) source = { kind: 'stripe-latest' };
    else {
      const afterPath = inputPath(settings.after);
      if (options.integration === undefined || entry.id === options.integration) {
        const current = parseSpecificationInput(
          await read(afterPath, MAX_SPECIFICATION_BYTES),
          afterPath,
        );
        if (current.provenance && current.provenance.provider !== provider.id)
          throw new PipelineInputError(
            'Repository after-contract provenance does not match its provider adapter.',
          );
      }
      source = {
        kind: 'file',
        path: generated?.paths.get(afterPath) ?? join(snapshot.directory, afterPath),
      };
    }
    profiles.push({
      id: entry.id,
      workflow: { ...workflow, ...(integration ? { integration } : {}) },
      source,
      apiVersion,
    });
  }
  const files: ApprovedInput[] = paths.map((file) => ({
    ...file,
    sha256: digest(contents.get(cacheFileName(file))!),
    bytes: Buffer.byteLength(contents.get(cacheFileName(file))!),
  }));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new PipelineInputError(
      'Repository workflow, baseline and adapter inputs must be separate committed files.',
    );
  const integrations =
    configuration.formatVersion === 2 ? profiles.map((profile) => profile.id!) : undefined;
  return {
    formatVersion: configuration.formatVersion,
    integrations,
    profiles,
    repository: target.repository.toLowerCase(),
    base: target.base,
    reviewedRevision: snapshot.revision,
    fingerprint: fingerprint(target.repository, target.base, files, integrations),
    files,
    contents,
    generated: generated?.proposal ?? null,
    settings: raw,
    workflow: configuration.formatVersion === 1 ? profiles[0].workflow : undefined,
    source: configuration.formatVersion === 1 ? profiles[0].source : undefined,
    apiVersion: configuration.formatVersion === 1 ? profiles[0].apiVersion : undefined,
  };
}

// The approval `refit enroll --approve` writes and the hosted approval issue stores, valid only for
// the exact fingerprint of the inspected configuration.
export function repositoryApproval(
  enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>,
  fingerprint: string,
): RepositoryApproval {
  if (!HASH.test(fingerprint) || fingerprint !== enrollment.fingerprint)
    throw new RepositoryApprovalError(
      'The supplied approval fingerprint does not match the current committed configuration. Inspect the profile again before approval.',
    );
  return {
    formatVersion: enrollment.formatVersion,
    ...(enrollment.integrations ? { integrations: enrollment.integrations } : {}),
    kind: 'refit-repository-approval',
    repository: enrollment.repository,
    base: enrollment.base,
    fingerprint: enrollment.fingerprint,
    files: enrollment.files,
    reviewedRevision: enrollment.reviewedRevision,
    approvedAt: new Date().toISOString(),
  };
}

export async function approveRepositoryEnrollment(options: {
  enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>;
  fingerprint: string;
  output: string;
}) {
  const approval = repositoryApproval(options.enrollment, options.fingerprint);
  const output = resolve(options.output);
  await standaloneStateDirectory(dirname(output));
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await standaloneStateDirectory(await realpath(dirname(output)));
  await writeFile(output, `${JSON.stringify(approval, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { output, approval };
}

export async function readRepositoryApproval(path: string): Promise<RepositoryApproval> {
  await standaloneStateDirectory(await realpath(dirname(resolve(path))));
  const file = await inspectArtifactFile(path, MAX_APPROVAL_BYTES, true);
  const value = parseObject(file.content, 'Repository approval');
  const multiple = value.formatVersion === 2;
  const expectedKeys = multiple
    ? 'approvedAt,base,files,fingerprint,formatVersion,integrations,kind,repository,reviewedRevision'
    : 'approvedAt,base,files,fingerprint,formatVersion,kind,repository,reviewedRevision';
  if (
    Object.keys(value).sort().join(',') !== expectedKeys ||
    (value.formatVersion !== 1 && value.formatVersion !== 2) ||
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
    value.files.length > (multiple ? 1 + MAX_REPOSITORY_INTEGRATIONS * 2 : ROLES.length)
  )
    throw new PipelineInputError('Repository approval has an invalid format or identity.');
  let integrations: string[] | undefined;
  if (multiple) {
    if (
      !Array.isArray(value.integrations) ||
      !value.integrations.length ||
      value.integrations.length > MAX_REPOSITORY_INTEGRATIONS ||
      !value.integrations.every(validIntegrationId) ||
      new Set(value.integrations).size !== value.integrations.length
    )
      throw new PipelineInputError('Repository approval requires unique integration identifiers.');
    integrations = value.integrations as string[];
  }
  validateGitHubTarget(value.repository, value.base);
  const files = value.files.map((entry, index): ApprovedInput => {
    const scoped = multiple && index > 0;
    if (
      !isObject(entry) ||
      Object.keys(entry).sort().join(',') !==
        (scoped ? 'bytes,integration,path,role,sha256' : 'bytes,path,role,sha256') ||
      !ROLES.includes(entry.role as InputRole) ||
      (index === 0 && entry.role !== 'workflow') ||
      (index > 0 && entry.role === 'workflow') ||
      (!multiple && entry.role !== ROLES[index]) ||
      (scoped &&
        (!validIntegrationId(entry.integration) || !integrations!.includes(entry.integration))) ||
      typeof entry.path !== 'string' ||
      inputPath(entry.path) !== entry.path ||
      (entry.role === 'workflow' && entry.path !== REPOSITORY_CONFIGURATION) ||
      typeof entry.sha256 !== 'string' ||
      !HASH.test(entry.sha256) ||
      typeof entry.bytes !== 'number' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes >
        (entry.role === 'baseline' ? MAX_SPECIFICATION_BYTES : MAX_WORKFLOW_CONFIGURATION_BYTES)
    )
      throw new PipelineInputError('Repository approval contains invalid file evidence.');
    return {
      role: entry.role as InputRole,
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      ...(scoped ? { integration: entry.integration as string } : {}),
    };
  });
  if (integrations) {
    const expected = [
      CACHE_FILES.workflow,
      ...integrations.flatMap((integration) => [
        cacheFileName({ role: 'baseline', integration }),
        ...(files.some((entry) => entry.integration === integration && entry.role === 'adapter')
          ? [cacheFileName({ role: 'adapter', integration })]
          : []),
      ]),
    ];
    if (files.map(cacheFileName).join(',') !== expected.join(','))
      throw new PipelineInputError(
        'Repository approval must contain each integration baseline and its optional adapter in reviewed order.',
      );
  }
  if (
    new Set(files.map((entry) => entry.path)).size !== files.length ||
    fingerprint(value.repository, value.base, files, integrations) !== value.fingerprint
  )
    throw new PipelineInputError(
      'Repository approval fingerprint does not match its file evidence.',
    );
  return {
    formatVersion: value.formatVersion as 1 | 2,
    kind: 'refit-repository-approval',
    repository: value.repository,
    base: value.base,
    fingerprint: value.fingerprint,
    files,
    reviewedRevision: value.reviewedRevision,
    approvedAt: value.approvedAt,
    ...(integrations ? { integrations } : {}),
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
          join(directory, cacheFileName(file)),
          enrollment.contents.get(cacheFileName(file))!,
          { flag: 'wx', mode: 0o600 },
        );
    const names = enrollment.files.map(cacheFileName);
    if ((await readdir(directory)).some((name) => !names.includes(name)))
      throw new PipelineInputError('Approved input cache contains unexpected files.');
    for (const file of enrollment.files) {
      const actual = await inspectArtifactFile(join(directory, cacheFileName(file)), file.bytes);
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
  integration?: string;
  // Versions the code may send instead of the baseline's, such as the target of a merged draft.
  acceptedApiVersions?: string[];
  contracts?: string;
  // Must match the approval's enrollment, or the regenerated configuration refuses again.
  allowUntested?: boolean;
}) {
  if (
    options.approval.formatVersion === 2 &&
    (!options.integration || !options.approval.integrations?.includes(options.integration))
  )
    throw new RepositoryApprovalError(
      'A multi-integration approval requires a selected approved integration.',
    );
  let enrollment: Awaited<ReturnType<typeof inspectRepositoryEnrollment>>;
  try {
    enrollment = await inspectEnrollmentInputs({
      repository: options.repository,
      github: options.approval.repository,
      base: options.approval.base,
      integration: options.integration,
      acceptedApiVersions: options.acceptedApiVersions,
      contracts: options.contracts,
      allowUntested: options.allowUntested,
    });
  } catch (cause) {
    if (!(cause instanceof PipelineInputError)) throw cause;
    throw new RepositoryApprovalError(`Repository configuration needs review: ${cause.message}`, {
      cause,
    });
  }
  if (enrollment.fingerprint !== options.approval.fingerprint) {
    // Nothing generated is committed, so name the move instead of files the person never wrote.
    if (enrollment.generated) {
      const { apiVersion, target } = enrollment.generated;
      throw new RepositoryApprovalError(
        apiVersion.value === target
          ? `Your code now sends Stripe API version ${target}, the newest Refit has a contract for, so there is nothing to move.`
          : `The configuration Refit generates for this repository changed since it was approved: your code now sends Stripe API version ${apiVersion.value}, moving to ${target}. Approve again to run that move.`,
      );
    }
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
  const profile = enrollment.profiles.find((entry) => entry.id === (options.integration ?? null));
  if (!profile)
    throw new RepositoryApprovalError('Selected integration is absent from the approved profile.');
  return {
    workflow: {
      ...profile.workflow,
      before: join(inputs, cacheFileName({ role: 'baseline', integration: options.integration })),
      providerConfig: profile.workflow.providerConfig
        ? join(inputs, cacheFileName({ role: 'adapter', integration: options.integration }))
        : undefined,
    },
    source: profile.source,
    fingerprint: enrollment.fingerprint,
  };
}

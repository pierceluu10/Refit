import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { publicationConfiguration } from './publication.ts';
import { readWorkflowConfiguration, readWorkflowConfigurations } from './workflow-configuration.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { PipelineInputError } from './types.ts';
import type { SpecificationSource } from './openapi-sources.ts';
import { readRepositoryApproval, type RepositoryApproval } from './repository-enrollment.ts';
import {
  documentationSourceId,
  normalizeDocumentationSource,
  MAX_DOCUMENTATION_SOURCES,
  type DocumentationSource,
} from './documentation-sources.ts';

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_TARGETS = 32;
const TARGET_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TARGET_KEYS = new Set([
  'id',
  'repository',
  'base',
  'workflow',
  'approval',
  'source',
  'documentationSources',
  'integrations',
]);

interface ServiceTargetIdentity {
  id: string;
  integration?: string;
  repository: string;
  base: string;
  documentationSources: DocumentationSource[];
}

export type ServiceTarget = ServiceTargetIdentity &
  (
    | {
        workflow: Awaited<ReturnType<typeof readWorkflowConfiguration>>;
        source: SpecificationSource;
        approval?: never;
      }
    | { approval: RepositoryApproval; workflow?: never; source?: SpecificationSource }
  );

export async function readServiceConfiguration(path: string, app: GitHubAppConfiguration) {
  if ((await stat(path)).size > MAX_CONFIGURATION_BYTES)
    throw new PipelineInputError('Service configuration exceeds 64 KiB.');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES)
    throw new PipelineInputError('Service configuration exceeds 64 KiB.');
  const value = parseObject(content, 'Service configuration');
  if (
    value.formatVersion !== 1 ||
    Object.keys(value).some((key) => !['formatVersion', 'targets'].includes(key)) ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > MAX_TARGETS
  )
    throw new PipelineInputError(
      'Service configuration requires formatVersion: 1 and 1–32 explicit targets. Credentials, AI and publication options belong outside the file.',
    );
  const ids = new Set<string>();
  const directory = dirname(resolve(path));
  const targets: ServiceTarget[] = [];
  for (const target of value.targets) {
    const profilePath = isObject(target) ? (target.workflow ?? target.approval) : undefined;
    if (
      !isObject(target) ||
      Object.keys(target).some((key) => !TARGET_KEYS.has(key)) ||
      typeof target.id !== 'string' ||
      !TARGET_ID.test(target.id) ||
      ids.has(target.id) ||
      (target.workflow === undefined) === (target.approval === undefined) ||
      typeof profilePath !== 'string' ||
      !profilePath.trim() ||
      profilePath.includes('\0')
    )
      throw new PipelineInputError(
        'Each service target needs a unique id, GitHub repository/base and exactly one workflow or approval file.',
      );
    const github = publicationConfiguration(
      typeof target.repository === 'string' ? target.repository : undefined,
      typeof target.base === 'string' ? target.base : undefined,
      undefined,
      app,
    );
    const approval =
      target.approval === undefined
        ? undefined
        : await readRepositoryApproval(resolve(directory, profilePath));
    if (
      approval &&
      (approval.repository !== github.repository.toLowerCase() || approval.base !== github.base)
    )
      throw new PipelineInputError(
        'Repository approval belongs to another GitHub repository or base branch.',
      );
    const collection =
      target.workflow === undefined
        ? undefined
        : await readWorkflowConfigurations(resolve(directory, profilePath));
    const entries = approval
      ? (approval.integrations?.map((id) => ({ id, workflow: undefined })) ?? [
          { id: null, workflow: undefined },
        ])
      : collection!.workflows;
    const multiple = approval?.formatVersion === 2 || collection?.formatVersion === 2;
    if (multiple && (target.source !== undefined || target.documentationSources !== undefined))
      throw new PipelineInputError(
        'Multi-integration targets require source and documentation overrides inside integrations, keyed by an approved integration id.',
      );
    if (
      target.integrations !== undefined &&
      (!multiple ||
        !isObject(target.integrations) ||
        Object.keys(target.integrations).some((id) => !entries.some((entry) => entry.id === id)))
    )
      throw new PipelineInputError(
        'Service integration overrides must name configured integrations on a multi-integration target.',
      );
    ids.add(target.id);
    for (const entry of entries) {
      const overrides =
        multiple && isObject(target.integrations) && Object.hasOwn(target.integrations, entry.id!)
          ? target.integrations[entry.id!]
          : multiple
            ? {}
            : target;
      if (
        !isObject(overrides) ||
        (multiple &&
          Object.keys(overrides).some((key) => !['source', 'documentationSources'].includes(key)))
      )
        throw new PipelineInputError(
          'Each integration override may contain only source and documentationSources.',
        );
      const workflow = entry.workflow
        ? { ...entry.workflow, ...(entry.id ? { integration: entry.id } : {}) }
        : undefined;
      const source =
        overrides.source !== undefined
          ? parseServiceSource(overrides.source, directory)
          : workflow
            ? workflow.latestStripe
              ? { kind: 'stripe-latest' as const }
              : { kind: 'file' as const, path: workflow.after! }
            : undefined;
      const documentationSources = parseDocumentationSources(overrides.documentationSources);
      const id = entry.id ? `${target.id}.${entry.id}` : target.id;
      if (entry.id && ids.has(id))
        throw new PipelineInputError('Service target integration ids must be unique.');
      ids.add(id);
      targets.push({
        id,
        ...(entry.id ? { integration: entry.id } : {}),
        repository: github.repository,
        base: github.base,
        documentationSources,
        ...(approval
          ? { approval, ...(source ? { source } : {}) }
          : { workflow: workflow!, source: source! }),
      });
      if (targets.length > MAX_TARGETS)
        throw new PipelineInputError(
          `Service configuration exceeds ${MAX_TARGETS} integration workers after expansion.`,
        );
    }
  }
  return targets;
}

function parseServiceSource(value: unknown, directory: string): SpecificationSource {
  if (!isObject(value)) throw new PipelineInputError('Service source must be an object.');
  if (
    value.kind === 'file' &&
    typeof value.path === 'string' &&
    value.path.trim() &&
    !value.path.includes('\0') &&
    Object.keys(value).sort().join(',') === 'kind,path'
  )
    return { kind: 'file', path: resolve(directory, value.path) };
  if (
    value.kind === 'https' &&
    typeof value.url === 'string' &&
    Object.keys(value).sort().join(',') === 'kind,url'
  ) {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new PipelineInputError(
        'Service sources require a public HTTPS URL without credentials or query parameters.',
      );
    return { kind: 'https', url: url.href };
  }
  if (value.kind === 'stripe-latest' && Object.keys(value).join(',') === 'kind')
    return { kind: 'stripe-latest' };
  throw new PipelineInputError('Service source requires file/path, https/url or stripe-latest.');
}

function parseDocumentationSources(value: unknown): DocumentationSource[] {
  if (value !== undefined && !Array.isArray(value))
    throw new PipelineInputError('Documentation sources must be an array.');
  const sources = ((value ?? []) as unknown[]).map(normalizeDocumentationSource);
  if (
    sources.length > MAX_DOCUMENTATION_SOURCES ||
    new Set(sources.map(documentationSourceId)).size !== sources.length
  )
    throw new PipelineInputError(
      `Each target accepts up to ${MAX_DOCUMENTATION_SOURCES} unique documentation sources.`,
    );
  return sources;
}

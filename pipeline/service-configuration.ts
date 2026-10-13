import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { publicationConfiguration } from './publication.ts';
import { readWorkflowConfiguration } from './workflow-configuration.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { PipelineInputError } from './types.ts';
import type { SpecificationSource } from './openapi-sources.ts';
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
  'source',
  'documentationSources',
]);

export interface ServiceTarget {
  id: string;
  repository: string;
  base: string;
  workflow: Awaited<ReturnType<typeof readWorkflowConfiguration>>;
  source: SpecificationSource;
  documentationSources: DocumentationSource[];
}

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
    if (
      !isObject(target) ||
      Object.keys(target).some((key) => !TARGET_KEYS.has(key)) ||
      typeof target.id !== 'string' ||
      !TARGET_ID.test(target.id) ||
      ids.has(target.id) ||
      typeof target.workflow !== 'string' ||
      !target.workflow.trim() ||
      target.workflow.includes('\0')
    )
      throw new PipelineInputError(
        'Each service target needs a unique id, GitHub repository/base and workflow file.',
      );
    const github = publicationConfiguration(
      typeof target.repository === 'string' ? target.repository : undefined,
      typeof target.base === 'string' ? target.base : undefined,
      undefined,
      app,
    );
    const workflow = await readWorkflowConfiguration(resolve(directory, target.workflow));
    let source: SpecificationSource = workflow.latestStripe
      ? { kind: 'stripe-latest' }
      : { kind: 'file', path: workflow.after! };
    if (target.source !== undefined) {
      if (!isObject(target.source))
        throw new PipelineInputError('Service source must be an object.');
      const input = target.source;
      if (
        input.kind === 'file' &&
        typeof input.path === 'string' &&
        input.path.trim() &&
        !input.path.includes('\0') &&
        Object.keys(input).sort().join(',') === 'kind,path'
      )
        source = { kind: 'file', path: resolve(directory, input.path) };
      else if (
        input.kind === 'https' &&
        typeof input.url === 'string' &&
        Object.keys(input).sort().join(',') === 'kind,url'
      ) {
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
          throw new PipelineInputError(
            'Service sources require a public HTTPS URL without credentials or query parameters.',
          );
        source = { kind: 'https', url: url.href };
      } else if (input.kind === 'stripe-latest' && Object.keys(input).join(',') === 'kind')
        source = { kind: 'stripe-latest' };
      else
        throw new PipelineInputError(
          'Service source requires file/path, https/url or stripe-latest.',
        );
    }
    if (target.documentationSources !== undefined && !Array.isArray(target.documentationSources))
      throw new PipelineInputError('Documentation sources must be an array.');
    const documentationSources = (target.documentationSources ?? []).map(
      normalizeDocumentationSource,
    );
    if (
      documentationSources.length > MAX_DOCUMENTATION_SOURCES ||
      new Set(documentationSources.map(documentationSourceId)).size !== documentationSources.length
    )
      throw new PipelineInputError(
        `Each target accepts up to ${MAX_DOCUMENTATION_SOURCES} unique documentation sources.`,
      );
    ids.add(target.id);
    targets.push({
      id: target.id,
      repository: github.repository,
      base: github.base,
      workflow,
      source,
      documentationSources,
    });
  }
  return targets;
}

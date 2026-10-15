import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { validateCheckCommand, validateWorkflowSources } from './validation-options.ts';
import { validateApiVersionPolicy } from './api-version.ts';

export const MAX_WORKFLOW_CONFIGURATION_BYTES = 64 * 1024;
export const REPOSITORY_CONFIGURATION = '.refit.json';
export const MAX_REPOSITORY_INTEGRATIONS = 8;
const INTEGRATION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONFIGURATION_KEYS = new Set([
  'formatVersion',
  'repository',
  'before',
  'after',
  'latestStripe',
  'image',
  'command',
  'baselineCommand',
  'providerConfig',
  'apiVersion',
  'apiVersionPolicy',
  'fullDiff',
  'prepareDependencies',
  'generatedChecks',
]);
const GENERATED_CHECK_KEYS = 'afterFixtures,beforeFixtures,stripeMockImage';

export async function readWorkflowConfigurations(path: string) {
  if ((await stat(path)).size > MAX_WORKFLOW_CONFIGURATION_BYTES)
    throw new PipelineInputError('Run configuration exceeds 64 KiB.');
  const content = await readFile(path, 'utf8');
  return parseWorkflowConfigurations(content, path);
}

export async function readWorkflowConfiguration(path: string, integration?: string) {
  return selectWorkflowConfiguration(await readWorkflowConfigurations(path), integration);
}

export function parseWorkflowConfiguration(content: string, path: string, integration?: string) {
  return selectWorkflowConfiguration(parseWorkflowConfigurations(content, path), integration);
}

export function validIntegrationId(value: unknown): value is string {
  return typeof value === 'string' && INTEGRATION_ID.test(value);
}

export function parseWorkflowConfigurations(content: string, path: string) {
  if (Buffer.byteLength(content) > MAX_WORKFLOW_CONFIGURATION_BYTES)
    throw new PipelineInputError('Run configuration exceeds 64 KiB.');
  const value = parseObject(content, 'Run configuration');
  if (value.formatVersion === 2) {
    if (
      Object.keys(value).sort().join(',') !== 'formatVersion,integrations' ||
      !Array.isArray(value.integrations) ||
      !value.integrations.length ||
      value.integrations.length > MAX_REPOSITORY_INTEGRATIONS
    )
      throw new PipelineInputError(
        `Repository configuration requires formatVersion: 2 and 1–${MAX_REPOSITORY_INTEGRATIONS} integrations; repository selection, AI and publication stay outside the file.`,
      );
    const seen = new Set<string>();
    const workflows = value.integrations.map((entry) => {
      if (
        !isObject(entry) ||
        !validIntegrationId(entry.id) ||
        seen.has(entry.id) ||
        Object.hasOwn(entry, 'formatVersion') ||
        Object.hasOwn(entry, 'repository')
      )
        throw new PipelineInputError(
          'Each repository integration requires a unique lowercase identifier and workflow settings without formatVersion or repository.',
        );
      const { id, ...settings } = entry;
      seen.add(id);
      return {
        id,
        settings,
        workflow: parseSingleWorkflowConfiguration({ ...settings, formatVersion: 1 }, path),
      };
    });
    return { formatVersion: 2 as const, workflows };
  }
  return {
    formatVersion: 1 as const,
    workflows: [
      { id: null, settings: value, workflow: parseSingleWorkflowConfiguration(value, path) },
    ],
  };
}

function selectWorkflowConfiguration(
  configuration: ReturnType<typeof parseWorkflowConfigurations>,
  integration?: string,
): ReturnType<typeof parseSingleWorkflowConfiguration> & { integration?: string } {
  if (configuration.formatVersion === 1) {
    if (integration !== undefined)
      throw new PipelineInputError(
        'A formatVersion: 1 workflow has no named integrations; omit --integration.',
      );
    return configuration.workflows[0].workflow;
  }
  if (!integration || !validIntegrationId(integration))
    throw new PipelineInputError(
      `Choose --integration from: ${configuration.workflows.map((entry) => entry.id).join(', ')}.`,
    );
  const selected = configuration.workflows.find((entry) => entry.id === integration);
  if (!selected)
    throw new PipelineInputError(
      `Unknown integration ${integration}; choose from: ${configuration.workflows.map((entry) => entry.id).join(', ')}.`,
    );
  return { ...selected.workflow, integration };
}

function parseSingleWorkflowConfiguration(value: Record<string, unknown>, path: string) {
  const unknown = Object.keys(value).filter((key) => !CONFIGURATION_KEYS.has(key));
  if (unknown.length)
    throw new PipelineInputError(
      `Unknown run configuration fields: ${unknown.join(', ')}. Output, AI and publication options belong on the command line; credentials belong in the environment.`,
    );
  if (value.formatVersion !== 1)
    throw new PipelineInputError('Run configuration requires formatVersion: 1.');
  const string = (key: string): string => {
    const field = value[key];
    if (typeof field !== 'string' || !field.trim() || field.includes('\0'))
      throw new PipelineInputError(`Run configuration requires a nonempty ${key} string.`);
    return field;
  };
  if (value.latestStripe !== undefined && typeof value.latestStripe !== 'boolean')
    throw new PipelineInputError('Run configuration latestStripe must be a boolean.');
  if (value.fullDiff !== undefined && typeof value.fullDiff !== 'boolean')
    throw new PipelineInputError('Run configuration fullDiff must be a boolean.');
  if (value.prepareDependencies !== undefined && typeof value.prepareDependencies !== 'boolean')
    throw new PipelineInputError('Run configuration prepareDependencies must be a boolean.');
  if ((value.after !== undefined) === Boolean(value.latestStripe))
    throw new PipelineInputError(
      'Run configuration requires exactly one of after or latestStripe.',
    );
  const directory = dirname(resolve(path));
  const generated = value.generatedChecks;
  if (
    generated !== undefined &&
    (!isObject(generated) ||
      Object.keys(generated).sort().join(',') !== GENERATED_CHECK_KEYS ||
      Object.values(generated).some(
        (field) => typeof field !== 'string' || !field.trim() || field.includes('\0'),
      ))
  )
    throw new PipelineInputError(
      'Run configuration generatedChecks requires stripeMockImage, beforeFixtures and afterFixtures strings.',
    );
  validateWorkflowSources({
    after: value.after === undefined ? undefined : string('after'),
    latestStripe: value.latestStripe as boolean | undefined,
    providerConfig: value.providerConfig === undefined ? undefined : string('providerConfig'),
  });
  return {
    repository:
      value.repository === undefined ? undefined : resolve(directory, string('repository')),
    before: resolve(directory, string('before')),
    after: value.after === undefined ? undefined : resolve(directory, string('after')),
    latestStripe: value.latestStripe as boolean | undefined,
    image: string('image'),
    command: validateCheckCommand(value.command),
    baselineCommand:
      value.baselineCommand === undefined ? undefined : validateCheckCommand(value.baselineCommand),
    providerConfig:
      value.providerConfig === undefined ? undefined : resolve(directory, string('providerConfig')),
    apiVersion: value.apiVersion === undefined ? undefined : string('apiVersion'),
    ...(value.apiVersionPolicy === undefined
      ? {}
      : { apiVersionPolicy: validateApiVersionPolicy(value.apiVersionPolicy) }),
    fullDiff: value.fullDiff as boolean | undefined,
    ...(value.prepareDependencies ? { prepareDependencies: true } : {}),
    ...(isObject(generated)
      ? {
          generatedChecks: {
            stripeMockImage: generated.stripeMockImage as string,
            beforeFixtures: resolve(directory, generated.beforeFixtures as string),
            afterFixtures: resolve(directory, generated.afterFixtures as string),
          },
        }
      : {}),
  };
}

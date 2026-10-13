import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { validateCheckCommand } from './validation-options.ts';

const MAX_CONFIGURATION_BYTES = 64 * 1024;
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
  'fullDiff',
]);

export async function readWorkflowConfiguration(path: string) {
  if ((await stat(path)).size > MAX_CONFIGURATION_BYTES)
    throw new PipelineInputError('Run configuration exceeds 64 KiB.');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES)
    throw new PipelineInputError('Run configuration exceeds 64 KiB.');
  const value = parseObject(content, 'Run configuration');
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
  if ((value.after !== undefined) === Boolean(value.latestStripe))
    throw new PipelineInputError(
      'Run configuration requires exactly one of after or latestStripe.',
    );
  const directory = dirname(resolve(path));
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
    fullDiff: value.fullDiff as boolean | undefined,
  };
}

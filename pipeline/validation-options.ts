import { PipelineInputError } from './types.ts';

export const MAX_REPAIR_ATTEMPTS = 2;

export function validateWorkflowSources(options: {
  after?: string;
  latestStripe?: boolean;
  providerConfig?: string;
}) {
  if (Boolean(options.after) === Boolean(options.latestStripe))
    throw new PipelineInputError('Choose exactly one of --after or --latest-stripe.');
  if (options.latestStripe && options.providerConfig)
    throw new PipelineInputError('--latest-stripe cannot be combined with a custom provider.');
}

export function validateRepairAttempts(value: number, aiEnabled: boolean) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REPAIR_ATTEMPTS)
    throw new PipelineInputError(
      `Repair attempts must be an integer from 0 to ${MAX_REPAIR_ATTEMPTS}.`,
    );
  if (value > 0 && !aiEnabled) throw new PipelineInputError('Repair attempts require --ai-patch.');
  return value;
}

export function validateCheckCommand(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
  )
    throw new PipelineInputError(
      'Validation command must be a nonempty JSON array of nonempty strings without NUL characters.',
    );
  return value;
}

export function parseCheckCommand(content: string, option = '--command') {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause) {
    throw new PipelineInputError(`${option} must be a JSON array.`, { cause });
  }
  return validateCheckCommand(value);
}

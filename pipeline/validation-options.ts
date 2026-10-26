import { PipelineInputError } from './types.ts';

export const MAX_REPAIR_ATTEMPTS = 2;
// What the hosted worker runs (fly.toml REFIT_HOSTED_FLAGS); AI benchmarks default to it.
export const HOSTED_REPAIR_ATTEMPTS = 2;
// Seconds one check (baseline, patched or generated) may run before its container is stopped.
// The default is set from measured durations in docs/DEPENDENCIES.md ("Check time limit").
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
const MIN_CHECK_TIMEOUT_SECONDS = 30;
const MAX_CHECK_TIMEOUT_SECONDS = 1800;

export function validateCheckTimeout(value: unknown = DEFAULT_CHECK_TIMEOUT_SECONDS) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CHECK_TIMEOUT_SECONDS ||
    value > MAX_CHECK_TIMEOUT_SECONDS
  )
    throw new PipelineInputError(
      `checkTimeoutSeconds must be a whole number from ${MIN_CHECK_TIMEOUT_SECONDS} to ${MAX_CHECK_TIMEOUT_SECONDS}.`,
    );
  return value;
}

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

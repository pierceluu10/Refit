import { PipelineInputError } from './types.ts';

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

export function parseCheckCommand(content: string) {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause) {
    throw new PipelineInputError('--command must be a JSON array.', { cause });
  }
  return validateCheckCommand(value);
}

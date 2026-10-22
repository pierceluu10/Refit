import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { cliErrorMessage } from './cli-errors.ts';
import { DependencyPreparationError } from './dependency-preparation.ts';
import { PipelineInputError } from './types.ts';

const thrown = async (work: () => unknown) => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected an error');
};

it('prints input the person can fix as a plain sentence naming the command', async () => {
  expect(cliErrorMessage(new PipelineInputError('No .refit.json at /app.'), 'run')).toBe(
    'refit run: No .refit.json at /app.',
  );
  expect(cliErrorMessage(new DependencyPreparationError('Archive too large.'), 'prepare')).toBe(
    'refit prepare: Archive too large.',
  );
  // Before: "TypeError: Unknown option '--bogus'".
  const option = await thrown(() =>
    parseArgs({ args: ['--bogus'], options: { json: { type: 'boolean' } } }),
  );
  expect(cliErrorMessage(option, 'doctor')).toBe(
    "refit doctor: Unknown option '--bogus'. Run refit doctor --help for its options.",
  );
  // Before: "Error: ENOENT: no such file or directory, realpath '/nonexistent'".
  const missing = await thrown(() => realpath('/refit-missing-repository'));
  expect(cliErrorMessage(missing, 'deadlines')).toBe(
    'refit deadlines: /refit-missing-repository does not exist.',
  );
});

it('keeps the class name of an unexpected error, and strips control characters', () => {
  expect(cliErrorMessage(new RangeError('Invalid array length'), 'scan')).toBe(
    'RangeError: Invalid array length',
  );
  expect(cliErrorMessage(new PipelineInputError('a\nb\u001b[31m'), 'run')).toBe(
    'refit run: a b [31m',
  );
});

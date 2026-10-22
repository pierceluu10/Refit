import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);

// A benchmark root built before setup checked its clones can hold an empty checkout where a fetch
// failed (a repository deleted upstream), which would read as a repository with no SDK calls.
export async function requireCheckout(directory: string, commit: string, setup: string) {
  const head = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );
  if (head !== commit) throw new PipelineInputError(`No checkout at ${commit}; rerun ${setup}.`);
}

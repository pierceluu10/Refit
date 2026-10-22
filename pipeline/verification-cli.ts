import { parseArgs } from 'node:util';
import { verifyArtifacts } from './verification.ts';
import { PipelineInputError } from './types.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit verify --directory <workflow-or-review-or-stripe-check-directory>\nChecks recorded SHA-256 hashes and byte counts without executing code or accessing the network. Unsigned manifests do not authenticate their producer or prove migration correctness.';
try {
  const { values } = parseArgs({
    options: { directory: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) console.log(USAGE);
  else {
    if (!values.directory) throw new PipelineInputError(USAGE);
    console.log(JSON.stringify(await verifyArtifacts(values.directory), null, 2));
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'verify'));
  process.exitCode = 1;
}

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { captureSpecification } from './openapi-sources.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: refit source-snapshot --provider <id> (--url <public-https-openapi> | --file <openapi.json-or-yaml>) --output <new-snapshot.json>';
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PRIVATE_FILE_MODE = 0o600;

try {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      url: { type: 'string' },
      file: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(USAGE);
  } else {
    if (!values.provider || !PROVIDER_ID.test(values.provider))
      throw new PipelineInputError(
        'Provider ID must start with a lowercase letter and use only lowercase letters, numbers or hyphens.',
      );
    if (!values.output) throw new PipelineInputError('Supply --output with a new snapshot path.');
    const hasUrl = values.url !== undefined;
    const hasFile = values.file !== undefined;
    if (hasUrl === hasFile)
      throw new PipelineInputError('Supply exactly one source with --url or --file.');

    const source = hasUrl
      ? { kind: 'https' as const, url: values.url! }
      : { kind: 'file' as const, path: values.file! };
    const snapshot = await captureSpecification(source, values.provider);
    const output = resolve(values.output);
    await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });

    console.log(`Saved ${snapshot.provider} OpenAPI snapshot`);
    console.log(`Revision  ${snapshot.revision}`);
    console.log(`Source    ${snapshot.url}`);
    console.log(`Output    ${output}`);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fetchStripeSnapshot } from './snapshots.ts';
import { MAX_SPECIFICATION_BYTES } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: npm run stripe:snapshot -- --revision <full-commit-sha> --output <new-snapshot.json>';

try {
  const { values } = parseArgs({
    options: {
      revision: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (!values.revision || !values.output) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const snapshot = await fetchStripeSnapshot(values.revision);
    const encoded = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(encoded) > MAX_SPECIFICATION_BYTES)
      throw new PipelineInputError('Encoded snapshot exceeds the 64 MiB input limit.');
    await writeFile(values.output, encoded, { flag: 'wx' });
    console.log(
      JSON.stringify(
        {
          output: values.output,
          provider: snapshot.provider,
          revision: snapshot.revision,
          url: snapshot.url,
          hash: snapshot.hash,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: refit stripe-snapshot (--revision <full-commit-sha> | --latest) --output <new-snapshot.json>';

try {
  const { values } = parseArgs({
    options: {
      revision: { type: 'string' },
      latest: { type: 'boolean' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if ((!values.revision && !values.latest) || !values.output) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    if (values.revision && values.latest)
      throw new PipelineInputError('Choose --revision or --latest, not both.');
    const snapshot = await fetchStripeSnapshot(values.revision ?? (await discoverStripeRevision()));
    await writeFile(values.output, encodeSnapshot(snapshot), { flag: 'wx', mode: 0o600 });
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

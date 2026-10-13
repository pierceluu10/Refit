import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  MAX_DEPRECATION_SNAPSHOT_BYTES,
  buildDeprecationSnapshot,
  encodeDeprecationSnapshot,
  readDeprecationSnapshot,
} from './deprecation-snapshots.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: refit ai-snapshot (--input <hand-curated.json> --output <new-snapshot.json> | --verify <snapshot.json>)';

async function readInput(path: string): Promise<unknown> {
  if ((await stat(path)).size > MAX_DEPRECATION_SNAPSHOT_BYTES)
    throw new PipelineInputError(`${path} exceeds the 1 MiB deprecation snapshot input limit.`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new PipelineInputError(`${path} is not valid JSON.`, { cause });
  }
}

try {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      verify: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
  } else if (
    (values.verify && (values.input || values.output)) ||
    (!values.verify && (!values.input || !values.output))
  ) {
    console.error(USAGE);
    process.exitCode = 1;
  } else if (values.verify) {
    const snapshot = await readDeprecationSnapshot(values.verify);
    console.log(
      JSON.stringify(
        {
          verified: values.verify,
          provider: snapshot.provider,
          models: snapshot.models.length,
          sha256: snapshot.source.sha256,
        },
        null,
        2,
      ),
    );
  } else {
    const snapshot = buildDeprecationSnapshot(await readInput(values.input!), values.input);
    await writeFile(values.output!, encodeDeprecationSnapshot(snapshot), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          output: values.output,
          provider: snapshot.provider,
          models: snapshot.models.length,
          sha256: snapshot.source.sha256,
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

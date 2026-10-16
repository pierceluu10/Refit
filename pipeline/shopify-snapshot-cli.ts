import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fetchShopifySnapshot } from './shopify-schemas.ts';

const USAGE =
  'Usage: refit shopify-snapshot --version <YYYY-MM> --output <new-snapshot.json>\nDownloads one supported Shopify Admin API version schema from the public documentation proxy. No store, credentials or store operation are involved.';

try {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (!values.version || !values.output) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const snapshot = await fetchShopifySnapshot(values.version);
    await writeFile(values.output, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify(
        {
          output: values.output,
          provider: snapshot.provider,
          version: snapshot.version,
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

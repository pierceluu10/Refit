import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { pinnedShopifyDiff, shopifyDiffFile } from './shopify-schema-diff.ts';
import {
  fetchShopifySnapshot,
  normalizedIntrospection,
  pinnedShopifyVersions,
  SHOPIFY_APIS,
  shopifySchemaFile,
  type ShopifyApi,
  type ShopifySchemaPin,
} from './shopify-schemas.ts';
import { cliErrorMessage } from './cli-errors.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const USAGE = `Usage: refit shopify-snapshot --version <YYYY-MM> --output <new-snapshot.json>
       refit shopify-snapshot --pin --api <admin|storefront> --version <YYYY-MM>
       refit shopify-snapshot --diffs
       refit shopify-snapshot --pin --api <api> --version <YYYY-MM> --file <schema.json> --package <name@release> --path <path in package> --integrity <sha512-...>
Downloads one supported Shopify Admin API version schema from the public documentation proxy. No store, credentials or store operation are involved.
--pin saves the schema gzipped in data/shopify-schemas/<api>/<version>.json.gz and records its SHA-256 and source in data/shopify-schema-versions.json: downloaded from the proxy (admin and storefront), or read from a file unpacked from a Shopify npm tarball (npm pack <name@release> --ignore-scripts), named with the tarball's integrity.
--diffs writes data/shopify-schema-diffs/<api>/<version>.json for every pinned version, the changes from the pinned version before it.`;
const PINS = new URL('../data/shopify-schema-versions.json', import.meta.url);

try {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      output: { type: 'string' },
      pin: { type: 'boolean' },
      api: { type: 'string', default: 'admin' },
      file: { type: 'string' },
      package: { type: 'string' },
      path: { type: 'string' },
      integrity: { type: 'string' },
      diffs: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (values.diffs)
    for (const api of SHOPIFY_APIS)
      for (const version of pinnedShopifyVersions(api).slice(1)) {
        const diff = pinnedShopifyDiff(api, version);
        const file = shopifyDiffFile(api, version);
        await mkdir(new URL('.', file), { recursive: true });
        await writeFile(file, `${JSON.stringify(diff, null, 2)}\n`);
        console.log(`${api} ${diff.previous} -> ${version}: ${diff.changes.length} changes`);
      }
  else if (values.pin && values.version) await pin(values);
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
  console.error(cliErrorMessage(error, 'shopify-snapshot'));
  process.exitCode = 1;
}

async function pin(values: Record<string, string | boolean | undefined>) {
  const api = values.api as ShopifyApi;
  const version = values.version as string;
  if (!SHOPIFY_APIS.includes(api)) throw new PipelineInputError(USAGE);
  let content: string;
  let source: ShopifySchemaPin['source'];
  if (values.file) {
    const [, name, release] = /^(@?[^@]+)@(.+)$/.exec(String(values.package ?? '')) ?? [];
    if (!name || !values.path || !/^sha512-/.test(String(values.integrity ?? '')))
      throw new PipelineInputError(`--file needs --package, --path and --integrity.\n${USAGE}`);
    content = normalizedIntrospection(await readFile(values.file as string, 'utf8'));
    source = {
      package: name,
      release,
      path: values.path as string,
      integrity: values.integrity as string,
    };
  } else {
    if (api === 'customer-account')
      throw new PipelineInputError('Shopify publishes no Customer Account proxy; pin a --file.');
    const snapshot = await fetchShopifySnapshot(version, api);
    content = snapshot.content;
    source = { url: snapshot.url, fetchedAt: new Date().toISOString().slice(0, 10) };
  }
  const file = shopifySchemaFile(api, version);
  await mkdir(new URL('.', file), { recursive: true });
  // zlib writes no timestamp, so identical content gives identical bytes.
  await writeFile(file, gzipSync(content, { level: 9 }));
  const pins = JSON.parse(readFileSync(PINS, 'utf8')) as {
    formatVersion: 1;
    schemas: ShopifySchemaPin[];
  };
  const entry: ShopifySchemaPin = { api, version, sha256: digest(content), source };
  pins.schemas = [
    ...pins.schemas.filter((item) => item.api !== api || item.version !== version),
    entry,
  ].sort((left, right) =>
    left.api === right.api
      ? left.version.localeCompare(right.version)
      : SHOPIFY_APIS.indexOf(left.api) - SHOPIFY_APIS.indexOf(right.api),
  );
  writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
  console.log(JSON.stringify(entry, null, 2));
}

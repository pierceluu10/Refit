// Builds data/aws-sdk-v2-clients.json: every service client of the AWS SDK for JavaScript v2
// (`aws-sdk`), with the `aws-sdk/clients/<id>` path it loads from and the v3 package that replaces
// it. The v2 package is read as JSON from an unpacked npm tarball and never executed or installed.
// Each v3 name comes from the service's `serviceId` in v2's own API model, which is the name v3's
// code generator turns into `@aws-sdk/client-<service-id>`; every derived name is then checked
// against the npm registry, and a name npm does not have is recorded as null rather than guessed.
//
//   npm pack aws-sdk@2.1693.0 --ignore-scripts && tar xzf aws-sdk-2.1693.0.tgz -C aws-sdk
//   node scripts/aws-sdk-clients.mjs --sdk aws-sdk/package --checked-at 2026-10-22 \
//     --output data/aws-sdk-v2-clients.json
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org';
const CONCURRENCY = 16;
const { values } = parseArgs({
  options: {
    sdk: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.sdk ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/aws-sdk-clients.mjs --sdk <unpacked aws-sdk dir> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

const manifest = JSON.parse(await readFile(join(values.sdk, 'package.json'), 'utf8'));
if (manifest.name !== 'aws-sdk') throw new Error(`${values.sdk} is not aws-sdk.`);
const metadata = JSON.parse(await readFile(join(values.sdk, 'apis', 'metadata.json'), 'utf8'));
const models = (await readdir(join(values.sdk, 'apis'))).filter((file) =>
  file.endsWith('.min.json'),
);

// The newest API model of a service: `apis/<prefix>-<yyyy-mm-dd>.min.json`.
async function serviceId(prefix) {
  const files = models
    .filter((file) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.min\\.json$`).test(file))
    .sort();
  if (!files.length) return null;
  const model = JSON.parse(await readFile(join(values.sdk, 'apis', files.at(-1)), 'utf8'));
  return model.metadata?.serviceId ?? null;
}

async function published(name) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
      method: 'HEAD',
    });
    if (response.ok) return true;
    if (response.status === 404) return false;
    if (attempt >= 3) throw new Error(`${name}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
}

const clients = [];
for (const [id, entry] of Object.entries(metadata)) {
  const service = await serviceId(entry.prefix ?? id);
  const candidate = service
    ? `@aws-sdk/client-${service.toLowerCase().replace(/[\s_]+/g, '-')}`
    : null;
  clients.push({ name: entry.name, id, serviceId: service, candidate });
}
for (let start = 0; start < clients.length; start += CONCURRENCY) {
  const batch = clients.slice(start, start + CONCURRENCY);
  const found = await Promise.all(
    batch.map((client) => (client.candidate ? published(client.candidate) : false)),
  );
  batch.forEach((client, index) => {
    client.v3Package = found[index] ? client.candidate : null;
  });
}
clients.sort((a, b) => a.name.localeCompare(b.name));
const missing = clients.filter((client) => !client.v3Package).map((client) => client.name);
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/aws-sdk-clients.mjs',
      checkedAt: values['checked-at'],
      package: 'aws-sdk',
      version: manifest.version,
      deprecated:
        (await (await fetch(`${REGISTRY}/aws-sdk/${manifest.version}`)).json()).deprecated ?? null,
      clients: Object.fromEntries(
        clients.map((client) => [
          client.name,
          { id: client.id, serviceId: client.serviceId, v3Package: client.v3Package },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
console.error(
  `${clients.length} v2 clients; ${missing.length} without a published v3 package: ${missing.join(', ')}`,
);

// Builds data/stripe-openapi-versions.json: for each Stripe API version a frozen benchmark list pins
// to a stripe/openapi tag, the commit behind that tag and the SHA-256 of its openapi/spec3.json.
// Enrollment uses it to name the contract a repository's pinned API version needs
// (pipeline/enrollment-contracts.ts). Every spec is downloaded and its info.version checked.
//
//   node scripts/stripe-openapi-versions.mjs --checked-at 2026-10-24 \
//     --output data/stripe-openapi-versions.json [--contracts ~/.refit/contracts]
//
// --contracts also saves each spec as the snapshot enrollment reads, so a later run needs no download.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const LISTS = 'docs/benchmarks';
const COMMITS = 'https://api.github.com/repos/stripe/openapi/commits';
const RAW = 'https://raw.githubusercontent.com/stripe/openapi';
const SPEC_PATH = 'openapi/spec3.json';
const { values } = parseArgs({
  options: {
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    contracts: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') || !values.output) {
  console.log(
    'Usage: node scripts/stripe-openapi-versions.mjs --checked-at YYYY-MM-DD --output data/stripe-openapi-versions.json [--contracts <dir>]',
  );
  process.exit(values.help ? 0 : 1);
}

const tags = new Map();
for (const name of (await readdir(LISTS)).filter((file) => file.endsWith('.json'))) {
  const list = JSON.parse(await readFile(join(LISTS, name), 'utf8'));
  for (const { version, tag } of Array.isArray(list.specs) ? list.specs : []) {
    if (tags.has(version) && tags.get(version) !== tag)
      throw new Error(`${name} pins ${version} to ${tag}, another list to ${tags.get(version)}.`);
    tags.set(version, tag);
  }
}

async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

const versions = [];
for (const [version, tag] of [...tags].sort(([a], [b]) => a.localeCompare(b))) {
  const { sha: commit } = await json(`${COMMITS}/${tag}`);
  const url = `${RAW}/${commit}/${SPEC_PATH}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const content = await response.text();
  const found = JSON.parse(content).info?.version;
  if (found !== version) throw new Error(`stripe/openapi ${tag} is ${found}, not ${version}.`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  versions.push({ version, tag, commit, sha256, bytes: Buffer.byteLength(content) });
  if (values.contracts) {
    const directory = join(resolve(values.contracts), 'refit');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshot = {
      formatVersion: 1,
      kind: 'refit-snapshot',
      provider: 'stripe',
      revision: commit,
      url,
      hash: sha256,
      content,
    };
    await writeFile(join(directory, `stripe-${version}.json`), `${JSON.stringify(snapshot)}\n`, {
      mode: 0o600,
    });
  }
  console.error(`${version} ${tag} ${commit}`);
}
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      source: 'https://github.com/stripe/openapi',
      checkedAt: values['checked-at'],
      versions,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ output: values.output, versions: versions.length }, null, 2));

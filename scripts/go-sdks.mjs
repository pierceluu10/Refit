// Generates data/go-sdks.json for the Go tracer (pipeline/go/): the Stripe API version each
// stripe-go release (v70 and later) pins, and the model constants of the latest openai-go and
// anthropic-sdk-go release of each major. Release lists come from proxy.golang.org; source files are
// read from raw.githubusercontent.com at each release tag. Nothing is installed or built.
//
//   node scripts/go-sdks.mjs --output data/go-sdks.json
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const PROXY = 'https://proxy.golang.org';
const RAW = 'https://raw.githubusercontent.com';
const STRIPE_MAJORS = Array.from({ length: 20 }, (_, index) => 70 + index);
const CONCURRENCY = 8;
const { values } = parseArgs({
  options: { output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help || !values.output) {
  console.log('Usage: node scripts/go-sdks.mjs --output data/go-sdks.json');
  process.exit(values.help ? 0 : 1);
}

async function text(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.text();
    if (response.status === 404 || response.status === 410) return undefined;
    if (attempt >= 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
}

async function versions(module) {
  const list = (await text(`${PROXY}/${module}/@v/list`)) ?? '';
  return list
    .split('\n')
    .filter((version) => /^v\d+\.\d+\.\d+$/.test(version))
    .sort((a, b) => {
      const [x, y] = [a, b].map((version) => version.slice(1).split('.').map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
}

async function mapLimit(items, run) {
  const results = [];
  for (let start = 0; start < items.length; start += CONCURRENCY)
    results.push(...(await Promise.all(items.slice(start, start + CONCURRENCY).map(run))));
  return results;
}

// stripe-go declares the version in api_version.go (`apiVersion` before v84, `APIVersion` after).
const STRIPE_VERSION = /\b(?:apiVersion|APIVersion)\s+string\s*=\s*"([^"]+)"/;
const stripe = {};
for (const major of STRIPE_MAJORS) {
  const module = `github.com/stripe/stripe-go/v${major}`;
  const releases = await versions(module);
  if (!releases.length) continue;
  const pins = await mapLimit(releases, async (release) => {
    for (const file of ['api_version.go', 'stripe.go']) {
      const source = await text(`${RAW}/stripe/stripe-go/${release}/${file}`);
      const match = source && STRIPE_VERSION.exec(source);
      if (match) return [release, match[1]];
    }
    throw new Error(`No API version found in stripe-go ${release}.`);
  });
  stripe[module] = Object.fromEntries(pins);
  console.error(`${module}: ${releases.length} releases`);
}

// `ChatModelGPT4o ChatModel = "gpt-4o"`: exported string constants of a model type, across every
// release of the module, since code pinned to an old release names constants later ones removed.
const MODEL_CONSTANT = /^\s*([A-Z]\w*)\s+(\w*Model)\s*=\s*"([^"]+)"/gm;
async function modelConstants(repository, module, files) {
  const releases = await versions(module);
  if (!releases.length) return undefined;
  const sources = await mapLimit(releases, async (release) =>
    Promise.all(files.map((file) => text(`${RAW}/${repository}/${release}/${file}`))),
  );
  const constants = {};
  for (const [index, found] of sources.entries())
    for (const source of found)
      for (const match of (source ?? '').matchAll(MODEL_CONSTANT)) {
        if (constants[match[1]] !== undefined && constants[match[1]] !== match[3])
          throw new Error(`${module} ${releases[index]}: ${match[1]} changed value.`);
        constants[match[1]] = match[3];
      }
  return { releases: [releases[0], releases.at(-1)], constants };
}

const openai = {};
for (const module of [
  'github.com/openai/openai-go',
  'github.com/openai/openai-go/v2',
  'github.com/openai/openai-go/v3',
]) {
  const found = await modelConstants('openai/openai-go', module, ['shared/shared.go']);
  if (found) openai[module] = found;
}
const anthropic = {};
for (const module of ['github.com/anthropics/anthropic-sdk-go']) {
  const found = await modelConstants('anthropics/anthropic-sdk-go', module, ['message.go']);
  if (found) anthropic[module] = found;
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      source:
        'proxy.golang.org release lists; api_version.go or stripe.go, shared/shared.go and message.go at each release tag on raw.githubusercontent.com',
      stripe,
      openai,
      anthropic,
    },
    null,
    2,
  )}\n`,
);

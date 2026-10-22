// Prints what a person reads to label a repository blind for the package inventory benchmark:
// every dependency-declaring file (manifests Refit reads and ones it does not, such as setup.py and
// *.gemspec) and each line in them that names a catalog provider. It imports no pipeline code and
// uses no Refit output, so labels made from it do not depend on the parsers being measured.
// The sample is drawn with a fixed seed, stratified by ecosystem.
//
//   node scripts/package-inventory-label-candidates.mjs --list <frozen.json> --root <clones> \
//     --per-ecosystem 5 --seed 20261022 [--exclude <labels.json>] [--sample-only]
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    'per-ecosystem': { type: 'string', default: '5' },
    seed: { type: 'string', default: '20261022' },
    'sample-only': { type: 'boolean' },
    // Labels already made: their repositories are left out of this draw (a held-out sample).
    exclude: { type: 'string' },
  },
});
const DECLARING =
  /^(requirements[\w.-]*\.(txt|in)|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|go\.mod|Gemfile|gems\.rb|[\w.-]+\.gemspec|composer\.json|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml|[\w.-]+\.(cs|fs|vb)proj|Directory\.Packages\.props|packages\.config|Cargo\.toml|package\.json)$/;
const SKIP = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
  'dist',
  'build',
]);
const PROVIDERS =
  /stripe|openai|anthropic|claude|gemini|genai|generativeai|shopify|facebook|twilio|sendgrid|resend|paypal/i;

// mulberry32: a small seeded generator, so the sample is reproducible from the seed alone.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(repositories, perEcosystem, seed) {
  const next = random(seed);
  const chosen = [];
  for (const ecosystem of [...new Set(repositories.map((item) => item.ecosystem))]) {
    const pool = repositories.filter((item) => item.ecosystem === ecosystem);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(next() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    chosen.push(...pool.slice(0, perEcosystem));
  }
  return chosen;
}

async function declaringFiles(root, directory = root, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !SKIP.has(entry.name)) await declaringFiles(root, path, found);
    else if (entry.isFile() && DECLARING.test(entry.name)) found.push(relative(root, path));
  }
  return found.sort();
}

const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const excluded = new Set(
  values.exclude
    ? JSON.parse(await readFile(values.exclude, 'utf8')).repositories.map((item) => item.repository)
    : [],
);
const chosen = sample(
  frozen.repositories.filter((item) => !excluded.has(item.repository)),
  Number(values['per-ecosystem']),
  Number(values.seed),
);
for (const entry of chosen) {
  console.log(`\n## ${entry.ecosystem} ${entry.repository} ${entry.commit}`);
  if (values['sample-only']) continue;
  const root = join(values.root, entry.host, entry.repository);
  for (const file of await declaringFiles(root)) {
    const lines = (await readFile(join(root, file), 'utf8')).split('\n');
    const hits = lines
      .map((line, index) => [index + 1, line])
      .filter(([, line]) => PROVIDERS.test(line));
    console.log(`- ${file}${hits.length ? '' : ' (no provider names)'}`);
    for (const [number, line] of hits.slice(0, 15))
      console.log(`    ${number}: ${line.trim().slice(0, 160)}`);
  }
}

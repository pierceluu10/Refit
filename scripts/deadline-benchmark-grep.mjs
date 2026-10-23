// An independent, deliberately loose string search for recall: every line in a benchmark
// repository's JavaScript/TypeScript files that names a provider version or model, quoted or not,
// in code or comments. Versions outside the registry are kept so its coverage can be measured.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-16-deadline-repos.json' },
    registry: { type: 'string', default: 'data/deadlines.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/deadline-benchmark-grep.mjs --root <dir> [--list <repos.json>] [--registry <deadlines.json>]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const { deadlines } = JSON.parse(await readFile(values.registry, 'utf8'));
const SOURCE = /\.[cm]?[jt]sx?$/;
// Manifests are read too, for SDK end-of-support entries such as `@google/generative-ai`.
const MANIFEST = /^package\.json$/;
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'vendor',
]);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const modelProvider = new Map(
  deadlines
    .filter((d) => d.kind === 'model')
    .flatMap((d) => d.versions.map((v) => [v, d.provider])),
);
const models = [...modelProvider.keys()];
const packages = deadlines.filter((d) => d.kind === 'sdk').flatMap((d) => d.versions);
const sdkProvider = new Map(
  deadlines.filter((d) => d.kind === 'sdk').flatMap((d) => d.versions.map((v) => [v, d.provider])),
);
const MODEL = new RegExp(
  `(?<![\\w.-])(${models
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?![\\w.-])`,
  'g',
);
const inRegistry = new Set(deadlines.flatMap((d) => d.versions.map((v) => `${d.provider}:${v}`)));

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && (SOURCE.test(entry.name) || MANIFEST.test(entry.name))) yield path;
  }
}

function lineMatches(line, shopifyFile, metaFile) {
  const found = [];
  for (const match of line.matchAll(MODEL)) found.push([modelProvider.get(match[1]), match[1]]);
  for (const name of packages)
    if (line.includes(`'${name}'`) || line.includes(`"${name}"`))
      found.push([sdkProvider.get(name), name]);
  for (const match of line.matchAll(/graph\.facebook\.com\/(v\d+\.\d+)/g))
    found.push(['meta-graph', match[1]]);
  if (metaFile)
    for (const match of line.matchAll(/(?<![\w./])(v\d{1,2}\.0)(?![\w.])/g))
      found.push(['meta-graph', match[1]]);
  for (const match of line.matchAll(/admin\/api\/(\d{4}-\d{2})/g))
    found.push(['shopify', match[1]]);
  for (const match of line.matchAll(/ApiVersion\.(January|April|July|October)(\d{2})\b/g))
    found.push([
      'shopify',
      `20${match[2]}-${{ January: '01', April: '04', July: '07', October: '10' }[match[1]]}`,
    ]);
  if (shopifyFile && /version/i.test(line))
    for (const match of line.matchAll(/(?<![\w-])(20\d{2}-(?:01|04|07|10))(?![\w-])/g))
      found.push(['shopify', match[1]]);
  return [...new Map(found.map((item) => [item.join(':'), item])).values()];
}

const results = [];
for (const entry of pinned.repos) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const hits = [];
  for await (const path of files(directory)) {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (content.length > 2 * 1024 * 1024) continue;
    const shopifyFile = /shopify/i.test(content);
    const metaFile = /facebook|whatsapp|instagram|graph\.fb/i.test(content);
    for (const [index, line] of content.split('\n').entries())
      for (const [provider, version] of lineMatches(line, shopifyFile, metaFile))
        hits.push({
          file: relative(directory, path),
          line: index + 1,
          provider,
          version,
          inRegistry: inRegistry.has(`${provider}:${version}`),
          text: line.trim().slice(0, 160),
        });
  }
  results.push({ repo: entry.repo, provider: entry.provider, hits });
}
await writeFile(join(root, 'grep.json'), `${JSON.stringify(results, null, 1)}\n`);
console.log(
  JSON.stringify({
    repos: results.length,
    hits: results.reduce((sum, r) => sum + r.hits.length, 0),
    reposWithRegistryHit: results.filter((r) => r.hits.some((h) => h.inRegistry)).length,
  }),
);

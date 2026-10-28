// Selects the vendor detection sample: a seeded draw from frozen lists across JavaScript,
// TypeScript, Python, Go and Ruby repositories. Provider detection is never consulted.
// Usage: node scripts/vendor-detection-select.mjs --output docs/benchmarks/2026-10-27-vendor-detection-repos.json
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { seededSample } from './ai-app-helpers.mjs';

const SEED = 20261027;
const DRAWS = [
  { list: 'docs/benchmarks/2026-10-21-openai-app-repos.json', count: 7 },
  { list: 'docs/benchmarks/2026-10-21-anthropic-app-repos.json', count: 3 },
  { list: 'docs/benchmarks/2026-10-14-stripe-repos.json', count: 5 },
  { list: 'docs/benchmarks/2026-10-16-shopify-repos.json', count: 2 },
  { list: 'docs/benchmarks/2026-10-22-package-inventory-repos.json', ecosystem: 'pypi', count: 3 },
  { list: 'docs/benchmarks/2026-10-22-package-inventory-repos.json', ecosystem: 'go', count: 3 },
  {
    list: 'docs/benchmarks/2026-10-22-package-inventory-repos.json',
    ecosystem: 'rubygems',
    count: 3,
  },
];

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Usage: --output <repos.json>');
const repositories = [];
for (const draw of DRAWS) {
  const frozen = JSON.parse(await readFile(draw.list, 'utf8'));
  const entries = (frozen.repos ?? frozen.repositories)
    .filter((entry) => !draw.ecosystem || entry.ecosystem === draw.ecosystem)
    .map((entry) => ({
      host: entry.host ?? 'github.com',
      repository: entry.repo ?? entry.repository,
      commit: entry.commit,
    }))
    .filter((entry) => !repositories.some((taken) => taken.repository === entry.repository));
  const byKey = new Map(entries.map((entry) => [entry.repository, entry]));
  const keys = seededSample([...byKey.keys()], SEED, 1).slice(0, draw.count);
  for (const key of keys) repositories.push({ ...byKey.get(key), list: draw.list });
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, seed: SEED, draws: DRAWS, repositories }, null, 2)}\n`,
);
console.log(`${repositories.length} repositories`);

// Prints what a person reads to label cloud-hosted model sites blind (docs/MODEL-HOSTS.md): in each
// sampled repository's JS/TS source, every line that quotes a Bedrock-shaped model ID or ARN, every
// line naming an api-version or deployment in a file that mentions Azure, and every quoted
// provider/model ID in a file that mentions OpenRouter. The patterns are deliberately wider than
// Refit's detector; this script imports no pipeline code and reads no Refit output. The sample is
// drawn per host with a fixed seed.
//
//   node scripts/model-hosts-label-candidates.mjs --list <frozen.json> --root <clones> --seed 20261022
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    seed: { type: 'string', default: '20261022' },
    'sample-only': { type: 'boolean' },
    // At most this many candidate lines per repository, drawn with the same seed.
    lines: { type: 'string', default: '12' },
    // Repositories per host, and labels already made whose repositories are left out (held out).
    'per-host': { type: 'string' },
    exclude: { type: 'string' },
  },
});
const PER_HOST = { bedrock: 7, 'azure-openai': 7, openrouter: 6 };
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const BEDROCK =
  /['"`](?:arn:aws[\w-]*:bedrock[^'"`]*|(?:[a-z-]{2,7}\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer|stability|twelvelabs|luma|moonshot|minimax|google|nvidia)\.[a-z0-9][^'"`\s]*)['"`]/;
const AZURE_LINE = /api-?version|deployment/i;
const ROUTED = /['"`][a-z0-9-]+\/[a-z0-9][\w.:-]*['"`]/;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function sources(root, directory = root, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !SKIP.has(entry.name)) await sources(root, path, found);
    else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts'))
      found.push(relative(root, path));
  }
  return found.sort();
}

const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const excluded = new Set(
  values.exclude
    ? JSON.parse(await readFile(values.exclude, 'utf8')).repositories.map((item) => item.repository)
    : [],
);
const next = random(Number(values.seed));
for (const [host, perHost] of Object.entries(PER_HOST)) {
  const count = values['per-host'] ? Number(values['per-host']) : perHost;
  const pool = frozen.repos.filter((item) => item.host === host && !excluded.has(item.repo));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  for (const entry of pool.slice(0, count)) {
    console.log(`\n## ${host} ${entry.repo} ${entry.commit}`);
    if (values['sample-only']) continue;
    const root = join(values.root, entry.repo.replace('/', '_'));
    const candidates = [];
    for (const file of await sources(root)) {
      const content = await readFile(join(root, file), 'utf8');
      const azure = /azure/i.test(content);
      const openrouter = /openrouter/i.test(content);
      for (const [index, line] of content.split('\n').entries())
        if (
          BEDROCK.test(line) ||
          (azure && AZURE_LINE.test(line)) ||
          (openrouter && ROUTED.test(line))
        )
          candidates.push(`${file}:${index + 1}: ${line.trim().slice(0, 150)}`);
    }
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(next() * (index + 1));
      [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
    }
    console.log(`(${candidates.length} candidate lines)`);
    for (const line of candidates.slice(0, Number(values.lines)).sort()) console.log(line);
  }
}

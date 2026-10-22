// Draws the 20 monorepos labelled blind for docs/WORKSPACE-ATTRIBUTION.md from the listing that
// scripts/workspace-monorepos.mjs writes: 10 that declare workspaces at their root and 10 that only
// nest package.json files, each drawn with a fixed seed. Prints one repo@commit per line.
//
//   node scripts/workspace-sample.mjs --list docs/benchmarks/2026-10-22-workspace-monorepos.json --seed 20261022
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { list: { type: 'string' }, seed: { type: 'string', default: '20261022' } },
});
// mulberry32, as in scripts/package-inventory-label-candidates.mjs.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(Number(values.seed));
const listing = JSON.parse(await readFile(values.list, 'utf8'));
const monorepos = listing.results.filter((item) => item.monorepo);
const declared = (item) => item.signals.some((signal) => !signal.endsWith('package.json files'));
for (const pool of [monorepos.filter(declared), monorepos.filter((item) => !declared(item))]) {
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  for (const item of pool.slice(0, 10)) console.log(`${item.repo}@${item.commit}`);
}

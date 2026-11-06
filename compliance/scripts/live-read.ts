// One live read per rule family, with the real model and the real official pages.
// Not run in tests. Run it on a machine that can reach the sources, with the prompt's cap:
//   REFIT_AI_BUDGET_USD=4 node --experimental-strip-types compliance/scripts/live-read.ts [family...]
// (ANTHROPIC_API_KEY from the environment.) Writes what was read, what couldn't be and what it
// cost to .refit/compliance/live-read-<date>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULE_FAMILIES } from '../families.ts';
import { readRegulations } from '../watch.ts';

const wanted = process.argv.slice(2);
const families = wanted.length ? RULE_FAMILIES.filter((f) => wanted.includes(f.id)) : RULE_FAMILIES;
if (!families.length) {
  console.error(`No such family. Families: ${RULE_FAMILIES.map((f) => f.id).join(', ')}`);
  process.exit(1);
}
if (!process.env.REFIT_AI_BUDGET_USD) {
  console.error('Set REFIT_AI_BUDGET_USD to the cap (O5: $4 in total) before a live read.');
  process.exit(1);
}

const read = await readRegulations(undefined, { families });
for (const family of read.families) {
  console.log(`\n${family.family}: ${family.obligations.length} obligations`);
  for (const o of family.obligations) {
    const flagged = o.needsHuman.some((n) => /not found word for word|did not read/.test(n));
    const date = o.effectiveDate ? ` (${o.effectiveDate})` : '';
    console.log(`  - ${o.id}${date}${flagged ? ' [quote unchecked]' : ''}`);
  }
}
if (read.errors.length) console.log(`\nCould not read or finish:\n- ${read.errors.join('\n- ')}`);
console.log(`\nCost: $${read.costUsd.toFixed(4)}`);

const dir = join(process.cwd(), '.refit', 'compliance');
mkdirSync(dir, { recursive: true });
const file = join(dir, `live-read-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(read, null, 2));
console.log(`Wrote ${file}`);

// Groups the type errors a stripe-node upgrade leaves in benchmark rows by shape
// (docs/UPGRADE-FALLOUT.md). A row's errors are the type oracle's patched side when it ran, else the
// introduced errors of a patch that upgraded stripe-node and regressed. Prints one line per shape
// and member: rows, errors, errors in JavaScript, lane, shape, member and the rows, most rows first.
//   node scripts/upgrade-fallout.mjs <results.json> [--json]
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { falloutShape } from '../pipeline/upgrade-fallout.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean' } },
});
if (positionals.length !== 1) {
  console.error('Usage: node scripts/upgrade-fallout.mjs <results.json> [--json]');
  process.exit(1);
}

// "file TS1234 message", as validation records introduced errors.
const parsed = (text) => {
  const match = /^(\S+) (TS\d+) (.*)$/.exec(text);
  return match && { file: match[1], code: match[2], message: match[3] };
};

export function rowErrors(row) {
  const workflow = row.workflow ?? {};
  const oracle = workflow.typeOracle?.patched;
  if (oracle?.status === 'compared') return oracle.introduced;
  if (workflow.validation === 'regression' && workflow.sdkUpgrade?.to)
    return (workflow.typeErrors?.introduced ?? []).map(parsed).filter(Boolean);
  return [];
}

const rows = JSON.parse(await readFile(positionals[0], 'utf8'));
const groups = new Map();
for (const row of rows)
  for (const error of rowErrors(row)) {
    const { shape, lane, member } = falloutShape(error);
    const key = `${lane}\t${shape}\t${member ?? ''}`;
    const group = groups.get(key) ?? {
      lane,
      shape,
      member,
      errors: 0,
      javascript: 0,
      repos: new Set(),
    };
    group.errors++;
    // A generated type check's errors in JavaScript are advisory and never fail validation.
    if (/\.[cm]?jsx?$/.test(error.file)) group.javascript++;
    group.repos.add(row.repo);
    groups.set(key, group);
  }
const ranked = [...groups.values()]
  .map((group) => ({ ...group, repos: [...group.repos].sort() }))
  .sort((a, b) => b.repos.length - a.repos.length || b.errors - a.errors);
if (values.json) console.log(JSON.stringify(ranked, null, 2));
else
  for (const group of ranked)
    console.log(
      `${group.repos.length}\t${group.errors}\t${group.javascript}\t${group.lane}\t${group.shape}\t${group.member ?? ''}\t${group.repos.join(', ')}`,
    );

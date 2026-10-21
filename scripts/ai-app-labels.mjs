// Validates the labelling agents' labels-NN.json files against the candidates and merges them into
// the committed labels file. Refuses to write until every batch has a labels file. It never writes a
// judgment field itself; it only copies the agents' labels and the candidates' own fields.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMITTED_KEYS, validateLabels } from './ai-app-helpers.mjs';

const { values } = parseArgs({
  options: {
    candidates: { type: 'string' },
    batches: { type: 'string' },
    output: { type: 'string' },
    'labelled-at': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.candidates ||
  !values.batches ||
  !values.output ||
  !values['labelled-at']
) {
  console.log(
    'Usage: node scripts/ai-app-labels.mjs --candidates <candidates.json> --batches <dir> --output <labels.json> --labelled-at <YYYY-MM-DD>',
  );
  process.exit(values.help ? 0 : 1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(values['labelled-at'])) {
  console.error('--labelled-at must be YYYY-MM-DD.');
  process.exit(1);
}

const numbers = (await readdir(values.batches))
  .map((f) => /^batch-(\d\d)\.json$/.exec(f)?.[1])
  .filter(Boolean)
  .sort();
const missing = numbers.filter((nn) => !existsSync(join(values.batches, `labels-${nn}.json`)));
if (missing.length) {
  console.error(`missing batches: ${missing.join(', ')}`);
  process.exit(3);
}

const read = async (name) => JSON.parse(await readFile(join(values.batches, name), 'utf8'));
const labelByKey = new Map();
const key = (x) => [x.repo, x.provider, x.file, x.line, x.column, x.model].join('\u0000');
let invalid = false;
for (const nn of numbers) {
  const batch = await read(`batch-${nn}.json`);
  let labels;
  try {
    const file = await read(`labels-${nn}.json`);
    if (file.batch !== nn || !Array.isArray(file.labels)) throw new Error('shape');
    labels = file.labels;
  } catch {
    console.error(`invalid batch ${nn}: 1 errors\n  labels file: unreadable-or-wrong-shape`);
    invalid = true;
    continue;
  }
  const errors = validateLabels(
    batch.candidates,
    labels,
    batch.candidates.map((c) => c.context.line),
  );
  if (errors.length) {
    console.error(
      `invalid batch ${nn}: ${errors.length} errors\n${errors
        .slice(0, 20)
        .map((e) => `  ${e.key}: ${e.kind}`)
        .join('\n')}`,
    );
    invalid = true;
    continue;
  }
  for (const label of labels) labelByKey.set(key(label), label);
}
if (invalid) process.exit(1);

const candidates = await read2(values.candidates);
async function read2(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
const counts = { byLanguage: {}, byVia: {}, byReason: {} };
let candidateTotal = 0;
let live = 0;
let liveJsTs = 0;
let generated = 0;
const bump = (map, name) => (map[name] = (map[name] ?? 0) + 1);
const repos = candidates.repos.map((entry) => ({
  repo: entry.repo,
  provider: entry.provider,
  commit: entry.commit,
  labels: entry.candidates.map((candidate) => {
    const label = labelByKey.get(key(candidate));
    const merged = { ...candidate, ...label };
    const committed = Object.fromEntries(
      COMMITTED_KEYS.filter((k) => k in merged).map((k) => [k, merged[k]]),
    );
    candidateTotal++;
    bump(counts.byLanguage, committed.language);
    if (committed.generated) generated++;
    if (committed.live) {
      live++;
      if (['typescript', 'javascript'].includes(committed.language)) liveJsTs++;
      bump(counts.byVia, committed.via.startsWith('wrapper:') ? 'wrapper:*' : committed.via);
    } else bump(counts.byReason, committed.reason);
    return committed;
  }),
}));

const output = {
  formatVersion: 1,
  method:
    'An independent grep (scripts/ai-app-label-candidates.mjs) for quoted exact registry model IDs, then one AI-assisted reading pass: fresh-context labelling agents, one per batch of at most 40 candidates, each reading only its batch and the code it points to. Not hand labelling.',
  labelledAt: values['labelled-at'],
  lists: candidates.lists,
  registry: candidates.registry,
  scope: {
    ...candidates.scope,
    included: `${candidates.scope.included}; registry IDs only; aliases the registry does not name, such as gpt-4o, are out of scope`,
  },
  counts: {
    repositories: repos.length,
    candidates: candidateTotal,
    live,
    notLive: candidateTotal - live,
    liveJsTs,
    byLanguage: counts.byLanguage,
    generated,
    byVia: counts.byVia,
    byReason: counts.byReason,
  },
  reread: null,
  repos,
};
await writeFile(values.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts));

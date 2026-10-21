// Validates the labelling agents' labels-NN.json files against the candidates and merges them into
// the committed labels file. Refuses to write until every batch has a labels file. It never writes a
// judgment field itself; it only copies the agents' labels and the candidates' own fields.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { COMMITTED_KEYS, agreement, seededSample, validateLabels } from './ai-app-helpers.mjs';

const { values } = parseArgs({
  options: {
    candidates: { type: 'string' },
    batches: { type: 'string' },
    output: { type: 'string' },
    'labelled-at': { type: 'string' },
    'reread-sample': { type: 'boolean' },
    'reread-merge': { type: 'boolean' },
    seed: { type: 'string' },
    fraction: { type: 'string' },
    labels: { type: 'string' },
    sample: { type: 'string' },
    reread: { type: 'string' },
    adjudications: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const idOf = (x) => [x.repo, x.provider, x.file, x.line, x.column, x.model].join('\u0000');
const shown = (x) => idOf(x).replaceAll('\u0000', '|');
const batchContexts = async (dir) => {
  const byId = new Map();
  for (const f of (await readdir(dir)).filter((n) => /^batch-\d\d\.json$/.test(n)))
    for (const c of (await readJson(join(dir, f))).candidates) byId.set(idOf(c), c);
  return byId;
};

// Draws the sample from candidate keys alone; the batch files carry context and no labels.
async function rereadSample() {
  const seed = Number(values.seed);
  const fraction = Number(values.fraction);
  if (!values.candidates || !values.batches || !values.output) return usage(1);
  if (!Number.isInteger(seed) || !(fraction > 0 && fraction <= 1)) return usage(1);
  const candidates = await readJson(values.candidates);
  const keys = candidates.repos.flatMap((r) => r.candidates.map(idOf));
  const contexts = await batchContexts(values.batches);
  const picked = seededSample(keys, seed, fraction);
  const sample = {
    formatVersion: 1,
    seed,
    fraction,
    sampleSize: picked.length,
    candidates: picked.map((k) => contexts.get(k)),
  };
  if (sample.candidates.some((c) => !c))
    throw new Error('a sampled candidate has no batch context');
  await writeFile(values.output, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`sample ${picked.length} of ${keys.length}`);
}

// Compares the frozen re-read with the first labels, applies adjudications, regenerates the file.
async function rereadMerge() {
  for (const k of ['candidates', 'batches', 'labels', 'sample', 'reread', 'output'])
    if (!values[k]) return usage(1);
  if (!existsSync(values.reread)) {
    console.error('missing re-read file');
    process.exit(3);
  }
  const bytes = await readFile(values.reread);
  const rereadSha256 = createHash('sha256').update(bytes).digest('hex');
  const second = JSON.parse(bytes.toString('utf8')).labels;
  const sample = await readJson(values.sample);
  const errors = validateLabels(
    sample.candidates,
    second,
    sample.candidates.map((c) => c.context.line),
  );
  if (errors.length) {
    console.error(`invalid re-read: ${errors.length} errors`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e.key}: ${e.kind}`);
    process.exit(1);
  }
  const file = await readJson(values.labels);
  const firstFlat = file.repos.flatMap((r) =>
    r.labels.map((l) => ({ ...l, repo: r.repo, provider: r.provider })),
  );
  const firstLabels = file.repos.flatMap((r) => r.labels);
  const labelFor = new Map(firstFlat.map((l, i) => [idOf(l), firstLabels[i]]));
  const result = agreement(firstFlat, second);
  const adjudications = new Map(
    values.adjudications ? (await readJson(values.adjudications)).map((a) => [a.key, a]) : [],
  );
  const unresolved = result.disagreements.filter((k) => !adjudications.has(k));
  if (unresolved.length) {
    console.error(`unadjudicated disagreements:\n${unresolved.map((k) => `  ${k}`).join('\n')}`);
    process.exit(2);
  }
  const brief = (l) => ({ live: l.live, via: l.via, reason: l.reason ?? null });
  const secondById = new Map(second.map((l) => [idOf(l), l]));
  const sampleById = new Map(sample.candidates.map((c) => [idOf(c), c]));
  const disagreements = [];
  for (const k of result.disagreements) {
    const { final, note } = adjudications.get(k);
    const id = k.replaceAll('|', '\u0000');
    const label = labelFor.get(id);
    const adjudicated = { ...secondById.get(id), live: final.live, via: final.via ?? null };
    delete adjudicated.reason;
    if (!final.live) adjudicated.reason = final.reason;
    const bad = validateLabels([sampleById.get(id)], [adjudicated]);
    if (
      bad.length ||
      typeof note !== 'string' ||
      !note.trim() ||
      /[\r\n]/.test(note) ||
      note.length > 160
    ) {
      console.error(`invalid adjudication: ${k}`);
      process.exit(1);
    }
    const first = brief(label);
    label.live = adjudicated.live;
    label.via = adjudicated.via;
    delete label.reason;
    if (!label.live) label.reason = adjudicated.reason;
    disagreements.push({
      key: k,
      first,
      second: brief(secondById.get(id)),
      final: brief(label),
      note,
    });
  }
  file.counts = summarize(file.repos);
  const addition =
    ' A seeded random 10% of candidates was re-read by a separate fresh-context agent that saw only the sampled candidates and the rules, never the first labels; agreement and adjudications are in `reread`.';
  if (!file.method.includes(addition)) file.method += addition;
  file.reread = {
    seed: sample.seed,
    fraction: sample.fraction,
    sampleSize: sample.sampleSize,
    reader: 'separate fresh-context agent given only the sample and the labelling rules',
    rereadSha256,
    agreement: { live: result.live, via: result.via },
    disagreements,
    sample: second.map((l) => ({ key: shown(l), second: brief(l) })),
  };
  await writeFile(values.output, `${JSON.stringify(file, null, 2)}\n`);
  console.log(JSON.stringify(file.reread.agreement));
}

function summarize(repos) {
  const counts = { byLanguage: {}, byVia: {}, byReason: {} };
  let candidates = 0;
  let live = 0;
  let liveJsTs = 0;
  let generated = 0;
  const bump = (map, name) => (map[name] = (map[name] ?? 0) + 1);
  for (const r of repos)
    for (const l of r.labels) {
      candidates++;
      bump(counts.byLanguage, l.language);
      if (l.generated) generated++;
      if (l.live) {
        live++;
        if (['typescript', 'javascript'].includes(l.language)) liveJsTs++;
        bump(counts.byVia, l.via.startsWith('wrapper:') ? 'wrapper:*' : l.via);
      } else bump(counts.byReason, l.reason);
    }
  return {
    repositories: repos.length,
    candidates,
    live,
    notLive: candidates - live,
    liveJsTs,
    byLanguage: counts.byLanguage,
    generated,
    byVia: counts.byVia,
    byReason: counts.byReason,
  };
}

function usage(code) {
  console.log(
    'Usage: node scripts/ai-app-labels.mjs --candidates <candidates.json> --batches <dir> --output <labels.json> --labelled-at <YYYY-MM-DD>\n   or: --reread-sample --candidates --batches --seed <int> --fraction <0..1> --output <sample.json>\n   or: --reread-merge --candidates --batches --labels --sample --reread [--adjudications] --output',
  );
  process.exit(code);
}

if (values['reread-sample']) {
  await rereadSample();
  process.exit(0);
}
if (values['reread-merge']) {
  await rereadMerge();
  process.exit(0);
}
if (
  values.help ||
  !values.candidates ||
  !values.batches ||
  !values.output ||
  !values['labelled-at']
) {
  usage(values.help ? 0 : 1);
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
const repos = candidates.repos.map((entry) => ({
  repo: entry.repo,
  provider: entry.provider,
  commit: entry.commit,
  labels: entry.candidates.map((candidate) => {
    const merged = { ...candidate, ...labelByKey.get(key(candidate)) };
    return Object.fromEntries(COMMITTED_KEYS.filter((k) => k in merged).map((k) => [k, merged[k]]));
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
  counts: summarize(repos),
  reread: null,
  repos,
};
await writeFile(values.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts));

#!/usr/bin/env node
// Builds data/meta-graph/changes.json and data/rules/meta-graph from mined candidates
// (scripts/meta-graph-mine.mjs, or files of the same shape: out-*.json with
// {pages: [{page, candidates}], backfill: [{id, page, quote}]} and verdicts-*.json with
// {verdicts: [{page, index, supported, problem}]}). A candidate is kept only when the second pass
// supported it and its quote passes the deterministic check against the saved page. Existing
// entries keep their id and take a checked quote. Prints coverage; --write saves the files.
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  checkMetaGraphChanges,
  DEFAULT_META_GRAPH_CHANGES,
} from '../pipeline/meta-graph-changes.ts';
import {
  META_PAGE_SOURCES,
  META_RULES,
  META_VERSIONS,
  changeSubject,
  checkMetaGraphEvidence,
  quoteProblems,
  ruleFamily,
} from '../pipeline/meta-graph-rules.ts';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    checked: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    write: { type: 'boolean' },
  },
});
if (!values.input) throw new Error('--input <directory> is required');
const checkedAt = values.checked;
const pageContent = new Map();
for (const label of Object.keys(META_PAGE_SOURCES)) {
  try {
    const page = JSON.parse(
      await readFile(
        new URL(`../docs/benchmarks/meta-graph-changelog/pages/${label}.json`, import.meta.url),
        'utf8',
      ),
    );
    pageContent.set(label, page.content);
  } catch {}
}
// The URL a person opens: Meta's page without the Markdown view or trailing slash.
const sourceOf = (label) => META_PAGE_SOURCES[label].replace(/\.md$/, '').replace(/\/$/, '');

const files = (await readdir(values.input)).filter((file) =>
  /^(out|verdicts)-.*\.json$/.test(file),
);
const outputs = [];
const verdicts = new Map();
for (const file of files.sort()) {
  const value = JSON.parse(await readFile(`${values.input}/${file}`, 'utf8'));
  if (file.startsWith('out-')) outputs.push(value);
  if (file.startsWith('verdicts-'))
    for (const verdict of value.verdicts) verdicts.set(`${verdict.page}#${verdict.index}`, verdict);
}

const table = JSON.parse(await readFile(DEFAULT_META_GRAPH_CHANGES, 'utf8'));
const existing = new Map(table.changes.map((change) => [change.id, change]));
const refused = [];
const unquoted = [];

// Quotes for entries written before the table carried them.
const backfill = new Map(
  outputs.flatMap((output) => output.backfill ?? []).map((entry) => [entry.id, entry]),
);
const changes = [];
for (const change of table.changes) {
  const found = backfill.get(change.id);
  const label = found?.page;
  const entry = {
    ...change,
    replacement: change.replacement ?? null,
    appliesToAll: change.appliesToAll ?? null,
    quote: found?.quote ?? change.quote ?? null,
  };
  if (label && entry.quote) {
    entry.source = sourceOf(label);
    entry.checkedAt = checkedAt;
  }
  const problems =
    label && entry.quote ? quoteProblems(entry, pageContent.get(label)) : ['no quote'];
  if (problems.length) unquoted.push({ id: change.id, problems });
  else changes.push(order(entry));
}

const key = (entry) =>
  [
    entry.version ?? `all-${entry.appliesToAll}`,
    (changeSubject(entry) ?? '').toLowerCase(),
    entry.edge ?? '',
    entry.path ?? '',
    entry.replacement ?? '',
  ].join('\t');
const loose = (entry) => [entry.version, (changeSubject(entry) ?? '').toLowerCase()].join('\t');
const seen = new Set(changes.flatMap((entry) => [key(entry), loose(entry)]));
const ids = new Set(changes.map((entry) => entry.id));
let candidates = 0;
for (const output of outputs)
  for (const { page, candidates: list } of output.pages)
    for (const [index, candidate] of list.entries()) {
      candidates++;
      const verdict = 'supported' in candidate ? candidate : verdicts.get(`${page}#${index}`);
      const reason = (problem) =>
        refused.push({ page, index, name: changeSubject(candidate), problem });
      if (!verdict?.supported) {
        reason(`second pass: ${verdict?.problem ?? 'no verdict'}`);
        continue;
      }
      const problems = quoteProblems(candidate, pageContent.get(page) ?? '');
      if (problems.length) {
        reason(`quote check: ${problems.join('; ')}`);
        continue;
      }
      if (candidate.version !== null && !META_VERSIONS.includes(candidate.version)) {
        reason(
          `version ${candidate.version} is outside ${META_VERSIONS[0]}–${META_VERSIONS.at(-1)}`,
        );
        continue;
      }
      if (candidate.path !== null && !/^\/[\w/{}.-]+$/.test(candidate.path)) candidate.path = null;
      // Kinds the mining passes did not have: a root path whose behaviour changes, and a product
      // shut down without a path the changelog prints.
      if (candidate.kind === 'edge-changed' && !candidate.edge && candidate.path)
        candidate.kind = 'endpoint-changed';
      if (candidate.kind === 'endpoint-removed' && !candidate.edge && !candidate.path)
        candidate.kind = 'product-removed';
      if (candidate.kind === 'product-removed' && !candidate.name) {
        reason('a product removal names no product');
        continue;
      }
      // The same change from another page or agent, or already in the table.
      if (seen.has(key(candidate)) || (!candidate.replacement && seen.has(loose(candidate))))
        continue;
      seen.add(key(candidate));
      seen.add(loose(candidate));
      const base =
        `meta-graph-${candidate.version?.replace('.', '-') ?? `all-${candidate.appliesToAll}`}-${candidate.kind}-${(
          changeSubject(candidate) ?? 'change'
        )
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`.slice(0, 112);
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      changes.push(
        order({
          id,
          ...candidate,
          source: sourceOf(page),
          checkedAt,
        }),
      );
    }

function order(entry) {
  return {
    id: entry.id,
    version: entry.version,
    kind: entry.kind,
    node: entry.node,
    edge: entry.edge,
    path: entry.path,
    name: entry.name,
    replacement: entry.replacement,
    appliesToAll: entry.appliesToAll,
    summary: entry.summary,
    quote: entry.quote,
    source: entry.source,
    checkedAt: entry.checkedAt,
  };
}

const NOTE =
  'Read in full on CHECKED, with the Marketing API changelog, the Graph API out-of-cycle changes and the Instagram Platform, WhatsApp Business Platform and Messenger Platform changelogs (saved in docs/benchmarks/meta-graph-changelog/pages). Entries were mined, checked by a second independent pass and kept only when their quote is in the saved page and names the change; see docs/META-GRAPH-CHANGES.md.';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// "Released October 8, 2025" on the version's own changelog page.
function released(version) {
  const match = pageContent
    .get(`graph-api-${version}`)
    ?.match(/Released ([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
  if (!match || !MONTHS.includes(match[1]))
    throw new Error(`${version}: no release date on its page`);
  return `${match[3]}-${String(MONTHS.indexOf(match[1]) + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}
const versions = META_VERSIONS.map((version) => ({
  version,
  released: released(version),
  status: 'reviewed',
  source: sourceOf(`graph-api-${version}`),
  checkedAt,
  note: NOTE.replace('CHECKED', checkedAt),
}));
const versionOrder = (a, b) =>
  (a.version === null) - (b.version === null) ||
  (a.version && b.version
    ? Number(a.version.slice(1).split('.')[0]) - Number(b.version.slice(1).split('.')[0])
    : String(a.appliesToAll).localeCompare(String(b.appliesToAll))) ||
  a.id.localeCompare(b.id);
const result = {
  formatVersion: 1,
  provider: 'meta-graph',
  versions,
  changes: changes.sort(versionOrder),
};

const rules = new Map();
for (const change of result.changes.filter((entry) => entry.replacement)) {
  const file = `${change.version ?? 'out-of-cycle'}.json`;
  rules.set(file, [
    ...(rules.get(file) ?? []),
    {
      rule: `${change.id}-replacement`.slice(0, 120),
      family: ruleFamily(change),
      change: change.id,
      from: changeSubject(change),
      to: change.replacement,
      source: change.source,
      quote: change.quote,
      checkedAt: change.checkedAt,
      status: 'review',
      origin: 'mined',
    },
  ]);
}
const tables = [...rules].map(([file, list]) => ({
  file,
  table: {
    formatVersion: 1,
    provider: 'meta-graph',
    version: file === 'out-of-cycle.json' ? null : file.slice(0, -5),
    rules: list,
  },
}));

const shape = checkMetaGraphChanges(result, new Date(`${checkedAt}T12:00:00Z`));
const evidence = checkMetaGraphEvidence(result.changes, tables, pageContent);
const today = checkedAt;
const report = {
  candidates,
  refused: refused.length,
  existing: table.changes.length,
  existingUnquoted: unquoted,
  changes: result.changes.length,
  rules: tables.reduce((total, { table }) => total + table.rules.length, 0),
  alertOnly: result.changes.filter((change) => !change.replacement).length,
  alertOnlyUpcoming: result.changes.filter(
    (change) => !change.replacement && change.appliesToAll > today,
  ).length,
  errors: [
    ...unquoted.map(({ id, problems }) => `${id}: ${problems.join('; ')}`),
    ...shape.errors,
    ...evidence,
  ],
};
await writeFile(`${values.input}/refused.json`, `${JSON.stringify(refused, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (values.write) {
  if (report.errors.length)
    throw new Error('Not written: the merged table does not pass its checks.');
  await writeFile(DEFAULT_META_GRAPH_CHANGES, `${JSON.stringify(result, null, 2)}\n`);
  await rm(META_RULES, { recursive: true, force: true });
  await mkdir(META_RULES, { recursive: true });
  for (const { file, table } of tables)
    await writeFile(new URL(file, META_RULES), `${JSON.stringify(table, null, 2)}\n`);
}

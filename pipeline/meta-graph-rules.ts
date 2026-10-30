import { readdir, readFile } from 'node:fs/promises';
import type { MetaGraphChange } from './meta-graph-changes.ts';
import { isObject } from './specifications.ts';

// Where Meta's changelog pages are saved, and which pages the change table and rules may quote.
// Meta publishes prose changelogs only, so a saved page is the evidence every quote is checked
// against, as docs/benchmarks/stripe-changelog/pages is for Stripe.

export const META_PAGES = new URL(
  '../docs/benchmarks/meta-graph-changelog/pages/',
  import.meta.url,
);
const DOCS = 'https://developers.facebook.com/docs';
const DOCUMENTATION = 'https://developers.facebook.com/documentation';
// Graph API v10.0 (February 2021) is the oldest version benchmark repositories still pin.
export const META_VERSIONS = Array.from({ length: 17 }, (_, index) => `v${index + 10}.0`);
// Marketing API changelogs have their own page from v18.0; earlier ones are on the Graph API page.
const MARKETING_VERSIONS = META_VERSIONS.slice(8);
// Graph API out-of-cycle changes since v10.0, each on its own page.
const OUT_OF_CYCLE: Array<[string, string]> = [
  ['apr-12-2021', 'graph-api/changelog/non-versioned-changes/apr-12-2021'],
  ['apr-14-2021', 'graph-api/changelog/non-versioned-changes/apr-14-2021'],
  ['apr-27-2021', 'graph-api/changelog/non-versioned-changes/apr-27-2021'],
  ['apr-9-2021', 'graph-api/changelog/non-versioned-changes/apr-9-2021'],
  ['aug-30-2021', 'graph-api/changelog/ooc-changes/aug-30-2021'],
  ['feb-3-2022', 'graph-api/changelog/non-versioned-changes/feb-3-2022'],
  ['jan-19-2021', 'graph-api/changelog/non-versioned-changes/jan-19-2021'],
  ['jan-31-2022', 'graph-api/changelog/non-versioned-changes/jan-31-2022'],
  ['jun-15-2021', 'graph-api/changelog/ooc-changes/jun-15-2021'],
  ['jun-30-2021', 'graph-api/changelog/ooc-changes/jun-30-2021'],
  ['june-20-2022', 'graph-api/changelog/out-of-cycle-changes/june-20-2022'],
  ['june-28-2022', 'graph-api/changelog/out-of-cycle-changes/june-28-2022'],
  ['mar-15-2022', 'graph-api/changelog/non-versioned-changes/mar-15-2022'],
  ['mar-16-2021', 'graph-api/changelog/non-versioned-changes/mar-16-2021'],
  ['mar-3-2022', 'graph-api/changelog/non-versioned-changes/mar-3-2022'],
  ['mar-4-2022', 'graph-api/changelog/non-versioned-changes/mar-4-2022'],
  ['may-26-2021', 'graph-api/changelog/non-versioned-changes/may-26-2021'],
  ['may-31-2022', 'graph-api/changelog/non-versioned-changes/may-31-2022'],
  ['may-4-2021', 'graph-api/changelog/non-versioned-changes/may-4-2021'],
  ['nov-9-2021', 'graph-api/changelog/ooc-changes/nov-9-2021'],
  ['nvc-2023', 'graph-api/changelog/non-versioned-changes/nvc-2023'],
  ['nvc-2024', 'graph-api/changelog/non-versioned-changes/nvc-2024'],
  ['nvc-2025', 'graph-api/changelog/non-versioned-changes/nvc-2025'],
  ['oct-13-2021', 'graph-api/changelog/ooc-changes/oct-13-2021'],
  ['oct-20-2021', 'graph-api/changelog/ooc-changes/oct-20-2021'],
  ['oct-26-2021', 'graph-api/changelog/ooc-changes/oct-26-2021'],
  ['oct-5-2021', 'graph-api/changelog/ooc-changes/oct-5-2021'],
];

export const META_PAGE_SOURCES: Record<string, string> = {
  'graph-api-changelog': `${DOCS}/graph-api/changelog/`,
  ...Object.fromEntries(
    OUT_OF_CYCLE.map(([slug, path]) => [`graph-api-out-of-cycle-${slug}`, `${DOCS}/${path}/`]),
  ),
  ...Object.fromEntries(
    META_VERSIONS.map((version) => [
      `graph-api-${version}`,
      `${DOCS}/graph-api/changelog/version${version.slice(1)}/`,
    ]),
  ),
  ...Object.fromEntries(
    MARKETING_VERSIONS.map((version) => [
      `marketing-api-${version}`,
      `${DOCUMENTATION}/ads-commerce/marketing-api/marketing-api-changelog/version${version.slice(1)}.md`,
    ]),
  ),
  'marketing-api-out-of-cycle': `${DOCUMENTATION}/ads-commerce/marketing-api/out-of-cycle-changes.md`,
  'instagram-platform': `${DOCUMENTATION}/instagram-platform/changelog.md`,
  whatsapp: `${DOCUMENTATION}/business-messaging/whatsapp/changelog.md`,
  'messenger-platform': `${DOCUMENTATION}/business-messaging/messenger-platform/changelog.md`,
  'whatsapp-on-premises-sunset': `${DOCS}/whatsapp/on-premises/sunset/`,
};

// A page URL without its scheme, /docs or /documentation prefix, `.md` view, fragment or trailing
// slash: Meta serves the same changelog under both prefixes.
function pageKey(url: string) {
  return url
    .replace(/^https:\/\/developers\.facebook\.com\/(docs|documentation)\//, '')
    .replace(/[#?].*$/, '')
    .replace(/\.md$/, '')
    .replace(/\/$/, '')
    .replace(/^ads-commerce\/marketing-api\//, 'marketing-api/')
    .replace(/^business-messaging\//, '');
}

// The saved page a change or rule cites.
export function pageLabel(source: string) {
  const key = pageKey(source);
  return Object.entries(META_PAGE_SOURCES).find(([, url]) => pageKey(url) === key)?.[0];
}

const spaced = (text: string) => text.replace(/\s+/g, ' ').trim();

// Why a quote does not back its entry: it must be in the saved page as written (whitespace aside),
// and name the entry's name and its replacement.
export function quoteProblems(
  entry: {
    quote: string | null;
    name: string | null;
    edge: string | null;
    path: string | null;
    replacement?: string | null;
  },
  content: string,
) {
  if (!entry.quote?.trim()) return ['no quote'];
  const quote = spaced(entry.quote);
  const problems: string[] = [];
  if (!spaced(content).includes(quote)) problems.push('the quote is not in the saved page');
  // `daily_budget`, `daily budget` and `daily-budget` name the same thing.
  const loose = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, ' ');
  const words = loose(quote);
  // Edges and paths are often named in prose ("Instant Articles API endpoints"), so only a printed
  // field, metric, parameter or code name is required.
  if (entry.name && !words.includes(loose(entry.name)))
    problems.push(`the quote does not name ${entry.name}`);
  if (entry.replacement && !words.includes(loose(entry.replacement)))
    problems.push(`the quote does not name the replacement ${entry.replacement}`);
  return problems;
}

export const META_RULES = new URL('../data/rules/meta-graph/', import.meta.url);

// A rule answers one change the table holds whose changelog names a replacement: requests that use
// `from` should use `to`. Rules are review-only until tracing applies them and a benchmark shows
// the result; `out-of-cycle.json` holds rules for changes with no version (`version: null`).
export interface MetaGraphRule {
  rule: string;
  family: string;
  change: string;
  from: string;
  to: string;
  source: string;
  quote: string;
  checkedAt: string;
  status: 'review';
  origin: 'mined';
}

export interface MetaGraphRuleTable {
  formatVersion: 1;
  provider: 'meta-graph';
  version: string | null;
  rules: MetaGraphRule[];
}

const RULE_KEYS = [
  'rule',
  'family',
  'change',
  'from',
  'to',
  'source',
  'quote',
  'checkedAt',
  'status',
  'origin',
];

// `field-replacement` when the changelog swaps one identifier for another (`instagram_actor_id` to
// `instagram_user_id`); `field-migration` when the replacement is a product, a pair of fields or an
// endpoint, which needs a plan rather than a rename.
export function ruleFamily(change: MetaGraphChange) {
  const identifier = (text: string | null) => !!text && /^[\w.]+$/.test(text);
  const subject = change.kind.split('-')[0];
  return identifier(changeSubject(change)) && identifier(change.replacement)
    ? `${subject}-replacement`
    : `${subject}-migration`;
}

// The identifier a change names: its field, metric or parameter, else its edge or path.
export function changeSubject(change: MetaGraphChange) {
  return change.name ?? change.edge ?? change.path;
}

// Every problem with the change table's quotes and the rule tables: each quote must be in its
// saved page and name its subject and replacement, each rule must answer one change exactly, and
// every change that names a replacement must have its rule.
export function checkMetaGraphEvidence(
  changes: MetaGraphChange[],
  tables: { file: string; table: unknown }[],
  pages: Map<string, string>,
) {
  const problems: string[] = [];
  const pageFor = (label: string, source: string) => {
    const page = pageLabel(source);
    const content = page && pages.get(page);
    if (!content) problems.push(`${label}: no saved page for ${source}.`);
    return content;
  };
  const byId = new Map(changes.map((change) => [change.id, change]));
  for (const change of changes) {
    const content = pageFor(change.id, change.source);
    if (content)
      for (const problem of quoteProblems(change, content))
        problems.push(`${change.id}: ${problem}.`);
  }
  const answered = new Set<string>();
  for (const { file, table } of tables) {
    if (
      !isObject(table) ||
      table.formatVersion !== 1 ||
      table.provider !== 'meta-graph' ||
      !(table.version === null || typeof table.version === 'string') ||
      !Array.isArray(table.rules)
    ) {
      problems.push(`${file}: needs formatVersion 1, provider meta-graph, version and rules.`);
      continue;
    }
    if (file !== `${table.version ?? 'out-of-cycle'}.json`)
      problems.push(`${file}: the file must be named after its version.`);
    for (const rule of table.rules) {
      const label = isObject(rule) && typeof rule.rule === 'string' ? rule.rule : file;
      if (!isObject(rule) || Object.keys(rule).sort().join() !== [...RULE_KEYS].sort().join()) {
        problems.push(`${label}: a rule has exactly the fields ${RULE_KEYS.join(', ')}.`);
        continue;
      }
      const change = byId.get(String(rule.change));
      if (!change) {
        problems.push(`${label}: change ${rule.change} is not in the change table.`);
        continue;
      }
      if (answered.has(change.id)) problems.push(`${label}: ${change.id} has another rule.`);
      answered.add(change.id);
      if (change.version !== table.version)
        problems.push(
          `${label}: ${change.id} belongs in ${change.version ?? 'out-of-cycle'}.json.`,
        );
      if (rule.from !== changeSubject(change) || rule.to !== change.replacement)
        problems.push(`${label}: from and to must be the change's subject and replacement.`);
      if (rule.family !== ruleFamily(change))
        problems.push(`${label}: family must be ${ruleFamily(change)}.`);
      if (rule.source !== change.source || rule.checkedAt !== change.checkedAt)
        problems.push(`${label}: source and checkedAt must be the change's.`);
      if (rule.status !== 'review' || rule.origin !== 'mined')
        problems.push(`${label}: status must be review and origin mined.`);
      const content = pageFor(label, String(rule.source));
      if (content)
        for (const problem of quoteProblems({ ...change, quote: String(rule.quote) }, content))
          problems.push(`${label}: ${problem}.`);
    }
  }
  for (const change of changes)
    if (change.replacement && !answered.has(change.id))
      problems.push(`${change.id}: names a replacement but has no rule.`);
  return problems;
}

export async function readMetaGraphEvidence() {
  const pages = new Map<string, string>();
  for (const file of await readdir(META_PAGES))
    if (file.endsWith('.json')) {
      const page = JSON.parse(await readFile(new URL(file, META_PAGES), 'utf8'));
      pages.set(page.label, page.content);
    }
  const tables = [];
  for (const file of (await readdir(META_RULES)).filter((name) => name.endsWith('.json')).sort())
    tables.push({ file, table: JSON.parse(await readFile(new URL(file, META_RULES), 'utf8')) });
  return { pages, tables };
}

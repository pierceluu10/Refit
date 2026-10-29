import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import {
  captureDocumentation,
  readDocumentationSnapshots,
  type CapturedDocumentation,
} from './documentation-sources.ts';
import {
  STRIPE_PAGES,
  capturedPages,
  previousStripeVersion,
  versionEvidence,
} from './rule-evidence.ts';
import {
  completeCandidate,
  keep,
  reproductions,
  diffDigest,
  generateCandidates,
  type Candidate,
  type PageGeneration,
} from './rule-generation.ts';
import {
  STRIPE_LEARNED_TABLES,
  STRIPE_PACK,
  STRIPE_RULE_TABLES,
  type RuleTable,
  type TableRule,
} from './rule-pack.ts';
import { loadMetaGraphChanges } from './meta-graph-changes.ts';
import {
  checkMetaGraphEvidence,
  readMetaGraphEvidence,
  type MetaGraphRuleTable,
} from './meta-graph-rules.ts';
import { responseRemovals, verifyRule } from './rule-verification.ts';
import { digest } from './specifications.ts';
import { breakingPages } from './stripe-release.ts';
import {
  changelogEntries,
  completeMined,
  isChangeEntry,
  mineEntry,
  type EntryMining,
  type MinedCandidate,
  type Outcome,
} from './shopify-changelog-mining.ts';
import {
  loadShopifyAlerts,
  loadShopifyRuleTables,
  type ShopifyRuleTable,
  shopifyCoverage,
  verifyShopifyAlert,
  verifyShopifyRule,
} from './shopify-rules.ts';
import { pinnedShopifyDiff, shopifyDiffFile } from './shopify-schema-diff.ts';
import { pinnedShopifyVersions, SHOPIFY_APIS } from './shopify-schemas.ts';
import { PipelineInputError } from './types.ts';

const USAGE = `Usage: refit rules check [--contracts <directory>] [--provider shopify] [--coverage <shopify-coverage.json>]
       refit rules save-page --url <https://shopify.dev/....md> [--url ...]
       refit rules mine-shopify --output <new-directory> [--write] [--limit <entries>] [--entry <slug> ...]
       refit rules generate --version <api-version> [--version ...] --output <new-directory> [--write] [--contracts <directory>]`;
const CHANGELOG = { label: 'stripe-changelog', url: 'https://docs.stripe.com/changelog.md' };
const TABLES = fileURLToPath(new URL('../data/rules/stripe/', import.meta.url));
const SHOPIFY_FEED = 'https://shopify.dev/changelog/feed.xml';
const SHOPIFY_PAGES = fileURLToPath(
  new URL('../docs/benchmarks/shopify-changelog/pages/', import.meta.url),
);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contracts: { type: 'string', default: join(homedir(), '.refit', 'contracts') },
    version: { type: 'string', multiple: true },
    output: { type: 'string' },
    write: { type: 'boolean' },
    coverage: { type: 'string' },
    provider: { type: 'string' },
    url: { type: 'string', multiple: true },
    limit: { type: 'string' },
    entry: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`${USAGE}

check: verifies data/meta-graph/changes.json and every rule in data/rules/meta-graph: each quote must
be in its saved Meta changelog page (docs/benchmarks/meta-graph-changelog/pages) and name its
identifier and replacement, and every change that names a replacement has exactly one rule. It then
verifies every rule in data/rules/stripe. Each rule's quote must be in its saved changelog
page (docs/benchmarks/stripe-changelog/pages) verbatim, its oasdiff entry must be in the changelog
between the table's two pinned contracts and be the change the rule answers, and the rule must
agree with both contracts. Contracts missing from --contracts are downloaded at their pinned
stripe/openapi commit and checked against data/stripe-openapi-versions.json. Needs oasdiff.
It then checks data/rules/shopify and data/shopify-alerts.json against the saved Shopify pages
(docs/benchmarks/shopify-changelog/pages) and the pinned schemas (data/shopify-schema-versions.json),
checks that data/shopify-schema-diffs is what those schemas give, and prints how many breaking and
deprecated schema changes a rule or an alert answers; --coverage writes every change with its state.
--provider shopify checks only Shopify. See docs/SHOPIFY-RULES.md.

save-page: saves Shopify pages (Markdown URLs ending in .md) under docs/benchmarks/shopify-changelog/
pages for rules and alerts to quote; a rule's source is the URL without .md.

mine-shopify: reads https://shopify.dev/changelog/feed.xml, saves every entry that announces a change
to an API area Refit reads (pipeline/shopify-changelog-mining.ts), asks OpenAI for candidate rules and
alerts per entry with the schema changes it mentions, and verifies each as check does. A rule that
fails becomes an alert when its quote verifies. Writes results.json and audit.json; --write also adds
the kept rules (review-only) to data/rules/shopify/generated-<api>-<version>.json and the alerts to
data/shopify-alerts.json. Needs OPENAI_API_KEY and OPENAI_MODEL; spends at most REFIT_AI_BUDGET_USD.

generate: reads docs.stripe.com/changelog.md, saves each page it marks Breaking for the version
(skipping pages already saved), diffs the version's pinned contract with the one before it, asks
OpenAI for candidate rules per page and verifies each one as check does. Writes results.json (every
candidate and why it was kept or refused, and which shipped rules the kept rules reproduce)
and audit.json (every prompt and model output). --write also saves the kept rules, review-only,
as data/rules/stripe/<version>.json. Needs OPENAI_API_KEY and OPENAI_MODEL; spends at most
REFIT_AI_BUDGET_USD (default $1). See docs/MINED-RULES.md.`);
  process.exit(0);
}

if (positionals[0] === 'check' && values.provider === 'shopify') await checkShopify();
else if (positionals[0] === 'check') await check();
else if (positionals[0] === 'mine-shopify') await mineShopify();
else if (positionals[0] === 'save-page' && values.url?.length)
  for (const url of values.url) {
    const page = await savedShopifyPage(url);
    console.log(`${page.url} ${page.hash}`);
  }
else if (positionals[0] === 'generate') await generate();
else throw new PipelineInputError(USAGE);

async function check() {
  await checkMetaGraph();
  const pages = await capturedPages();
  let failures = 0;
  const tables = [...STRIPE_RULE_TABLES, ...STRIPE_LEARNED_TABLES];
  for (const table of tables) {
    if (table.previous !== previousStripeVersion(table.version))
      throw new PipelineInputError(
        `The ${table.version} rule table must compare against ${previousStripeVersion(table.version)}, not ${table.previous}.`,
      );
    const evidence = await versionEvidence(table.version, values.contracts!);
    const removals = responseRemovals(evidence.diff, evidence.before);
    for (const rule of table.rules) {
      const problems = verifyRule(rule, { ...evidence, pages }, removals);
      failures += problems.length ? 1 : 0;
      console.log(
        `${problems.length ? 'FAIL' : 'ok  '} ${table.version} ${rule.rule} (${rule.status})${problems.map((problem) => `\n     ${problem}`).join('')}`,
      );
    }
  }
  if (failures) throw new PipelineInputError(`${failures} rules are not backed by their evidence.`);
  console.log(`${tables.reduce((total, table) => total + table.rules.length, 0)} rules verified.`);
  await checkShopify();
}

// Shopify: the committed schema diffs must be what the pinned schemas give, and every rule and
// alert must be backed by its saved page and the pinned schemas (pipeline/shopify-rules.ts).
async function checkShopify() {
  for (const api of SHOPIFY_APIS)
    for (const version of pinnedShopifyVersions(api).slice(1)) {
      const committed = readFileSync(shopifyDiffFile(api, version), 'utf8');
      if (committed !== `${JSON.stringify(pinnedShopifyDiff(api, version), null, 2)}\n`)
        throw new PipelineInputError(
          `data/shopify-schema-diffs/${api}/${version}.json is not the diff of its pinned schemas; run refit shopify-snapshot --diffs.`,
        );
    }
  const pages = await capturedPages(SHOPIFY_PAGES);
  const releases = async (name: string) => {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new PipelineInputError(`npm returned HTTP ${response.status} for ${name}.`);
    return Object.keys(((await response.json()) as { versions: object }).versions);
  };
  const tables = loadShopifyRuleTables();
  const alerts = loadShopifyAlerts();
  let failures = 0;
  for (const table of tables)
    for (const rule of table.rules) {
      const problems = await verifyShopifyRule(rule, table, { pages, releases });
      failures += problems.length ? 1 : 0;
      console.log(
        `${problems.length ? 'FAIL' : 'ok  '} shopify ${table.api} ${table.version ?? ''} ${rule.rule}${problems.map((problem) => `\n     ${problem}`).join('')}`,
      );
    }
  for (const alert of alerts) {
    const problems = verifyShopifyAlert(alert, pages);
    failures += problems.length ? 1 : 0;
    if (problems.length)
      console.log(
        `FAIL shopify alert ${alert.id}${problems.map((problem) => `\n     ${problem}`).join('')}`,
      );
  }
  if (failures)
    throw new PipelineInputError(
      `${failures} Shopify rules or alerts are not backed by their evidence.`,
    );
  const coverage = shopifyCoverage(tables, alerts);
  const count = (state: string, breaking: boolean) =>
    coverage.filter((row) => row.state === state && row.change.breaking === breaking).length;
  console.log(
    `${tables.reduce((total, table) => total + table.rules.length, 0)} Shopify rules and ${alerts.length} alerts verified. Breaking schema changes: ${count('rule', true)} mapped to a rule, ${count('alert-only', true)} alert-only, ${count('unmapped', true)} unmapped. Deprecations: ${count('rule', false)} mapped to a rule, ${count('alert-only', false)} alert-only, ${count('unmapped', false)} unmapped.`,
  );
  if (values.coverage)
    await writeFile(
      values.coverage,
      `${JSON.stringify(
        coverage.map(({ api, version, change, state, by }) => ({
          api,
          version,
          id: change.id,
          coordinate: change.coordinate,
          breaking: change.breaking,
          state,
          ...(by ? { by } : {}),
        })),
        null,
        2,
      )}\n`,
    );
}

// Meta publishes no contract, so its rules are checked against the change table and the saved
// changelog pages alone.
async function checkMetaGraph() {
  const { changes } = await loadMetaGraphChanges();
  const { pages, tables } = await readMetaGraphEvidence();
  const problems = checkMetaGraphEvidence(changes, tables, pages);
  for (const problem of problems) console.log(`FAIL meta-graph ${problem}`);
  if (problems.length)
    throw new PipelineInputError(
      `${problems.length} Meta Graph quotes or rules are not backed by their pages.`,
    );
  const rules = tables.reduce(
    (total, { table }) => total + (table as MetaGraphRuleTable).rules.length,
    0,
  );
  console.log(
    `${changes.length} Meta Graph changes and ${rules} rules verified against their saved pages.`,
  );
}

// The saved page, or a fresh capture saved next to the others.
async function savedPage(version: string, slug: string, url: string) {
  const path = join(STRIPE_PAGES, version, `${slug}.json`);
  if (existsSync(path)) {
    const [page] = await readDocumentationSnapshots([path]);
    if (page.url === `${url}.md`) return page;
  }
  const page = await captureDocumentation({ label: slug, url: `${url}.md` });
  await mkdir(join(STRIPE_PAGES, version), { recursive: true });
  await writeFile(path, `${JSON.stringify(page, null, 2)}\n`);
  return page;
}

// A Shopify page saved for rules to quote: changelog entries under changelog/, guides under docs/.
async function savedShopifyPage(url: string) {
  const match = /^https:\/\/shopify\.dev\/(changelog\/posts|docs)\/(.+)\.md$/.exec(url);
  if (!match) throw new PipelineInputError(`${url} is not a shopify.dev Markdown page.`);
  const group = match[1] === 'docs' ? 'docs' : 'changelog';
  const slug = match[2].replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const path = join(SHOPIFY_PAGES, group, `${slug}.json`);
  if (existsSync(path)) {
    const [page] = await readDocumentationSnapshots([path]);
    if (page.url === url) return page;
  }
  const page = await captureDocumentation({ label: slug.slice(0, 100), url });
  await mkdir(join(SHOPIFY_PAGES, group), { recursive: true });
  await writeFile(path, `${JSON.stringify(page, null, 2)}\n`);
  return page;
}

async function generate() {
  if (!values.version?.length || !values.output)
    throw new PipelineInputError(
      `At least one --version and an --output directory are required.\n${USAGE}`,
    );
  const ai = assessmentConfiguration(true, process.env)!;
  const checkedAt = new Date().toISOString().slice(0, 10);
  await mkdir(values.output);
  const changelog = await captureDocumentation(CHANGELOG);
  // The rules Refit ships: what a new generation must reproduce before it may replace them.
  const shipped = [...STRIPE_PACK.fieldMoves, ...STRIPE_PACK.requestMoves];
  const pages: (PageGeneration & { version: string })[] = [];
  const candidates: {
    version: string;
    page: string;
    candidate: Candidate;
    rule?: TableRule;
    reason?: string;
  }[] = [];
  const versionErrors: Record<string, string> = {};
  const generated: TableRule[] = [];
  for (const version of values.version) {
    const listed = breakingPages(changelog.content, version);
    let evidence: Awaited<ReturnType<typeof versionEvidence>>;
    try {
      evidence = await versionEvidence(version, values.contracts!);
    } catch (error) {
      // A pair oasdiff cannot compare has no diff to verify against, so it yields no rules.
      if (!(error instanceof PipelineInputError)) throw error;
      versionErrors[version] = error.message;
      console.error(`[${version}] ${error.message}`);
      continue;
    }
    const removals = responseRemovals(evidence.diff, evidence.before);
    const kept: TableRule[] = [];
    const versionPages = new Map<string, CapturedDocumentation>();
    for (const [index, listing] of listed.entries()) {
      const page = await savedPage(version, listing.slug, listing.url);
      versionPages.set(listing.url, page);
      const result = await generateCandidates(
        version,
        listing.slug,
        page,
        diffDigest(page, evidence.diff, removals),
        ai,
      );
      pages.push({ version, ...result });
      console.error(
        `[${version} ${index + 1}/${listed.length}] ${listing.slug}: ${result.error ?? `${result.candidates.length} candidates`} ($${result.costUsd.toFixed(4)})`,
      );
      for (const candidate of result.candidates) {
        const outcome = completeCandidate(
          candidate,
          {
            version,
            source: listing.url,
            checkedAt,
            generatedBy: { model: result.model!, responseId: result.responseId! },
          },
          { ...evidence, pages: versionPages },
          removals,
        );
        candidates.push({ version, page: listing.slug, candidate, ...outcome });
        if ('rule' in outcome)
          keep(kept, outcome.rule, { ...evidence, pages: versionPages }, removals);
      }
    }
    generated.push(...kept);
    if (values.write && kept.length) {
      const table: RuleTable = {
        formatVersion: 1,
        provider: 'stripe',
        version,
        previous: previousStripeVersion(version),
        rules: kept,
      };
      await mkdir(TABLES, { recursive: true });
      await writeFile(join(TABLES, `${version}.json`), `${JSON.stringify(table, null, 2)}\n`);
    }
  }
  const costUsd = pages.reduce((total, page) => total + page.costUsd, 0);
  const verified = candidates.flatMap((entry) => (entry.rule ? [entry.rule] : []));
  const found = reproductions(shipped, generated);
  const reproducing = new Set([...found.values()].flat());
  const summary = {
    pages: pages.length,
    versionErrors,
    pageErrors: pages.filter((page) => page.error).length,
    candidates: candidates.length,
    verified: verified.length,
    unverifiable: candidates.length - verified.length,
    shippedRules: shipped.length,
    reproduced: Object.fromEntries(found),
    notReproduced: shipped.map((rule) => rule.rule).filter((rule) => !found.has(rule)),
    kept: generated.length,
    new: generated.filter((rule) => !reproducing.has(rule.rule)).map((rule) => rule.rule),
  };
  await writeFile(
    join(values.output, 'results.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        checkedAt,
        configuredModel: ai.model,
        changelog: { url: changelog.url, sha256: changelog.hash },
        versions: values.version,
        costUsd,
        summary,
        candidates,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(values.output, 'audit.json'), `${JSON.stringify({ pages }, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, costUsd }, null, 2));
}

async function mineShopify() {
  if (!values.output) throw new PipelineInputError(`--output is required.\n${USAGE}`);
  const ai = assessmentConfiguration(true, process.env)!;
  const checkedAt = new Date().toISOString().slice(0, 10);
  await mkdir(values.output);
  const response = await fetch(SHOPIFY_FEED, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new PipelineInputError(`The Shopify changelog feed returned HTTP ${response.status}.`);
  const feed = await response.text();
  const entries = changelogEntries(feed)
    .filter(isChangeEntry)
    .filter((entry) => !values.entry?.length || values.entry.includes(entry.slug))
    .slice(0, values.limit ? Number(values.limit) : undefined);
  const pages = new Map<string, CapturedDocumentation>();
  for (const entry of entries) {
    const page = await savedShopifyPage(entry.url);
    pages.set(page.url.replace(/\.md$/, ''), page);
  }
  const releases = async (name: string) => {
    const reply = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      signal: AbortSignal.timeout(60_000),
    });
    return reply.ok ? Object.keys(((await reply.json()) as { versions: object }).versions) : [];
  };
  const evidence = { pages: await capturedPages(SHOPIFY_PAGES), releases };
  const minings: EntryMining[] = [];
  // One entry at a time: the budget ledger's lock refuses concurrent reservations.
  for (const [index, entry] of entries.entries()) {
    const mining = await mineEntry(entry, pages.get(entry.url.replace(/\.md$/, ''))!, ai);
    console.error(
      `[${index + 1}/${entries.length}] ${entry.slug}: ${mining.error ?? `${mining.candidates.length} candidates`} ($${mining.costUsd.toFixed(4)})`,
    );
    minings.push(mining);
  }
  const outcomes: { entry: string; candidate: MinedCandidate; outcome: Outcome }[] = [];
  for (const mining of minings)
    for (const candidate of mining.candidates) {
      const source = mining.url.replace(/\.md$/, '');
      const outcome = await completeMined(
        candidate,
        {
          source,
          checkedAt,
          generatedBy: { model: mining.model!, responseId: mining.responseId! },
          page: evidence.pages.get(source)!,
        },
        evidence,
      );
      outcomes.push({ entry: mining.slug, candidate, outcome });
    }
  const handWritten = loadShopifyRuleTables().filter((table) =>
    table.rules.some((rule) => rule.origin !== 'generated'),
  );
  const known = new Set(
    handWritten.flatMap((table) =>
      table.rules.map((rule) => `${table.api} ${rule.diff.operationId}`),
    ),
  );
  const kept = new Map<string, ShopifyRuleTable>();
  const names = new Set(
    loadShopifyRuleTables().flatMap((table) => table.rules.map((rule) => rule.rule)),
  );
  const reproduced: string[] = [];
  for (const { outcome } of outcomes) {
    if (outcome.kind !== 'rule') continue;
    if (known.has(`${outcome.table.api} ${outcome.rule.diff.operationId}`)) {
      reproduced.push(outcome.rule.rule);
      continue;
    }
    if (names.has(outcome.rule.rule)) continue;
    names.add(outcome.rule.rule);
    const key = `${outcome.table.api}-${outcome.table.version ?? 'packages'}`;
    const table = kept.get(key) ?? { ...outcome.table, rules: [] };
    table.rules.push(outcome.rule);
    kept.set(key, table);
  }
  const alerts = outcomes.flatMap(({ outcome }) =>
    outcome.kind === 'alert' ? [outcome.alert] : [],
  );
  const costUsd = minings.reduce((total, mining) => total + mining.costUsd, 0);
  const summary = {
    entries: entries.length,
    entryErrors: minings.filter((mining) => mining.error).length,
    candidates: outcomes.length,
    rules: [...kept.values()].reduce((total, table) => total + table.rules.length, 0),
    reproducedHandWritten: reproduced.length,
    alerts: alerts.length,
    refused: outcomes.filter(({ outcome }) => outcome.kind === 'refused').length,
    ruleCandidatesKeptAsAlerts: outcomes.filter(
      ({ outcome }) => outcome.kind === 'alert' && outcome.refusedRule,
    ).length,
  };
  await writeFile(
    join(values.output, 'results.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        checkedAt,
        configuredModel: ai.model,
        feed: { url: SHOPIFY_FEED, sha256: digest(feed) },
        costUsd,
        summary,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(values.output, 'audit.json'), `${JSON.stringify({ minings }, null, 2)}\n`);
  if (values.write) {
    for (const [key, table] of kept) {
      const path = fileURLToPath(
        new URL(`../data/rules/shopify/generated-${key}.json`, import.meta.url),
      );
      const existing = existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as ShopifyRuleTable)
        : undefined;
      await writeFile(
        path,
        `${JSON.stringify({ ...table, rules: [...(existing?.rules ?? []), ...table.rules] }, null, 2)}\n`,
      );
    }
    const file = fileURLToPath(new URL('../data/shopify-alerts.json', import.meta.url));
    const stored = loadShopifyAlerts();
    const ids = new Set(stored.map((alert) => alert.id));
    for (const alert of alerts) {
      let id = alert.id;
      for (let suffix = 2; ids.has(id); suffix += 1) id = `${alert.id}-${suffix}`;
      ids.add(id);
      stored.push({ ...alert, id });
    }
    await writeFile(file, `${JSON.stringify({ formatVersion: 1, alerts: stored }, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...summary, costUsd }, null, 2));
}

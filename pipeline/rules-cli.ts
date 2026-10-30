import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { breakingPages } from './stripe-release.ts';
import { PipelineInputError } from './types.ts';

const USAGE = `Usage: refit rules check [--contracts <directory>]
       refit rules generate --version <api-version> [--version ...] --output <new-directory> [--write] [--contracts <directory>]`;
const CHANGELOG = { label: 'stripe-changelog', url: 'https://docs.stripe.com/changelog.md' };
const TABLES = fileURLToPath(new URL('../data/rules/stripe/', import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contracts: { type: 'string', default: join(homedir(), '.refit', 'contracts') },
    version: { type: 'string', multiple: true },
    output: { type: 'string' },
    write: { type: 'boolean' },
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

generate: reads docs.stripe.com/changelog.md, saves each page it marks Breaking for the version
(skipping pages already saved), diffs the version's pinned contract with the one before it, asks
OpenAI for candidate rules per page and verifies each one as check does. Writes results.json (every
candidate and why it was kept or refused, and which shipped rules the kept rules reproduce)
and audit.json (every prompt and model output). --write also saves the kept rules, review-only,
as data/rules/stripe/<version>.json. Needs OPENAI_API_KEY and OPENAI_MODEL; spends at most
REFIT_AI_BUDGET_USD (default $1). See docs/MINED-RULES.md.`);
  process.exit(0);
}

if (positionals[0] === 'check') await check();
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

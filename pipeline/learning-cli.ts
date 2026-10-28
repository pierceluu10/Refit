import { writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  addLearnedRule,
  blindRepositories,
  CANDIDATES,
  demote,
  emptyCandidates,
  emptySignatures,
  groundCandidate,
  isBlindList,
  knownPatterns,
  LEARNED_RULES,
  PROMOTION_REPOSITORIES,
  promotionBlockers,
  readJson,
  recordCandidates,
  recordSignatures,
  SIGNATURES,
  type CandidateStore,
  type OutcomeEvent,
} from './learning.ts';
import { stripeContractVersions } from './enrollment-contracts.ts';
import { capturedPages, STRIPE_PAGES, versionEvidence } from './rule-evidence.ts';
import { STRIPE_LEARNED_TABLES, STRIPE_PACK, type RuleTable } from './rule-pack.ts';
import { PipelineInputError } from './types.ts';

const USAGE = `Usage: refit learn record --run <id> --list <frozen.json> --results <results.json> [--results ...]
       refit learn promote [--contracts <directory>] [--dry-run]
       refit learn demote --events <events.json>
       refit learn replay --run <id> --list <frozen.json> --results <results.json> [--results ...] [--contracts <directory>]`;
const BENCHMARKS = new URL('../docs/benchmarks/', import.meta.url);
const REVIEWS = new URL('fix-reviews.json', BENCHMARKS);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    list: { type: 'string' },
    results: { type: 'string', multiple: true },
    events: { type: 'string' },
    contracts: { type: 'string', default: join(homedir(), '.refit', 'contracts') },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`${USAGE}

The autonomous loop's learning steps (docs/AUTONOMOUS-LOOP.md), each a commit to data/learning/.

record: counts each failed row's signature in data/learning/signatures.json (new against seen) and
adds proven AI fixes (grade A or B, or merged without edits) as candidate rules, with check
failures of learned rules as contrary evidence, in data/learning/candidates.json. A blind list
(progress-30, a frozen final set, or "blind": true) is refused, and rows of repositories on any
blind list are skipped.

promote: promotes each candidate proven on ${PROMOTION_REPOSITORIES} or more repositories, with no contrary evidence (its
own or a wrong verdict in docs/benchmarks/fix-reviews.json), whose rule passes the rules:check
verification against a saved Stripe page and both pinned contracts. Needs oasdiff.

demote: applies outcome events ([{ kind, rule | pullRequest, repo?, detail? }], kind one of
reverted, closed-unmerged, post-merge-ci-failed, check-failed). One event demotes a promoted rule to
review-only and lists the pull requests its patches opened, to flag.

replay: record and promote without writing anything, to show what a run would teach.`);
  process.exit(0);
}

const command = positionals[0];
if (command === 'record' || command === 'replay') await record(command === 'replay');
else if (command === 'promote')
  await promote(
    readJson(CANDIDATES, emptyCandidates),
    STRIPE_LEARNED_TABLES,
    Boolean(values['dry-run']),
  );
else if (command === 'demote') {
  if (!values.events) throw new PipelineInputError(`--events is required.\n${USAGE}`);
  const events = JSON.parse(readFileSync(values.events, 'utf8')) as OutcomeEvent[];
  const result = await rollBack(events, readJson(CANDIDATES, emptyCandidates), false);
  if (!result.demoted.length) console.log('No promoted rule is affected.');
} else throw new PipelineInputError(USAGE);

async function record(dryRun: boolean) {
  if (!values.run || !values.list || !values.results?.length)
    throw new PipelineInputError(`--run, --list and --results are required.\n${USAGE}`);
  // The path is checked before the list is read, so a blind list is never opened.
  if (
    isBlindList(values.list) ||
    isBlindList(values.list, JSON.parse(readFileSync(values.list, 'utf8')) as unknown)
  )
    throw new PipelineInputError(`${values.list} is a blind list; Refit never learns from it.`);
  // One row per repository: shard and merged results of one run repeat rows; the last one wins.
  const rows = [
    ...new Map(
      values.results
        .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[])
        .map((row) => [String(row.repo).toLowerCase(), row]),
    ).values(),
  ];
  const blind = blindRepositories(BENCHMARKS);
  const learnable = rows.filter((row) => !blind.has(String(row.repo).toLowerCase()));
  const signatures = recordSignatures(readJson(SIGNATURES, emptySignatures), values.run, learnable);
  const candidates = recordCandidates(
    readJson(CANDIDATES, emptyCandidates),
    values.run,
    learnable,
    {
      known: knownPatterns([
        ...STRIPE_PACK.requestMoves,
        ...STRIPE_LEARNED_TABLES.flatMap((table) => table.rules),
      ]),
      blind,
    },
  );
  console.log(
    `${learnable.length} rows (${rows.length - learnable.length} on blind lists skipped): ${signatures.fresh.length} new signatures, ${signatures.seen} seen before.`,
  );
  for (const id of signatures.fresh) {
    const entry = signatures.store.signatures[id];
    console.log(`  new ${id} ${entry.status}/${entry.stage} x${entry.rows}: ${entry.lead}`);
  }
  console.log(`Candidates touched: ${candidates.touched.length}.`);
  for (const candidate of candidates.store.candidates.filter((entry) =>
    candidates.touched.includes(entry.id),
  ))
    console.log(
      `  ${candidate.id} (${candidate.status}): ${candidate.evidence.map((entry) => `${entry.repo} ${entry.grade ?? 'merged'}`).join(', ')}`,
    );
  if (!dryRun) await writeFile(SIGNATURES, json(signatures.store));
  // A check failure a learned rule caused in this run demotes it before anything is promoted.
  const rolled = await rollBack([], candidates.store, dryRun);
  await promote(rolled.store, rolled.tables, dryRun);
}

async function promote(store: CandidateStore, learned: RuleTable[], dryRun: boolean) {
  const reviews = JSON.parse(readFileSync(REVIEWS, 'utf8')) as unknown;
  const ready = store.candidates.filter((candidate) => {
    const blockers = promotionBlockers(candidate, reviews);
    if (blockers.length && candidate.status === 'candidate')
      console.log(`  not promoted ${candidate.id}: ${blockers.join('; ')}`);
    return !blockers.length;
  });
  if (!ready.length) return console.log('Nothing to promote.');
  const pages = await capturedPages();
  let tables = learned;
  const candidates = store.candidates.map((candidate) => ({ ...candidate }));
  // Each version change with saved changelog pages, newest first: a rule belongs to the version
  // that removed its value.
  const pinned = stripeContractVersions().map((entry) => entry.version);
  const versions = readdirSync(STRIPE_PAGES)
    .filter((name) => pinned.indexOf(name) > 0)
    .sort()
    .reverse();
  const evidence = new Map<string, Awaited<ReturnType<typeof versionEvidence>>>();
  for (const candidate of candidates.filter((entry) =>
    ready.some((ready) => ready.id === entry.id),
  )) {
    const problems: string[] = [];
    for (const version of versions) {
      if (!evidence.has(version))
        evidence.set(version, await versionEvidence(version, values.contracts!));
      const found = evidence.get(version)!;
      const grounded = groundCandidate(candidate, version, { ...found, pages });
      if (!grounded.rule) {
        problems.push(...grounded.problems.map((problem) => `${version}: ${problem}`));
        continue;
      }
      tables = addLearnedRule(tables, version, found.previous, grounded.rule);
      Object.assign(candidate, {
        status: 'promoted',
        rule: grounded.rule.rule,
        version,
        promotedAt: grounded.rule.checkedAt,
      });
      console.log(`  promoted ${candidate.id} as ${grounded.rule.rule} in ${version}`);
      break;
    }
    if (candidate.status !== 'promoted')
      console.log(`  not promoted ${candidate.id}: the rule check failed (${problems.join('; ')})`);
  }
  if (dryRun) return;
  for (const table of tables)
    await writeFile(new URL(`${table.version}.json`, LEARNED_RULES), json(table));
  await writeFile(CANDIDATES, json({ formatVersion: 1, candidates }));
}

async function rollBack(events: OutcomeEvent[], store: CandidateStore, dryRun: boolean) {
  const result = demote(STRIPE_LEARNED_TABLES, store, events);
  for (const entry of result.demoted)
    console.log(
      `demoted ${entry.rule}: ${entry.reason}\n  flag: ${entry.flagged.length ? entry.flagged.join(', ') : 'no pull requests'}`,
    );
  if (!dryRun) {
    for (const table of result.tables)
      await writeFile(new URL(`${table.version}.json`, LEARNED_RULES), json(table));
    await writeFile(CANDIDATES, json(result.store));
  }
  return result;
}

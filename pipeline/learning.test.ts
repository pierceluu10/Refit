import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CapturedDocumentation } from './documentation-sources.ts';
import {
  addLearnedRule,
  blindRepositories,
  demote,
  diffPatterns,
  emptyCandidates,
  emptySignatures,
  failureSignature,
  groundCandidate,
  isBlindList,
  knownPatterns,
  patternId,
  promotionBlockers,
  recordCandidates,
  recordSignatures,
  signatureSummary,
  type Candidate,
  type CandidateStore,
} from './learning.ts';
import { parseRuleTable, STRIPE_PACK, withRuleTables, type RuleTable } from './rule-pack.ts';
import type { RuleEvidence } from './rule-verification.ts';

const VERSION = '2026-09-30.endive';
const SOURCE = 'https://docs.stripe.com/changelog/endive/2026-09-30/example';
const QUOTE = 'Use `new_param` instead of `old_param` when you create a widget.';

const stop = (repo: string, reason: string, stage = 'checks') => ({
  repo,
  workflow: { status: 'needs-review', stage, reason },
});

const RENAME_DIFF = [
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -1,3 +1,3 @@',
  ' const widget = await stripe.widgets.create({',
  "-  old_param: ['card'],",
  "+  new_param: ['card'],",
  ' });',
].join('\n');

const aiRow = (repo: string, letter: string, diff = RENAME_DIFF, extra = {}) => ({
  repo,
  workflow: {
    status: 'needs-review',
    validation: 'passed',
    generator: 'openai',
    grade: { letter, level: 'tests', reason: 'tests reach every changed file' },
    diff,
    coverageAi: { outcome: 'kept', targets: [{ expression: 'POST /v1/widgets' }] },
  },
  ...extra,
});

const learn = (rows: Record<string, unknown>[], store = emptyCandidates(), run = 'run-1') =>
  recordCandidates(store, run, rows, { known: new Set(), blind: new Set() }).store;

const body = (properties: Record<string, unknown>) => ({
  requestBody: {
    content: {
      'application/x-www-form-urlencoded': { schema: { type: 'object', properties } },
    },
  },
});
const contract = (properties: Record<string, unknown>) => ({
  openapi: '3.0.0',
  paths: { '/v1/widgets': { post: { operationId: 'PostWidgets', ...body(properties) } } },
  components: { schemas: {} },
});
const list = { type: 'array', items: { type: 'string', maxLength: 5000 } };
const page = (content: string): CapturedDocumentation => ({
  formatVersion: 1,
  kind: 'refit-documentation-snapshot',
  label: 'example',
  url: `${SOURCE}.md`,
  revision: 'hash',
  hash: 'hash',
  content,
  contentType: 'text/markdown',
});
const evidence = (content = `# Widgets\n\n${QUOTE}\n`): RuleEvidence => ({
  pages: new Map([[SOURCE, page(content)]]),
  before: contract({ old_param: list }),
  after: contract({ new_param: list }),
  diff: [
    {
      id: 'request-property-removed',
      operationId: 'PostWidgets',
      text: 'removed the request property `old_param`',
    },
  ],
});

const proven = () => learn(['a/one', 'b/two', 'c/three'].map((repo) => aiRow(repo, 'B')));

describe('failure signatures', () => {
  it('gives one cause in different repositories one signature', () => {
    const one = failureSignature(
      stop('a/one', 'Type check failed in src/billing/pay.ts:12:4 with TS2353 after 3 edits.'),
    );
    const two = failureSignature(
      stop('b/two', 'Type check failed in app/lib/stripe.tsx:88:1 with TS2353 after 14 edits.'),
    );
    expect(one?.id).toBe(two?.id);
    expect(one?.codes).toEqual(['TS2353']);
    expect(one?.lead).toBe('Type check failed in <file> with TS2353 after <n> edits.');
  });

  it('separates stages and change ids, and ignores rows that passed', () => {
    const reason = 'A traced call sends a removed parameter.';
    expect(failureSignature(stop('a/one', reason, 'scan'))?.id).not.toBe(
      failureSignature(stop('a/one', reason, 'checks'))?.id,
    );
    expect(failureSignature(stop('a/one', `${reason} request-property-removed`))?.changes).toEqual([
      'request-property-removed',
    ]);
    expect(failureSignature({ repo: 'a/one', workflow: { status: 'validated' } })).toBeUndefined();
    expect(failureSignature({ repo: 'a/one' })).toBeUndefined();
    expect(
      failureSignature({ repo: 'a/one', infrastructure: { kind: 'clone', message: 'timeout' } })
        ?.status,
    ).toBe('infrastructure');
  });

  it('counts new against seen signatures per run and refuses a run twice', () => {
    const first = recordSignatures(emptySignatures(), 'run-1', [
      stop('a/one', 'No check can run.'),
      stop('b/two', 'No check can run.'),
      { repo: 'c/three', workflow: { status: 'validated' } },
    ]);
    expect(first.fresh).toHaveLength(1);
    const second = recordSignatures(first.store, 'run-2', [
      stop('a/one', 'No check can run.'),
      stop('d/four', 'Dependencies could not be prepared: ERR_PNPM_OUTDATED_LOCKFILE.', 'prepare'),
    ]);
    expect([second.fresh.length, second.seen]).toEqual([1, 1]);
    const id = first.fresh[0];
    expect(second.store.signatures[id]).toMatchObject({ runs: 2, rows: 3, firstRun: 'run-1' });
    expect(second.store.runs.map((run) => run.new.length)).toEqual([1, 1]);
    expect(() => recordSignatures(second.store, 'run-2', [])).toThrow(/already recorded/);
  });

  it('lists new signatures in the benchmark summary', () => {
    const { store } = recordSignatures(emptySignatures(), 'run-1', [stop('a/one', 'Old cause.')]);
    const summary = signatureSummary(
      [stop('a/one', 'Old cause.'), stop('b/two', 'New cause.')],
      store,
    );
    expect(summary).toContain('new against data/learning/signatures.json: 1, seen before: 1');
    expect(summary).toContain('| needs-review | checks | 1 | New cause. |');
    expect(summary).not.toContain('Old cause. |');
  });
});

describe('candidate rules', () => {
  it('reads renames and enum replacements from a diff', () => {
    expect(diffPatterns(RENAME_DIFF)).toEqual([
      { family: 'request-rename', parameter: 'old_param', replacement: 'new_param' },
    ]);
    const enumDiff = ["-    ui_mode: 'hosted',", "+    ui_mode: 'hosted_page',"].join('\n');
    expect(diffPatterns(enumDiff)).toEqual([
      {
        family: 'request-enum-value',
        parameter: 'ui_mode',
        value: 'hosted',
        replacement: 'hosted_page',
      },
    ]);
    // A changed value expression, unequal blocks and a renamed variable are not request moves.
    expect(diffPatterns('-  amount: total,\n+  amount: total * 100,')).toEqual([]);
    expect(diffPatterns('-  a: 1,\n-  b: 2,\n+  c: 1,')).toEqual([]);
    expect(diffPatterns('-const old_name = 1;\n+const new_name = 1;')).toEqual([]);
  });

  it('learns only from proven AI fixes on repositories that are not blind', () => {
    const rows = [
      aiRow('a/one', 'B'),
      aiRow('b/two', 'C'),
      aiRow('c/three', 'C', RENAME_DIFF, {
        publication: { url: 'https://x/pull/1', outcome: 'merged-without-edits' },
      }),
      {
        repo: 'd/four',
        workflow: {
          ...aiRow('d/four', 'A').workflow,
          generator: 'deterministic',
          coverageAi: undefined,
        },
      },
      aiRow('e/blind', 'A'),
      {
        ...aiRow('f/failed', 'A'),
        workflow: { ...aiRow('f/failed', 'A').workflow, validation: 'regression' },
      },
    ];
    const { store } = recordCandidates(emptyCandidates(), 'run-1', rows, {
      known: new Set(),
      blind: new Set(['e/blind']),
    });
    expect(store.candidates).toHaveLength(1);
    expect(
      store.candidates[0].evidence.map((entry) => [entry.repo, entry.grade, entry.merged]),
    ).toEqual([
      ['a/one', 'B', undefined],
      ['c/three', 'C', true],
    ]);
    expect(store.candidates[0].evidence[0].operations).toEqual(['POST /v1/widgets']);
  });

  it('skips patterns a shipped rule already makes', () => {
    const known = knownPatterns(STRIPE_PACK.requestMoves);
    const enumDiff = ["-  ui_mode: 'hosted',", "+  ui_mode: 'hosted_page',"].join('\n');
    expect(known.has(patternId(diffPatterns(enumDiff)[0]))).toBe(true);
    const { store } = recordCandidates(
      emptyCandidates(),
      'run-1',
      [aiRow('a/one', 'A', enumDiff)],
      {
        known,
        blind: new Set(),
      },
    );
    expect(store.candidates).toEqual([]);
    const policy = [
      "-  payment_method_types: ['card'],",
      "+  allowed_payment_method_types: ['card'],",
    ].join('\n');
    expect(learn([aiRow('a/one', 'A', policy)]).candidates).toEqual([]);
  });

  it('promotes at three distinct proven repositories with no contrary evidence', () => {
    const two = learn(['a/one', 'b/two'].map((repo) => aiRow(repo, 'A')));
    expect(promotionBlockers(two.candidates[0])).toEqual(['proven on 2 of 3 repositories']);
    // The same repository in another run is still one repository.
    const again = learn([aiRow('a/one', 'A')], two, 'run-2');
    expect(promotionBlockers(again.candidates[0])).toEqual(['proven on 2 of 3 repositories']);
    const store = proven();
    expect(promotionBlockers(store.candidates[0])).toEqual([]);
    const reviews = { reviews: [{ repo: 'b/two', verdict: 'wrong' }] };
    expect(promotionBlockers(store.candidates[0], reviews)).toEqual([
      'contrary evidence (wrong-review): fix-reviews.json: wrong',
    ]);
  });

  it('grounds a candidate in its Stripe page and both contracts, as rules:check does', () => {
    const [candidate] = proven().candidates;
    const grounded = groundCandidate(candidate, VERSION, evidence());
    expect(grounded.problems).toEqual([]);
    expect(grounded.rule).toMatchObject({
      rule: 'learned-request-rename-old_param-new_param',
      family: 'request-rename',
      operations: ['PostWidgets'],
      source: SOURCE,
      quote: QUOTE,
      status: 'auto',
      origin: 'learned',
    });
    const table = addLearnedRule([], VERSION, '2026-08-26.dahlia', grounded.rule!);
    expect(() => parseRuleTable(table[0], 'learned.json')).not.toThrow();
  });

  it('refuses a candidate no saved page or diff entry backs', () => {
    const [candidate] = proven().candidates;
    expect(
      groundCandidate(candidate, VERSION, evidence('# Widgets\n\nNothing here.')).problems,
    ).toEqual([`no saved ${VERSION} Stripe page names new_param`]);
    expect(groundCandidate(candidate, VERSION, { ...evidence(), diff: [] }).problems).toEqual([
      `${VERSION} does not remove the request property \`old_param\``,
    ]);
    const unrelated = {
      ...candidate,
      evidence: candidate.evidence.map((entry) => ({ ...entry, operations: ['POST /v1/other'] })),
    };
    expect(groundCandidate(unrelated, VERSION, evidence()).rule).toBeUndefined();
  });

  it('refuses a learned rule with fewer than three repositories', () => {
    const [candidate] = proven().candidates;
    const rule = groundCandidate(candidate, VERSION, evidence()).rule!;
    const table = addLearnedRule([], VERSION, '2026-08-26.dahlia', {
      ...rule,
      learnedFrom: rule.learnedFrom!.slice(0, 2),
    } as typeof rule);
    expect(() => parseRuleTable(table[0], 'learned.json')).toThrow(/at least 3 repositories/);
  });
});

describe('blind lists', () => {
  it('marks progress-30, final sets and lists that say so', () => {
    expect(isBlindList('docs/benchmarks/subsets/progress-30.json')).toBe(true);
    expect(isBlindList('docs/benchmarks/2026-10-30-stripe-final-repos.json')).toBe(true);
    expect(isBlindList('docs/benchmarks/subsets/x.json', { blind: true })).toBe(true);
    expect(isBlindList('docs/benchmarks/subsets/l2-push-249.json', { repos: [] })).toBe(false);
  });

  it('collects every repository on a blind list', () => {
    const root = mkdtempSync(join(tmpdir(), 'refit-blind-'));
    mkdirSync(join(root, 'subsets'));
    writeFileSync(
      join(root, 'subsets', 'progress-30.json'),
      JSON.stringify({ repos: [{ repo: 'Hidden/One' }] }),
    );
    writeFileSync(join(root, 'open.json'), JSON.stringify({ repos: [{ repo: 'open/two' }] }));
    writeFileSync(
      join(root, 'marked.json'),
      JSON.stringify({ blind: true, repos: [{ repo: 'hidden/three' }] }),
    );
    expect([...blindRepositories(pathToFileURL(`${root}/`))].sort()).toEqual([
      'hidden/one',
      'hidden/three',
    ]);
  });
});

describe('roll back', () => {
  // A promoted learned rule, live in the pack, and the pull requests its patches opened.
  function promoted(): { tables: RuleTable[]; store: CandidateStore } {
    const store = proven();
    const candidate = store.candidates[0];
    const rule = groundCandidate(candidate, VERSION, evidence()).rule!;
    const live: Candidate = {
      ...candidate,
      status: 'promoted',
      rule: rule.rule,
      version: VERSION,
      pullRequests: [
        'https://github.com/refit-dev/a/pull/3',
        'https://github.com/refit-dev/b/pull/4',
      ],
    };
    return {
      tables: addLearnedRule([], VERSION, '2026-08-26.dahlia', rule),
      store: { formatVersion: 1, candidates: [live] },
    };
  }
  const live = (tables: RuleTable[]) =>
    withRuleTables({ ...STRIPE_PACK, fieldMoves: [], requestMoves: [] }, tables).requestMoves.map(
      (move) => move.rule,
    );

  it('demotes a promoted rule on one revert and flags every pull request it opened', () => {
    const { tables, store } = promoted();
    expect(live(tables)).toEqual(['learned-request-rename-old_param-new_param']);
    const result = demote(
      tables,
      store,
      [
        {
          kind: 'reverted',
          pullRequest: 'https://github.com/refit-dev/b/pull/4',
          detail: 'reverted by the customer',
        },
      ],
      '2026-10-28',
    );
    expect(result.demoted).toEqual([
      {
        rule: 'learned-request-rename-old_param-new_param',
        reason: 'reverted: reverted by the customer',
        flagged: ['https://github.com/refit-dev/a/pull/3', 'https://github.com/refit-dev/b/pull/4'],
      },
    ]);
    expect(result.store.candidates[0]).toMatchObject({
      status: 'demoted',
      demotedAt: '2026-10-28',
    });
    expect(result.tables[0].rules[0]).toMatchObject({
      status: 'review-only',
      demoted: { at: '2026-10-28', reason: 'reverted: reverted by the customer' },
    });
    expect(live(result.tables)).toEqual([]);
    // A demoted rule cannot be promoted again from its old evidence.
    expect(promotionBlockers(result.store.candidates[0])).toContain('already demoted');
  });

  it('demotes on a later check failure the rule caused', () => {
    const { tables, store } = promoted();
    const rows = [
      {
        repo: 'g/seven',
        workflow: {
          status: 'needs-review',
          validation: 'regression',
          patched: 'failed',
          reason: 'The patched tests failed.',
          rules: ['learned-request-rename-old_param-new_param'],
        },
        publication: { url: 'https://github.com/refit-dev/g/pull/9' },
      },
    ];
    const recorded = recordCandidates(store, 'run-9', rows, { known: new Set(), blind: new Set() });
    expect(recorded.store.candidates[0].contrary).toEqual([
      { kind: 'check-failed', repo: 'g/seven', run: 'run-9', detail: 'The patched tests failed.' },
    ]);
    const result = demote(tables, recorded.store, []);
    expect(result.demoted[0].flagged).toContain('https://github.com/refit-dev/g/pull/9');
    expect(live(result.tables)).toEqual([]);
  });

  it('leaves rules alone when no event is theirs', () => {
    const { tables, store } = promoted();
    const result = demote(tables, store, [
      { kind: 'closed-unmerged', pullRequest: 'https://x/pull/1' },
    ]);
    expect(result.demoted).toEqual([]);
    expect(live(result.tables)).toHaveLength(1);
  });
});

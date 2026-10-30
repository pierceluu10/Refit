import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { listOpenApiOperations } from './openapi-operations.ts';
import {
  ENUM_VALUE,
  IDENTIFIER,
  type RequestMove,
  type RuleProvenance,
  type RuleTable,
  type TableRule,
} from './rule-pack.ts';
import { removedEnumValueText, verifyRule, type RuleEvidence } from './rule-verification.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Refit's autonomous loop (founder decision, 2026-10-28; docs/AUTONOMOUS-LOOP.md): every stop gets
// a stable signature counted across runs (spot), proven AI fixes become candidate rules (learn), a
// candidate proven on 3 repositories with no contrary evidence and backed by its Stripe page and
// both contracts becomes a deterministic rule (promote), and one failure demotes it (roll back).

export const LEARNING_DIRECTORY = new URL('../data/learning/', import.meta.url);
export const LEARNED_RULES = new URL('rules/stripe/', LEARNING_DIRECTORY);
export const SIGNATURES = new URL('signatures.json', LEARNING_DIRECTORY);
export const CANDIDATES = new URL('candidates.json', LEARNING_DIRECTORY);
export const PROMOTION_REPOSITORIES = 3;
// Blind sets are never learned from: progress-30 and any frozen final set.
const BLIND_LIST = /(^|[/\\])(progress-30|[^/\\]*final[^/\\]*)\.json$/;
const PROVEN_GRADES = new Set(['A', 'B']);
// Parameters owner policies govern in code (payment_method_types: the 2026-10-16 to 2026-10-24
// decisions in AGENTS.md); a learned rule never moves them, so payment behaviour never changes
// silently.
const POLICY_PARAMETERS = new Set(['payment_method_types']);
// Workflow outcomes that passed: a validated draft, a version bump or (older results) `passed`.
const PASSED_STATUSES = new Set(['validated', 'version-bump', 'passed']);
// Validation results whose checks ran on the patch and did not pass.
const FAILED_VALIDATIONS = new Set(['failed', 'regression']);

type Row = Record<string, unknown>;

export interface SignatureRecord {
  status: string;
  stage: string;
  lead: string;
  codes: string[];
  changes: string[];
  firstRun: string;
  lastRun: string;
  runs: number;
  rows: number;
}

export interface SignatureStore {
  formatVersion: 1;
  runs: { run: string; rows: number; signatures: number; new: string[] }[];
  signatures: Record<string, SignatureRecord>;
}

export interface Evidence {
  repo: string;
  run: string;
  grade: string | null;
  generator: string;
  // Method and path of the traced calls AI was asked to resolve, when the run recorded them.
  operations?: string[];
  pullRequest?: string;
  merged?: boolean;
}

export interface Contrary {
  kind: 'reverted' | 'closed-unmerged' | 'post-merge-ci-failed' | 'check-failed' | 'wrong-review';
  repo?: string;
  run?: string;
  pullRequest?: string;
  detail: string;
}

export interface Pattern {
  family: 'request-rename' | 'request-enum-value';
  parameter: string;
  replacement: string;
  value?: string;
}

export interface Candidate extends Pattern {
  id: string;
  status: 'candidate' | 'promoted' | 'demoted';
  evidence: Evidence[];
  contrary: Contrary[];
  // Pull requests a promoted rule's patches opened, flagged on demotion.
  pullRequests: string[];
  rule?: string;
  version?: string;
  promotedAt?: string;
  demotedAt?: string;
  flagged?: string[];
}

export interface CandidateStore {
  formatVersion: 1;
  candidates: Candidate[];
}

export const emptySignatures = (): SignatureStore => ({
  formatVersion: 1,
  runs: [],
  signatures: {},
});
export const emptyCandidates = (): CandidateStore => ({ formatVersion: 1, candidates: [] });

export function readJson<T>(url: URL, empty: () => T): T {
  return existsSync(url) ? (JSON.parse(readFileSync(url, 'utf8')) as T) : empty();
}

// A list is blind when it is progress-30, a frozen final set, or says `"blind": true`.
export function isBlindList(path: string, list?: unknown) {
  return BLIND_LIST.test(path) || (isObject(list) && list.blind === true);
}

// Repository names on every blind list under the benchmarks directory, so a row from a blind
// repository is skipped even when its run's list is not named.
export function blindRepositories(directory: URL) {
  const names = new Set<string>();
  const walk = (url: URL) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url));
      else if (entry.name.endsWith('.json')) {
        const path = new URL(entry.name, url);
        const list = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (isBlindList(path.pathname, list) && isObject(list) && Array.isArray(list.repos))
          for (const repo of list.repos)
            if (isObject(repo) && typeof repo.repo === 'string') names.add(repo.repo.toLowerCase());
      }
    }
  };
  walk(directory);
  return names;
}

// Repository-specific detail is replaced so one cause gets one signature across repositories.
function template(text: string) {
  return text
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w@.-]*\/[\w@./-]*\.[A-Za-z]{1,5}(:\d+){0,2}\b/g, '<file>')
    .replace(/\b[\w-]+\.(?:[cm]?[jt]sx?|json|ya?ml)(:\d+){0,2}\b/g, '<file>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b\d+(\.\d+)*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The failure a row ended in, or nothing for a row that passed, was not affected or never ran.
function failure(row: Row) {
  if (isObject(row.infrastructure))
    return {
      status: 'infrastructure',
      stage: String(row.infrastructure.kind ?? 'unknown'),
      text: String(row.infrastructure.message ?? ''),
    };
  const workflow = row.workflow;
  if (!isObject(workflow) || PASSED_STATUSES.has(String(workflow.status))) return undefined;
  return {
    status: String(workflow.status ?? 'missing-manifest'),
    stage: String(workflow.stage ?? 'unknown'),
    text: String(workflow.reason ?? workflow.error ?? ''),
  };
}

// Stage, reason, change ids and error codes, hashed: the same cause in another repository or run
// gets the same id.
export function failureSignature(row: Row) {
  const found = failure(row);
  if (!found) return undefined;
  const normalized = template(found.text);
  const lead = (/^.*?[.:](?=\s|$)/.exec(normalized)?.[0] ?? normalized).slice(0, 200);
  const unique = (pattern: RegExp) =>
    [...new Set(found.text.match(pattern) ?? [])].sort().slice(0, 5);
  const codes = unique(/\b(?:TS\d{4}|ERR_[A-Z0-9_]+|E[A-Z]{4,})\b/g);
  const changes = unique(/\b(?:request|response|api)-[a-z]+(?:-[a-z]+)+\b/g);
  const id = createHash('sha256')
    .update([found.status, found.stage, lead, codes.join(','), changes.join(',')].join('|'))
    .digest('hex')
    .slice(0, 12);
  return { id, status: found.status, stage: found.stage, lead, codes, changes };
}

// Records a run's signatures; `new` lists the ids the store had not seen before this run.
export function recordSignatures(store: SignatureStore, run: string, rows: Row[]) {
  if (store.runs.some((entry) => entry.run === run))
    throw new PipelineInputError(`Run ${run} is already recorded in the signature store.`);
  const counts = new Map<
    string,
    { signature: NonNullable<ReturnType<typeof failureSignature>>; rows: number }
  >();
  for (const row of rows) {
    const signature = failureSignature(row);
    if (signature)
      counts.set(signature.id, { signature, rows: (counts.get(signature.id)?.rows ?? 0) + 1 });
  }
  const fresh: string[] = [];
  const signatures = { ...store.signatures };
  for (const [id, { signature, rows: count }] of counts) {
    const known = signatures[id];
    if (!known) fresh.push(id);
    const { id: _, ...fields } = signature;
    signatures[id] = known
      ? { ...known, lastRun: run, runs: known.runs + 1, rows: known.rows + count }
      : { ...fields, firstRun: run, lastRun: run, runs: 1, rows: count };
  }
  return {
    store: {
      formatVersion: 1 as const,
      runs: [...store.runs, { run, rows: rows.length, signatures: counts.size, new: fresh.sort() }],
      signatures,
    },
    fresh,
    seen: counts.size - fresh.length,
  };
}

// The benchmark summary's section: signatures this run has that the committed store has not.
export function signatureSummary(rows: Row[], store: SignatureStore) {
  const counts = new Map<
    string,
    { signature: NonNullable<ReturnType<typeof failureSignature>>; repos: string[] }
  >();
  for (const row of rows) {
    const signature = failureSignature(row);
    if (!signature) continue;
    const entry = counts.get(signature.id) ?? { signature, repos: [] };
    entry.repos.push(String(row.repo));
    counts.set(signature.id, entry);
  }
  const fresh = [...counts.values()].filter((entry) => !store.signatures[entry.signature.id]);
  return [
    '## Failure signatures',
    '',
    `Signatures: ${counts.size}, new against data/learning/signatures.json: ${fresh.length}, seen before: ${counts.size - fresh.length}.`,
    ...(fresh.length
      ? [
          '',
          '| Signature | Status | Stage | Rows | Reason |',
          '|---|---|---|---|---|',
          ...fresh.map(
            ({ signature, repos }) =>
              `| ${signature.id} | ${signature.status} | ${signature.stage} | ${repos.length} | ${signature.lead.replace(/\|/g, '/')} |`,
          ),
        ]
      : []),
    '',
  ].join('\n');
}

// Request renames and enum-value replacements a unified diff makes on one line: `old: v` to
// `new: v`, or `parameter: 'old'` to `parameter: 'new'`, with the rest of the line unchanged.
export function diffPatterns(diff: string): Pattern[] {
  const patterns: Pattern[] = [];
  const removed: string[] = [];
  const pair = (before: string, after: string) => {
    let start = 0;
    while (start < before.length && before[start] === after[start]) start++;
    let end = 0;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    // Widen to whole tokens, so `customer_email` to `customer_update` compares the full names.
    while (start > 0 && /[\w$-]/.test(before[start - 1])) start--;
    while (end > 0 && /[\w$-]/.test(before[before.length - end])) end--;
    const [old, next] = [
      before.slice(start, before.length - end),
      after.slice(start, after.length - end),
    ];
    const [prefix, suffix] = [before.slice(0, start), before.slice(before.length - end)];
    if (old === next) return;
    if (
      IDENTIFIER.test(old) &&
      IDENTIFIER.test(next) &&
      /^['"]?\s*:/.test(suffix) &&
      /(^|[\s{,'"])$/.test(prefix)
    )
      patterns.push({ family: 'request-rename', parameter: old, replacement: next });
    const key = /([A-Za-z_$][\w$]*)['"]?\s*:\s*['"]$/.exec(prefix);
    if (key && ENUM_VALUE.test(old) && ENUM_VALUE.test(next) && /^['"]/.test(suffix))
      patterns.push({
        family: 'request-enum-value',
        parameter: key[1],
        value: old,
        replacement: next,
      });
  };
  const flush = (added: string[]) => {
    if (added.length === removed.length) added.forEach((line, index) => pair(removed[index], line));
    removed.length = 0;
  };
  let added: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) {
      if (added.length) {
        flush(added);
        added = [];
      }
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) added.push(line.slice(1));
    else {
      flush(added);
      added = [];
    }
  }
  flush(added);
  return patterns;
}

export const patternId = (pattern: Pattern) =>
  `${pattern.family}:${pattern.parameter}${pattern.value === undefined ? '' : `=${pattern.value}`}->${pattern.replacement}`;

const ruleName = (pattern: Pattern) =>
  `learned-${pattern.family}-${pattern.parameter}${pattern.value ? `-${pattern.value}` : ''}-${pattern.replacement}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');

// Whether an AI fix in this row is proven: grade A or B, or merged without edits.
function provenAi(row: Row) {
  const workflow = row.workflow;
  // AI output is always a [Needs review] draft, so its proof is that the checks passed on it.
  if (!isObject(workflow) || workflow.validation !== 'passed' || typeof workflow.diff !== 'string')
    return undefined;
  const coverage = isObject(workflow.coverageAi) ? workflow.coverageAi : undefined;
  const ai = workflow.generator === 'openai' || coverage?.outcome === 'kept';
  if (!ai) return undefined;
  const grade =
    isObject(workflow.grade) && typeof workflow.grade.letter === 'string'
      ? workflow.grade.letter
      : null;
  const merged = isObject(row.publication) && row.publication.outcome === 'merged-without-edits';
  if (!(grade && PROVEN_GRADES.has(grade)) && !merged) return undefined;
  const operations = Array.isArray(coverage?.targets)
    ? [
        ...new Set(
          coverage.targets.flatMap((target) =>
            isObject(target) &&
            typeof target.expression === 'string' &&
            /^[A-Z]+ \//.test(target.expression)
              ? [target.expression]
              : [],
          ),
        ),
      ]
    : [];
  return { diff: workflow.diff, grade, merged, operations };
}

// Learned rules the row's patch applied, for attributing its outcome.
const appliedRules = (row: Row) =>
  isObject(row.workflow) && Array.isArray(row.workflow.rules)
    ? row.workflow.rules.filter((rule): rule is string => typeof rule === 'string')
    : [];

// Adds a run's proven AI fixes as candidate evidence and its learned-rule outcomes as contrary
// evidence: a check failure where a learned rule edited demotes it. `known` holds every
// (parameter, replacement) the shipped rules already make, so only new patterns are learned.
export function recordCandidates(
  store: CandidateStore,
  run: string,
  rows: Row[],
  options: { known: Set<string>; blind: Set<string> },
) {
  const candidates = store.candidates.map((candidate) => ({ ...candidate }));
  const touched = new Set<string>();
  for (const row of rows) {
    const repo = String(row.repo);
    if (options.blind.has(repo.toLowerCase())) continue;
    const proven = provenAi(row);
    for (const pattern of proven ? diffPatterns(proven.diff) : []) {
      const id = patternId(pattern);
      if (options.known.has(id) || POLICY_PARAMETERS.has(pattern.parameter)) continue;
      let candidate = candidates.find((entry) => entry.id === id);
      if (!candidate) {
        candidate = {
          ...pattern,
          id,
          status: 'candidate',
          evidence: [],
          contrary: [],
          pullRequests: [],
        };
        candidates.push(candidate);
      }
      if (candidate.evidence.some((entry) => entry.repo === repo && entry.run === run)) continue;
      candidate.evidence = [
        ...candidate.evidence,
        {
          repo,
          run,
          grade: proven!.grade,
          generator: 'openai',
          ...(proven!.operations.length ? { operations: proven!.operations } : {}),
          ...(isObject(row.publication) && typeof row.publication.url === 'string'
            ? { pullRequest: row.publication.url }
            : {}),
          ...(proven!.merged ? { merged: true } : {}),
        },
      ];
      touched.add(id);
    }
    for (const rule of appliedRules(row)) {
      const candidate = candidates.find((entry) => entry.rule === rule);
      if (!candidate) continue;
      const url = isObject(row.publication) ? row.publication.url : undefined;
      if (typeof url === 'string' && !candidate.pullRequests.includes(url))
        candidate.pullRequests = [...candidate.pullRequests, url];
      const workflow = row.workflow as Row;
      if (FAILED_VALIDATIONS.has(String(workflow.validation)) || workflow.patched === 'failed')
        candidate.contrary = [
          ...candidate.contrary,
          {
            kind: 'check-failed',
            repo,
            run,
            detail: String(workflow.reason ?? workflow.error ?? workflow.status).slice(0, 300),
          },
        ];
      touched.add(candidate.id);
    }
  }
  return { store: { formatVersion: 1 as const, candidates }, touched: [...touched] };
}

// Wrong verdicts in the fix-review log are contrary evidence for every candidate built on that
// repository's fix.
export function reviewContrary(candidate: Candidate, reviews: unknown) {
  const repos = new Set(candidate.evidence.map((entry) => entry.repo));
  const list = isObject(reviews) && Array.isArray(reviews.reviews) ? reviews.reviews : [];
  return list.flatMap((review): Contrary[] =>
    isObject(review) && repos.has(String(review.repo)) && /^wrong/.test(String(review.verdict))
      ? [
          {
            kind: 'wrong-review',
            repo: String(review.repo),
            detail: `fix-reviews.json: ${String(review.verdict)}`,
          },
        ]
      : [],
  );
}

const provenRepositories = (candidate: Candidate) =>
  new Set(
    candidate.evidence
      .filter((entry) => (entry.grade && PROVEN_GRADES.has(entry.grade)) || entry.merged)
      .map((entry) => entry.repo.toLowerCase()),
  );

// Why a candidate cannot be promoted yet; empty when the evidence count allows it. The rule check
// (`groundCandidate`) still has to pass.
export function promotionBlockers(candidate: Candidate, reviews?: unknown) {
  const repos = provenRepositories(candidate).size;
  const contrary = [...candidate.contrary, ...reviewContrary(candidate, reviews)];
  return [
    ...(candidate.status === 'candidate' ? [] : [`already ${candidate.status}`]),
    ...(repos >= PROMOTION_REPOSITORIES
      ? []
      : [`proven on ${repos} of ${PROMOTION_REPOSITORIES} repositories`]),
    ...contrary.map((entry) => `contrary evidence (${entry.kind}): ${entry.detail}`),
  ];
}

// Builds the rule a candidate stands for in one version change and checks it as `rules:check`
// does: one of the version's saved Stripe changelog pages quoted verbatim, the oasdiff entry it answers and both contracts. The
// operations are those the evidence touched, or every operation that removed the parameter.
export function groundCandidate(
  candidate: Candidate,
  version: string,
  evidence: RuleEvidence,
): { rule?: TableRule; problems: string[] } {
  const text =
    candidate.family === 'request-enum-value'
      ? removedEnumValueText(candidate.parameter, candidate.value!)
      : `removed the request property \`${candidate.parameter}\``;
  const id =
    candidate.family === 'request-enum-value'
      ? 'request-property-enum-value-removed'
      : 'request-property-removed';
  const operationIds = new Map(
    listOpenApiOperations(evidence.before).map((operation) => [
      `${operation.httpMethod} ${operation.path}`,
      String(operation.operation.operationId),
    ]),
  );
  const touched = new Set(
    candidate.evidence
      .flatMap((entry) => entry.operations ?? [])
      .map((name) => operationIds.get(name)),
  );
  const entries = evidence.diff.filter(
    (change) =>
      change.id === id &&
      change.text === text &&
      (!touched.size || touched.has(String(change.operationId))),
  );
  if (!entries.length) return { problems: [`${version} does not remove ${text.slice(8)}`] };
  const needle = candidate.family === 'request-enum-value' ? candidate.value! : candidate.parameter;
  // The version's own changelog pages, whose URLs carry its date.
  const sources = [...evidence.pages].filter(([url]) => url.includes(version.slice(0, 10)));
  const lines = sources.flatMap(([url, page]) =>
    page.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(candidate.replacement) && line.length <= 1000)
      .map((line) => ({ url, line, both: line.includes(needle) })),
  );
  const quoted = lines.find((entry) => entry.both) ?? lines[0];
  if (!quoted)
    return { problems: [`no saved ${version} Stripe page names ${candidate.replacement}`] };
  const move: RequestMove = {
    rule: ruleName(candidate),
    family: candidate.family,
    operations: [...new Set(entries.map((entry) => String(entry.operationId)))].sort(),
    parameter: candidate.parameter,
    replacement: candidate.replacement,
    ...(candidate.value === undefined ? {} : { value: candidate.value }),
    source: quoted.url,
    warning: `Learned from proven AI fixes on ${provenRepositories(candidate).size} repositories: ${
      candidate.family === 'request-enum-value'
        ? `${candidate.parameter} '${candidate.value}' is sent as '${candidate.replacement}'`
        : `${candidate.parameter} is sent as ${candidate.replacement}`
    }, as the Stripe page quoted in the rule says. Check code that reads the old name or value back.`,
  };
  const provenance: RuleProvenance = {
    quote: quoted.line,
    checkedAt: new Date().toISOString().slice(0, 10),
    diff: { id, operationId: move.operations[0], text },
    status: 'auto',
    origin: 'learned',
    benchmark: `Learned (founder decision 2026-10-28): proven AI fixes on ${[...provenRepositories(candidate)].join(', ')}; runs ${[
      ...new Set(candidate.evidence.map((entry) => entry.run)),
    ].join(', ')}.`,
    learnedFrom: candidate.evidence,
  };
  const rule = { ...move, ...provenance } as TableRule;
  const problems = verifyRule(rule, evidence);
  return problems.length ? { problems } : { rule, problems };
}

// Adds a promoted rule to its version's learned table, creating the table when needed.
export function addLearnedRule(
  tables: RuleTable[],
  version: string,
  previous: string,
  rule: TableRule,
) {
  const table = tables.find((entry) => entry.version === version);
  if (table?.rules.some((entry) => entry.rule === rule.rule))
    throw new PipelineInputError(`Learned rule ${rule.rule} is already in the ${version} table.`);
  return table
    ? tables.map((entry) => (entry === table ? { ...entry, rules: [...entry.rules, rule] } : entry))
    : [
        ...tables,
        { formatVersion: 1 as const, provider: 'stripe', version, previous, rules: [rule] },
      ];
}

export interface OutcomeEvent {
  kind: Exclude<Contrary['kind'], 'wrong-review'>;
  // The learned rule, or a pull request one of its patches opened.
  rule?: string;
  pullRequest?: string;
  repo?: string;
  run?: string;
  detail?: string;
}

// One failure demotes: a learned rule with any contrary evidence leaves `auto` at once, and every
// pull request its patches opened is flagged for review. Demoted rules stay in their table as
// `review-only` with the reason, so the record is kept.
export function demote(
  tables: RuleTable[],
  store: CandidateStore,
  events: OutcomeEvent[],
  today = new Date().toISOString().slice(0, 10),
) {
  const candidates = store.candidates.map((candidate) => ({ ...candidate }));
  for (const event of events) {
    const candidate = candidates.find(
      (entry) =>
        (event.rule && entry.rule === event.rule) ||
        (event.pullRequest &&
          (entry.pullRequests.includes(event.pullRequest) ||
            entry.evidence.some((evidence) => evidence.pullRequest === event.pullRequest))),
    );
    if (!candidate) continue;
    candidate.contrary = [
      ...candidate.contrary,
      {
        kind: event.kind,
        ...(event.repo ? { repo: event.repo } : {}),
        ...(event.run ? { run: event.run } : {}),
        ...(event.pullRequest ? { pullRequest: event.pullRequest } : {}),
        detail: event.detail ?? event.kind,
      },
    ];
  }
  const demoted: { rule: string; reason: string; flagged: string[] }[] = [];
  for (const candidate of candidates)
    if (candidate.status === 'promoted' && candidate.contrary.length) {
      const reason = candidate.contrary
        .map((entry) => `${entry.kind}${entry.repo ? ` on ${entry.repo}` : ''}: ${entry.detail}`)
        .join('; ');
      candidate.status = 'demoted';
      candidate.demotedAt = today;
      candidate.flagged = [...candidate.pullRequests];
      demoted.push({ rule: candidate.rule!, reason, flagged: candidate.flagged });
    }
  const reasons = new Map(demoted.map((entry) => [entry.rule, entry.reason]));
  return {
    tables: tables.map((table) => ({
      ...table,
      rules: table.rules.map((rule) =>
        reasons.has(rule.rule) && rule.status === 'auto'
          ? ({
              ...rule,
              status: 'review-only',
              demoted: { at: today, reason: reasons.get(rule.rule)! },
            } as TableRule)
          : rule,
      ),
    })),
    store: { formatVersion: 1 as const, candidates },
    demoted,
  };
}

// Every (parameter, replacement) the given rules already make, in pattern-id form.
export function knownPatterns(rules: (TableRule | RequestMove)[]) {
  return new Set(
    rules.flatMap((rule) =>
      rule.family === 'request-rename' || rule.family === 'request-enum-value'
        ? [
            patternId({
              family: rule.family,
              parameter: rule.parameter,
              replacement: rule.replacement,
              value: rule.value,
            }),
          ]
        : [],
    ),
  );
}

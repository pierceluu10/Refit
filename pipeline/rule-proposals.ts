import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateName } from './ai-fallback.ts';
import { codeShape, MEASUREMENT_LISTS, type MissRecord } from './ai-misses.ts';

// "It should never happen twice" (owner decision, Furqan, 2026-10-29), from the fix side: every AI
// fallback patch that passed every gate (pipeline/ai-fallback.ts) is read hunk by hunk into a
// proposed Refit rule: the call shape it matched, the transformation, the conditions it was safe
// under and the evidence (rows, gates passed). Proposals deduplicate against the shipped rule
// tables, the deadline registry and the proposal ledger (data/rule-proposals/ledger.json), so a
// pattern is proposed once, and one a person rejected is never proposed again. Nothing here
// becomes an active rule: a person accepts a proposal (rule-proposals-cli.ts accept), which writes
// the rule with a quote from a saved provider page and a synthetic fixture test. This module reads
// only JSON and Node built-ins, so refit-bench runs it straight after a benchmark.

export const LEDGER = 'data/rule-proposals/ledger.json';
export const FIXTURES = 'data/rule-proposals/fixtures';

export type Transformation =
  // A call's member path changed, arguments unchanged: `createChatCompletion(` -> `chat.completions.create(`.
  | { kind: 'method-rename'; from: string; to: string }
  // A request key renamed, value unchanged: `max_tokens:` -> `max_completion_tokens:`.
  | { kind: 'parameter-rename'; from: string; to: string }
  // A request key removed.
  | { kind: 'parameter-remove'; parameter: string }
  // A model string replaced.
  | { kind: 'model-replace'; from: string; to: string }
  // Anything else, as code shapes (names and literals taken out). No table holds these; a person
  // writes the engine rule by hand.
  | { kind: 'rewrite'; before: string[]; after: string[] };

export interface ProposalEvidence {
  list: string;
  run: string;
  repo: string;
  commit: string;
  file: string;
  line: number;
  // The open items the hunk fixed (registry deadline or rule table refs) and Refit's stop.
  refs: string[];
  kinds: string[];
  stopReason: string;
  gatesPassed: GateName[];
}

export interface RuleProposal {
  formatVersion: 1;
  id: string;
  signature: string;
  provider: string;
  changeType: string;
  transformation: Transformation;
  // The removed code with the repository's names and literals taken out.
  callShapes: string[];
  // Where the AI's fix was shown safe: every gate it passed, on these rows, for these items.
  conditions: {
    refs: string[];
    kinds: string[];
    languages: string[];
    // The fix also changed package.json or a lockfile, so the rule may need a dependency move.
    dependencyChange: boolean;
    gatesPassed: GateName[];
  };
  safeUnder: string[];
  sources: Array<{ url: string; quote: string }>;
  repositories: number;
  evidence: ProposalEvidence[];
}

export type ProposalState = 'open' | 'accepted' | 'rejected';

export interface LedgerEntry {
  id: string;
  signature: string;
  status: ProposalState;
  provider: string;
  changeType: string;
  transformation: Transformation;
  callShapes: string[];
  safeUnder: string[];
  sources: RuleProposal['sources'];
  firstSeen: { run: string; list: string; date: string };
  lastSeen: { run: string; list: string; date: string };
  // At most MAX_EVIDENCE rows, newest last; a measurement-set row is never stored.
  evidence: ProposalEvidence[];
  decision?: {
    by: string;
    at: string;
    reason: string;
    // Hand-check verdict for a rejection: the AI fix was wrong, or right but outside Refit's scope.
    verdict?: 'wrong' | 'out-of-scope' | 'duplicate' | 'other';
    // Accepted: the rule that now covers the pattern, the table it is in and its fixture.
    rule?: string;
    table?: string;
    fixture?: string;
  };
}

export interface Round {
  run: string;
  list: string;
  commit: string;
  date: string;
  misses: Record<string, number>;
  validatedFixes: number;
  proposed: string[];
  covered: number;
  suppressed: number;
}

export interface Ledger {
  formatVersion: 1;
  proposals: LedgerEntry[];
  rounds: Round[];
}

export const MAX_EVIDENCE = 10;

export function emptyLedger(): Ledger {
  return { formatVersion: 1, proposals: [], rounds: [] };
}

export function parseLedger(value: unknown): Ledger {
  const ledger = value as Ledger;
  if (
    !ledger ||
    ledger.formatVersion !== 1 ||
    !Array.isArray(ledger.proposals) ||
    !Array.isArray(ledger.rounds)
  )
    throw new Error(`${LEDGER} needs formatVersion 1 and proposals and rounds arrays.`);
  const ids = new Set<string>();
  for (const entry of ledger.proposals) {
    if (ids.has(entry.id)) throw new Error(`${LEDGER}: duplicate proposal ${entry.id}.`);
    ids.add(entry.id);
    if (!['open', 'accepted', 'rejected'].includes(entry.status))
      throw new Error(`${LEDGER}: ${entry.id} has unknown status ${entry.status}.`);
    if (entry.status !== 'open' && !(entry.decision?.by && entry.decision.reason))
      throw new Error(`${LEDGER}: ${entry.id} is ${entry.status} without who decided and why.`);
    if (entry.status === 'accepted' && !entry.decision?.rule)
      throw new Error(`${LEDGER}: ${entry.id} is accepted without the rule that covers it.`);
  }
  return ledger;
}

// --- Reading a patch ---------------------------------------------------------------------------

interface Hunk {
  file: string;
  // First line of the hunk in the original file.
  line: number;
  removed: string[];
  added: string[];
}

const DEPENDENCY_FILES =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/;
// New test files are allowed by the fallback's scope gate; they are not part of the fix.
const TEST_FILES =
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/;

// Runs of removed and added lines, one per change block: the unit a rule rewrites.
export function patchHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let line = 0;
  let current: Hunk | null = null;
  const flush = () => {
    if (current && (current.removed.length || current.added.length)) hunks.push(current);
    current = null;
  };
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      flush();
      file = null;
      continue;
    }
    if (text.startsWith('--- ')) continue;
    if (text.startsWith('+++ ')) {
      const path = text.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(text);
    if (header) {
      flush();
      line = Number(header[1]);
      continue;
    }
    if (!file) continue;
    if (text.startsWith('-')) {
      current ??= { file, line, removed: [], added: [] };
      current.removed.push(text.slice(1));
      line++;
    } else if (text.startsWith('+')) {
      current ??= { file, line, removed: [], added: [] };
      current.added.push(text.slice(1));
    } else {
      flush();
      line++;
    }
  }
  flush();
  return hunks;
}

const TOKENS =
  /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\S/g;
const tokens = (text: string): string[] => text.match(TOKENS) ?? [];
const isName = (token: string | undefined) => !!token && /^[A-Za-z_$][\w$]*$/.test(token);
const isString = (token: string | undefined) => !!token && /^["'`]/.test(token);
const unquote = (token: string) => token.slice(1, -1);
const MODEL =
  /^(?:gpt|o\d|chatgpt|text-|davinci|babbage|claude|gemini|models\/gemini|tts|whisper|dall-e)/i;

// A member path around the changed tokens: `openai.createChatCompletion(` -> `createChatCompletion`.
function memberPath(list: string[], start: number, end: number) {
  let from = start;
  while (from >= 2 && list[from - 1] === '.' && isName(list[from - 2])) from -= 2;
  let to = end;
  while (list[to] === '.' && isName(list[to + 1])) to += 2;
  if (list[to] !== '(') return null;
  const path = list.slice(from, to);
  if (!path.length || !path.every((token, index) => (index % 2 ? token === '.' : isName(token))))
    return null;
  // The receiver is the repository's own name; the path after it is the API.
  return { from, text: path.join(''), first: path[0] };
}

// One removed line against one added line: the smallest token span that differs.
export function lineTransformation(removed: string, added: string): Transformation | null {
  const a = tokens(removed);
  const b = tokens(added);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const oldSpan = a.slice(start, endA);
  const newSpan = b.slice(start, endB);
  if (!oldSpan.length && !newSpan.length) return null;
  if (
    oldSpan.length === 1 &&
    newSpan.length === 1 &&
    isString(oldSpan[0]) &&
    isString(newSpan[0]) &&
    (MODEL.test(unquote(oldSpan[0])) || /\bmodel\s*:/.test(removed))
  )
    return { kind: 'model-replace', from: unquote(oldSpan[0]), to: unquote(newSpan[0]) };
  if (
    oldSpan.length === 1 &&
    newSpan.length === 1 &&
    isName(oldSpan[0]) &&
    isName(newSpan[0]) &&
    a[endA] === ':' &&
    b[endB] === ':'
  )
    return { kind: 'parameter-rename', from: oldSpan[0], to: newSpan[0] };
  // Member paths: extend both spans to the whole `.a.b.c(` around them, without the receiver.
  const before = memberPath(a, start, endA);
  const after = memberPath(b, start, endB);
  if (before && after && before.from === after.from) {
    const strip = (path: string, first: string) =>
      path.startsWith(`${first}.`) && before.first === after.first
        ? path.slice(first.length + 1)
        : path;
    const from = strip(before.text, before.first);
    const to = strip(after.text, after.first);
    const restA = a.slice(a.indexOf('(', before.from));
    const restB = b.slice(b.indexOf('(', after.from));
    if (from !== to && restA.join(' ') === restB.join(' '))
      return { kind: 'method-rename', from, to };
  }
  return null;
}

const removedKey = (text: string) =>
  /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*[^,]*,?\s*$/.exec(text)?.[1];

export function hunkTransformation(hunk: Hunk): Transformation {
  if (hunk.removed.length === 1 && hunk.added.length === 1) {
    const one = lineTransformation(hunk.removed[0], hunk.added[0]);
    if (one) return one;
  }
  if (!hunk.added.length && hunk.removed.length === 1) {
    const key = removedKey(hunk.removed[0]);
    if (key) return { kind: 'parameter-remove', parameter: key };
  }
  const shapes = (lines: string[]) =>
    lines.map((text) => codeShape(text)).filter((text) => text.length > 0);
  return { kind: 'rewrite', before: shapes(hunk.removed), after: shapes(hunk.added) };
}

// --- From validated fixes to proposals ---------------------------------------------------------

export interface ResultRow {
  repo: string;
  commit: string;
  provider?: string | null;
  language?: 'js' | 'py';
  misses?: MissRecord[];
  fallback?: {
    status: string;
    patch?: string | null;
    gates?: Array<{ gate: GateName; status: string; detail: string }>;
  } | null;
}

export function signatureOf(provider: string, changeType: string, transformation: Transformation) {
  return JSON.stringify([provider, changeType, transformation]);
}

const idOf = (provider: string, transformation: Transformation, signature: string) =>
  `${provider}-${transformation.kind}-${createHash('sha256').update(signature).digest('hex').slice(0, 10)}`;

const unique = <T>(values: T[]) => [...new Set(values)];

function safeUnder(proposal: Omit<RuleProposal, 'safeUnder'>) {
  const t = proposal.transformation;
  const lines = [
    `${proposal.provider} code only, at sites where Refit stops with ${proposal.conditions.kinds.map((kind) => `\`${kind}\``).join(' or ')} for ${proposal.conditions.refs.map((ref) => `\`${ref}\``).join(', ')}.`,
    `Only call sites shaped like ${proposal.callShapes
      .slice(0, 2)
      .map((shape) => `\`${shape}\``)
      .join(' or ')}; test files are never edited.`,
  ];
  if (t.kind === 'method-rename') lines.push('The call keeps its arguments unchanged.');
  if (t.kind === 'parameter-rename')
    lines.push('The value stays exactly as written; only the key changes.');
  if (t.kind === 'parameter-remove')
    lines.push(`The request sent \`${t.parameter}\` and nothing else read it.`);
  if (proposal.conditions.dependencyChange)
    lines.push('The fix also moved a dependency; the rule needs the same package move.');
  lines.push(
    `Validated on ${proposal.repositories} ${proposal.repositories === 1 ? 'repository' : 'repositories'} with the gates ${proposal.conditions.gatesPassed.join(', ')} passing.`,
  );
  return lines;
}

// Every hunk of every validated fix as a proposal, grouped by signature across rows.
export function fixProposals(
  rows: ResultRow[],
  meta: { list: string; run: string },
): { proposals: RuleProposal[]; validatedFixes: number; withheld: number } {
  const measurement = MEASUREMENT_LISTS.has(meta.list);
  const validated = rows.filter(
    (row) => row.fallback?.status === 'validated' && typeof row.fallback.patch === 'string',
  );
  // Measurement sets are measured, never mined: their fixes are counted, never kept as evidence.
  if (measurement)
    return { proposals: [], validatedFixes: validated.length, withheld: validated.length };
  const groups = new Map<string, RuleProposal>();
  for (const row of validated) {
    const records = (row.misses ?? []).filter((record) => record.ai.status === 'validated');
    const hunks = patchHunks(row.fallback!.patch!);
    const dependencyChange = hunks.some((hunk) => DEPENDENCY_FILES.test(hunk.file));
    const gatesPassed = (row.fallback!.gates ?? [])
      .filter((gate) => gate.status === 'passed')
      .map((gate) => gate.gate);
    for (const hunk of hunks) {
      if (DEPENDENCY_FILES.test(hunk.file) || TEST_FILES.test(hunk.file)) continue;
      // The items this hunk fixed: same file, nearest line; else every item on the row.
      const sameFile = records.filter((record) => record.file === hunk.file);
      const nearest = sameFile.length
        ? [
            sameFile.reduce((best, record) =>
              Math.abs(record.line - hunk.line) < Math.abs(best.line - hunk.line) ? record : best,
            ),
          ]
        : records;
      const items = nearest.length ? nearest : [];
      const provider = items[0]?.provider ?? row.provider ?? 'unknown';
      const changeType = items[0]?.changeType ?? 'unknown';
      const transformation = hunkTransformation(hunk);
      if (
        transformation.kind === 'rewrite' &&
        !transformation.before.length &&
        !transformation.after.length
      )
        continue;
      const signature = signatureOf(provider, changeType, transformation);
      const evidence: ProposalEvidence = {
        list: meta.list,
        run: meta.run,
        repo: row.repo,
        commit: row.commit,
        file: hunk.file,
        line: hunk.line,
        refs: unique(items.map((record) => record.ref)).sort(),
        kinds: unique(items.map((record) => record.kind)).sort(),
        stopReason: items[0]?.stopReason ?? '',
        gatesPassed,
      };
      const shapes = hunk.removed.map((text) => codeShape(text)).filter(Boolean);
      const sources = items
        .map((record) => record.source)
        .filter((source) => !!source?.quote && !!source.url)
        .map((source) => ({ url: source!.url, quote: source!.quote! }));
      const existing = groups.get(signature);
      if (existing) {
        existing.evidence.push(evidence);
        existing.callShapes = unique([...existing.callShapes, ...shapes]).slice(0, 5);
        existing.conditions.refs = unique([...existing.conditions.refs, ...evidence.refs]).sort();
        existing.conditions.kinds = unique([
          ...existing.conditions.kinds,
          ...evidence.kinds,
        ]).sort();
        existing.conditions.languages = unique([
          ...existing.conditions.languages,
          row.language ?? 'js',
        ]);
        existing.conditions.dependencyChange ||= dependencyChange;
        // Only the gates every row passed.
        existing.conditions.gatesPassed = existing.conditions.gatesPassed.filter((gate) =>
          gatesPassed.includes(gate),
        );
        for (const source of sources)
          if (!existing.sources.some((s) => s.url === source.url && s.quote === source.quote))
            existing.sources.push(source);
        continue;
      }
      groups.set(signature, {
        formatVersion: 1,
        id: idOf(provider, transformation, signature),
        signature,
        provider,
        changeType,
        transformation,
        callShapes: unique(shapes).slice(0, 5),
        conditions: {
          refs: evidence.refs,
          kinds: evidence.kinds,
          languages: [row.language ?? 'js'],
          dependencyChange,
          gatesPassed,
        },
        safeUnder: [],
        sources: sources.filter(
          (source, index) =>
            sources.findIndex((s) => s.url === source.url && s.quote === source.quote) === index,
        ),
        repositories: 0,
        evidence: [evidence],
      });
    }
  }
  const proposals = [...groups.values()].map((proposal) => {
    proposal.repositories = new Set(proposal.evidence.map((item) => item.repo)).size;
    proposal.safeUnder = safeUnder(proposal);
    return proposal;
  });
  return {
    proposals: proposals.sort(
      (a, b) => b.repositories - a.repositories || a.id.localeCompare(b.id),
    ),
    validatedFixes: validated.length,
    withheld: 0,
  };
}

// --- What Refit already knows ------------------------------------------------------------------

export interface KnownRules {
  // `<provider>:<old>` -> rule id, for method renames in the AI rule tables.
  methods: Map<string, string>;
  // `<provider>:rename:<parameter>:<to>` or `<provider>:remove:<parameter>` -> change id.
  parameters: Map<string, string>;
  // `<provider>:<retired model>` -> registry deadline ids whose replacement names the new model.
  models: Map<string, Array<{ id: string; replacement: string }>>;
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

export async function loadKnownRules(root: string): Promise<KnownRules> {
  const known: KnownRules = { methods: new Map(), parameters: new Map(), models: new Map() };
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const folder = join(root, 'data/rules', provider);
    const files = await readdir(folder).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const table = await readJson(join(folder, file));
      for (const rule of table.rules ?? []) {
        if (rule.family !== 'method-rename') continue;
        for (const old of [rule.data?.old].flat())
          if (typeof old === 'string') known.methods.set(`${provider}:${old}`, rule.rule);
      }
    }
  }
  const changes = await readJson(join(root, 'data/model-parameter-changes.json')).catch(() => ({}));
  for (const change of changes.changes ?? [])
    for (const parameter of change.parameters ?? [])
      known.parameters.set(
        change.action === 'rename'
          ? `${change.provider}:rename:${parameter}:${change.to}`
          : `${change.provider}:remove:${parameter}`,
        change.id,
      );
  const registry = await readJson(join(root, 'data/deadlines.json')).catch(() => ({}));
  for (const deadline of registry.deadlines ?? []) {
    if (!Array.isArray(deadline.models)) continue;
    for (const model of deadline.models) {
      const key = `${deadline.provider}:${model}`;
      known.models.set(key, [
        ...(known.models.get(key) ?? []),
        { id: deadline.id, replacement: String(deadline.replacement ?? '') },
      ]);
    }
  }
  return known;
}

// The shipped rule or registry entry that already makes this transformation, if any. A covered
// pattern is not a new rule: the engine reached the site and stopped for another reason, or did
// not reach it at all, which is reach work, not a table entry.
export function coveredBy(proposal: RuleProposal, known: KnownRules) {
  const t = proposal.transformation;
  const p = proposal.provider;
  if (t.kind === 'method-rename') {
    const id = known.methods.get(`${p}:${t.from}`);
    return id ? `rule ${id}` : null;
  }
  if (t.kind === 'parameter-rename') {
    const id = known.parameters.get(`${p}:rename:${t.from}:${t.to}`);
    return id ? `parameter change ${id}` : null;
  }
  if (t.kind === 'parameter-remove') {
    const id = known.parameters.get(`${p}:remove:${t.parameter}`);
    return id ? `parameter change ${id}` : null;
  }
  if (t.kind === 'model-replace') {
    const entry = known.models
      .get(`${p}:${t.from}`)
      ?.find((item) => item.replacement.includes(t.to));
    return entry ? `registry deadline ${entry.id}` : null;
  }
  return null;
}

// --- One run against the ledger ----------------------------------------------------------------

export interface RunProposals {
  formatVersion: 1;
  run: string;
  list: string;
  commit: string;
  date: string;
  measurement: boolean;
  validatedFixes: number;
  // New patterns, and open ones this run saw again (with this run's evidence).
  proposals: Array<RuleProposal & { state: 'new' | 'open' }>;
  // Patterns a shipped rule, the registry or an accepted proposal already makes.
  covered: Array<{ id: string; transformation: Transformation; by: string; evidence: number }>;
  // Patterns a person rejected: not proposed again.
  suppressed: Array<{
    id: string;
    transformation: Transformation;
    reason: string;
    verdict?: string;
  }>;
  misses: Record<string, number>;
}

export const missCategory = (record: Pick<MissRecord, 'changeType' | 'kind'>) =>
  `${record.changeType} / ${record.kind}`;

export function missesByCategory(rows: ResultRow[]) {
  const counts: Record<string, number> = {};
  for (const row of rows)
    for (const record of row.misses ?? []) {
      if (record.ai.status === 'ai-unavailable') continue;
      counts[missCategory(record)] = (counts[missCategory(record)] ?? 0) + 1;
    }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

export function runProposals(
  rows: ResultRow[],
  meta: { list: string; run: string; commit: string; date: string },
  ledger: Ledger,
  known: KnownRules,
): RunProposals {
  const { proposals, validatedFixes } = fixProposals(rows, meta);
  const byId = new Map(ledger.proposals.map((entry) => [entry.id, entry]));
  const result: RunProposals = {
    formatVersion: 1,
    ...meta,
    measurement: MEASUREMENT_LISTS.has(meta.list),
    validatedFixes,
    proposals: [],
    covered: [],
    suppressed: [],
    misses: missesByCategory(rows),
  };
  for (const proposal of proposals) {
    const entry = byId.get(proposal.id);
    if (entry?.status === 'rejected') {
      result.suppressed.push({
        id: proposal.id,
        transformation: proposal.transformation,
        reason: entry.decision!.reason,
        verdict: entry.decision!.verdict,
      });
      continue;
    }
    const by =
      entry?.status === 'accepted'
        ? `accepted proposal (rule ${entry.decision!.rule})`
        : coveredBy(proposal, known);
    if (by) {
      result.covered.push({
        id: proposal.id,
        transformation: proposal.transformation,
        by,
        evidence: proposal.evidence.length,
      });
      continue;
    }
    result.proposals.push({ ...proposal, state: entry ? 'open' : 'new' });
  }
  return result;
}

// Folds a run into the ledger: new proposals become open entries, open ones gain the run's
// evidence, and the round is recorded. Decisions are never changed here.
export function recordRun(ledger: Ledger, run: RunProposals): Ledger {
  const proposals = ledger.proposals.map((entry) => ({ ...entry }));
  const seen = { run: run.run, list: run.list, date: run.date };
  for (const proposal of run.proposals) {
    const entry = proposals.find((item) => item.id === proposal.id);
    if (entry) {
      const known = new Set(
        entry.evidence.map((item) => `${item.repo}@${item.commit}:${item.file}:${item.line}`),
      );
      entry.evidence = [
        ...entry.evidence,
        ...proposal.evidence.filter(
          (item) => !known.has(`${item.repo}@${item.commit}:${item.file}:${item.line}`),
        ),
      ].slice(-MAX_EVIDENCE);
      entry.callShapes = unique([...entry.callShapes, ...proposal.callShapes]).slice(0, 5);
      entry.lastSeen = seen;
      continue;
    }
    proposals.push({
      id: proposal.id,
      signature: proposal.signature,
      status: 'open',
      provider: proposal.provider,
      changeType: proposal.changeType,
      transformation: proposal.transformation,
      callShapes: proposal.callShapes,
      safeUnder: proposal.safeUnder,
      sources: proposal.sources,
      firstSeen: seen,
      lastSeen: seen,
      evidence: proposal.evidence.slice(0, MAX_EVIDENCE),
    });
  }
  const rounds = ledger.rounds.filter((round) => round.run !== run.run);
  rounds.push({
    run: run.run,
    list: run.list,
    commit: run.commit,
    date: run.date,
    misses: run.misses,
    validatedFixes: run.validatedFixes,
    proposed: run.proposals.filter((item) => item.state === 'new').map((item) => item.id),
    covered: run.covered.length,
    suppressed: run.suppressed.length,
  });
  return { formatVersion: 1, proposals, rounds };
}

export function decide(
  ledger: Ledger,
  id: string,
  decision: NonNullable<LedgerEntry['decision']> & { status: 'accepted' | 'rejected' },
): Ledger {
  const entry = ledger.proposals.find((item) => item.id === id);
  if (!entry) throw new Error(`No proposal ${id} in ${LEDGER}; record the run first.`);
  if (entry.status !== 'open')
    throw new Error(`${id} is already ${entry.status} (${entry.decision?.reason}).`);
  if (!decision.by.trim() || !decision.reason.trim())
    throw new Error('A decision needs who made it (--by) and why (--reason).');
  if (decision.status === 'accepted' && !decision.rule)
    throw new Error('An accepted proposal needs the rule that covers it.');
  const { status, ...rest } = decision;
  return {
    ...ledger,
    proposals: ledger.proposals.map((item) =>
      item.id === id ? { ...item, status, decision: rest } : item,
    ),
  };
}

// --- Reports ------------------------------------------------------------------------------------

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function describe(t: Transformation) {
  switch (t.kind) {
    case 'method-rename':
      return `\`${t.from}(\` → \`${t.to}(\``;
    case 'parameter-rename':
      return `\`${t.from}:\` → \`${t.to}:\``;
    case 'parameter-remove':
      return `remove \`${t.parameter}\``;
    case 'model-replace':
      return `\`'${t.from}'\` → \`'${t.to}'\``;
    case 'rewrite':
      return `${t.before.map((s) => `\`${s}\``).join(' ') || '(nothing)'} → ${t.after.map((s) => `\`${s}\``).join(' ') || '(nothing)'}`;
  }
}

export function renderRun(run: RunProposals) {
  const lines = [
    `## Rule proposals from AI fixes`,
    '',
    `List \`${run.list}\`, run ${run.run}, Refit \`${run.commit.slice(0, 12)}\`. ${run.validatedFixes} AI ${run.validatedFixes === 1 ? 'fix' : 'fixes'} passed every gate.`,
    '',
  ];
  if (run.measurement)
    lines.push(
      `\`${run.list}\` is a measurement set, so its fixes are counted and never mined for rules or fixtures.`,
      '',
    );
  lines.push(
    `| New | Seen again (open) | Already covered | Rejected before (not proposed) |`,
    `|---:|---:|---:|---:|`,
    `| ${run.proposals.filter((item) => item.state === 'new').length} | ${run.proposals.filter((item) => item.state === 'open').length} | ${run.covered.length} | ${run.suppressed.length} |`,
    '',
  );
  if (run.proposals.length)
    lines.push(
      '| Proposal | State | Transformation | Repositories | Refs |',
      '|---|---|---|---:|---|',
      ...run.proposals.map(
        (item) =>
          `| \`${item.id}\` | ${item.state} | ${cell(describe(item.transformation))} | ${item.repositories} | ${cell(item.conditions.refs.slice(0, 3).join(', '))} |`,
      ),
      '',
    );
  if (run.covered.length)
    lines.push(
      'Already covered (reach work, not a new rule):',
      '',
      ...run.covered.map((item) => `- ${cell(describe(item.transformation))}: ${item.by}`),
      '',
    );
  if (run.suppressed.length)
    lines.push(
      'Rejected earlier, so not proposed again:',
      '',
      ...run.suppressed.map(
        (item) =>
          `- \`${item.id}\` ${cell(describe(item.transformation))}: ${item.verdict ? `${item.verdict}, ` : ''}${cell(item.reason)}`,
      ),
      '',
    );
  lines.push(...renderMisses(run.misses));
  lines.push(
    'Proposals never become rules by themselves: `npx tsx pipeline/rule-proposals-cli.ts record` adds them to the ledger, and a person accepts or rejects each one (`docs/RULE-PROPOSALS.md`).',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function renderMisses(misses: Record<string, number>) {
  const entries = Object.entries(misses);
  if (!entries.length) return ['No miss records in this run.', ''];
  return [
    '| Miss category (change type / engine stop) | Records |',
    '|---|---:|',
    ...entries.map(([category, count]) => `| ${cell(category)} | ${count} |`),
    '',
  ];
}

// What each round taught Refit: its misses by category and the ledger's proposals by state.
export function renderReport(ledger: Ledger) {
  const count = (status: ProposalState) =>
    ledger.proposals.filter((entry) => entry.status === status).length;
  const lines = [
    '# What Refit learned from AI fixes',
    '',
    `Generated by \`pipeline/rule-proposals-cli.ts report\` from \`${LEDGER}\`. Every AI fallback fix that passed every gate is a proposal; a person accepts it into a rule table (with a synthetic fixture test) or rejects it with a reason so it is never proposed again.`,
    '',
    '| Open | Accepted | Rejected |',
    '|---:|---:|---:|',
    `| ${count('open')} | ${count('accepted')} | ${count('rejected')} |`,
    '',
  ];
  if (ledger.rounds.length) {
    lines.push(
      '## Rounds',
      '',
      '| Run | List | Date | Misses | Validated AI fixes | New proposals | Covered | Rejected before |',
      '|---|---|---|---:|---:|---:|---:|---:|',
      ...ledger.rounds.map(
        (round) =>
          `| ${round.run} | \`${round.list}\` | ${round.date} | ${Object.values(round.misses).reduce((a, b) => a + b, 0)} | ${round.validatedFixes} | ${round.proposed.length} | ${round.covered} | ${round.suppressed} |`,
      ),
      '',
      `### Misses by category, latest round (${ledger.rounds.at(-1)!.run})`,
      '',
      ...renderMisses(ledger.rounds.at(-1)!.misses),
    );
  }
  for (const [title, status] of [
    ['Open proposals', 'open'],
    ['Accepted', 'accepted'],
    ['Rejected', 'rejected'],
  ] as const) {
    const entries = ledger.proposals.filter((entry) => entry.status === status);
    if (!entries.length) continue;
    lines.push(`## ${title}`, '');
    for (const entry of entries) {
      const repositories = new Set(entry.evidence.map((item) => item.repo)).size;
      lines.push(
        `- \`${entry.id}\` (${entry.provider}, ${entry.changeType}): ${cell(describe(entry.transformation))}; ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}, first seen ${entry.firstSeen.run}.` +
          (entry.decision
            ? ` ${entry.decision.by}, ${entry.decision.at}: ${entry.decision.verdict ? `${entry.decision.verdict}, ` : ''}${cell(entry.decision.reason)}${entry.decision.rule ? ` (rule \`${entry.decision.rule}\`${entry.decision.fixture ? `, fixture \`${entry.decision.fixture}\`` : ''})` : ''}`
            : ''),
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

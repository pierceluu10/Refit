import { createHash } from 'node:crypto';
import type {
  ChangeType,
  FallbackResult,
  GateName,
  OpenItem,
  OpenItemKind,
  QuotedSource,
  StopCategory,
} from './ai-fallback.ts';

// "It should never happen twice" (owner decision, Furqan, 2026-10-29): every open item the AI was
// needed for becomes a miss record, whether the AI fixed it or not. Records group by the pattern
// Refit missed, never by repository (D5), into proposed deterministic rules. A proposal needs at
// least two repositories and a quoted provider source; a validated AI fix in the group becomes the
// rule's first fixture. Proposals are drafts for a person to turn into an engine rule.

// Lists that may never feed a rule: measurement sets are measured, not mined
// (docs/benchmarks/AI-PROVIDER-SETS.md).
export const MEASUREMENT_LISTS = new Set(['openai-100', 'anthropic-100', 'gemini-30']);

export interface MissRecord {
  formatVersion: 1;
  repo: string;
  commit: string;
  provider: string;
  language: 'js' | 'py';
  changeType: ChangeType;
  kind: OpenItemKind;
  // The registry deadline or rule table rule.
  ref: string;
  // The stop reason with repository-specific text taken out: the pattern Refit missed.
  pattern: string;
  // The code at the site with names and literals taken out.
  shape: string;
  file: string;
  line: number;
  stopReason: string;
  // The kind of stop (stopCategory in pipeline/ai-fallback.ts); absent on older records.
  stop?: StopCategory;
  source: QuotedSource | null;
  ai: {
    status: FallbackResult['status'] | 'not-run';
    reason: string;
    costUsd: number | null;
    gatesFailed: GateName[];
    // Only a patch that passed every gate; a suggestion is never a fixture.
    diff: string | null;
    // The AI's own one-line description of the pattern; a hint, never evidence.
    pattern: string | null;
  };
}

// Stop reasons name models, files, identifiers and counts; none of that is the pattern.
export function reasonPattern(reason: string) {
  return reason
    .replace(/`[^`]*`/g, '<code>')
    .replace(/"[^"]*"|'[^']*'/g, '<text>')
    .replace(/\b[\w./-]+\.(?:[cm]?[jt]sx?|py|json|ya?ml|toml|go)(?::\d+)?\b/g, '<file>')
    .replace(
      /\b(?:gpt|o\d|chatgpt|text|davinci|claude|gemini|models\/gemini)[-a-z0-9.:]*\b/gi,
      '<model>',
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d+(?:\.\d+)*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

const KEEP = new Set([
  'await',
  'new',
  'const',
  'let',
  'var',
  'return',
  'async',
  'function',
  'import',
  'from',
  'require',
  'export',
  'default',
  'def',
  'class',
  'self',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'None',
  'True',
  'False',
  'with',
  'as',
  'for',
  'in',
  'of',
  'if',
  'else',
]);

// Names after a dot (not a spread) or before a colon are API surface (`.chat.completions.create`,
// `model:`); every other identifier, string and number is the repository's own.
const TOKEN =
  /(`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|((?<!\.)\.\s*[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)(\s*:(?!:))?/g;

export function codeShape(text: string) {
  return text
    .slice(0, 240)
    .replace(TOKEN, (whole, string, number, member, name, colon) =>
      string ? '<s>' : number ? '<n>' : member || colon || KEEP.has(name) ? whole : '<id>',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function missRecords(
  row: { repo: string; commit: string; provider: string; language?: 'js' | 'py' },
  items: OpenItem[],
  sources: QuotedSource[],
  fallback: FallbackResult | null,
): MissRecord[] {
  // A key or quota problem is Refit's, not the repository's: no miss.
  if (fallback?.status === 'ai-unavailable') return [];
  return items.map((item) => ({
    formatVersion: 1,
    repo: row.repo,
    commit: row.commit,
    provider: item.provider || row.provider,
    language: row.language ?? 'js',
    changeType: item.changeType,
    kind: item.kind,
    ref: item.ref,
    pattern: reasonPattern(item.reason),
    shape: codeShape(item.text),
    file: item.file,
    line: item.line,
    stopReason: item.reason,
    ...(item.stop ? { stop: item.stop } : {}),
    source: sources.find((source) => source.ref === item.ref) ?? null,
    ai:
      fallback?.sent && !fallback.sent.includes(item.id)
        ? {
            status: 'not-run' as const,
            reason: 'The item did not fit the AI input, so the AI never saw it.',
            costUsd: null,
            gatesFailed: [],
            diff: null,
            pattern: null,
          }
        : fallback
          ? {
              status: fallback.status,
              reason: fallback.reason,
              costUsd: fallback.ai?.costUsd ?? null,
              gatesFailed: (fallback.gates ?? [])
                .filter((gate) => gate.status === 'failed')
                .map((gate) => gate.gate),
              diff: fallback.status === 'validated' ? fallback.patch : null,
              pattern: fallback.patterns?.find((entry) => entry.item === item.id)?.pattern ?? null,
            }
          : {
              status: 'not-run',
              reason: 'AI was off for this run.',
              costUsd: null,
              gatesFailed: [],
              diff: null,
              pattern: null,
            },
  }));
}

export type CandidateStatus =
  // At least two repositories, a quoted source and a validated AI fix to start the rule from.
  | 'rule-candidate'
  // At least two repositories and a quoted source; the rule still needs a fix someone checked.
  | 'needs-fix-example'
  // Withheld: one repository only (D5: no rule for one repository).
  | 'single-repository'
  // Withheld: no saved quote from the provider backs the change.
  | 'no-quoted-source'
  // Not a rule gap: Refit's own checks could not run or judge the fix (a failing baseline,
  // preparation or lockfile). Listed as infrastructure work, never as a rule.
  | 'infrastructure';

export interface RuleCandidate {
  formatVersion: 1;
  id: string;
  status: CandidateStatus;
  provider: string;
  changeType: ChangeType;
  kind: OpenItemKind;
  pattern: string;
  // A regular expression the stub matches stop reasons with; built from `pattern`.
  match: string;
  shapes: string[];
  refs: string[];
  sources: Array<{ url: string; quote: string }>;
  repositories: number;
  sites: number;
  fixtures: Array<{
    repo: string;
    commit: string;
    file: string;
    line: number;
    stopReason: string;
    // A validated AI patch for the row, when there is one.
    diff: string | null;
  }>;
  aiPatterns: string[];
  ai: { attempted: number; validated: number; costUsd: number };
}

const STATUS_ORDER: CandidateStatus[] = [
  'rule-candidate',
  'needs-fix-example',
  'single-repository',
  'no-quoted-source',
  'infrastructure',
];

// Stops that say Refit's checks could not decide, not that a pattern was missed.
const INFRASTRUCTURE =
  /baseline-failed|baseline failed|could not (?:run|prepare|install|resolve)|lockfile|preparation|no test or build/i;

// Why the fallback's checks gate failed, by cause: a check-infrastructure gap or a real failure.
export function checkFailureCause(detail: string) {
  if (/baseline-failed|Baseline failed|passed on the original code/.test(detail))
    return 'the checks already fail on the original code';
  if (/re-resolves only/.test(detail))
    return 'dependency change in a repository with a pnpm or Yarn lockfile, or several lockfiles';
  if (/could not re-resolve the lockfile/.test(detail))
    return 'npm could not re-resolve the lockfile';
  if (/no offline Python/.test(detail)) return 'no offline Python install-and-test runner';
  if (/no test, build or type check|No check runs/.test(detail)) return 'no check to run';
  return null;
}

// The pattern as a regular expression over stop reasons: literal text, each placeholder any run of
// characters.
export function patternMatcher(pattern: string) {
  return `^${pattern
    .split(/<(?:code|text|file|model|date|n)>/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+?')}$`;
}

export function ruleCandidates(records: MissRecord[]): RuleCandidate[] {
  const groups = new Map<string, MissRecord[]>();
  for (const record of records) {
    if (record.ai.status === 'ai-unavailable') continue;
    const key = [record.provider, record.changeType, record.kind, record.pattern].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const candidates: RuleCandidate[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    const repositories = new Set(group.map((record) => record.repo));
    const sources = new Map<string, { url: string; quote: string }>();
    for (const record of group)
      if (record.source?.quote && record.source.url)
        sources.set(record.source.url + record.source.quote, {
          url: record.source.url,
          quote: record.source.quote,
        });
    const validated = group.filter((record) => record.ai.status === 'validated');
    const status: CandidateStatus = INFRASTRUCTURE.test(first.pattern)
      ? 'infrastructure'
      : repositories.size < 2
        ? 'single-repository'
        : !sources.size
          ? 'no-quoted-source'
          : validated.length
            ? 'rule-candidate'
            : 'needs-fix-example';
    const byRepo = new Map<string, MissRecord>();
    for (const record of [...validated, ...group])
      if (!byRepo.has(record.repo)) byRepo.set(record.repo, record);
    const rows = new Map<string, MissRecord>();
    for (const record of group) rows.set(`${record.repo}@${record.commit}`, record);
    candidates.push({
      formatVersion: 1,
      id: `${first.provider}-${first.changeType}-${first.kind}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`,
      status,
      provider: first.provider,
      changeType: first.changeType,
      kind: first.kind,
      pattern: first.pattern,
      match: patternMatcher(first.pattern),
      shapes: [...new Set(group.map((record) => record.shape).filter(Boolean))].slice(0, 5),
      refs: [...new Set(group.map((record) => record.ref))].sort(),
      sources: [...sources.values()],
      repositories: repositories.size,
      sites: group.length,
      fixtures: [...byRepo.values()].slice(0, 5).map((record) => ({
        repo: record.repo,
        commit: record.commit,
        file: record.file,
        line: record.line,
        stopReason: record.stopReason,
        diff: record.ai.diff,
      })),
      aiPatterns: [
        ...new Set(
          group.map((record) => record.ai.pattern).filter((text): text is string => !!text),
        ),
      ].slice(0, 3),
      ai: {
        attempted: [...rows.values()].filter((record) =>
          ['validated', 'needs-review'].includes(record.ai.status),
        ).length,
        validated: [...rows.values()].filter((record) => record.ai.status === 'validated').length,
        costUsd: [...rows.values()].reduce((sum, record) => sum + (record.ai.costUsd ?? 0), 0),
      },
    });
  }
  return candidates.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.repositories - a.repositories ||
      b.sites - a.sites ||
      a.id.localeCompare(b.id),
  );
}

const table = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderProposal(
  candidates: RuleCandidate[],
  meta: {
    lists: string[];
    runs: string[];
    commit: string;
    records: number;
    date: string;
    // Fallback attempts whose checks gate failed for a check-infrastructure cause, by cause.
    infrastructure?: Record<string, number>;
  },
) {
  const proposed = candidates.filter((item) =>
    ['rule-candidate', 'needs-fix-example'].includes(item.status),
  );
  const count = (status: CandidateStatus) =>
    candidates.filter((item) => item.status === status).length;
  const lines = [
    '# Rules proposed from AI fallback misses',
    '',
    `Generated by \`pipeline/ai-miss-rules-cli.ts\` on ${meta.date} from ${meta.records} miss records (dev sets ${meta.lists.map((list) => `\`${list}\``).join(', ')}; refit-bench ${meta.runs.join(', ')}; Refit \`${meta.commit.slice(0, 12)}\`). Each record is an item Refit's deterministic engines left open, with what the AI did about it (\`pipeline/ai-fallback.ts\`). Records group by the pattern Refit missed, never by repository (D5).`,
    '',
    'These are proposals, not rules. A person turns each one into an engine rule with its stub in `data/rule-candidates/` as the starting point, checks the quote on the provider page, and writes the fix from the source, not from the AI patch. Measurement sets never feed this file.',
    '',
    '| Status | Groups | Meaning |',
    '|---|---:|---|',
    `| rule-candidate | ${count('rule-candidate')} | Two or more repositories, a quoted source and a validated AI fix as the first fixture |`,
    `| needs-fix-example | ${count('needs-fix-example')} | Two or more repositories and a quoted source; no fix passed every gate yet |`,
    `| single-repository | ${count('single-repository')} | Withheld (D5) until a second repository shows the pattern |`,
    `| no-quoted-source | ${count('no-quoted-source')} | Withheld: no saved provider quote backs the change |`,
    `| infrastructure | ${count('infrastructure')} | Not a rule gap: Refit's checks could not run or judge the fix |`,
    '',
  ];
  for (const item of proposed) {
    lines.push(
      `## \`${item.id}\` (${item.status})`,
      '',
      `- **Provider / change type / engine stop:** ${item.provider} / ${item.changeType} / ${item.kind}`,
      `- **Pattern Refit missed:** ${item.pattern}`,
      `- **Repositories / sites:** ${item.repositories} / ${item.sites}; AI attempted ${item.ai.attempted}, validated ${item.ai.validated} ($${item.ai.costUsd.toFixed(4)})`,
      `- **Registry and rule refs:** ${item.refs.map((ref) => `\`${ref}\``).join(', ')}`,
      ...item.shapes.slice(0, 3).map((shape) => `- **Code shape:** \`${table(shape)}\``),
      ...item.aiPatterns.map((text) => `- **AI's description (a hint only):** ${table(text)}`),
      '',
      ...item.sources
        .slice(0, 3)
        .flatMap((source) => [`> ${source.quote.replace(/\n/g, ' ')}`, `>`, `> ${source.url}`, '']),
    );
  }
  const infrastructure = candidates.filter((item) => item.status === 'infrastructure');
  const causes = Object.entries(meta.infrastructure ?? {}).sort((a, b) => b[1] - a[1]);
  if (infrastructure.length || causes.length)
    lines.push(
      '## Check-infrastructure gaps (not rule candidates)',
      '',
      "These are places where Refit's own validation could not run or judge a fix, so no rule would help. They belong to the check and preparation work, not to rules.",
      '',
      ...infrastructure.map(
        (item) =>
          `- Engine stop \`${item.kind}\` on ${item.repositories} ${item.repositories === 1 ? 'repository' : 'repositories'} (${item.sites} ${item.sites === 1 ? 'site' : 'sites'}): ${table(item.pattern.length > 220 ? `${item.pattern.slice(0, 220)}…` : item.pattern)}`,
      ),
      ...causes.map(
        ([cause, count]) => `- AI attempts whose checks gate failed because of ${cause}: ${count}`,
      ),
      '',
    );
  const withheld = candidates.filter(
    (item) => !proposed.includes(item) && item.status !== 'infrastructure',
  );
  if (withheld.length) {
    lines.push(
      '## Withheld groups',
      '',
      '| Group | Status | Change type | Pattern | Sites |',
      '|---|---|---|---|---:|',
      ...withheld.map(
        (item) =>
          `| \`${item.id}\` | ${item.status} | ${item.changeType} | ${table(item.pattern).slice(0, 160)} | ${item.sites} |`,
      ),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

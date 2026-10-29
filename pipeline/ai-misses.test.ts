import { describe, expect, it } from 'vitest';
import type { FallbackResult, OpenItem } from './ai-fallback.ts';
import {
  codeShape,
  missRecords,
  patternMatcher,
  reasonPattern,
  renderProposal,
  ruleCandidates,
  type MissRecord,
} from './ai-misses.ts';
import { fallbackCounts, rowOutcome } from './ai-provider-benchmark-cli.ts';

const item = (file: string, reason: string, extra: Partial<OpenItem> = {}): OpenItem => ({
  id: `model-stop:openai-gpt-4-0613:${file}:4`,
  kind: 'model-stop',
  provider: 'openai',
  ref: 'openai-gpt-4-0613',
  changeType: 'retired-model',
  file,
  line: 4,
  text: "const result = await openai.chat.completions.create({ ...defaults, model: 'gpt-4-0613' })",
  reason,
  target: 'gpt-5.6-terra',
  ...extra,
});
const source = {
  ref: 'openai-gpt-4-0613',
  url: 'https://developers.openai.com/api/docs/deprecations',
  quote: '| 2026-10-01 | gpt-4-0613 | gpt-5.6-terra |',
  summary: 'retired',
};
const fallback = (status: FallbackResult['status'], patch: string | null): FallbackResult => ({
  status,
  reason: status,
  items: 1,
  ai: { model: 'gpt-6.1-sol', responseId: 'r', costUsd: 0.05 },
  gates: status === 'validated' ? [] : [{ gate: 'checks', status: 'failed', detail: 'x' }],
  patch,
  suggestion: status !== 'validated' && patch !== null,
  notes: [],
  unresolved: [],
  patterns: [],
  calls: [],
});

describe('miss patterns', () => {
  it('takes models, files, code, dates and counts out of a stop reason', () => {
    const a = reasonPattern(
      'The request spreads `defaults` from src/config.ts:12 into the body, so the model gpt-4-0613 may be overridden (2 sites, 2026-10-01).',
    );
    const b = reasonPattern(
      'The request spreads `baseParams` from lib/ai/params.js into the body, so the model gpt-4o-2024-05-13 may be overridden (5 sites, 2026-11-20).',
    );
    expect(a).toBe(b);
    expect(a).toBe(
      'The request spreads <code> from <file> into the body, so the model <model> may be overridden (<n> sites, <date>).',
    );
  });

  it('keeps API names and drops the repository own names from code', () => {
    expect(
      codeShape(
        'const reply = await myClient.chat.completions.create({ model: MODEL, temperature: 0.2 })',
      ),
    ).toBe('const <id> = await <id>.chat.completions.create({ model: <id>, temperature: <n> })');
  });

  it('builds a matcher that matches the reasons it came from', () => {
    const reason = 'The model comes from `process.env.X` with no literal default.';
    expect(new RegExp(patternMatcher(reasonPattern(reason))).test(reason)).toBe(true);
    expect(new RegExp(patternMatcher(reasonPattern(reason))).test('Something else entirely.')).toBe(
      false,
    );
  });
});

describe('miss records and rule candidates', () => {
  const spread = (variable: string, file: string) =>
    `The request spreads \`${variable}\` from ${file} into the body, so the model may be overridden.`;
  const records = (
    repo: string,
    file: string,
    variable: string,
    result: FallbackResult | null,
    withSource = true,
  ) =>
    missRecords(
      { repo, commit: 'a'.repeat(40), provider: 'openai', language: 'js' },
      [item(file, spread(variable, file))],
      withSource ? [source] : [],
      result,
    );

  it('records the change type, pattern, stop reason, source and only a validated diff', () => {
    const [kept] = records(
      'dev/one',
      'src/a.ts',
      'defaults',
      fallback('validated', 'diff --git a'),
    );
    expect(kept).toEqual(
      expect.objectContaining({
        repo: 'dev/one',
        changeType: 'retired-model',
        kind: 'model-stop',
        pattern:
          'The request spreads <code> from <file> into the body, so the model may be overridden.',
        source,
      }),
    );
    expect(kept.ai).toEqual(
      expect.objectContaining({ status: 'validated', diff: 'diff --git a', costUsd: 0.05 }),
    );
    const [suggested] = records(
      'dev/one',
      'src/a.ts',
      'defaults',
      fallback('needs-review', 'diff'),
    );
    expect(suggested.ai.diff).toBe(null);
    expect(suggested.ai.gatesFailed).toEqual(['checks']);
    const [off] = records('dev/one', 'src/a.ts', 'defaults', null);
    expect(off.ai.status).toBe('not-run');
  });

  it('proposes a rule only across repositories, with a quoted source, and a validated fix as fixture', () => {
    const all: MissRecord[] = [
      ...records('dev/one', 'src/a.ts', 'defaults', fallback('validated', 'diff --git a/src/a.ts')),
      ...records('dev/two', 'lib/b.js', 'base', fallback('needs-review', 'diff')),
      // The same pattern without a source, in a different change type, stays its own group.
      ...records('dev/three', 'c.ts', 'x', null).map((record) => ({
        ...record,
        changeType: 'parameter-change' as const,
      })),
    ];
    const candidates = ruleCandidates(all);
    expect(candidates.map((candidate) => candidate.status)).toEqual([
      'rule-candidate',
      'single-repository',
    ]);
    const [rule] = candidates;
    expect(rule.repositories).toBe(2);
    expect(rule.fixtures[0]).toEqual(
      expect.objectContaining({ repo: 'dev/one', diff: 'diff --git a/src/a.ts' }),
    );
    expect(rule.ai).toEqual({ attempted: 2, validated: 1, costUsd: 0.1 });
    expect(rule.sources).toEqual([{ url: source.url, quote: source.quote }]);
    // D5: nothing repository-specific in what the rule matches on.
    for (const text of [rule.pattern, rule.match, ...rule.shapes])
      expect(text).not.toMatch(/dev\/|src\/a\.ts|lib\/b\.js|defaults|base\b/);
    for (const fixture of rule.fixtures)
      expect(new RegExp(rule.match).test(fixture.stopReason)).toBe(true);
  });

  it('withholds a group no saved quote backs', () => {
    const candidates = ruleCandidates([
      ...records('dev/one', 'a.ts', 'a', null, false),
      ...records('dev/two', 'b.ts', 'b', null, false),
    ]);
    expect(candidates.map((candidate) => candidate.status)).toEqual(['no-quoted-source']);
  });

  it('renders proposals and withheld groups', () => {
    const text = renderProposal(
      ruleCandidates([
        ...records('dev/one', 'a.ts', 'a', fallback('validated', 'd')),
        ...records('dev/two', 'b.ts', 'b', null),
      ]),
      {
        lists: ['openai-dev-30'],
        runs: ['123'],
        commit: 'f'.repeat(40),
        records: 2,
        date: '2026-10-29',
      },
    );
    expect(text).toContain('| rule-candidate | 1 |');
    expect(text).toContain(`> ${source.quote}`);
    expect(text).not.toContain('dev/one');
  });
});

describe('benchmark rows', () => {
  it('counts a row whose fallback passed every gate as ai-validated', () => {
    expect(rowOutcome({ stops: [{}], fallback: { status: 'validated' } })).toBe('ai-validated');
    expect(rowOutcome({ stops: [{}], fallback: { status: 'needs-review' } })).toBe('needs-review');
    expect(rowOutcome({ error: 'x', fallback: { status: 'validated' } })).toBe('error');
  });

  it('sums the fallback over a run', () => {
    expect(
      fallbackCounts([
        { misses: [{}], fallback: { status: 'validated', suggestion: false } },
        { misses: [{}, {}], fallback: { status: 'needs-review', suggestion: true } },
        { misses: [{}], fallback: { status: 'no-attempt' } },
        { misses: [{}], fallback: null },
        { outcome: 'unaffected' },
      ]),
    ).toEqual({ eligible: 4, attempted: 2, validated: 1, suggestions: 1, noAttempt: 1 });
  });
});

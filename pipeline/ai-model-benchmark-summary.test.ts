import { expect, it } from 'vitest';
import {
  benchmarkSummary,
  repositoryNonLive,
  stopReasonKind,
  stopReasons,
  type BenchmarkRepository,
  type DeadlineGroup,
} from '../scripts/ai-model-benchmark-summary.mjs';

// A group as `refit deadlines --json` prints it: only the provider and the exact non-live counts.
function group(provider: string, nonLiveCounts?: Record<string, number>): DeadlineGroup {
  return { deadline: { provider }, ...(nonLiveCounts ? { nonLiveCounts } : {}) };
}

it("sums one provider's non-live counts by use over exposures and mentions", () => {
  const result = {
    exposures: [group('openai', { catalog: 2, comment: 1 }), group('anthropic', { test: 9 })],
    mentions: [group('openai', { catalog: 1 }), group('anthropic', { catalog: 7 })],
  };
  expect(repositoryNonLive(result, 'openai')).toEqual({
    nonLive: { catalog: 3, comment: 1 },
    nonLiveTotal: 4,
  });
  expect(repositoryNonLive(result, 'anthropic')).toEqual({
    nonLive: { test: 9, catalog: 7 },
    nonLiveTotal: 16,
  });
  expect(repositoryNonLive(result, 'meta-graph')).toEqual({ nonLive: {}, nonLiveTotal: 0 });
});

it('reports no non-live matches for a missing result or groups without counts', () => {
  const none = { nonLive: {}, nonLiveTotal: 0 };
  expect(repositoryNonLive(undefined, 'openai')).toEqual(none);
  expect(repositoryNonLive({}, 'openai')).toEqual(none);
  // A scan from an older Refit has no counts.
  expect(repositoryNonLive({ exposures: [group('openai')] }, 'openai')).toEqual(none);
});

const exposure = [{ deadline: 'openai-gpt-4', date: '2026-10-23', evidence: ['src/a.ts:1'] }];

// Each entry has the shape ai-model-benchmark.mjs writes for one repository.
const results: BenchmarkRepository[] = [
  // Exposed with a replacement, and it also lists a catalog: not a mention-only repository.
  {
    repo: 'a/fixed',
    exposures: exposure,
    replacements: [{}],
    stops: [{}, {}],
    nonLive: { catalog: 4 },
    nonLiveTotal: 4,
  },
  { repo: 'a/stopped', exposures: exposure, replacements: [], stops: [{}] },
  { repo: 'a/silent', exposures: exposure, replacements: [], stops: [] },
  // Silent, but every live match is explained.
  { repo: 'a/explained', exposures: exposure, replacements: [], stops: [], unresolved: [{}, {}] },
  {
    repo: 'a/slow',
    error: 'timed out after 120 s',
    exposures: exposure,
    replacements: [],
    stops: [],
  },
  // The deadline model appears only outside live code.
  {
    repo: 'a/mention',
    exposures: [],
    replacements: [],
    stops: [],
    nonLive: { catalog: 3, comment: 1 },
    nonLiveTotal: 4,
  },
  { repo: 'a/clean', exposures: [], replacements: [], stops: [], nonLive: {}, nonLiveTotal: 0 },
  // An errored repository is counted as an error, never as a mention.
  { repo: 'a/checkout', error: 'checkout: fetch failed' },
  {
    repo: 'a/broken',
    error: 'timed out after 120 s',
    exposures: [],
    replacements: [],
    stops: [],
    nonLive: { catalog: 5 },
    nonLiveTotal: 5,
  },
];

it('keeps every 2026-10-20 summary key and value, and adds the newer counts after them', () => {
  expect(benchmarkSummary(results)).toEqual({
    repositories: 9,
    errors: 3,
    timedOut: 2,
    exposed: 5,
    exposedWithReplacement: 1,
    exposedStoppedOnly: 1,
    // The timed-out exposed repository is not silent: it is counted as errored.
    exposedSilent: 2,
    replacements: 1,
    stops: 3,
    mentionedOnly: 1,
    exposedErrored: 1,
    exposedUnresolvedOnly: 1,
    exposedUnexplained: 1,
    unresolved: 2,
  });
  // The earlier keys keep their order, and the new one follows them.
  expect(Object.keys(benchmarkSummary(results))).toEqual([
    'repositories',
    'errors',
    'timedOut',
    'exposed',
    'exposedWithReplacement',
    'exposedStoppedOnly',
    'exposedSilent',
    'replacements',
    'stops',
    'mentionedOnly',
    'exposedErrored',
    'exposedUnresolvedOnly',
    'exposedUnexplained',
    'unresolved',
  ]);
});

it('summarizes an empty run as zeros', () => {
  expect(benchmarkSummary([])).toEqual({
    repositories: 0,
    errors: 0,
    timedOut: 0,
    exposed: 0,
    exposedWithReplacement: 0,
    exposedStoppedOnly: 0,
    exposedSilent: 0,
    replacements: 0,
    stops: 0,
    mentionedOnly: 0,
    exposedErrored: 0,
    exposedUnresolvedOnly: 0,
    exposedUnexplained: 0,
    unresolved: 0,
  });
});

it('ranks stop reasons by the exposed repositories they block', () => {
  const custom = (to: string) =>
    `The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to ${to}.`;
  const spread = (name: string, to: string) =>
    `The request takes its model from the options it spreads (\`...${name}\`), which Refit reports but does not edit; change it by hand to ${to}.`;
  const exposures = [{}];
  expect(
    stopReasons([
      {
        exposures,
        replacements: [],
        stops: [{ reason: custom('gpt-5.6-sol') }, { reason: custom('o4-mini') }],
      },
      { exposures, replacements: [{}], stops: [{ reason: custom('claude-opus-4-8') }] },
      { exposures, replacements: [], stops: [{ reason: spread('params', 'claude-opus-4-8') }] },
      { exposures, replacements: [], stops: [{ reason: spread('base', 'gpt-5.6-sol') }] },
      // Not exposed: a stop on a deadline the scan does not report is not counted.
      { exposures: [], replacements: [], stops: [{ reason: custom('gpt-5.6-sol') }] },
    ]),
  ).toEqual(
    [
      {
        reason:
          "The client sets a custom base URL, so the model may name another provider's model or a deployment",
        repositories: 2,
        blocked: 1,
      },
      {
        reason:
          'The request takes its model from the options it spreads, which Refit reports but does not edit',
        repositories: 2,
        blocked: 2,
      },
    ].reverse(),
  );
  expect(
    stopReasonKind(
      "The client is Claude on Amazon Bedrock, where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's (the Claude API retires claude-3-opus-20240229 on 2026-01-05); check Amazon Bedrock's model lifecycle and change it by hand to its ID for claude-opus-4-8.",
    ),
  ).toBe(
    "The client is Claude on Amazon Bedrock, where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's",
  );
  expect(
    stopReasonKind(
      'The request sets max_tokens, which gpt-5.6-sol may reject or treat differently.',
    ),
  ).toBe('The request sets max_tokens, which <model> may reject or treat differently.');
});

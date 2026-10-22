import { expect, it } from 'vitest';
import {
  benchmarkSummary,
  repositoryNonLive,
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

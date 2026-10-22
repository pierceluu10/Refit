// Types for the plain-JavaScript summary module, so pipeline tests can import it under strict
// TypeScript. They describe only the fields the functions read.

// A group in `refit deadlines --json`: an exposure or a mention.
export interface DeadlineGroup {
  deadline: { provider: string };
  nonLiveCounts?: Record<string, number>;
}

export interface DeadlinesResult {
  exposures?: DeadlineGroup[];
  mentions?: DeadlineGroup[];
}

export interface RepositoryNonLive {
  // Non-live matches by use. Key order carries no meaning.
  nonLive: Record<string, number>;
  nonLiveTotal: number;
}

// One repository's entry in a benchmark results file.
export interface BenchmarkRepository {
  repo?: string;
  commit?: string;
  error?: string;
  exposures?: unknown[];
  replacements?: unknown[];
  stops?: { reason?: string }[];
  unresolved?: unknown[];
  nonLive?: Record<string, number>;
  nonLiveTotal?: number;
}

export interface BenchmarkSummary {
  repositories: number;
  errors: number;
  timedOut: number;
  exposed: number;
  exposedWithReplacement: number;
  exposedStoppedOnly: number;
  exposedSilent: number;
  replacements: number;
  stops: number;
  mentionedOnly: number;
  exposedErrored: number;
  exposedUnresolvedOnly: number;
  exposedUnexplained: number;
  unresolved: number;
}

export function repositoryNonLive(
  result: DeadlinesResult | undefined,
  provider: string,
): RepositoryNonLive;

export function benchmarkSummary(results: BenchmarkRepository[]): BenchmarkSummary;

export interface StopReasonCount {
  reason: string;
  repositories: number;
  blocked: number;
}

export function stopReasonKind(reason: string): string;

export function stopReasons(results: BenchmarkRepository[]): StopReasonCount[];

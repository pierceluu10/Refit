import { captureDocumentation } from './documentation-sources.ts';
import { environmentFlag } from './monitoring.ts';
import { captureSpecification } from './openapi-sources.ts';
import { PipelineInputError } from './types.ts';
import type { WatchCapture, WatchTarget } from './watch-target-store.ts';

// Each watch target's public sources are read again at most once a day.
export const WATCH_INTERVAL_SECONDS = 24 * 60 * 60;

// Off by default: REFIT_HOSTED_WATCH=1 makes serve capture due watch targets.
export function hostedWatch(environment: NodeJS.ProcessEnv) {
  return environmentFlag(environment, 'REFIT_HOSTED_WATCH');
}

// Download refusals, network failures (fetch's TypeError) and timeouts stay with their source.
const SOURCE_FAILURES = new Set(['TypeError', 'TimeoutError']);
const failure = (error: unknown) => {
  if (
    error instanceof PipelineInputError ||
    (error instanceof Error && SOURCE_FAILURES.has(error.name))
  )
    return error.message;
  throw error;
};

// Captures a target's OpenAPI document and changelog pages with the same capture `refit watch`
// uses, keeping only each content hash. One failing source does not stop the others.
export async function captureWatchTarget(target: WatchTarget) {
  const captures: WatchCapture[] = [];
  const { specification, documentation } = target.sources;
  if (specification)
    try {
      const snapshot = await captureSpecification(
        { kind: 'https', url: specification },
        target.provider,
      );
      captures.push({ kind: 'specification', url: specification, hash: snapshot.hash });
    } catch (error) {
      captures.push({ kind: 'specification', url: specification, error: failure(error) });
    }
  for (const page of documentation)
    try {
      const snapshot = await captureDocumentation(page);
      captures.push({ kind: 'documentation', url: page.url, hash: snapshot.hash });
    } catch (error) {
      captures.push({ kind: 'documentation', url: page.url, error: failure(error) });
    }
  const previous = new Map(
    (target.captures ?? []).flatMap((capture) =>
      'hash' in capture ? [[capture.url, capture.hash]] : [],
    ),
  );
  const changed = captures.some(
    (capture) =>
      'hash' in capture && previous.has(capture.url) && previous.get(capture.url) !== capture.hash,
  );
  return { captures, changed };
}

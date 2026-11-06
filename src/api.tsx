import { Info, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import type { ScanReport } from '../shared/types.ts';

// No API is served here (a static deploy answers 404 or falls back to index.html).
export class ApiUnavailableError extends Error {}
// The API needs a sign-in the site can't do yet.
export class ApiSignedOutError extends Error {}
// The API is there and says this one thing doesn't exist, e.g. a repo with no scan yet.
export class ApiNotFoundError extends Error {}

export async function fetchApi<T>(
  path: string,
  isExpected: (body: unknown) => body is T,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal });
  if (response.status === 401) throw new ApiSignedOutError();
  const json = response.headers.get('content-type')?.includes('application/json');
  if (!json) throw new ApiUnavailableError();
  if (response.status === 404) throw new ApiNotFoundError();
  if (!response.ok) throw new Error(`The API answered ${response.status}.`);
  const body: unknown = await response.json();
  if (!isExpected(body)) throw new Error('The API returned something unexpected.');
  return body;
}

export function isList<T>(body: unknown): body is T[] {
  return Array.isArray(body);
}

export function fetchRepos(signal: AbortSignal) {
  return fetchApi('/api/repos', isList<string>, signal);
}

function isReport(body: unknown): body is ScanReport {
  return typeof body === 'object' && body !== null && 'items' in body;
}

// null means the repo has no finished scan yet.
export async function fetchReport(repo: string, signal: AbortSignal): Promise<ScanReport | null> {
  try {
    return await fetchApi(`/api/report?${new URLSearchParams({ repo })}`, isReport, signal);
  } catch (error) {
    if (error instanceof ApiNotFoundError) return null;
    throw error;
  }
}

export type ApiState<T> =
  | { status: 'loading' }
  | { status: 'live'; data: T }
  | { status: 'example'; signedOut: boolean }
  | { status: 'error'; message: string };

// `key` names what's being loaded: `load` re-runs when it changes.
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, key: string) {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    load(controller.signal).then(
      (data) => setState({ status: 'live', data }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiUnavailableError) setState({ status: 'example', signedOut: false });
        else if (error instanceof ApiSignedOutError)
          setState({ status: 'example', signedOut: true });
        else
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => controller.abort();
    // `load` is a new function each render; `key` says when it means something different.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  return { state, retry };
}

export function ExampleNote({ signedOut, what }: { signedOut: boolean; what: string }) {
  return (
    <div className="detail-explanation example-note">
      <Info />
      <span>
        {signedOut
          ? `Your ${what} need a GitHub sign-in, which isn’t available yet. These are examples.`
          : `No Refit API is reachable from this site. These ${what} are examples.`}
      </span>
    </div>
  );
}

export function ApiLoading({ what }: { what: string }) {
  return (
    <p className="api-loading" role="status">
      Loading {what}…
    </p>
  );
}

export function ApiError({
  what,
  message,
  retry,
}: {
  what: string;
  message: string;
  retry: () => void;
}) {
  return (
    <div className="empty-state" role="alert">
      <WarningCircle size={30} />
      <h2>Couldn’t load {what}.</h2>
      <p>{message} Check that the Refit app is running, then try again.</p>
      <button className="button button-secondary button-small" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

import { ArrowUpRight, ClockCounterClockwise, Info, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { RunView } from '../../shared/types.ts';
import { PageHeading, Status } from '../components/WorkspaceUI';
import { providerName, runs as exampleRuns } from '../fixtures';

export const RUNS_LIMIT = 50;

// No API is served here (a static deploy answers 404 or falls back to index.html).
export class RunsUnavailableError extends Error {}
// The API needs a GitHub sign-in the site can't do yet.
export class RunsSignedOutError extends Error {}

export async function fetchRuns(repo: string | null, signal: AbortSignal): Promise<RunView[]> {
  const query = new URLSearchParams({ limit: String(RUNS_LIMIT) });
  if (repo) query.set('repo', repo);
  const response = await fetch(`/api/runs?${query}`, { signal });
  if (response.status === 401) throw new RunsSignedOutError();
  const json = response.headers.get('content-type')?.includes('application/json');
  if (response.status === 404 || !json) throw new RunsUnavailableError();
  if (!response.ok) throw new Error(`The runs API answered ${response.status}.`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('The runs API returned something other than a list.');
  return body as RunView[];
}

type State =
  | { status: 'loading' }
  | { status: 'live'; runs: RunView[] }
  | { status: 'example'; signedOut: boolean }
  | { status: 'error'; message: string };

const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Runs() {
  const [parameters] = useSearchParams();
  const repo = parameters.get('repo');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchRuns(repo, controller.signal).then(
      (runs) => setState({ status: 'live', runs }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof RunsUnavailableError)
          setState({ status: 'example', signedOut: false });
        else if (error instanceof RunsSignedOutError)
          setState({ status: 'example', signedOut: true });
        else
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => controller.abort();
  }, [repo, attempt]);

  const example = state.status === 'example';
  const shown =
    state.status === 'live'
      ? state.runs
      : example
        ? exampleRuns.filter((run) => !repo || run.repo === repo)
        : [];

  return (
    <>
      <PageHeading
        title="Runs"
        description={
          repo
            ? `Every finished run on ${repo}, newest first.`
            : 'Every finished run across your repositories, newest first.'
        }
        example={example}
      />
      {repo && (
        <p className="runs-filter">
          Showing <code>{repo}</code> <Link to="/app/runs">All repositories</Link>
        </p>
      )}
      {example && (
        <div className="detail-explanation runs-note">
          <Info />
          <span>
            {state.signedOut
              ? 'Your runs need a GitHub sign-in, which isn’t available yet. These are example runs.'
              : 'No runs API is reachable from this site. These are example runs.'}
          </span>
        </div>
      )}
      {state.status === 'loading' && (
        <p className="runs-message" role="status">
          Loading runs…
        </p>
      )}
      {state.status === 'error' && (
        <div className="empty-state" role="alert">
          <WarningCircle size={30} />
          <h2>Couldn’t load runs.</h2>
          <p>{state.message} Check that the Aptitude app is running, then try again.</p>
          <button
            className="button button-secondary button-small"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {(state.status === 'live' || example) &&
        (shown.length === 0 ? (
          <div className="empty-state">
            <ClockCounterClockwise size={30} />
            <h2>No runs yet</h2>
            <p>Runs appear here when a provider change touches one of your repositories.</p>
          </div>
        ) : (
          <ul className="run-list" aria-label="Runs">
            {shown.map((run) => (
              <li key={run.id}>
                <Status outcome={run.outcome} />
                <div>
                  <strong>
                    {providerName(run.provider)} <span>·</span> <code>{run.changeId}</code>
                  </strong>
                  <p>{run.summary}</p>
                  <p className="run-meta">
                    {!repo && (
                      <>
                        {run.repo} <span>·</span>{' '}
                      </>
                    )}
                    {costFormat.format(run.costUsd)} <span>·</span>{' '}
                    <time dateTime={run.finishedAt}>
                      {timeFormat.format(new Date(run.finishedAt))}
                    </time>
                  </p>
                </div>
                {run.pr && (
                  <a
                    className="text-link"
                    href={run.pr}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Pull request for ${run.changeId} on ${run.repo} (opens in a new tab)`}
                  >
                    Pull request
                    <ArrowUpRight />
                  </a>
                )}
              </li>
            ))}
          </ul>
        ))}
      {example && shown.length > 0 && (
        <p className="list-footnote">Example runs. Costs and times are illustrative.</p>
      )}
    </>
  );
}

import { ClockCounterClockwise } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router-dom';
import type { RunView } from '../../shared/types.ts';
import { ApiError, ApiLoading, ExampleNote, fetchApi, isList, useApi } from '../api';
import { ExternalLink, PageHeading, Status } from '../components/WorkspaceUI';
import { providerName, runs as exampleRuns } from '../fixtures';

export const RUNS_LIMIT = 50;

function fetchRuns(repo: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ limit: String(RUNS_LIMIT) });
  if (repo) query.set('repo', repo);
  return fetchApi(`/api/runs?${query}`, isList<RunView>, signal);
}

const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Runs() {
  const [parameters] = useSearchParams();
  const repo = parameters.get('repo');
  const { state, retry } = useApi((signal) => fetchRuns(repo, signal), repo ?? '');

  const example = state.status === 'example';
  const shown =
    state.status === 'live'
      ? state.data
      : example
        ? exampleRuns.filter((run) => !repo || run.repo === repo)
        : [];

  return (
    <>
      <PageHeading
        title="Runs"
        description={
          repo
            ? `What Refit did about each change on ${repo}, newest first.`
            : 'What Refit did about each change across your repositories, newest first.'
        }
        example={example}
      />
      {repo && (
        <p className="runs-filter">
          Showing <code>{repo}</code> <Link to="/app/runs">All repositories</Link>
        </p>
      )}
      {state.status === 'example' && <ExampleNote signedOut={state.signedOut} what="runs" />}
      {state.status === 'loading' && <ApiLoading what="runs" />}
      {state.status === 'error' && <ApiError what="runs" message={state.message} retry={retry} />}
      {(state.status === 'live' || example) &&
        (shown.length === 0 ? (
          <div className="empty-state">
            <ClockCounterClockwise size={30} />
            <h2>No runs yet</h2>
            <p>
              Runs appear here when something your code depends on changes and touches one of your
              repositories.
            </p>
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
                  <ExternalLink
                    href={run.pr}
                    label={`Pull request for ${run.changeId} on ${run.repo} (opens in a new tab)`}
                  >
                    Pull request
                  </ExternalLink>
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

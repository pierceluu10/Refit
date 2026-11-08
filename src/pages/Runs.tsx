import { ClockCounterClockwise } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, ApiLoading, ExampleNote, fetchRuns, RUNS_LIMIT, useApi } from '../api';
import { ExternalLink, formatCost, PageHeading, Status } from '../components/WorkspaceUI';
import { providerName, runs as exampleRuns } from '../fixtures';

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
  const waiting = shown.filter((run) => run.outcome === 'waiting-budget').length;

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
      {waiting > 0 && (
        <p className="detail-explanation scan-note">
          {waiting} {waiting === 1 ? 'task is' : 'tasks are'} waiting on budget. Refit hasn’t tried
          them, so they cost nothing and none of them failed.
        </p>
      )}
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
                    {formatCost(run.costUsd)} <span>·</span>{' '}
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
      {state.status === 'live' && shown.length === RUNS_LIMIT && (
        <p className="list-footnote">Showing the newest {RUNS_LIMIT} runs.</p>
      )}
      {example && shown.length > 0 && (
        <p className="list-footnote">Example runs. Costs and times are illustrative.</p>
      )}
    </>
  );
}

import {
  ArrowRight,
  ArrowUpRight,
  BracketsCurly,
  CaretRight,
  Check,
  FileCode,
  GitPullRequest,
  MagnifyingGlass,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PageHeading, Status, WorkspaceMissing } from '../components/WorkspaceUI';
import { CodeDiff, StageContent } from '../components/Workflow';

const exampleRuns = [
  {
    id: 'charge-reference',
    title: 'Adapt payment charge lookup',
    state: 'Example complete',
    outcome: 'A draft ready for human review',
    scenario: 'affected' as const,
  },
  {
    id: 'validation-failure',
    title: 'Charge lookup with a failing assertion',
    state: 'Example failed',
    outcome: 'Publication blocked by validation',
    scenario: 'failed' as const,
  },
];

export function Changes() {
  return (
    <>
      <PageHeading
        title="API changes"
        description="Upstream changes, with the downstream context."
      />
      <div className="change-provider">
        <span className="provider-symbol">S</span>
        <div>
          <strong>Stripe</strong>
          <span>OpenAPI specification · illustrative change</span>
        </div>
        <span className="preview-chip">MVP provider</span>
      </div>
      <Link className="change-row" to="/sample/changes/charge-reference">
        <span className="change-icon">
          <BracketsCurly />
        </span>
        <div>
          <h2>PaymentIntent charge reference</h2>
          <p>A response field changes from an expanded list to a latest-charge reference.</p>
          <span>1 affected repository · 1 unaffected · 1 needs review</span>
        </div>
        <CaretRight />
      </Link>
      <div className="detail-explanation">
        <FileCode />
        <span>
          Real change detection will compare immutable provider snapshots. This entry illustrates
          the resulting review experience.
        </span>
      </div>
    </>
  );
}

export function ChangeDetail() {
  const { id } = useParams();
  if (id !== 'charge-reference') return <WorkspaceMissing />;
  return (
    <>
      <Link className="back-link" to="/sample/changes">
        ← All API changes
      </Link>
      <PageHeading
        title="PaymentIntent charge reference"
        description="Stripe · illustrative change · migration-relevant response field"
      />
      <div className="change-detail-panel">
        <StageContent stage={0} />
      </div>
      <section className="detail-section">
        <h2>Impact by repository</h2>
        <p>
          The same provider change can affect each repository differently. Dependency presence alone
          does not determine impact.
        </p>
        <div className="impact-rows">
          {[
            {
              id: 'acme-api',
              name: 'acme / api',
              state: 'Affected',
              note: 'Reads the changed field',
            },
            {
              id: 'acme-web',
              name: 'acme / web',
              state: 'Unaffected',
              note: 'Creates checkout sessions only',
            },
            {
              id: 'acme-worker',
              name: 'acme / worker',
              state: 'Needs review',
              note: 'Dynamic access needs evidence',
            },
          ].map((repo) => (
            <Link key={repo.id} to={`/sample/repositories/${repo.id}`}>
              <div>
                <strong>{repo.name}</strong>
                <span>{repo.note}</span>
              </div>
              <Status value={repo.state} />
              <CaretRight />
            </Link>
          ))}
        </div>
      </section>
      <div className="detail-actions">
        <Link className="button button-primary" to="/sample/runs/charge-reference">
          Inspect the example migration <ArrowRight />
        </Link>
      </div>
    </>
  );
}

export function Runs() {
  const [parameters, setParameters] = useSearchParams();
  const query = parameters.get('q') ?? '';
  const requested = parameters.get('status');
  const state = requested === 'complete' || requested === 'failed' ? requested : 'all';
  const runs = exampleRuns.filter(
    (run) =>
      run.title.toLowerCase().includes(query.toLowerCase()) &&
      (state === 'all' || run.state.toLowerCase().endsWith(state)),
  );
  function update(key: string, value: string) {
    const next = new URLSearchParams(parameters);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParameters(next, { replace: true });
  }
  return (
    <>
      <PageHeading title="Migration runs" description="Follow the work. Inspect the result." />
      <div className="resource-toolbar">
        <label className="search-field">
          <MagnifyingGlass />
          <input
            aria-label="Search migration runs"
            placeholder="Search migration runs…"
            value={query}
            onChange={(event) => update('q', event.target.value)}
          />
        </label>
        <label className="filter-field">
          <span>Outcome</span>
          <select
            aria-label="Filter migration runs"
            value={state}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="all">All outcomes</option>
            <option value="complete">Example complete</option>
            <option value="failed">Example failed</option>
          </select>
        </label>
      </div>
      <div className="runs-list">
        {runs.map((run) => (
          <Link key={run.id} to={`/sample/runs/${run.id}`}>
            <GitPullRequest />
            <div>
              <strong>{run.title}</strong>
              <p>
                acme / api <span>·</span> {run.outcome}
              </p>
            </div>
            <Status value={run.state} />
            <CaretRight />
          </Link>
        ))}
        {runs.length === 0 && (
          <div className="empty-state">
            <MagnifyingGlass size={30} />
            <h2>No runs match.</h2>
            <p>Try another search or clear the outcome filter.</p>
            <button className="button button-secondary" onClick={() => setParameters({})}>
              Clear filters
            </button>
          </div>
        )}
      </div>
      <p className="list-footnote">Sample outcomes only. No commands have been executed.</p>
    </>
  );
}

export function RunDetail() {
  const { id } = useParams();
  const [parameters, setParameters] = useSearchParams();
  const run = exampleRuns.find((item) => item.id === id);
  if (!run) return <WorkspaceMissing />;
  const tabs = ['Overview', 'Code diff', 'Validation', 'Review'] as const;
  const tab =
    tabs.find((item) => item.toLowerCase().replace(' ', '-') === parameters.get('tab')) ??
    'Overview';
  const failed = run.scenario === 'failed';
  return (
    <>
      <Link className="back-link" to="/sample/runs">
        ← All migration runs
      </Link>
      <PageHeading
        title={run.title}
        description="acme / api · Stripe · sample migration run"
        action={<Status value={run.state} />}
      />
      <div className="run-tabs" aria-label="Run detail views">
        {tabs.map((item) => (
          <button
            key={item}
            aria-pressed={tab === item}
            className={tab === item ? 'selected' : ''}
            onClick={() => setParameters({ tab: item.toLowerCase().replace(' ', '-') })}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="run-panel">
        {tab === 'Code diff' ? (
          <>
            <div className="detail-file">
              <FileCode />
              <code>src/billing/payments.ts</code>
              <span>Illustrative patch</span>
            </div>
            <CodeDiff />
            <p className="artifact-footnote">
              Review the sample migration in context. This code has not been applied to a
              repository.
            </p>
          </>
        ) : tab === 'Validation' ? (
          <StageContent stage={2} scenario={run.scenario} />
        ) : tab === 'Review' ? (
          <StageContent stage={3} scenario={run.scenario} />
        ) : (
          <div className="run-overview">
            <h2>The path from change to review.</h2>
            <p>Illustrative sequence. No live execution or measured timestamps.</p>
            <ol className="run-timeline">
              {[
                {
                  title: 'Provider change detected',
                  body: 'Compare versioned API specifications.',
                },
                {
                  title: 'Affected usage identified',
                  body: 'Trace the response field into the billing wrapper.',
                },
                {
                  title: 'Focused patch prepared',
                  body: 'Handle a charge ID, expanded object, or null reference.',
                },
                {
                  title: failed ? 'Validation failed' : 'Validation completed',
                  body: failed
                    ? 'A test assertion still fails after the repair limit.'
                    : 'The successful scenario illustrates all required checks passing.',
                },
                {
                  title: failed ? 'Publication blocked' : 'Draft review prepared',
                  body: failed
                    ? 'No draft PR is created when required checks fail.'
                    : 'In the real pipeline, this is where a draft would be published.',
                },
              ].map((step, index) => (
                <li key={step.title} className={failed && index >= 3 ? 'timeline-failed' : ''}>
                  <span className="timeline-mark">
                    {failed && index >= 3 ? <WarningCircle /> : <Check />}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </div>
                  <span className="timeline-index">0{index + 1}</span>
                </li>
              ))}
            </ol>
            <div className="detail-explanation">
              <ShieldCheck />
              <span>
                {failed
                  ? 'The failure state is a useful outcome: it prevents an unvalidated patch from reaching review.'
                  : 'Human review is required. The preview creates no real branch, commit, or pull request.'}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="detail-actions">
        <Link className="text-link" to={`/demo?scenario=${run.scenario}`}>
          Explore this scenario interactively <ArrowUpRight />
        </Link>
      </div>
    </>
  );
}

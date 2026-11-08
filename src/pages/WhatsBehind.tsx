import { CheckCircle, Funnel, WarningCircle } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BehindItem, ExternalChange, ScanReport } from '../../shared/types.ts';
import {
  ApiError,
  ApiLoading,
  ExampleNote,
  fetchReport,
  fetchRepos,
  fetchRuns,
  useApi,
  waitingChanges,
} from '../api';
import {
  BehindStatus,
  behindStatusLabels,
  DataCell,
  ExternalLink,
  type FindingStatus,
  formatDay,
  labelOf,
  NoRepositories,
  PageHeading,
  repoPath,
  ScanErrors,
} from '../components/WorkspaceUI';
import { exampleReports, runs as exampleRuns } from '../fixtures';

// waiting: the changes whose newest run is held for budget.
export type RepoScan = { repo: string; report: ScanReport | null; waiting: Set<string> };

export async function fetchScans(signal: AbortSignal): Promise<RepoScan[]> {
  const repos = await fetchRepos(signal);
  return Promise.all(
    repos.map(async (repo) => {
      const [report, runs] = await Promise.all([
        fetchReport(repo, signal),
        fetchRuns(repo, signal),
      ]);
      return { repo, report, waiting: waitingChanges(runs) };
    }),
  );
}

export const exampleScans: RepoScan[] = exampleReports.map((report) => ({
  repo: report.repo,
  report,
  waiting: waitingChanges(exampleRuns.filter((run) => run.repo === report.repo)),
}));

export function isUnresolved(item: BehindItem) {
  return item.status === 'open' || item.status === 'pr-open';
}

// Only an open finding can wait: one with a PR or a verdict has already been worked on.
export function isWaiting(item: BehindItem, waiting: Set<string>) {
  return item.status === 'open' && waiting.has(item.change.id);
}

type Finding = BehindItem & { shownStatus: FindingStatus };

const kindLabels: Record<ExternalChange['kind'], string> = {
  'api-version': 'API version',
  'sdk-major': 'SDK major version',
  'field-removed': 'Field removed',
  'field-renamed': 'Field renamed',
  'endpoint-removed': 'Endpoint removed',
  'rest-to-graphql': 'REST to GraphQL',
  'auth-change': 'Login change',
  'webhook-payload': 'Webhook change',
  'model-retirement': 'AI model retired',
  'product-shutdown': 'Product shutdown',
  'pagination-or-limits': 'Limits change',
  other: 'Other change',
  'runtime-eol': 'Runtime end of life',
  'framework-major': 'Framework major version',
  'dependency-major': 'Library major version',
  'security-fix': 'Security fix',
  'container-image-eol': 'Container image end of life',
  'ci-deprecation': 'CI deprecation',
  'k8s-version': 'Kubernetes version',
  'serverless-runtime': 'Serverless runtime',
  'cloud-deprecation': 'Cloud deprecation',
  'platform-policy': 'Platform policy',
  'mobile-os': 'Mobile OS change',
  'browser-change': 'Browser change',
  'tls-crypto': 'Encryption change',
  'auth-standard': 'Login standard',
  'payment-rule': 'Payment rule',
  regulation: 'Regulation',
};

const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

function deadlineTime(item: BehindItem) {
  const time = item.deadline ? Date.parse(item.deadline) : NaN;
  return Number.isNaN(time) ? NO_DEADLINE : time;
}

function startOfToday() {
  return Date.parse(new Date().toISOString().slice(0, 10));
}

// Merged and not-affected findings are done, so a date behind them isn't overdue.
function isPastDue(item: BehindItem) {
  return isUnresolved(item) && deadlineTime(item) < startOfToday();
}

function sortByDeadline(items: Finding[]) {
  return [...items].sort(
    (first, second) =>
      Number(isPastDue(second)) - Number(isPastDue(first)) ||
      deadlineTime(first) - deadlineTime(second),
  );
}

const filters: {
  name: string;
  label: string;
  value: (item: Finding) => string;
  labels: Record<string, string>;
}[] = [
  { name: 'repo', label: 'Repository', value: (item) => item.repo, labels: {} },
  { name: 'kind', label: 'Kind', value: (item) => item.change.kind, labels: kindLabels },
  {
    name: 'status',
    label: 'Status',
    value: (item) => item.shownStatus,
    labels: behindStatusLabels,
  },
];

export function WhatsBehind() {
  const { state, retry } = useApi(fetchScans, 'scans');
  const scans =
    state.status === 'live' ? state.data : state.status === 'example' ? exampleScans : null;
  return (
    <>
      <PageHeading
        title="What’s behind"
        description="Everything outside your code that has changed or is about to, soonest deadline first."
        example={state.status === 'example'}
      />
      {state.status === 'example' && <ExampleNote signedOut={state.signedOut} what="findings" />}
      {state.status === 'loading' && <ApiLoading what="findings" />}
      {state.status === 'error' && (
        <ApiError what="findings" message={state.message} retry={retry} />
      )}
      {scans && <Findings scans={scans} />}
      {state.status === 'example' && (
        <p className="list-footnote">
          Example findings. The repositories, scan errors and pull requests are invented. The dates
          and source links are real.
        </p>
      )}
    </>
  );
}

function Findings({ scans }: { scans: RepoScan[] }) {
  const [parameters, setParameters] = useSearchParams();
  if (scans.length === 0) return <NoRepositories />;

  const items = sortByDeadline(
    scans.flatMap(({ report, waiting }) =>
      (report?.items ?? []).map((item) => ({
        ...item,
        shownStatus: isWaiting(item, waiting) ? ('waiting-budget' as const) : item.status,
      })),
    ),
  );
  const shown = items.filter((item) =>
    filters.every((filter) => {
      const selected = parameters.get(filter.name);
      return !selected || filter.value(item) === selected;
    }),
  );
  const filtered = filters.some((filter) => parameters.get(filter.name));
  const unscanned = scans.filter((scan) => !scan.report).map((scan) => scan.repo);

  function setFilter(name: string, value: string) {
    setParameters((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
  }
  const clearFilters = () => setParameters({});

  return (
    <>
      {scans.map(
        ({ repo, report }) =>
          report &&
          report.errors.length > 0 && <ScanErrors key={repo} repo={repo} errors={report.errors} />,
      )}
      {unscanned.length > 0 && (
        <p className="detail-explanation scan-note">
          No scan yet for {unscanned.join(', ')}. Findings show here once the first scan finishes.
        </p>
      )}
      {items.length > 0 && (
        <div className="resource-toolbar" role="group" aria-label="Filter findings">
          {filters.map((filter) => {
            const selected = parameters.get(filter.name) ?? '';
            // A deep link can name a value no finding has today, so keep it selectable.
            const values = [...new Set([...items.map(filter.value), selected])].filter(Boolean);
            return (
              <label className="filter-field" key={filter.name}>
                {filter.label}
                <select
                  value={selected}
                  onChange={(event) => setFilter(filter.name, event.target.value)}
                >
                  <option value="">All</option>
                  {values
                    .map((value) => ({ value, label: labelOf(filter.labels, value) }))
                    .sort((first, second) => first.label.localeCompare(second.label))
                    .map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
            );
          })}
          <p className="result-count" aria-live="polite">
            {shown.length} of {items.length}
          </p>
          {filtered && shown.length > 0 && (
            <button className="button button-secondary button-small" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}
      {shown.length > 0 && <FindingsTable items={shown} />}
      {items.length > 0 && shown.length === 0 && (
        <div className="empty-state">
          <Funnel size={30} />
          <h2>Nothing matches these filters</h2>
          <p>Clear them to see every finding.</p>
          <button className="button button-secondary button-small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}
      {items.length === 0 && unscanned.length < scans.length && (
        <div className="empty-state">
          <CheckCircle size={30} />
          <h2>Nothing is behind</h2>
          <p>The last scans found no changes that touch these repositories.</p>
        </div>
      )}
    </>
  );
}

function FindingsTable({ items }: { items: Finding[] }) {
  return (
    <div className="data-table-frame">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Deadline</th>
            <th scope="col">Repository</th>
            <th scope="col">Dependency</th>
            <th scope="col">Current</th>
            <th scope="col">Target</th>
            <th scope="col">What changed</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.repo}:${item.dependency.name}:${item.change.id}`}>
              <DataCell label="Deadline">
                <Deadline item={item} />
              </DataCell>
              <DataCell label="Repository">
                <Link className="table-link" to={repoPath(item.repo)}>
                  {item.repo}
                </Link>
              </DataCell>
              <DataCell label="Dependency">
                <code>{item.dependency.name}</code>
                <small>{labelOf(kindLabels, item.change.kind)}</small>
              </DataCell>
              <DataCell label="Current">
                {item.dependency.version ? <code>{item.dependency.version}</code> : 'Unknown'}
              </DataCell>
              <DataCell label="Target">
                {item.change.toVersion ? <code>{item.change.toVersion}</code> : 'None given'}
              </DataCell>
              <DataCell label="What changed">
                <span>{item.change.title}</span>
                <ExternalLink
                  href={item.change.source.url}
                  label={`Source for ${item.change.title} (opens in a new tab)`}
                >
                  Source
                </ExternalLink>
              </DataCell>
              <DataCell label="Status">
                <BehindStatus status={item.shownStatus} />
                {item.pr && (
                  <ExternalLink
                    href={item.pr}
                    label={`Pull request for ${item.dependency.name} on ${item.repo} (opens in a new tab)`}
                  >
                    Pull request
                  </ExternalLink>
                )}
              </DataCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Deadline({ item }: { item: BehindItem }) {
  if (!item.deadline) return <span className="muted-text">None</span>;
  return (
    <>
      <time dateTime={item.deadline}>{formatDay(item.deadline)}</time>
      {isPastDue(item) && (
        <strong className="past-due">
          <WarningCircle />
          Past due
        </strong>
      )}
    </>
  );
}

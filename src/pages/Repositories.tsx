import { ArrowRight, CheckCircle, ClockCounterClockwise } from '@phosphor-icons/react';
import { Link, useParams } from 'react-router-dom';
import type { DependencyUsage, ScanReport } from '../../shared/types.ts';
import { ApiError, ApiLoading, ExampleNote, fetchApi, fetchReport, isList, useApi } from '../api';
import {
  DataCell,
  ExternalLink,
  formatDay,
  labelOf,
  NoRepositories,
  PageHeading,
  repoPath,
  ScanErrors,
  WorkspaceMissing,
} from '../components/WorkspaceUI';
import { examplePullRequests, exampleReports, type RepoPullRequest } from '../fixtures';
import { exampleScans, fetchScans, isUnresolved } from './WhatsBehind';

export function Repositories() {
  const { state, retry } = useApi(fetchScans, 'scans');
  const scans =
    state.status === 'live' ? state.data : state.status === 'example' ? exampleScans : null;
  return (
    <>
      <PageHeading
        title="Repositories"
        description="The repositories Refit scans, and how many findings still need work in each."
        example={state.status === 'example'}
      />
      {state.status === 'example' && (
        <ExampleNote signedOut={state.signedOut} what="repositories" />
      )}
      {state.status === 'loading' && <ApiLoading what="repositories" />}
      {state.status === 'error' && (
        <ApiError what="repositories" message={state.message} retry={retry} />
      )}
      {scans?.length === 0 && <NoRepositories />}
      {scans && scans.length > 0 && (
        <div className="data-table-frame">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Open findings</th>
                <th scope="col">Last scan</th>
              </tr>
            </thead>
            <tbody>
              {scans.map(({ repo, report }) => (
                <tr key={repo}>
                  <DataCell label="Repository">
                    <Link className="table-link" to={repoPath(repo)}>
                      {repo}
                    </Link>
                  </DataCell>
                  <DataCell label="Open findings">
                    {report ? report.items.filter(isUnresolved).length : 'None yet'}
                  </DataCell>
                  <DataCell label="Last scan">
                    {report ? formatDay(report.scannedAt) : 'No scan yet'}
                  </DataCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type RepoDetail = { report: ScanReport | null; pullRequests: RepoPullRequest[] };

async function fetchRepoDetail(repo: string, signal: AbortSignal): Promise<RepoDetail> {
  const query = new URLSearchParams({ repo });
  const [report, pullRequests] = await Promise.all([
    fetchReport(repo, signal),
    fetchApi(`/api/prs?${query}`, isList<RepoPullRequest>, signal),
  ]);
  return { report, pullRequests };
}

function exampleDetail(repo: string): RepoDetail | null {
  const report = exampleReports.find((example) => example.repo === repo);
  if (!report) return null;
  return {
    report,
    pullRequests: examplePullRequests.filter((pullRequest) => pullRequest.repo === repo),
  };
}

const dependencyKindLabels: Record<DependencyUsage['kind'], string> = {
  api: 'APIs',
  sdk: 'SDKs',
  library: 'Libraries',
  framework: 'Frameworks',
  runtime: 'Runtimes',
  'ai-model': 'AI models',
  'container-image': 'Container images',
  ci: 'CI',
  platform: 'Platforms',
  infrastructure: 'Infrastructure',
  'security-standard': 'Security standards',
  'regulated-surface': 'Regulated surfaces',
};

// A dependency with several findings appears once.
function dependenciesWithFindings(report: ScanReport) {
  const unique = new Map(
    report.items.map(({ dependency }) => [
      `${dependency.kind}:${dependency.name}:${dependency.version}`,
      dependency,
    ]),
  );
  return [...unique.values()];
}

function groupByKind(dependencies: DependencyUsage[]) {
  const groups = new Map<string, DependencyUsage[]>();
  for (const dependency of dependencies) {
    groups.set(dependency.kind, [...(groups.get(dependency.kind) ?? []), dependency]);
  }
  return [...groups]
    .map(([kind, members]) => ({ label: labelOf(dependencyKindLabels, kind), members }))
    .sort((first, second) => first.label.localeCompare(second.label));
}

export function RepositoryDetail() {
  const { owner = '', name = '' } = useParams();
  const repo = `${owner}/${name}`;
  const { state, retry } = useApi((signal) => fetchRepoDetail(repo, signal), repo);
  const example = state.status === 'example';
  const detail = state.status === 'live' ? state.data : example ? exampleDetail(repo) : null;
  if (example && !detail) return <WorkspaceMissing />;

  const report = detail?.report;
  const filter = new URLSearchParams({ repo });
  return (
    <>
      <p className="runs-filter">
        <Link to="/app/repos">All repositories</Link>
      </p>
      <PageHeading
        title={repo}
        description={
          report
            ? `Last scanned ${formatDay(report.scannedAt)}.`
            : detail
              ? 'No finished scan yet.'
              : ''
        }
        example={example}
      />
      {state.status === 'example' && (
        <ExampleNote signedOut={state.signedOut} what="repository details" />
      )}
      {state.status === 'loading' && <ApiLoading what="this repository" />}
      {state.status === 'error' && (
        <ApiError what="this repository" message={state.message} retry={retry} />
      )}
      {detail && (
        <>
          <div className="detail-actions">
            <Link className="text-link" to={`/app?${filter}`}>
              What’s behind in this repository
              <ArrowRight />
            </Link>
            <Link className="text-link" to={`/app/runs?${filter}`}>
              Runs on this repository
              <ArrowRight />
            </Link>
          </div>
          {report && report.errors.length > 0 && <ScanErrors repo={repo} errors={report.errors} />}
          <Dependencies report={report ?? null} />
          <PullRequests pullRequests={detail.pullRequests} />
        </>
      )}
    </>
  );
}

function Dependencies({ report }: { report: ScanReport | null }) {
  const groups = groupByKind(report ? dependenciesWithFindings(report) : []);
  return (
    <section className="detail-section" aria-labelledby="dependencies-heading">
      <h2 id="dependencies-heading">Dependencies with findings</h2>
      <p>
        These are the dependencies a scan found something about. The full inventory isn’t available
        yet.
      </p>
      {!report && (
        <div className="empty-state">
          <ClockCounterClockwise size={30} />
          <h3>No scan yet</h3>
          <p>This repository hasn’t finished a scan, or the GitHub App isn’t installed on it.</p>
        </div>
      )}
      {report && groups.length === 0 && (
        <div className="empty-state">
          <CheckCircle size={30} />
          <h3>No findings</h3>
          <p>The last scan found no changes that touch this repository.</p>
        </div>
      )}
      {groups.map(({ label, members }) => (
        <div className="dependency-group" key={label}>
          <h3 id={`kind-${label}`}>{label}</h3>
          <div className="data-table-frame">
            <table className="data-table dependency-table" aria-labelledby={`kind-${label}`}>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Version</th>
                  <th scope="col">Declared in</th>
                </tr>
              </thead>
              <tbody>
                {members.map((dependency) => (
                  <tr key={`${dependency.name}:${dependency.version}`}>
                    <DataCell label="Name">
                      <code>{dependency.name}</code>
                    </DataCell>
                    <DataCell label="Version">
                      {dependency.version ? <code>{dependency.version}</code> : 'Unknown'}
                    </DataCell>
                    <DataCell label="Declared in">
                      {dependency.declaredIn.length === 0 && 'Not recorded'}
                      {dependency.declaredIn.map(({ file, line }) => (
                        <code key={`${file}:${line}`}>{line ? `${file}:${line}` : file}</code>
                      ))}
                    </DataCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function PullRequests({ pullRequests }: { pullRequests: RepoPullRequest[] }) {
  const open = pullRequests.filter((pullRequest) => pullRequest.state === 'open');
  return (
    <section className="detail-section" aria-labelledby="pull-requests-heading">
      <h2 id="pull-requests-heading">Open pull requests</h2>
      {open.length === 0 ? (
        <p>No open pull requests on this repository.</p>
      ) : (
        <div className="data-table-frame">
          <table className="data-table" aria-labelledby="pull-requests-heading">
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Dependency</th>
                <th scope="col">Target</th>
                <th scope="col">State</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {open.map((pullRequest) => (
                <tr key={pullRequest.url}>
                  <DataCell label="Pull request">
                    <ExternalLink
                      href={pullRequest.url}
                      label={`#${pullRequest.number} ${pullRequest.title} (opens in a new tab)`}
                    >
                      #{pullRequest.number} {pullRequest.title}
                    </ExternalLink>
                  </DataCell>
                  <DataCell label="Dependency">
                    {pullRequest.dependency ? <code>{pullRequest.dependency}</code> : 'Not given'}
                  </DataCell>
                  <DataCell label="Target">
                    {pullRequest.target ? <code>{pullRequest.target}</code> : 'Not given'}
                  </DataCell>
                  <DataCell label="State">{pullRequest.draft ? 'Draft' : 'Open'}</DataCell>
                  <DataCell label="Updated">{formatDay(pullRequest.updatedAt)}</DataCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

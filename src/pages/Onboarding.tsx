import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  CircleNotch,
  FolderSimple,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ScanReport } from '../../shared/types.ts';
import { ApiError, ApiLoading, ExampleNote, fetchReport, fetchRepos, useApi } from '../api';
import { Footer, Header } from '../components/Layout';
import { APP_INSTALL_URL } from '../data';
import { exampleReports, exampleRepos } from '../fixtures';
import './workspace.css';
import './onboarding.css';

export const SCAN_POLL_INTERVAL = 5000;

const steps = [
  { id: 'install', label: 'Install' },
  { id: 'repos', label: 'Choose repos' },
  { id: 'scan', label: 'First scan' },
] as const;

type StepId = (typeof steps)[number]['id'];
type RepoScan = { repo: string; report: ScanReport | null };

function stepFrom(parameters: URLSearchParams): StepId {
  const requested = steps.find((step) => step.id === parameters.get('step'));
  if (requested) return requested.id;
  // GitHub's install screen sends people back with this, and no `step`.
  return parameters.has('installation_id') ? 'repos' : 'install';
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function scanSummary(report: ScanReport) {
  const behind = report.items.filter(
    (item) => item.status === 'open' || item.status === 'pr-open',
  ).length;
  const found = behind ? `${counted(behind, 'item')} behind` : 'Nothing behind';
  return report.errors.length
    ? `${found}. ${counted(report.errors.length, 'thing')} couldn’t be read.`
    : `${found}.`;
}

async function fetchScans(signal: AbortSignal): Promise<RepoScan[]> {
  const repos = await fetchRepos(signal);
  return Promise.all(
    repos.map(async (repo) => ({ repo, report: await fetchReport(repo, signal) })),
  );
}

function StepHeading({
  title,
  description,
  example,
}: {
  title: string;
  description: string;
  example: boolean;
}) {
  return (
    <>
      {example && <span className="example-chip">Example data</span>}
      <h1>{title}</h1>
      <p className="onboarding-description">{description}</p>
    </>
  );
}

function NextLink({ to, primary }: { to: StepId; primary?: boolean }) {
  return (
    <Link
      className={`button ${primary ? 'button-primary' : 'button-secondary'}`}
      to={`?step=${to}`}
    >
      Next <ArrowRight />
    </Link>
  );
}

function ChangeReposLink() {
  return (
    <a
      className="button button-secondary"
      href={APP_INSTALL_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="Change repos on GitHub (opens in a new tab)"
    >
      Change repos on GitHub <ArrowUpRight />
    </a>
  );
}

function NoRepos() {
  return (
    <div className="empty-state">
      <FolderSimple size={30} />
      <h2>No repos yet</h2>
      <p>Refit can’t see any repos. Pick some on GitHub and they’ll show up here.</p>
    </div>
  );
}

function InstallStep() {
  return (
    <>
      <StepHeading
        title="Install the GitHub App"
        description="The app gets read and write access to code, pull requests and checks in the repos you pick. Refit only ever opens PRs."
        example={false}
      />
      <div className="onboarding-actions">
        {/* Same tab: GitHub sends people back here when the install finishes. */}
        <a className="button button-primary" href={APP_INSTALL_URL}>
          Install the GitHub App <ArrowUpRight />
        </a>
        <NextLink to="repos" />
      </div>
    </>
  );
}

function ReposStep() {
  const { state, retry } = useApi(fetchRepos, 'repos');
  const example = state.status === 'example';
  const repos = state.status === 'live' ? state.data : example ? exampleRepos : undefined;

  return (
    <>
      <StepHeading
        title="Choose repos"
        description="You choose repos on GitHub’s install screen, so changes to the list happen there."
        example={example}
      />
      {state.status === 'example' && <ExampleNote signedOut={state.signedOut} what="repos" />}
      {state.status === 'loading' && <ApiLoading what="repos" />}
      {state.status === 'error' && <ApiError what="repos" message={state.message} retry={retry} />}
      {repos?.length === 0 && <NoRepos />}
      {repos && repos.length > 0 && (
        <>
          {!example && (
            <p className="onboarding-count">Refit can see {counted(repos.length, 'repo')}.</p>
          )}
          <ul className="onboarding-repos" aria-label="Repos">
            {repos.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="onboarding-actions">
        <NextLink to="scan" primary />
        <ChangeReposLink />
      </div>
    </>
  );
}

function ScanStep() {
  const [round, setRound] = useState(0);
  const { state, retry } = useApi(fetchScans, String(round));
  // Each poll passes through `loading`; the last answer stays on screen until the next one lands.
  const [latest, setLatest] = useState<RepoScan[]>();

  useEffect(() => {
    if (state.status !== 'live') return;
    setLatest(state.data);
    if (state.data.length > 0 && state.data.every((scan) => scan.report)) return;
    const timer = setTimeout(() => setRound((count) => count + 1), SCAN_POLL_INTERVAL);
    return () => clearTimeout(timer);
  }, [state]);

  const example = state.status === 'example';
  const live =
    state.status === 'live' ? state.data : state.status === 'loading' ? latest : undefined;
  const scans = example ? exampleReports.map((report) => ({ repo: report.repo, report })) : live;
  const done = scans?.filter((scan) => scan.report).length ?? 0;
  const finished = scans !== undefined && scans.length > 0 && done === scans.length;
  const running = live !== undefined && live.length > 0 && !finished;

  let title = 'First scan';
  let description = 'Refit reads each repo and works out what it depends on.';
  if (example) {
    description = 'Nothing is scanning here. This is what a finished first scan looks like.';
  } else if (running) {
    title = 'First scan running';
    description += ' Repos fill in as they finish.';
  } else if (finished) {
    title = 'First scan done';
    description = 'Every repo has been scanned.';
  }

  return (
    <>
      <StepHeading title={title} description={description} example={example} />
      {state.status === 'example' && (
        <ExampleNote signedOut={state.signedOut} what="scan results" />
      )}
      {state.status === 'loading' && !latest && <ApiLoading what="scan status" />}
      {state.status === 'error' && (
        <ApiError what="scan status" message={state.message} retry={retry} />
      )}
      {scans?.length === 0 && <NoRepos />}
      {scans && scans.length > 0 && (
        <>
          {!example && (
            <p className="onboarding-count" role="status">
              {done} of {counted(scans.length, 'repo')} scanned.
            </p>
          )}
          <ul className="onboarding-repos" aria-label="Scan status">
            {scans.map(({ repo, report }) => (
              <li key={repo}>
                <div>
                  <code>{repo}</code>
                  {report && <p>{scanSummary(report)}</p>}
                </div>
                {report ? (
                  <span className="resource-status status-positive">
                    <CheckCircle /> Scan done
                  </span>
                ) : (
                  <span className="resource-status scan-running">
                    <CircleNotch /> Scanning
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="onboarding-actions">
        <Link className={`button ${finished ? 'button-primary' : 'button-secondary'}`} to="/app">
          See what’s behind <ArrowRight />
        </Link>
      </div>
    </>
  );
}

const stepViews: Record<StepId, () => ReactNode> = {
  install: InstallStep,
  repos: ReposStep,
  scan: ScanStep,
};

export function Onboarding() {
  const [parameters] = useSearchParams();
  const current = stepFrom(parameters);
  const CurrentStep = stepViews[current];
  const main = useRef<HTMLElement>(null);
  const shown = useRef(current);

  // The link that was pressed is gone after a step change, so focus would fall back to the page.
  useEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    main.current?.focus();
  }, [current]);

  return (
    <>
      <Header />
      <div className="onboarding-layout content-width">
        <nav className="onboarding-steps" aria-label="Onboarding steps">
          <ol>
            {steps.map((step, index) => (
              <li key={step.id}>
                <Link
                  to={`?step=${step.id}`}
                  aria-current={step.id === current ? 'step' : undefined}
                >
                  <span>{index + 1}</span> {step.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <main id="main-content" className="onboarding-content" ref={main} tabIndex={-1}>
          <CurrentStep />
        </main>
      </div>
      <Footer />
    </>
  );
}

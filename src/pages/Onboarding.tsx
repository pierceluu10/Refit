import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  CircleNotch,
  Clock,
  FolderSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ScanState, ScanView } from '../../app/api/scans.ts';
import type { ScanReport } from '../../shared/types.ts';
import {
  ApiError,
  ApiLoading,
  ApiNotFoundError,
  ExampleNote,
  fetchApi,
  isList,
  useApi,
} from '../api';
import type { ApiState } from '../api';
import { Footer, Header } from '../components/Layout';
import { APP_INSTALL_URL } from '../data';
import { exampleReports, exampleRepos } from '../fixtures';
import './workspace.css';
import './onboarding.css';

export const SCAN_POLL_INTERVAL = 5000;
const FINDINGS_SHOWN = 3;
const INSTALLATION_PARAMETER = 'installation_id';
const REQUESTED_INSTALL = 'request';

const steps = [
  { id: 'install', label: 'Install' },
  { id: 'repos', label: 'Choose repos' },
  { id: 'scan', label: 'First scan' },
] as const;

type StepId = (typeof steps)[number]['id'];

function stepFrom(parameters: URLSearchParams): StepId {
  const requested = steps.find((step) => step.id === parameters.get('step'));
  if (requested) return requested.id;
  // GitHub's install screen sends people back with this, and no `step`. They already chose repos there.
  return parameters.has(INSTALLATION_PARAMETER) ? 'scan' : 'install';
}

function useInstallationId() {
  return useSearchParams()[0].get(INSTALLATION_PARAMETER);
}

function stepLink(step: StepId, installationId: string | null) {
  const query = new URLSearchParams({ step });
  if (installationId) query.set(INSTALLATION_PARAMETER, installationId);
  return `?${query}`;
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function behindItems(report: ScanReport) {
  return report.items.filter((item) => item.status === 'open' || item.status === 'pr-open');
}

function scanSummary(report: ScanReport) {
  const behind = behindItems(report).length;
  if (behind === 0 && report.errors.length > 0) {
    return `No findings, but ${counted(report.errors.length, 'thing')} couldn’t be read.`;
  }
  const found = behind ? `${counted(behind, 'item')} behind` : 'Nothing behind';
  return report.errors.length
    ? `${found}. ${counted(report.errors.length, 'thing')} couldn’t be read.`
    : `${found}.`;
}

async function fetchScans(installationId: string | null, signal: AbortSignal): Promise<ScanView[]> {
  const query = installationId
    ? `?${new URLSearchParams({ installation_id: installationId })}`
    : '';
  try {
    return await fetchApi(`/api/scans${query}`, isList<ScanView>, signal);
  } catch (error) {
    if (error instanceof ApiNotFoundError) {
      throw new Error('GitHub doesn’t know this installation. It may have been removed.');
    }
    throw error;
  }
}

// Someone GitHub just sent here has a real install, so made-up repos would be a false answer.
function realOnly<T>(state: ApiState<T>, installationId: string | null): ApiState<T> {
  if (state.status !== 'example' || installationId === null) return state;
  return {
    status: 'error',
    message: state.signedOut
      ? 'Your scan needs a GitHub sign-in, which isn’t available yet.'
      : 'No Refit API is reachable from this site.',
  };
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
  const installationId = useInstallationId();
  return (
    <Link
      className={`button ${primary ? 'button-primary' : 'button-secondary'}`}
      to={stepLink(to, installationId)}
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
  const [parameters] = useSearchParams();
  if (parameters.get('setup_action') === REQUESTED_INSTALL) {
    return (
      <StepHeading
        title="Waiting for an org owner"
        description="Your request to install Refit went to an owner of the org on GitHub. The first scan starts once they approve it."
        example={false}
      />
    );
  }
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
  const installationId = useInstallationId();
  const { state: answer, retry } = useApi((signal) => fetchScans(installationId, signal), 'repos');
  const state = realOnly(answer, installationId);
  const example = state.status === 'example';
  const repos =
    state.status === 'live'
      ? state.data.map((scan) => scan.repo)
      : example
        ? exampleRepos
        : undefined;

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

const isSettled = (state: ScanState) => state === 'done' || state === 'failed';

function ScanChip({ state }: { state: ScanState }) {
  if (state === 'done') {
    return (
      <span className="resource-status status-positive">
        <CheckCircle /> Scan done
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="resource-status status-negative">
        <WarningCircle /> Scan failed
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span className="resource-status scan-running">
        <CircleNotch /> Scanning
      </span>
    );
  }
  return (
    <span className="resource-status">
      <Clock /> {state === 'queued' ? 'Queued' : 'Not queued yet'}
    </span>
  );
}

function ScanDetail({ report, state }: { report?: ScanReport; state: ScanState }) {
  if (!report || !isSettled(state)) return null;
  if (state === 'failed') return <p>{report.errors[0]}</p>;
  return (
    <>
      <p>{scanSummary(report)}</p>
      {behindItems(report)
        .slice(0, FINDINGS_SHOWN)
        .map((item) => (
          <p className="onboarding-finding" key={`${item.change.id}-${item.dependency.name}`}>
            {item.change.title}
          </p>
        ))}
    </>
  );
}

function ScanStep() {
  const installationId = useInstallationId();
  const [round, setRound] = useState(0);
  const { state: answer, retry } = useApi(
    (signal) => fetchScans(installationId, signal),
    String(round),
  );
  const state = realOnly(answer, installationId);
  // Each poll passes through `loading`; the last answer stays on screen until the next one lands.
  const [latest, setLatest] = useState<ScanView[]>();

  useEffect(() => {
    if (answer.status !== 'live') return;
    setLatest(answer.data);
    if (answer.data.length > 0 && answer.data.every((scan) => isSettled(scan.state))) return;
    const timer = setTimeout(() => setRound((count) => count + 1), SCAN_POLL_INTERVAL);
    return () => clearTimeout(timer);
  }, [answer]);

  const example = state.status === 'example';
  const live =
    state.status === 'live' ? state.data : state.status === 'loading' ? latest : undefined;
  const scans: ScanView[] | undefined = example
    ? exampleReports.map((report) => ({ repo: report.repo, state: 'done', report }))
    : live;
  const count = (wanted: ScanState) => scans?.filter((scan) => scan.state === wanted).length ?? 0;
  const done = count('done');
  const failed = count('failed');
  const finished = scans !== undefined && scans.length > 0 && done + failed === scans.length;
  const hasRepos = live !== undefined && live.length > 0;

  let title = 'First scan';
  let description = 'Refit reads each repo and works out what it depends on.';
  if (example) {
    description = 'Nothing is scanning here. This is what a finished first scan looks like.';
  } else if (finished) {
    title = 'First scan done';
    description = failed
      ? 'Some repos couldn’t be scanned. Refit will try them again on the next push.'
      : 'Every repo has been scanned.';
  } else if (hasRepos && count('running') > 0) {
    title = 'First scan running';
    description += ' Repos fill in as they finish.';
  } else if (hasRepos && count('queued') > 0) {
    title = 'First scan queued';
    description += ' It starts as soon as a slot is free.';
  } else if (hasRepos) {
    title = 'Waiting for the first scan';
    description =
      'Refit is waiting for GitHub to report the install. A repo with paused: true in its .refit.yml stays here.';
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
              {done} of {counted(scans.length, 'repo')} scanned
              {failed > 0 && `, ${failed} failed`}.
            </p>
          )}
          <ul className="onboarding-repos" aria-label="Scan status">
            {scans.map(({ repo, report, state: scanState }) => (
              <li key={repo}>
                <div>
                  <code>{repo}</code>
                  <ScanDetail report={report} state={scanState} />
                </div>
                <ScanChip state={scanState} />
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
  const installationId = parameters.get(INSTALLATION_PARAMETER);
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
                  to={stepLink(step.id, installationId)}
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

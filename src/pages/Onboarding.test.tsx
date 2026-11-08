import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanState } from '../../app/api/scans.ts';
import type { BehindItem, ScanReport } from '../../shared/types.ts';
import { APP_INSTALL_URL } from '../data';
import { exampleReports, exampleRepos } from '../fixtures';
import { Onboarding, SCAN_POLL_INTERVAL } from './Onboarding';

const repoA = 'test-owner/app';
const repoB = 'test-owner/api';

function item(status: BehindItem['status']): BehindItem {
  return {
    repo: repoA,
    status,
    dependency: { repo: repoA, kind: 'runtime', name: 'node', declaredIn: [] },
    change: {
      provider: 'node',
      id: `test-change-${status}`,
      kind: 'runtime-eol',
      title: 'Test change',
      source: { url: 'https://example.com/test', quote: 'Test quote.' },
      affects: {},
      dependencyKind: 'runtime',
      dependency: 'node',
    },
  };
}

function report(repo: string, items: BehindItem[] = [], errors: string[] = []): ScanReport {
  return { repo, scannedAt: '2026-11-05T12:00:00Z', items, costUsd: 0, errors };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Answers like /api/scans: a repo with a report is done, and one without is still running.
function liveApi(
  repos: string[],
  reports: Record<string, ScanReport> = {},
  states: Record<string, ScanState> = {},
) {
  return vi.fn(async (_path: string) =>
    json(
      repos.map((repo) => ({
        repo,
        state: states[repo] ?? (reports[repo] ? 'done' : 'running'),
        ...(reports[repo] && { report: reports[repo] }),
      })),
    ),
  );
}

// What a deployed site answers: index.html for everything.
function staticSite() {
  return vi.fn(
    async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
  );
}

function renderAt(search: string, fetcher: ReturnType<typeof vi.fn> = staticSite()) {
  vi.stubGlobal('fetch', fetcher);
  return render(
    <MemoryRouter initialEntries={[`/onboarding${search}`]}>
      <Onboarding />
    </MemoryRouter>,
  );
}

function currentStep() {
  return screen
    .getByRole('navigation', { name: 'Onboarding steps' })
    .querySelector('[aria-current="step"]')?.textContent;
}

function behindLink() {
  return screen.getByRole('link', { name: 'See what’s behind' });
}

function listedRepos(name: string) {
  return within(screen.getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('code')?.textContent);
}

// Flushes the mocked responses without waiting on real time.
async function advance(milliseconds = 0) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('onboarding steps', () => {
  it.each([
    ['', '1 Install', 'Install the GitHub App'],
    ['?step=install', '1 Install', 'Install the GitHub App'],
    ['?step=repos', '2 Choose repos', 'Choose repos'],
    ['?step=scan', '3 First scan', 'First scan'],
    ['?step=nonsense', '1 Install', 'Install the GitHub App'],
  ])('renders the step from the URL %s', async (search, label, heading) => {
    renderAt(search);
    expect(currentStep()).toBe(label);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeVisible();
  });

  it.each([
    '?installation_id=123&setup_action=install',
    '?installation_id=123&setup_action=update',
  ])('sends GitHub returning with %s to the first scan of that install', async (search) => {
    const fetcher = liveApi([repoA]);
    renderAt(search, fetcher);
    expect(currentStep()).toBe('3 First scan');
    expect(await screen.findByRole('list', { name: 'Scan status' })).toBeVisible();
    expect(fetcher.mock.calls[0][0]).toBe('/api/scans?installation_id=123');
  });

  it('keeps the installation when moving between steps', async () => {
    const fetcher = liveApi([repoA]);
    renderAt('?step=repos&installation_id=123', fetcher);
    await screen.findByRole('list', { name: 'Repos' });
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    await screen.findByRole('list', { name: 'Scan status' });
    expect(fetcher.mock.lastCall?.[0]).toBe('/api/scans?installation_id=123');
  });

  it('tells someone whose install needs approval to wait for an owner', () => {
    renderAt('?setup_action=request');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Waiting for an org owner' }),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Install the GitHub App' })).not.toBeInTheDocument();
  });

  it('walks forward with Next and moves focus to the new step', async () => {
    renderAt('');
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    expect(currentStep()).toBe('2 Choose repos');
    expect(screen.getByRole('main')).toHaveFocus();
    await screen.findByRole('list', { name: 'Repos' });
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    expect(currentStep()).toBe('3 First scan');
    await screen.findByRole('list', { name: 'Scan status' });
  });

  it('does not take focus on first load', () => {
    renderAt('?step=repos');
    expect(screen.getByRole('main')).not.toHaveFocus();
  });
});

describe('install step', () => {
  it('links to GitHub, says what the app can see and asks the API nothing', () => {
    const fetcher = staticSite();
    renderAt('', fetcher);
    const link = screen.getByRole('link', { name: 'Install the GitHub App' });
    expect(link).toHaveAttribute('href', APP_INSTALL_URL);
    expect(link).toHaveAttribute('href', 'https://github.com/apps/refit-agent/installations/new');
    expect(link).toHaveClass('button-primary');
    expect(screen.getByText(/code, pull requests and checks in the repos you pick/)).toBeVisible();
    expect(screen.getByText(/Refit only ever opens PRs/)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('claims no connection', () => {
    renderAt('');
    expect(screen.getByRole('main').textContent).not.toMatch(/connected|installed/i);
  });
});

describe('choose repos step', () => {
  it('lists the repos the API can see, unlabelled, with a link out to GitHub', async () => {
    renderAt('?step=repos', liveApi([repoA, repoB]));
    expect(screen.getByRole('status')).toHaveTextContent('Loading repos…');
    await screen.findByRole('list', { name: 'Repos' });
    expect(listedRepos('Repos')).toEqual([repoA, repoB]);
    expect(screen.getByText('Refit can see 2 repos.')).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Change repos on GitHub/ })).toHaveAttribute(
      'href',
      APP_INSTALL_URL,
    );
  });

  it('never renders controls that pretend to change the selection', async () => {
    renderAt('?step=repos', liveApi([repoA]));
    await screen.findByRole('list', { name: 'Repos' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('labels example repos when no API is reachable and claims nothing is connected', async () => {
    renderAt('?step=repos');
    await screen.findByRole('list', { name: 'Repos' });
    expect(listedRepos('Repos')).toEqual(exampleRepos);
    expect(screen.getByText('Example data')).toHaveClass('example-chip');
    expect(screen.getByText(/No Refit API is reachable/)).toBeVisible();
    expect(screen.queryByText(/Refit can see/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('labels example repos when signed out', async () => {
    renderAt(
      '?step=repos',
      vi.fn(async () => json({ error: 'unauthorized' }, 401)),
    );
    await screen.findByRole('list', { name: 'Repos' });
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/need a GitHub sign-in/)).toBeVisible();
  });

  it('says so when the API can see no repos', async () => {
    renderAt('?step=repos', liveApi([]));
    expect(await screen.findByRole('heading', { name: 'No repos yet' })).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      .mockResolvedValueOnce(json([{ repo: repoA, state: 'waiting' }]));
    renderAt('?step=repos', fetcher);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The API answered 500.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list', { name: 'Repos' });
    expect(listedRepos('Repos')).toEqual([repoA]);
  });
});

describe('first scan step', () => {
  it('moves a repo from scanning to done across a poll, then stops polling', async () => {
    vi.useFakeTimers();
    const reports: Record<string, ScanReport> = {
      [repoA]: report(repoA, [item('open'), item('pr-open')]),
    };
    const fetcher = liveApi([repoA, repoB], reports);
    renderAt('?step=scan', fetcher);
    await advance();

    expect(screen.getByRole('heading', { level: 1, name: 'First scan running' })).toBeVisible();
    expect(screen.getByText('1 of 2 repos scanned.')).toBeVisible();
    const [first, second] = within(screen.getByRole('list', { name: 'Scan status' })).getAllByRole(
      'listitem',
    );
    expect(first).toHaveTextContent('Scan done');
    expect(first).toHaveTextContent('2 items behind.');
    expect(second).toHaveTextContent('Scanning');
    expect(behindLink()).toHaveClass('button-secondary');

    // Still scanning just before the interval ends, so nothing has been asked again.
    const callsBefore = fetcher.mock.calls.length;
    await advance(SCAN_POLL_INTERVAL - 1);
    expect(fetcher.mock.calls.length).toBe(callsBefore);
    expect(screen.getByText('Scanning')).toBeVisible();

    reports[repoB] = report(repoB);
    await advance(1);

    expect(screen.getByRole('heading', { level: 1, name: 'First scan done' })).toBeVisible();
    expect(screen.getByText('2 of 2 repos scanned.')).toBeVisible();
    expect(screen.queryByText('Scanning')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing behind.')).toBeVisible();
    expect(behindLink()).toHaveClass('button-primary');
    expect(behindLink()).toHaveAttribute('href', '/app');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the rows on screen while a poll is in flight', async () => {
    vi.useFakeTimers();
    renderAt('?step=scan', liveApi([repoA]));
    await advance();
    await act(() => vi.advanceTimersToNextTimerAsync());
    expect(screen.getByRole('list', { name: 'Scan status' })).toBeVisible();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it('clears the poll timer on unmount', async () => {
    vi.useFakeTimers();
    const fetcher = liveApi([repoA]);
    const { unmount } = renderAt('?step=scan', fetcher);
    await advance();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SCAN_POLL_INTERVAL * 3);
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it('aborts a request in flight on unmount', () => {
    const fetcher = vi.fn((_path: string, _init: RequestInit) => new Promise<Response>(() => {}));
    const { unmount } = renderAt('?step=scan', fetcher);
    const { signal } = fetcher.mock.calls[0][1];
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('counts only open items as behind and reports what could not be read', async () => {
    const reports = {
      [repoA]: report(repoA, [item('open'), item('merged'), item('not-affected')], ['bad file']),
    };
    renderAt('?step=scan', liveApi([repoA], reports));
    expect(await screen.findByText('1 item behind. 1 thing couldn’t be read.')).toBeVisible();
  });

  it('shows labelled example results and never implies a scan is running', async () => {
    vi.useFakeTimers();
    const fetcher = staticSite();
    renderAt('?step=scan', fetcher);
    await advance();

    expect(screen.getByText('Example data')).toHaveClass('example-chip');
    expect(screen.getByText(/No Refit API is reachable/)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'First scan' })).toBeVisible();
    expect(screen.getByText(/Nothing is scanning here/)).toBeVisible();
    expect(listedRepos('Scan status')).toEqual(exampleReports.map((example) => example.repo));
    expect(screen.queryByText('Scanning')).not.toBeInTheDocument();
    expect(screen.queryByText(/of \d+ repos? scanned/)).not.toBeInTheDocument();

    const calls = fetcher.mock.calls.length;
    await advance(SCAN_POLL_INTERVAL * 3);
    expect(fetcher.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims no scan when the API can see no repos, and keeps looking for them', async () => {
    vi.useFakeTimers();
    const repos: string[] = [];
    renderAt('?step=scan', liveApi(repos));
    await advance();
    expect(screen.getByRole('heading', { level: 1, name: 'First scan' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No repos yet' })).toBeVisible();
    expect(behindLink()).toHaveClass('button-secondary');

    repos.push(repoA);
    await advance(SCAN_POLL_INTERVAL);
    expect(screen.getByRole('heading', { level: 1, name: 'First scan running' })).toBeVisible();
  });

  it('shows an error when a poll fails, keeps the link to /app and recovers on retry', async () => {
    vi.useFakeTimers();
    const fetcher = liveApi([repoA]);
    renderAt('?step=scan', fetcher);
    await advance();

    fetcher.mockImplementationOnce(async () => json({ error: 'boom' }, 500));
    await advance(SCAN_POLL_INTERVAL);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The API answered 500.');
    expect(screen.getByRole('heading', { level: 1, name: 'First scan' })).toBeVisible();
    expect(behindLink()).toHaveAttribute('href', '/app');
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await advance();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'First scan running' })).toBeVisible();
  });

  it('walks one repo through waiting, queued, running and findings on real answers', async () => {
    vi.useFakeTimers();
    const states: Record<string, ScanState> = { [repoA]: 'waiting' };
    const reports: Record<string, ScanReport> = {};
    renderAt('?installation_id=123', liveApi([repoA], reports, states));
    await advance();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Waiting for the first scan' }),
    ).toBeVisible();
    expect(screen.getByText('Not queued yet')).toBeVisible();

    states[repoA] = 'queued';
    await advance(SCAN_POLL_INTERVAL);
    expect(screen.getByRole('heading', { level: 1, name: 'First scan queued' })).toBeVisible();
    expect(screen.getByText('Queued')).toBeVisible();

    states[repoA] = 'running';
    await advance(SCAN_POLL_INTERVAL);
    expect(screen.getByRole('heading', { level: 1, name: 'First scan running' })).toBeVisible();
    expect(screen.getByText('Scanning')).toBeVisible();

    states[repoA] = 'done';
    reports[repoA] = report(repoA, [item('open')]);
    await advance(SCAN_POLL_INTERVAL);
    expect(screen.getByRole('heading', { level: 1, name: 'First scan done' })).toBeVisible();
    expect(screen.getByText('1 item behind.')).toBeVisible();
    expect(screen.getByText('Test change')).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a failed scan as failed and stops polling', async () => {
    vi.useFakeTimers();
    const reports = { [repoA]: report(repoA, [], ['The scan couldn’t finish: clone failed']) };
    renderAt('?step=scan', liveApi([repoA], reports, { [repoA]: 'failed' }));
    await advance();
    expect(screen.getByText('Scan failed')).toBeVisible();
    expect(screen.getByText('The scan couldn’t finish: clone failed')).toBeVisible();
    expect(screen.getByText('0 of 1 repo scanned, 1 failed.')).toBeVisible();
    expect(screen.queryByText(/Nothing behind/)).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never says nothing is behind when a clean-looking scan could not read things', async () => {
    renderAt('?step=scan', liveApi([repoA], { [repoA]: report(repoA, [], ['bad file']) }));
    expect(await screen.findByText('No findings, but 1 thing couldn’t be read.')).toBeVisible();
  });

  it('never shows example repos to someone GitHub just sent here', async () => {
    renderAt('?installation_id=123');
    expect(await screen.findByRole('alert')).toHaveTextContent('No Refit API is reachable');
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Scan status' })).not.toBeInTheDocument();
  });

  it('says so when GitHub does not know the installation', async () => {
    renderAt(
      '?installation_id=123',
      vi.fn(async () => json({ error: 'GitHub has no such installation' }, 404)),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub doesn’t know this installation',
    );
  });

  it('offers the link to /app while still loading', () => {
    renderAt(
      '?step=scan',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading scan status…');
    expect(behindLink()).toHaveAttribute('href', '/app');
    expect(behindLink()).toHaveClass('button-secondary');
  });
});

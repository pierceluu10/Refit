import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { RunView } from '../../shared/types.ts';
import { App } from '../App';
import { runs as exampleRuns } from '../fixtures';

const liveRuns: RunView[] = [
  {
    id: 'run-1',
    repo: 'test-owner/app',
    taskId: 'task-1',
    provider: 'stripe',
    changeId: 'test-change-verified',
    outcome: 'verified',
    pr: 'https://github.com/test-owner/app/pull/7',
    costUsd: 0.5,
    summary: 'Test summary for a verified run.',
    finishedAt: '2026-10-31T12:00:00Z',
  },
  {
    id: 'run-2',
    repo: 'test-owner/app',
    taskId: 'task-2',
    provider: 'test-provider',
    changeId: 'test-change-failed',
    outcome: 'failed',
    costUsd: 2,
    summary: 'Test summary for a failed run.',
    finishedAt: '2026-10-31T11:00:00Z',
  },
  {
    id: 'run-3',
    repo: 'test-owner/other',
    taskId: 'task-3',
    provider: 'stripe',
    changeId: 'test-change-review',
    outcome: 'needs-review',
    pr: 'https://github.com/test-owner/other/pull/2',
    costUsd: 1.25,
    summary: 'Test summary for a needs-review run.',
    finishedAt: '2026-10-30T10:00:00Z',
  },
  {
    id: 'run-4',
    repo: 'test-owner/other',
    taskId: 'task-4',
    provider: 'stripe',
    changeId: 'test-change-unaffected',
    outcome: 'not-affected',
    costUsd: 0.1,
    summary: 'Test summary for a not-affected run.',
    finishedAt: '2026-10-30T09:00:00Z',
  },
];

function respond(body: unknown, status = 200, contentType = 'application/json') {
  return vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  );
}

function renderRuns(fetcher: ReturnType<typeof vi.fn>, path = '/app/runs') {
  vi.stubGlobal('fetch', fetcher);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function rows() {
  return within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem');
}

describe('runs', () => {
  it('renders each run from the API without the example label', async () => {
    const fetcher = respond(liveRuns);
    renderRuns(fetcher);
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs…');
    await screen.findByRole('list', { name: 'Runs' });
    expect(fetcher).toHaveBeenCalledWith('/api/runs?limit=50', expect.anything());
    expect(rows()).toHaveLength(liveRuns.length);
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    const first = rows()[0];
    expect(within(first).getByText('Stripe')).toBeVisible();
    expect(within(first).getByText('test-change-verified')).toBeVisible();
    expect(within(first).getByText('Test summary for a verified run.')).toBeVisible();
    expect(within(first).getByText(/\$0\.50/)).toBeVisible();
    expect(within(first).getByText(/test-owner\/app/, { selector: '.run-meta' })).toBeVisible();
    expect(first.querySelector('time')).toHaveAttribute('dateTime', '2026-10-31T12:00:00Z');
  });

  it('labels every outcome in text, not colour alone', async () => {
    renderRuns(respond(liveRuns));
    await screen.findByRole('list', { name: 'Runs' });
    const labels = rows().map((row) => row.querySelector('.resource-status')?.textContent);
    expect(labels).toEqual(['Verified', 'Failed', 'Needs review', 'Not affected']);
  });

  it('shows an unknown provider by its raw name', async () => {
    renderRuns(respond(liveRuns));
    await screen.findByRole('list', { name: 'Runs' });
    expect(within(rows()[1]).getByText('test-provider')).toBeVisible();
  });

  it('links a pull request only when the run has one', async () => {
    renderRuns(respond(liveRuns));
    await screen.findByRole('list', { name: 'Runs' });
    const links = screen.getAllByRole('link', { name: /^Pull request/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      liveRuns.filter((run) => run.pr).map((run) => run.pr),
    );
    expect(links[0]).toHaveAccessibleName(
      'Pull request for test-change-verified on test-owner/app (opens in a new tab)',
    );
    expect(within(rows()[1]).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a pull request address that is not a web address as plain text', async () => {
    const pr = 'javascript:alert(1)';
    renderRuns(respond([{ ...liveRuns[0], pr }]));
    await screen.findByRole('list', { name: 'Runs' });
    expect(screen.queryByRole('link', { name: /^Pull request/ })).not.toBeInTheDocument();
    expect(screen.getByText('Pull request')).toBeVisible();
  });

  it('asks the API for one repository from a deep link', async () => {
    const fetcher = respond(liveRuns.slice(0, 2));
    renderRuns(fetcher, '/app/runs?repo=test-owner%2Fapp');
    await screen.findByRole('list', { name: 'Runs' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/runs?limit=50&repo=test-owner%2Fapp',
      expect.anything(),
    );
    expect(screen.getByRole('link', { name: 'All repositories' })).toHaveAttribute(
      'href',
      '/app/runs',
    );
  });

  it('says there are no runs yet when the API returns none', async () => {
    renderRuns(respond([]));
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the API is unreachable', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(liveRuns), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    renderRuns(fetcher);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Failed to fetch/)).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    within(alert).getByRole('button', { name: 'Try again' }).click();
    await screen.findByRole('list', { name: 'Runs' });
    expect(rows()).toHaveLength(liveRuns.length);
  });

  it('shows an error when the API fails', async () => {
    renderRuns(respond({ error: 'boom' }, 500));
    expect(await screen.findByRole('alert')).toHaveTextContent('The API answered 500.');
  });

  it('shows an error when the API returns something other than a list', async () => {
    renderRuns(respond({ runs: [] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('something unexpected');
  });

  it.each([
    [
      'a static deploy falls back to index.html',
      () => respond('<!doctype html>', 200, 'text/html'),
    ],
    ['the path is not served', () => respond('Not found', 404, 'text/plain')],
  ])('falls back to labelled example runs when %s', async (_, fetcher) => {
    renderRuns(fetcher());
    await screen.findByRole('list', { name: 'Runs' });
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/No Refit API is reachable/)).toBeVisible();
    expect(rows()).toHaveLength(exampleRuns.length);
  });

  it('falls back to example runs when signed out', async () => {
    renderRuns(respond({ error: 'unauthorized' }, 401));
    await screen.findByRole('list', { name: 'Runs' });
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/need a GitHub sign-in/)).toBeVisible();
  });

  it('filters example runs by repository', async () => {
    const repo = exampleRuns[0].repo;
    renderRuns(
      respond('<!doctype html>', 200, 'text/html'),
      `/app/runs?repo=${encodeURIComponent(repo)}`,
    );
    await screen.findByRole('list', { name: 'Runs' });
    expect(rows()).toHaveLength(exampleRuns.filter((run) => run.repo === repo).length);
  });
});

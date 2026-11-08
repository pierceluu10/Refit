import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BehindItem, DependencyUsage, ScanReport } from '../../shared/types.ts';
import { App } from '../App';
import {
  examplePullRequests,
  exampleReports,
  exampleRepos,
  type RepoPullRequest,
} from '../fixtures';

const json = { 'content-type': 'application/json' };
const REPO = 'test-owner/app';

function dependency(
  name: string,
  kind: DependencyUsage['kind'],
  version = '1.0.0',
): DependencyUsage {
  return {
    repo: REPO,
    kind,
    name,
    version,
    declaredIn: [{ file: `${name}.lock`, line: 7 }, { file: 'no-line.txt' }],
  };
}

function item(
  usage: DependencyUsage,
  id: string,
  status: BehindItem['status'] = 'open',
): BehindItem {
  return {
    repo: REPO,
    dependency: usage,
    change: {
      provider: 'test-provider',
      id,
      kind: 'dependency-major',
      title: `${id} title`,
      source: { url: `https://source.test/${id}`, quote: 'test quote' },
      affects: {},
      dependency: usage.name,
      dependencyKind: usage.kind,
    },
    status,
  };
}

function report(items: BehindItem[], errors: string[] = []): ScanReport {
  return { repo: REPO, scannedAt: '2026-10-15T00:00:00Z', items, costUsd: 0, errors };
}

function pullRequest(number: number, overrides: Partial<RepoPullRequest> = {}): RepoPullRequest {
  return {
    repo: REPO,
    title: `Change ${number}`,
    url: `https://github.test/pull/${number}`,
    state: 'open',
    number,
    draft: false,
    updatedAt: '2026-10-20T00:00:00Z',
    ...overrides,
  };
}

function api(reportBody: ScanReport | null, pullRequests: RepoPullRequest[] = []) {
  return vi.fn(async (path: string) => {
    if (path.startsWith('/api/prs')) {
      return new Response(JSON.stringify(pullRequests), { headers: json });
    }
    return reportBody
      ? new Response(JSON.stringify(reportBody), { headers: json })
      : new Response(JSON.stringify({ error: 'no scan' }), { status: 404, headers: json });
  });
}

function renderPath(path: string, fetcher: unknown) {
  vi.stubGlobal('fetch', fetcher);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const noApi = () => vi.fn().mockResolvedValue(new Response('<!doctype html>'));
const detailPath = `/app/repos/${REPO}`;

describe('repositories list', () => {
  it('lists each live repo with a link, its unresolved count and its last scan', async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === '/api/repos') {
        return new Response(JSON.stringify([REPO, 'test-owner/fresh']), { headers: json });
      }
      if (path.startsWith('/api/runs')) return new Response('[]', { headers: json });
      if (path.includes('fresh')) {
        return new Response(JSON.stringify({ error: 'no scan' }), { status: 404, headers: json });
      }
      const usage = dependency('lib', 'library');
      return new Response(
        JSON.stringify(
          report([
            item(usage, 'one', 'open'),
            item(usage, 'two', 'pr-open'),
            item(usage, 'three', 'merged'),
            item(usage, 'four', 'not-affected'),
          ]),
        ),
        { headers: json },
      );
    });
    renderPath('/app/repos', fetcher);
    const scanned = (await screen.findByRole('link', { name: REPO })).closest('tr') as HTMLElement;
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(within(scanned).getByRole('link', { name: REPO })).toHaveAttribute('href', detailPath);
    expect(scanned.querySelector('[data-label="Open findings"]')).toHaveTextContent(/^2$/);
    expect(scanned.querySelector('[data-label="Last scan"]')).toHaveTextContent('2026');

    const fresh = screen
      .getByRole('link', { name: 'test-owner/fresh' })
      .closest('tr') as HTMLElement;
    expect(within(fresh).getByText('No scan yet')).toBeVisible();
  });

  it('shows what each scan cost, its errors and how much is waiting on budget', async () => {
    const usage = dependency('lib', 'library');
    const held = item(usage, 'one', 'open');
    const heldRun = {
      id: 'run',
      repo: REPO,
      taskId: 'task',
      provider: 'test',
      changeId: held.change.id,
      outcome: 'waiting-budget',
      costUsd: 0,
      summary: 'Test summary.',
      finishedAt: '2026-11-01T00:00:00Z',
    };
    const fetcher = vi.fn(async (path: string) => {
      if (path === '/api/repos') return new Response(JSON.stringify([REPO]), { headers: json });
      if (path.startsWith('/api/runs')) {
        return new Response(JSON.stringify([heldRun]), { headers: json });
      }
      const body = {
        ...report([held, item(usage, 'two', 'open')], ['first', 'second']),
        costUsd: 1.46,
      };
      return new Response(JSON.stringify(body), { headers: json });
    });
    renderPath('/app/repos', fetcher);
    const row = (await screen.findByRole('link', { name: REPO })).closest('tr') as HTMLElement;
    expect(row.querySelector('[data-label="Open findings"]')).toHaveTextContent(
      /^2\s*1 waiting on budget$/,
    );
    expect(row.querySelector('[data-label="Open findings"]')).not.toHaveTextContent('failed');
    expect(row.querySelector('[data-label="Scan cost"]')).toHaveTextContent('$1.46');
    expect(row.querySelector('[data-label="Scan errors"]')).toHaveTextContent(/^2$/);
  });

  it('points to onboarding when there are no repositories', async () => {
    renderPath(
      '/app/repos',
      vi.fn(async () => new Response('[]', { headers: json })),
    );
    expect(await screen.findByRole('link', { name: 'Install the GitHub App' })).toHaveAttribute(
      'href',
      '/onboarding',
    );
  });

  it('labels the example list', async () => {
    renderPath('/app/repos', noApi());
    for (const repo of exampleRepos)
      expect(await screen.findByRole('link', { name: repo })).toBeVisible();
    expect(screen.getByText('Example data')).toBeVisible();
  });

  it('highlights Repositories in the navigation on the list and on a detail page', async () => {
    const { unmount } = renderPath('/app/repos', noApi());
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Repositories' })).toHaveClass('active');
    expect(screen.getByRole('banner')).toHaveTextContent('Repositories');
    unmount();

    renderPath(`/app/repos/${exampleRepos[0]}`, noApi());
    await screen.findByRole('heading', { level: 1, name: exampleRepos[0] });
    expect(screen.getByRole('link', { name: 'Repositories' })).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'What’s behind' })).not.toHaveClass('active');
    expect(screen.getByRole('banner')).toHaveTextContent('Repositories');
  });
});

describe('repository detail', () => {
  it('derives dependencies from the report, once each, grouped by kind', async () => {
    const lib = dependency('lib', 'library');
    renderPath(
      detailPath,
      api(
        report([
          item(lib, 'first-finding'),
          item(lib, 'second-finding'),
          item(dependency('lib', 'library', '2.0.0'), 'other-version'),
          item(dependency('node', 'runtime'), 'runtime-finding'),
          item(dependency('mystery', 'new-kind' as DependencyUsage['kind']), 'new-kind-finding'),
        ]),
      ),
    );
    expect(
      await screen.findByRole('heading', { name: 'Dependencies with findings' }),
    ).toBeVisible();
    expect(screen.getByText(/full inventory isn’t available yet/)).toBeVisible();

    const libraries = screen.getByRole('table', { name: 'Libraries' });
    const rows = within(libraries).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('1.0.0'),
      expect.stringContaining('2.0.0'),
    ]);
    expect(within(screen.getByRole('table', { name: 'Runtimes' })).getByText('node')).toBeVisible();
    // A kind added later still shows, by its raw name.
    expect(screen.getByRole('table', { name: 'new-kind' })).toBeVisible();
    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(['Libraries', 'new-kind', 'Runtimes']);
  });

  it('shows where each dependency is declared, with and without a line', async () => {
    renderPath(detailPath, api(report([item(dependency('node', 'runtime'), 'finding')])));
    const table = await screen.findByRole('table', { name: 'Runtimes' });
    expect(within(table).getByText('node.lock:7')).toBeVisible();
    expect(within(table).getByText('no-line.txt')).toBeVisible();
    expect(within(table).getByText('1.0.0')).toBeVisible();
  });

  it('asks the API about this repo, and lists its PRs in every state', async () => {
    const fetcher = api(report([]), [
      pullRequest(1, { dependency: 'node', target: '24' }),
      pullRequest(2, { draft: true }),
      pullRequest(3, { state: 'merged' }),
      pullRequest(4, { state: 'closed' }),
    ]);
    renderPath(detailPath, fetcher);
    const table = await screen.findByRole('table', { name: 'Pull requests' });
    expect(fetcher).toHaveBeenCalledWith('/api/report?repo=test-owner%2Fapp', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('/api/prs?repo=test-owner%2Fapp', expect.anything());
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();

    const links = within(table).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://github.test/pull/1',
      'https://github.test/pull/2',
      'https://github.test/pull/3',
      'https://github.test/pull/4',
    ]);
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('[data-label="State"]')?.textContent),
    ).toEqual(['Open', 'Draft', 'Merged', 'Closed']);
    expect(links[0]).toHaveAccessibleName('#1 Change 1 (opens in a new tab)');
    expect(links[0]).toHaveAttribute('target', '_blank');
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(within(first).getByText('24')).toBeVisible();
    expect(first.querySelector('[data-label="State"]')).toHaveTextContent('Open');
    expect(second.querySelector('[data-label="State"]')).toHaveTextContent('Draft');
    expect(second.querySelector('[data-label="Target"]')).toHaveTextContent('Not given');
  });

  it('keeps the scan on screen when GitHub won’t list pull requests', async () => {
    const fetcher = vi.fn(async (path: string) =>
      path.startsWith('/api/prs')
        ? new Response(JSON.stringify({ error: 'GitHub request failed' }), {
            status: 502,
            headers: json,
          })
        : new Response(JSON.stringify({ ...report([]), costUsd: 1.46 }), { headers: json }),
    );
    renderPath(detailPath, fetcher);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t get this repository’s pull requests from GitHub.',
    );
    expect(screen.getByText(/at a cost of \$1\.46/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No findings' })).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it('links to this repo’s runs and findings', async () => {
    renderPath(detailPath, api(report([])));
    expect(await screen.findByRole('link', { name: /Runs on this repository/ })).toHaveAttribute(
      'href',
      '/app/runs?repo=test-owner%2Fapp',
    );
    expect(screen.getByRole('link', { name: /What’s behind in this/ })).toHaveAttribute(
      'href',
      '/app?repo=test-owner%2Fapp',
    );
  });

  it('round-trips names that need encoding through the link, route and API', async () => {
    const repo = 'odd owner/app#1';
    const fetcher = vi.fn(async (path: string) => {
      if (path === '/api/repos') return new Response(JSON.stringify([repo]), { headers: json });
      if (path.startsWith('/api/prs') || path.startsWith('/api/runs')) {
        return new Response('[]', { headers: json });
      }
      return new Response(JSON.stringify({ ...report([]), repo }), { headers: json });
    });
    const { unmount } = renderPath('/app/repos', fetcher);
    const link = await screen.findByRole('link', { name: repo });
    expect(link).toHaveAttribute('href', '/app/repos/odd%20owner/app%231');
    unmount();

    renderPath('/app/repos/odd%20owner/app%231', fetcher);
    expect(await screen.findByRole('heading', { level: 1, name: repo })).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith('/api/report?repo=odd+owner%2Fapp%231', expect.anything());
    expect(fetcher).toHaveBeenCalledWith('/api/prs?repo=odd+owner%2Fapp%231', expect.anything());
    expect(await screen.findByRole('link', { name: /Runs on/ })).toHaveAttribute(
      'href',
      '/app/runs?repo=odd+owner%2Fapp%231',
    );
  });

  it('is honest about a repo with no scan', async () => {
    renderPath(detailPath, api(null));
    expect(await screen.findByRole('heading', { name: 'No scan yet' })).toBeVisible();
    expect(screen.getByText('No finished scan yet.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No findings' })).toBeNull();
    expect(
      screen.getByText('Refit hasn’t opened a pull request on this repository.'),
    ).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it('is honest about a scanned repo with no findings', async () => {
    renderPath(detailPath, api(report([])));
    expect(await screen.findByRole('heading', { name: 'No findings' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No scan yet' })).toBeNull();
  });

  it('shows what the scan couldn’t read', async () => {
    renderPath(detailPath, api(report([], ['Couldn’t read a file.'])));
    expect(await screen.findByText('Couldn’t read a file.')).toBeVisible();
  });

  it('shows an unknown repo as missing in example mode', async () => {
    renderPath('/app/repos/example-org/not-a-repo', noApi());
    expect(await screen.findByRole('heading', { name: 'Nothing at this address.' })).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it('uses the same derivation on the examples, labelled', async () => {
    const example = exampleReports.find((candidate) => candidate.repo.endsWith('next-web'))!;
    renderPath(`/app/repos/${example.repo}`, noApi());
    await screen.findByRole('heading', { name: 'Dependencies with findings' });
    expect(screen.getByText('Example data')).toBeVisible();
    // next has two findings in this report and must appear once.
    expect(example.items.filter((item) => item.dependency.name === 'next')).toHaveLength(2);
    const frameworks = screen.getByRole('table', { name: 'Frameworks' });
    expect(within(frameworks).getAllByRole('row').slice(1)).toHaveLength(1);
    const shown = examplePullRequests.filter((candidate) => candidate.repo === example.repo);
    const table = screen.getByRole('table', { name: 'Pull requests' });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(shown.length);
  });

  it('falls back to examples when signed out', async () => {
    renderPath(
      `/app/repos/${exampleRepos[0]}`,
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'no' }), { status: 401, headers: json }),
      ),
    );
    expect(await screen.findByText(/need a GitHub sign-in/)).toBeVisible();
    expect(screen.getByText('Example data')).toBeVisible();
  });

  it('shows an error with a working retry, including for a malformed repo', async () => {
    const working = api(report([]));
    const fetcher = vi.fn(working);
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad repo' }), { status: 400, headers: json }),
    );
    renderPath(detailPath, fetcher);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The API answered 400.');
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    within(alert).getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByRole('heading', { name: 'No findings' })).toBeVisible();
  });
});

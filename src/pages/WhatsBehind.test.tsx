import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BehindItem, RunView, ScanReport } from '../../shared/types.ts';
import { App } from '../App';
import { exampleReports } from '../fixtures';

const json = { 'content-type': 'application/json' };

function item(
  repo: string,
  name: string,
  overrides: Partial<BehindItem> & { kind?: BehindItem['change']['kind'] } = {},
): BehindItem {
  const { kind = 'runtime-eol', ...rest } = overrides;
  return {
    repo,
    dependency: {
      repo,
      kind: 'runtime',
      name,
      version: `${name}-current`,
      declaredIn: [{ file: 'package.json', line: 3 }],
    },
    change: {
      provider: 'test-provider',
      id: `${name}-change`,
      kind,
      title: `${name} changed`,
      source: { url: `https://source.test/${name}`, quote: 'test quote' },
      affects: {},
      dependency: name,
      dependencyKind: 'runtime',
      toVersion: `${name}-target`,
    },
    status: 'open',
    ...rest,
  };
}

function report(repo: string, items: BehindItem[], errors: string[] = []): ScanReport {
  return { repo, scannedAt: '2026-11-01T00:00:00Z', items, costUsd: 0.1, errors };
}

const FIRST = 'test-owner/first';
const SECOND = 'test-owner/second';

// Dispatches by address so concurrent loads can't take each other's response.
function api(
  reports: Record<string, ScanReport | null>,
  repos = Object.keys(reports),
  runs: RunView[] = [],
) {
  return vi.fn(async (path: string) => {
    if (path === '/api/repos') return new Response(JSON.stringify(repos), { headers: json });
    const repo = new URL(path, 'http://site.test').searchParams.get('repo') ?? '';
    if (path.startsWith('/api/runs')) {
      return new Response(JSON.stringify(runs.filter((run) => run.repo === repo)), {
        headers: json,
      });
    }
    const found = reports[repo];
    return found
      ? new Response(JSON.stringify(found), { headers: json })
      : new Response(JSON.stringify({ error: 'no scan' }), { status: 404, headers: json });
  });
}

function History() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="search">{search}</span>
      <button onClick={() => navigate(-1)}>Test back</button>
    </>
  );
}

function renderBehind(fetcher: unknown, path = '/app') {
  vi.stubGlobal('fetch', fetcher);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <History />
    </MemoryRouter>,
  );
}

function dependencyColumn() {
  return within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-label="Dependency"] code')?.textContent);
}

function row(dependency: string) {
  const code = within(screen.getByRole('table')).getByText(dependency);
  return code.closest('tr') as HTMLElement;
}

function select(name: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
}

const sortable = () =>
  api({
    [FIRST]: report(FIRST, [
      item(FIRST, 'no-date'),
      item(FIRST, 'future-far', { deadline: '2099-06-01' }),
      item(FIRST, 'overdue-recent', { deadline: '2024-06-01' }),
    ]),
    [SECOND]: report(SECOND, [
      item(SECOND, 'future-near', { deadline: '2098-01-15' }),
      item(SECOND, 'overdue-old', { deadline: '2020-01-15' }),
      item(SECOND, 'merged-old', { deadline: '2019-01-01', status: 'merged' }),
      item(SECOND, 'bad-date', { deadline: 'soon' }),
    ]),
  });

describe('what’s behind', () => {
  it('sorts past-due first, then by date, with no deadline last, across repos', async () => {
    renderBehind(sortable());
    await screen.findByRole('table');
    expect(dependencyColumn()).toEqual([
      'overdue-old',
      'overdue-recent',
      'merged-old',
      'future-near',
      'future-far',
      'no-date',
      'bad-date',
    ]);
  });

  it('marks only unresolved past deadlines as past due, in text', async () => {
    const today = new Date().toISOString().slice(0, 10);
    renderBehind(
      api({
        [FIRST]: report(FIRST, [
          item(FIRST, 'late', { deadline: '2020-01-15' }),
          item(FIRST, 'late-pr', { deadline: '2020-01-15', status: 'pr-open' }),
          item(FIRST, 'due-today', { deadline: today }),
          item(FIRST, 'done', { deadline: '2020-01-15', status: 'merged' }),
          item(FIRST, 'unaffected', { deadline: '2020-01-15', status: 'not-affected' }),
          item(FIRST, 'undated'),
        ]),
      }),
    );
    await screen.findByRole('table');
    expect(within(row('late')).getByText('Past due')).toBeVisible();
    expect(within(row('late-pr')).getByText('Past due')).toBeVisible();
    for (const name of ['due-today', 'done', 'unaffected', 'undated']) {
      expect(within(row(name)).queryByText('Past due')).not.toBeInTheDocument();
    }
    expect(within(row('undated')).getByText('None')).toBeVisible();
  });

  it('shows the whole row from the API, without the example label', async () => {
    const fetcher = api({
      [FIRST]: report(FIRST, [
        item(FIRST, 'node', {
          kind: 'ci-deprecation',
          deadline: '2020-01-15',
          status: 'pr-open',
          pr: 'https://github.test/test-owner/first/pull/9',
        }),
      ]),
    });
    renderBehind(fetcher);
    expect(screen.getByRole('status')).toHaveTextContent('Loading findings…');
    await screen.findByRole('table');
    expect(fetcher).toHaveBeenCalledWith('/api/report?repo=test-owner%2Ffirst', expect.anything());
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(screen.queryByText(/No Refit API is reachable/)).not.toBeInTheDocument();

    const cells = within(row('node'));
    expect(cells.getByRole('link', { name: FIRST })).toHaveAttribute(
      'href',
      '/app/repos/test-owner/first',
    );
    expect(cells.getByText('node-current')).toBeVisible();
    expect(cells.getByText('node-target')).toBeVisible();
    expect(cells.getByText('node changed')).toBeVisible();
    expect(cells.getByText('CI deprecation')).toBeVisible();
    expect(row('node').querySelector('time')).toHaveAttribute('dateTime', '2020-01-15');
    expect(row('node').querySelector('time')).toHaveTextContent('2020');
    expect(cells.getByText('PR open')).toBeVisible();

    const source = cells.getByRole('link', { name: /^Source for node changed/ });
    expect(source).toHaveAttribute('href', 'https://source.test/node');
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAccessibleName('Source for node changed (opens in a new tab)');

    const pullRequest = cells.getByRole('link', { name: /^Pull request/ });
    expect(pullRequest).toHaveAttribute('href', 'https://github.test/test-owner/first/pull/9');
    expect(pullRequest).toHaveAttribute('target', '_blank');
  });

  it('labels every status in text and links a PR only when there is one', async () => {
    renderBehind(
      api({
        [FIRST]: report(FIRST, [
          item(FIRST, 'a-open'),
          item(FIRST, 'b-pr', { status: 'pr-open', pr: 'https://github.test/pull/1' }),
          item(FIRST, 'c-merged', { status: 'merged', pr: 'https://github.test/pull/2' }),
          item(FIRST, 'd-clear', { status: 'not-affected' }),
        ]),
      }),
    );
    await screen.findByRole('table');
    const labels = ['a-open', 'b-pr', 'c-merged', 'd-clear'].map(
      (name) => row(name).querySelector('.resource-status')?.textContent,
    );
    expect(labels).toEqual(['Open', 'PR open', 'Merged', 'Not affected']);
    expect(within(row('a-open')).queryByRole('link', { name: /^Pull request/ })).toBeNull();
    expect(within(row('c-merged')).getByRole('link', { name: /^Pull request/ })).toBeVisible();
  });

  it('never links a source that isn’t a web address', async () => {
    const unsafe = item(FIRST, 'unsafe');
    unsafe.change.source.url = 'javascript:alert(1)';
    renderBehind(api({ [FIRST]: report(FIRST, [unsafe]) }));
    await screen.findByRole('table');
    expect(within(row('unsafe')).queryByRole('link', { name: /Source/ })).not.toBeInTheDocument();
    expect(within(row('unsafe')).getByText('Source')).toBeVisible();
  });

  describe('filters', () => {
    const filterable = () =>
      api({
        [FIRST]: report(FIRST, [
          item(FIRST, 'runtime-one', { status: 'open' }),
          item(FIRST, 'model-one', { kind: 'model-retirement', status: 'merged' }),
        ]),
        [SECOND]: report(SECOND, [
          item(SECOND, 'runtime-two', { status: 'pr-open' }),
          item(SECOND, 'unknown-kind', {
            kind: 'brand-new-kind' as BehindItem['change']['kind'],
          }),
        ]),
      });

    it('filters by repo and writes it to the URL', async () => {
      renderBehind(filterable());
      await screen.findByRole('table');
      select('Repository', SECOND);
      expect(dependencyColumn()).toEqual(['runtime-two', 'unknown-kind']);
      expect(screen.getByTestId('search')).toHaveTextContent('?repo=test-owner%2Fsecond');
    });

    it('filters by kind, in plain words, falling back to the raw kind', async () => {
      renderBehind(filterable());
      await screen.findByRole('table');
      const options = within(screen.getByRole('combobox', { name: 'Kind' }))
        .getAllByRole('option')
        .map((option) => option.textContent);
      expect(options).toEqual(['All', 'AI model retired', 'brand-new-kind', 'Runtime end of life']);
      expect(within(row('unknown-kind')).getByText('brand-new-kind')).toBeVisible();
      select('Kind', 'model-retirement');
      expect(dependencyColumn()).toEqual(['model-one']);
      expect(screen.getByTestId('search')).toHaveTextContent('?kind=model-retirement');
    });

    it('filters by status', async () => {
      renderBehind(filterable());
      await screen.findByRole('table');
      select('Status', 'pr-open');
      expect(dependencyColumn()).toEqual(['runtime-two']);
      expect(screen.getByTestId('search')).toHaveTextContent('?status=pr-open');
    });

    it('combines filters, restores them from a deep link and honours back', async () => {
      renderBehind(filterable(), '/app?repo=test-owner%2Ffirst&status=merged');
      await screen.findByRole('table');
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue(FIRST);
      expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('merged');
      expect(dependencyColumn()).toEqual(['model-one']);

      select('Status', 'open');
      expect(dependencyColumn()).toEqual(['runtime-one']);
      fireEvent.click(screen.getByRole('button', { name: 'Test back' }));
      expect(await screen.findByText('model-one')).toBeVisible();
      expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('merged');
    });

    it('removes a filter from the URL when set back to All', async () => {
      renderBehind(filterable(), '/app?kind=model-retirement&status=merged');
      await screen.findByRole('table');
      select('Kind', '');
      expect(screen.getByTestId('search')).toHaveTextContent('?status=merged');
      expect(screen.getByTestId('search')).not.toHaveTextContent('kind');
    });

    it('shows an empty state with a working clear button when nothing matches', async () => {
      renderBehind(filterable(), '/app?repo=test-owner%2Ffirst&status=pr-open');
      expect(await screen.findByRole('heading', { name: /Nothing matches/ })).toBeVisible();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(await screen.findByRole('table')).toBeVisible();
      expect(dependencyColumn()).toHaveLength(4);
      expect(screen.getByTestId('search')).toBeEmptyDOMElement();
    });

    it('keeps a deep-linked value selected even when no finding has it', async () => {
      renderBehind(filterable(), '/app?repo=test-owner%2Fgone');
      await screen.findByRole('heading', { name: /Nothing matches/ });
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('test-owner/gone');
    });
  });

  describe('work held for budget', () => {
    const run = (name: string, outcome: RunView['outcome'], id = name): RunView => ({
      id,
      repo: FIRST,
      taskId: id,
      provider: 'test-provider',
      changeId: `${name}-change`,
      outcome,
      costUsd: 0,
      summary: 'Test summary.',
      finishedAt: '2026-11-01T00:00:00Z',
    });
    const statusOf = (name: string) =>
      (screen.getByText(name).closest('tr') as HTMLElement).querySelector('[data-label="Status"]');

    it('shows a held finding as waiting, and lets you filter to it', async () => {
      const reports = {
        [FIRST]: report(FIRST, [item(FIRST, 'held'), item(FIRST, 'plain')]),
      };
      renderBehind(api(reports, [FIRST], [run('held', 'waiting-budget')]));
      await screen.findByRole('table');
      expect(statusOf('held')).toHaveTextContent('Waiting on budget');
      expect(statusOf('plain')).toHaveTextContent('Open');
      fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
        target: { value: 'waiting-budget' },
      });
      expect(dependencyColumn()).toEqual(['held']);
    });

    it('stops waiting once a newer run has tried it', async () => {
      const reports = { [FIRST]: report(FIRST, [item(FIRST, 'tried')]) };
      const runs = [run('tried', 'needs-review', 'new'), run('tried', 'waiting-budget', 'old')];
      renderBehind(api(reports, [FIRST], runs));
      await screen.findByRole('table');
      expect(statusOf('tried')).toHaveTextContent('Open');
    });

    it('keeps a finding with a PR as PR open, whatever its run says', async () => {
      const reports = { [FIRST]: report(FIRST, [item(FIRST, 'pr', { status: 'pr-open' })]) };
      renderBehind(api(reports, [FIRST], [run('pr', 'waiting-budget')]));
      await screen.findByRole('table');
      expect(statusOf('pr')).toHaveTextContent('PR open');
    });
  });

  it('collapses a long list of scan errors, and counts them', async () => {
    const errors = ['one', 'two', 'three', 'four'].map((name) => `Couldn’t read ${name}.`);
    renderBehind(api({ [FIRST]: report(FIRST, [item(FIRST, 'node')], errors) }));
    await screen.findByRole('table');
    expect(screen.getByText('4 notes')).toBeVisible();
    expect(screen.getByText('Couldn’t read one.')).not.toBeVisible();
  });

  it('says honestly what a scan couldn’t read', async () => {
    renderBehind(
      api({
        [FIRST]: report(FIRST, [item(FIRST, 'node')], ['Couldn’t read deploy/values.yaml.']),
        [SECOND]: report(SECOND, []),
      }),
    );
    await screen.findByRole('table');
    const note = screen.getByText(`Refit couldn’t read everything in ${FIRST}.`);
    expect(note).toBeVisible();
    expect(screen.getByText('1 note')).toBeVisible();
    expect(screen.getByText('Couldn’t read deploy/values.yaml.')).not.toBeVisible();
    fireEvent.click(note);
    expect(screen.getByText('Couldn’t read deploy/values.yaml.')).toBeVisible();
    expect(screen.queryByText(`Refit couldn’t read everything in ${SECOND}.`)).toBeNull();
  });

  it('names repos with no scan yet and still shows the others', async () => {
    renderBehind(api({ [FIRST]: report(FIRST, [item(FIRST, 'node')]), [SECOND]: null }));
    await screen.findByRole('table');
    expect(screen.getByText(new RegExp(`No scan yet for ${SECOND}`))).toBeVisible();
    expect(dependencyColumn()).toEqual(['node']);
  });

  it('says nothing is behind only when a scan actually finished', async () => {
    renderBehind(api({ [FIRST]: report(FIRST, []) }));
    expect(await screen.findByRole('heading', { name: 'Nothing is behind' })).toBeVisible();
  });

  it('doesn’t claim anything is clear when no repo has a scan', async () => {
    renderBehind(api({ [FIRST]: null }));
    expect(await screen.findByText(new RegExp(`No scan yet for ${FIRST}`))).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Nothing is behind' })).toBeNull();
  });

  it('points to onboarding when there are no repositories', async () => {
    renderBehind(api({}, []));
    expect(await screen.findByRole('link', { name: 'Install the GitHub App' })).toHaveAttribute(
      'href',
      '/onboarding',
    );
  });

  it('falls back to labelled examples when no API answers', async () => {
    renderBehind(vi.fn().mockResolvedValue(new Response('<!doctype html>')));
    await screen.findByRole('table');
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/No Refit API is reachable/)).toBeVisible();
    expect(dependencyColumn()).toHaveLength(
      exampleReports.reduce((total, example) => total + example.items.length, 0),
    );
  });

  it('falls back to labelled examples when signed out', async () => {
    renderBehind(
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'no' }), { status: 401, headers: json }),
      ),
    );
    await screen.findByRole('table');
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/need a GitHub sign-in/)).toBeVisible();
  });

  it('shows an error with a working retry, and no examples', async () => {
    const working = api({ [FIRST]: report(FIRST, [item(FIRST, 'node')]) });
    const fetcher = vi.fn(working);
    fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderBehind(fetcher);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to fetch');
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(dependencyColumn()).toEqual(['node']);
  });

  it('shows an error when one report fails, rather than hiding that repo', async () => {
    const working = api({ [FIRST]: report(FIRST, [item(FIRST, 'node')]) }, [FIRST, SECOND]);
    renderBehind(
      vi.fn(async (path: string) =>
        path.includes(encodeURIComponent(SECOND))
          ? new Response(JSON.stringify({ error: 'bad' }), { status: 502, headers: json })
          : working(path),
      ),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('The API answered 502.');
  });

  it('marks the page current in the dashboard navigation', async () => {
    renderBehind(api({}, []));
    await screen.findByRole('link', { name: 'Install the GitHub App' });
    expect(screen.getByRole('link', { name: 'What’s behind' })).toHaveClass('active');
    expect(screen.getByRole('banner')).toHaveTextContent('What’s behind');
  });
});

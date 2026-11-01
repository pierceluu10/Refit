import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { organization, repositories, resultOf, tasks, usages } from '../fixtures';

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const pages = [
  '/app',
  '/app/repositories',
  ...repositories.map((repo) => `/app/repositories/${repo.id}`),
  '/app/tasks',
  ...tasks.map((task) => `/app/tasks/${task.id}`),
];

describe('dashboard', () => {
  it.each(pages)('labels %s as example data', (path) => {
    renderRoute(path);
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(/This dashboard shows example data/)).toBeVisible();
  });

  it.each(['/app/repositories/not-real', '/app/tasks/not-real'])(
    'renders the missing state for %s',
    (path) => {
      renderRoute(path);
      expect(screen.getByRole('heading', { name: 'Nothing at this address.' })).toBeVisible();
    },
  );

  it('derives the overview counts from the fixtures', () => {
    renderRoute('/app');
    const summary = (label: string) =>
      screen.getByText(label, { selector: '.overview-summary span' }).previousSibling;
    expect(summary('Repositories')).toHaveTextContent(String(repositories.length));
    expect(summary('APIs in use')).toHaveTextContent(
      String(new Set(usages.map((usage) => usage.provider)).size),
    );
    expect(summary('Open pull requests')).toHaveTextContent(
      String(tasks.filter((task) => resultOf(task.id)?.pr).length),
    );
    expect(screen.getByRole('heading', { level: 1, name: organization.name })).toBeVisible();
    const needsReview = tasks.filter((task) => resultOf(task.id)?.outcome === 'needs-review');
    for (const task of needsReview)
      expect(screen.getByRole('link', { name: new RegExp(task.change.title) })).toBeVisible();
  });

  it.each(repositories)('lists every call site of $name', (repo) => {
    const { container } = renderRoute(`/app/repositories/${repo.id}`);
    const sites = usages
      .filter((usage) => usage.repo === repo.name)
      .flatMap((usage) => usage.callSites);
    const rendered = [...container.querySelectorAll('.call-sites code')].map(
      (node) => node.textContent,
    );
    expect(rendered).toEqual(sites.map((site) => `${site.file}:${site.line}`));
    for (const site of sites) expect(screen.getAllByText(site.operation).length).toBeGreaterThan(0);
    for (const task of tasks.filter((item) => item.repo === repo.name))
      expect(screen.getByRole('link', { name: new RegExp(task.change.title) })).toBeVisible();
  });

  it('filters repositories by an API from a deep link', () => {
    renderRoute('/app/repositories?provider=openai');
    const rows = screen.getAllByRole('link', { name: /^View / });
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('example-org/support-bot')).toBeVisible();
  });

  it('ignores an unknown API filter', () => {
    renderRoute('/app/repositories?provider=not-real');
    expect(screen.getByLabelText('Filter repositories by API')).toHaveValue('all');
    expect(screen.getAllByRole('link', { name: /^View / })).toHaveLength(repositories.length);
  });

  it('ranks tasks by priority', () => {
    const { container } = renderRoute('/app/tasks');
    const titles = [...container.querySelectorAll('.task-list strong')].map(
      (node) => node.textContent,
    );
    const ranked = [...tasks].sort((a, b) => a.priority - b.priority);
    expect(titles).toEqual(ranked.map((task) => task.change.title));
  });

  it('says what is unproven on a needs-review pull request', () => {
    const task = tasks.find((item) => resultOf(item.id)?.outcome === 'needs-review')!;
    renderRoute(`/app/tasks/${task.id}`);
    expect(screen.getByRole('heading', { name: 'What’s unproven' })).toBeVisible();
    for (const item of resultOf(task.id)!.unproven) expect(screen.getByText(item)).toBeVisible();
    expect(screen.getByText(task.change.source.quote)).toBeVisible();
    expect(screen.getByText(/Illustrative quote/)).toBeVisible();
  });

  it('shows a not-affected verdict without a pull request', () => {
    const task = tasks.find((item) => resultOf(item.id)?.outcome === 'not-affected')!;
    renderRoute(`/app/tasks/${task.id}`);
    expect(screen.getByRole('heading', { name: 'Verdict' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Pull request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

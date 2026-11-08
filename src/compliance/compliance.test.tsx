import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type {
  AuditEntry,
  BehindItem,
  ExternalChange,
  Obligation,
  RunView,
  ScanReport,
} from '../../shared/types.ts';
import { PlatformsAndRules } from './index';
import { safeHref } from './api';

const LEGAL_NOTE =
  "Refit doesn't give legal advice. Have counsel confirm the items marked for review.";
const NO_RECORD =
  'Refit has no record of what to confirm here. Read the PR, and have counsel review it.';
const BANNED = /\bcompliant\b|compliance status|\bmeets\b|passes the law/i;
const REPO = 'test-owner/app';
const OTHER = 'test-owner/other';
const PR = 'https://github.com/test-owner/app/pull/7';

function item(
  id: string,
  kind: ExternalChange['kind'],
  extra: Partial<BehindItem> & { url?: string } = {},
): BehindItem {
  const { url = `https://example.test/${id}`, ...rest } = extra;
  return {
    repo: REPO,
    dependency: {
      repo: REPO,
      kind: 'infrastructure',
      name: `dep-${id}`,
      version: '1.0',
      declaredIn: [{ file: `files/${id}.yaml`, line: 3 }],
    },
    change: {
      provider: 'test',
      id,
      kind,
      title: `Title ${id}`,
      source: { url, quote: `Quote ${id}` },
      affects: {},
      dependencyKind: 'infrastructure',
      dependency: `dep-${id}`,
      toVersion: `target-${id}`,
    },
    status: 'open',
    ...rest,
  };
}

const report = (items: BehindItem[], extra: Partial<ScanReport> = {}): ScanReport => ({
  repo: REPO,
  scannedAt: '2026-11-01T10:00:00Z',
  items,
  costUsd: 0,
  errors: [],
  ...extra,
});

const obligation = (id: string, needsHuman: string[]): Obligation => ({
  id,
  rule: {
    name: `Rule ${id}`,
    jurisdiction: 'Testland',
    url: `https://example.test/rule/${id}`,
    quote: `Rule quote ${id}`,
  },
  requirement: `Requirement ${id}`,
  appliesTo: 'test pages',
  inCode: 'test code',
  checkable: [],
  needsHuman,
});

const entry = (
  changeId: string,
  action: AuditEntry['action'],
  at: string,
  evidence: string[],
  extra: Partial<AuditEntry> = {},
): AuditEntry => ({ at, repo: REPO, changeId, action, evidence, actor: 'refit', ...extra });

const run = (changeId: string, outcome: RunView['outcome'], summary: string): RunView => ({
  id: `run-${changeId}`,
  repo: REPO,
  taskId: `task-${changeId}`,
  provider: 'test',
  changeId,
  outcome,
  costUsd: 0,
  summary,
  finishedAt: '2026-11-01T12:00:00Z',
});

type Route = { status?: number; type?: string; body: unknown };
type Routes = Record<string, Route | ((url: URL) => Route | Promise<Route>)>;

const json = (body: unknown, status = 200): Route => ({ body, status });
const html: Route = { body: '<!doctype html>', type: 'text/html' };

const baseRoutes = (overrides: Routes = {}): Routes => ({
  '/api/repos': json([REPO, OTHER]),
  '/api/report': json(report([])),
  '/api/runs': json([]),
  '/api/audit': json([]),
  '/api/obligations': json([]),
  ...overrides,
});

function stubApi(routes: Routes) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = routes[url.pathname];
    if (!route) throw new Error(`Unexpected request to ${url.pathname}`);
    const {
      status = 200,
      type = 'application/json',
      body,
    } = typeof route === 'function' ? await route(url) : route;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': type },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function Location() {
  return <div data-testid="location">{useLocation().search}</div>;
}

function renderPage(routes: Routes, path = '/app/rules') {
  const fetcher = stubApi(routes);
  render(
    <MemoryRouter initialEntries={[path]}>
      <PlatformsAndRules />
      <Location />
    </MemoryRouter>,
  );
  return fetcher;
}

const loaded = () => screen.findByRole('region', { name: 'Platforms' });
const rulesList = async () => within(await screen.findByRole('list', { name: 'Rules' }));

describe('safeHref', () => {
  it.each([
    ['https://example.test/a', 'https://example.test/a'],
    ['HTTP://example.test/', 'http://example.test/'],
    ['javascript:alert(1)', undefined],
    ['JaVaScRiPt:alert(1)', undefined],
    ['data:text/html,<script>alert(1)</script>', undefined],
    [' https://example.test/', undefined],
    ['https://', undefined],
    ['axe scan: 0 new violations', undefined],
  ])('%s becomes %s', (value, expected) => {
    expect(safeHref(value)).toBe(expected);
  });
});

describe('live data', () => {
  it('renders from the API with no example label', async () => {
    renderPage(baseRoutes({ '/api/report': json(report([item('k8s', 'k8s-version')])) }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    await loaded();
    expect(screen.getByText('Title k8s')).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(screen.queryByText(/refit-example-org/)).not.toBeInTheDocument();
  });

  it('sends no credentials from the browser', async () => {
    const fetcher = renderPage(baseRoutes());
    await loaded();
    expect(fetcher).toHaveBeenCalled();
    for (const [input, init] of fetcher.mock.calls) {
      expect(String(input)).toMatch(/^\/api\//);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.credentials).toBeUndefined();
    }
  });

  it('keeps token names out of the browser source', () => {
    const sources = import.meta.glob(['./*.ts', './index.tsx'], {
      eager: true,
      query: '?raw',
      import: 'default',
    });
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(3);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/VITE_|REFIT_SERVICE_TOKEN/);
    }
  });

  it('shows the scan time and what could not be read', async () => {
    renderPage(
      baseRoutes({ '/api/report': json(report([], { errors: ['Could not read go.mod'] })) }),
    );
    await loaded();
    expect(screen.getByText('Could not read go.mod')).not.toBeVisible();
    fireEvent.click(screen.getByText(`Refit couldn’t read everything in ${REPO}.`));
    expect(screen.getByText('Could not read go.mod')).toBeVisible();
    expect(screen.getByText(/at a cost of \$/)).toBeVisible();
    expect(screen.getByText(/Last scanned/).querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-11-01T10:00:00Z',
    );
  });

  it('treats a JSON 404 report as no scan yet, not as a missing API', async () => {
    renderPage(baseRoutes({ '/api/report': json({ error: 'no scan' }, 404) }));
    await loaded();
    expect(screen.getByText(/hasn’t been scanned yet/)).toBeVisible();
    expect(screen.getByText(`No platform findings in ${REPO}.`)).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });

  it.each([
    ['names', [REPO, OTHER]],
    ['{ repo }', [{ repo: REPO }, { repo: OTHER }]],
    ['{ fullName }', [{ fullName: REPO }, { fullName: OTHER }]],
    ['{ full_name }', [{ full_name: REPO }, { full_name: OTHER }]],
    ['{ name }', [{ name: REPO }, { name: OTHER }]],
  ])('reads repositories given as %s', async (_, repos) => {
    const fetcher = renderPage(baseRoutes({ '/api/repos': json(repos) }));
    await loaded();
    const select = screen.getByLabelText<HTMLSelectElement>('Repository');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([REPO, OTHER]);
    expect(select.value).toBe(REPO);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/audit?repo=${encodeURIComponent(REPO)}`,
      expect.anything(),
    );
  });

  it('refetches and keeps the choice in the URL when the repository changes', async () => {
    const fetcher = renderPage(baseRoutes());
    await loaded();
    fetcher.mockClear();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: OTHER } });
    expect(screen.getByTestId('location')).toHaveTextContent(`?repo=${encodeURIComponent(OTHER)}`);
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        `/api/report?repo=${encodeURIComponent(OTHER)}`,
        expect.anything(),
      ),
    );
    await loaded();
    expect(screen.getByLabelText<HTMLSelectElement>('Repository').value).toBe(OTHER);
  });

  it('opens the repository named in the URL', async () => {
    const fetcher = renderPage(baseRoutes(), `/app/rules?repo=${encodeURIComponent(OTHER)}`);
    await loaded();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/audit?repo=${encodeURIComponent(OTHER)}`,
      expect.anything(),
    );
  });

  it('ignores an answer for a repository the viewer has moved away from', async () => {
    let finishSlow: (route: Route) => void = () => {};
    const slow = new Promise<Route>((resolve) => (finishSlow = resolve));
    renderPage(
      baseRoutes({
        '/api/report': (url) =>
          url.searchParams.get('repo') === OTHER
            ? slow
            : json(report([item('kept', 'k8s-version')])),
      }),
    );
    await screen.findByText('Title kept');
    const select = screen.getByLabelText('Repository');
    fireEvent.change(select, { target: { value: OTHER } });
    fireEvent.change(select, { target: { value: REPO } });
    await screen.findByText('Title kept');
    finishSlow(json(report([item('stale', 'k8s-version')])));
    await new Promise((resolve) => setTimeout(resolve));
    expect(screen.queryByText('Title stale')).not.toBeInTheDocument();
    expect(screen.getByText('Title kept')).toBeVisible();
  });

  it('says so when there are no repositories yet', async () => {
    renderPage(baseRoutes({ '/api/repos': json([]) }));
    expect(await screen.findByRole('heading', { name: 'No repositories yet' })).toBeVisible();
    expect(screen.getByText(LEGAL_NOTE)).toBeVisible();
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
  });
});

describe('example fallback', () => {
  const live = baseRoutes({ '/api/report': json(report([item('live', 'k8s-version')])) });

  it.each<[string, Routes, RegExp]>([
    ['a static deploy answers with html', { ...live, '/api/repos': html }, /No Refit API/],
    [
      'the path is not served',
      { ...live, '/api/repos': { body: 'Not found', status: 404, type: 'text/plain' } },
      /No Refit API/,
    ],
    ['the API needs a sign-in', { ...live, '/api/repos': json({}, 401) }, /needs a sign-in/],
    ['one route is not mounted yet', { ...live, '/api/audit': json({}, 404) }, /No Refit API/],
    ['one route falls back to html', { ...live, '/api/obligations': html }, /No Refit API/],
    ['one route needs a sign-in', { ...live, '/api/runs': json({}, 401) }, /needs a sign-in/],
  ])('labels the whole page as an example when %s', async (_, routes, reason) => {
    renderPage(routes);
    await loaded();
    expect(screen.getByText('Example data')).toBeVisible();
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByText(/illustrative/)).toBeVisible();
    expect(screen.getByLabelText<HTMLSelectElement>('Repository').value).toMatch(
      /^refit-example-org\//,
    );
    expect(screen.queryByText('Title live')).not.toBeInTheDocument();
    expect(screen.queryByText(REPO)).not.toBeInTheDocument();
  });

  it('shows every platform group, a rule of each kind and all audit actions', async () => {
    const counts: string[] = [];
    renderPage({ '/api/repos': html });
    await loaded();
    const repos = within(screen.getByLabelText('Repository')).getAllByRole('option');
    for (const option of repos) {
      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: option.textContent },
      });
      await loaded();
      const platforms = within(screen.getByRole('region', { name: 'Platforms' }));
      counts.push(...platforms.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent!));
      for (const row of within(screen.getByRole('table')).getAllByRole('row').slice(1)) {
        counts.push(within(row).getAllByRole('cell')[1].textContent!);
      }
      expect(document.body.textContent).not.toMatch(BANNED);
    }
    expect(counts).toEqual(
      expect.arrayContaining([
        'Kubernetes and cloud',
        'Serverless',
        'App stores and mobile',
        'Browsers',
        'TLS and login',
        'Detected',
        'Matched',
        'Not affected',
        'PR opened',
        'PR updated',
        'Merged',
        'Closed',
      ]),
    );
  });

  it('exports example rows that say they are examples', async () => {
    const created: Blob[] = [];
    const names: string[] = [];
    const revoke = vi.fn();
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:example';
    });
    URL.revokeObjectURL = revoke;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderPage({ '/api/repos': html });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(names).toEqual(['refit-audit-example-refit-example-org-storefront.csv']);
    const bytes = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(created[0]);
    });
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('﻿# Example data. Not a real audit record.');
    expect(lines[1]).toMatch(/^Time,/);
    expect(text.match(/﻿/g)).toHaveLength(1);
    expect(lines[2]).toMatch(/example-/);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:example'), { timeout: 2000 });
  });
});

describe('errors', () => {
  it('shows a retry on a server failure and recovers', async () => {
    let failing = true;
    renderPage(
      baseRoutes({
        '/api/report': () =>
          failing
            ? { body: '', status: 500, type: 'text/plain' }
            : json(report([item('back', 'k8s-version')])),
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('answered 500');
    expect(screen.queryByText('Example data')).not.toBeInTheDocument();
    expect(screen.getByText(LEGAL_NOTE)).toBeVisible();
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title back')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not take a list route answering an object as data', async () => {
    renderPage(baseRoutes({ '/api/audit': json({ entries: [] }) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('something other than a list');
  });
});

describe('legal note', () => {
  it.each<[string, Routes]>([
    ['live', baseRoutes({ '/api/report': json(report([item('r', 'regulation')])) })],
    ['example', { '/api/repos': html }],
    ['empty', baseRoutes()],
  ])('is visible in %s data', async (_, routes) => {
    renderPage(routes);
    expect(screen.getByText(LEGAL_NOTE)).toBeVisible();
    await loaded();
    expect(screen.getByText(LEGAL_NOTE)).toBeVisible();
    expect(document.body.textContent).not.toMatch(BANNED);
  });
});

describe('platforms', () => {
  it('groups findings by kind and sorts each group soonest first, undated last', async () => {
    const items = [
      item('undated', 'k8s-version'),
      item('later', 'k8s-version', { deadline: '2027-06-01' }),
      item('sooner', 'cloud-deprecation', { deadline: '2026-12-01' }),
      item('lambda', 'serverless-runtime'),
      item('store', 'platform-policy'),
      item('ios', 'mobile-os'),
      item('chrome', 'browser-change'),
      item('tls', 'tls-crypto'),
      item('login', 'auth-standard'),
      item('library', 'dependency-major'),
      item('law', 'regulation'),
    ];
    renderPage(baseRoutes({ '/api/report': json(report(items)) }));
    const region = within(await loaded());
    const titles = (name: string) =>
      within(region.getByRole('list', { name }))
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent);
    expect(titles('Kubernetes and cloud')).toEqual([
      'Title sooner',
      'Title later',
      'Title undated',
    ]);
    expect(titles('Serverless')).toEqual(['Title lambda']);
    expect(titles('App stores and mobile')).toEqual(['Title store', 'Title ios']);
    expect(titles('Browsers')).toEqual(['Title chrome']);
    expect(titles('TLS and login')).toEqual(['Title tls', 'Title login']);
    expect(region.queryByText('Title library')).not.toBeInTheDocument();
    expect(region.queryByText('Title law')).not.toBeInTheDocument();
  });

  it('shows the facts of a finding and its PR', async () => {
    const finding = item('k8s', 'k8s-version', {
      deadline: '2026-12-01',
      status: 'pr-open',
      pr: PR,
    });
    renderPage(baseRoutes({ '/api/report': json(report([finding])) }));
    const row = within(await loaded()).getByRole('listitem');
    expect(row.querySelector('time')).toHaveAttribute('dateTime', '2026-12-01');
    expect(within(row).getByText('Dec 1, 2026')).toBeVisible();
    expect(within(row).getByText('dep-k8s 1.0')).toBeVisible();
    expect(within(row).getByText('files/k8s.yaml:3')).toBeVisible();
    expect(within(row).getByText('target-k8s')).toBeVisible();
    expect(within(row).getByText('Quote k8s')).toBeVisible();
    expect(within(row).getByText('PR open')).toBeVisible();
    const source = within(row).getByRole('link', {
      name: 'Source for Title k8s (opens in a new tab)',
    });
    expect(source).toHaveAttribute('href', 'https://example.test/k8s');
    expect(source).toHaveAttribute('rel', 'noreferrer');
    expect(source).toHaveAttribute('target', '_blank');
    expect(
      within(row).getByRole('link', {
        name: `Pull request for k8s on ${REPO} (opens in a new tab)`,
      }),
    ).toHaveAttribute('href', PR);
  });

  it.each<[BehindItem['status'], string]>([
    ['open', 'Open'],
    ['pr-open', 'PR open'],
    ['merged', 'Merged'],
    ['not-affected', 'Not affected'],
  ])('labels status %s in text', async (status, label) => {
    renderPage(
      baseRoutes({ '/api/report': json(report([item('k8s', 'k8s-version', { status })])) }),
    );
    expect(within(await loaded()).getByText(label)).toHaveClass('resource-status');
  });

  it('says plainly when a finding has no date', async () => {
    renderPage(baseRoutes({ '/api/report': json(report([item('k8s', 'k8s-version')])) }));
    expect(within(await loaded()).getByText('No date published')).toBeVisible();
  });

  it('keeps an unparseable deadline readable instead of crashing', async () => {
    const finding = item('k8s', 'k8s-version', { deadline: 'early 2027' });
    renderPage(baseRoutes({ '/api/report': json(report([finding])) }));
    expect(within(await loaded()).getByText('early 2027')).toBeVisible();
  });

  it('never links a javascript: source', async () => {
    const finding = item('bad', 'k8s-version', { url: 'javascript:alert(1)' });
    renderPage(baseRoutes({ '/api/report': json(report([finding])) }));
    const region = within(await loaded());
    expect(region.getByText('javascript:alert(1)')).toBeVisible();
    expect(region.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('rules', () => {
  const lawRoutes = (overrides: Routes = {}) =>
    baseRoutes({
      '/api/report': json(report([item('law', 'regulation', { status: 'pr-open', pr: PR })])),
      '/api/obligations': json([
        obligation('ob-1', ['Confirm the exemption.', 'Confirm the date.']),
      ]),
      '/api/runs': json([
        run('law', 'needs-review', 'Newest summary.'),
        run('law', 'failed', 'Older summary.'),
      ]),
      '/api/audit': json([
        entry('law', 'matched', '2026-11-01T09:00:00Z', ['Older reason.'], {
          obligationId: 'ob-1',
        }),
        entry('law', 'matched', '2026-11-01T10:00:00Z', ['Newest reason.']),
        entry('law', 'pr-opened', '2026-11-01T11:00:00Z', [
          'axe scan: 3 before, 1 after',
          'https://example.test/evidence',
        ]),
        entry('law', 'pr-updated', '2026-11-01T12:00:00Z', ['axe scan: 0 after']),
        entry('other-change', 'pr-opened', '2026-11-01T12:00:00Z', ['Someone else’s check']),
      ]),
      ...overrides,
    });

  it('shows a rule held for budget as waiting, with nothing changed and nothing to review', async () => {
    renderPage(
      lawRoutes({
        '/api/report': json(report([item('law', 'regulation')])),
        '/api/runs': json([
          run('law', 'waiting-budget', 'not attempted: $1.70 of the run cap left'),
        ]),
      }),
    );
    const list = await rulesList();
    expect(list.getByText('Waiting on budget')).toBeVisible();
    expect(list.queryByText('Needs review')).toBeNull();
    expect(list.queryByText('Failed')).toBeNull();
    expect(list.getByText(/Nothing yet. This is waiting on budget/)).toBeVisible();
    expect(list.queryByText(/not attempted/)).toBeNull();
  });

  it('joins the report, audit, obligation and run into one rule', async () => {
    renderPage(lawRoutes());
    const list = await rulesList();
    expect(list.getByRole('heading', { name: 'Rule ob-1' })).toBeVisible();
    expect(list.getByText('Testland')).toBeVisible();
    expect(list.getByText('Requirement ob-1')).toBeVisible();
    expect(list.getByText('Rule quote ob-1')).toBeVisible();
    expect(list.getByText('Likely applies')).toBeVisible();
    expect(list.getByText('Needs review')).toHaveClass('status-attention');
    expect(list.getByText('Newest reason.')).toBeVisible();
    expect(list.queryByText('Older reason.')).not.toBeInTheDocument();
    expect(list.getByText('files/law.yaml:3')).toBeVisible();
    expect(list.getByText('Newest summary.')).toBeVisible();
    expect(list.queryByText('Older summary.')).not.toBeInTheDocument();
    const checks = list.getByText('axe scan: 0 after').closest('ul')!;
    expect(
      within(checks)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['axe scan: 0 after', 'axe scan: 3 before, 1 after']);
    expect(list.queryByText('Someone else’s check')).not.toBeInTheDocument();
    expect(list.getAllByText('For review')).toHaveLength(2);
    expect(list.getByText('Confirm the exemption.')).toBeVisible();
    expect(
      list.getByRole('link', { name: `Pull request for law on ${REPO} (opens in a new tab)` }),
    ).toHaveAttribute('href', PR);
    expect(list.getByRole('link', { name: /Evidence source/ })).toHaveAttribute(
      'href',
      'https://example.test/evidence',
    );
  });

  it('never invents what to confirm when no obligation is recorded', async () => {
    renderPage(
      baseRoutes({
        '/api/report': json(report([item('law', 'payment-rule')])),
      }),
    );
    const list = await rulesList();
    expect(list.getByRole('heading', { name: 'Title law' })).toBeVisible();
    expect(list.getByText(NO_RECORD)).toBeVisible();
    expect(list.queryByText('For review')).not.toBeInTheDocument();
    expect(list.getByText('Needs review')).toBeVisible();
    expect(list.getByText('Refit recorded no reason for this.')).toBeVisible();
    expect(list.getByText('No change recorded yet.')).toBeVisible();
    expect(list.getByText('No check results recorded.')).toBeVisible();
    expect(list.getByText('No PR yet')).toBeVisible();
  });

  it('falls back to the dependency notes for why', async () => {
    const law = item('law', 'regulation');
    law.dependency.notes = 'The repo has a signup form.';
    renderPage(baseRoutes({ '/api/report': json(report([law])) }));
    expect((await rulesList()).getByText('The repo has a signup form.')).toBeVisible();
  });

  it('says a rule that likely does not apply needs nothing from a lawyer', async () => {
    renderPage(
      lawRoutes({
        '/api/report': json(report([item('law', 'regulation', { status: 'not-affected' })])),
        '/api/audit': json([
          entry('law', 'not-affected', '2026-11-01T09:00:00Z', ['No AI features here.'], {
            obligationId: 'ob-1',
          }),
        ]),
        '/api/runs': json([]),
      }),
    );
    const list = await rulesList();
    expect(list.getByText("Likely doesn't apply")).toBeVisible();
    expect(list.getByText('No AI features here.')).toBeVisible();
    expect(list.queryByText('Needs review')).not.toBeInTheDocument();
    expect(list.queryByText('Confirm the exemption.')).not.toBeInTheDocument();
    expect(list.queryByText('What a person or lawyer must confirm')).not.toBeInTheDocument();
  });

  it('drops the review mark only for a verified run with nothing to confirm, and never says verified', async () => {
    renderPage(
      lawRoutes({
        '/api/obligations': json([obligation('ob-1', [])]),
        '/api/runs': json([run('law', 'verified', 'Changed the form labels.')]),
      }),
    );
    const list = await rulesList();
    expect(list.queryByText('Needs review')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/verified/i);
    expect(list.getByText('Nothing is marked for review.')).toBeVisible();
  });

  it("shows the run and PR of the task that also resolves a rule, never another task's", async () => {
    renderPage(
      lawRoutes({
        '/api/report': json(
          report([item('law', 'regulation', { taskId: 'task-main', status: 'pr-open', pr: PR })]),
        ),
        '/api/runs': json([
          run('other', 'failed', 'Another task failed.'),
          run('main', 'needs-review', 'Marked the output.'),
        ]),
      }),
    );
    const list = await rulesList();
    expect(list.getByText('Marked the output.')).toBeVisible();
    expect(list.queryByText('Another task failed.')).not.toBeInTheDocument();
    expect(list.getByRole('link', { name: /^Pull request for law/ })).toHaveAttribute('href', PR);
  });

  it.each<[string, Routes]>([
    [
      'a verified run with items to confirm',
      {
        '/api/runs': json([run('law', 'verified', 'Summary.')]),
      },
    ],
    [
      'a verified run with no obligation on record',
      {
        '/api/obligations': json([]),
        '/api/runs': json([run('law', 'verified', 'Summary.')]),
      },
    ],
    [
      'nothing to confirm but no verified run',
      {
        '/api/obligations': json([obligation('ob-1', [])]),
        '/api/runs': json([run('law', 'needs-review', 'Summary.')]),
      },
    ],
  ])('keeps the review mark for %s', async (_, overrides) => {
    renderPage(lawRoutes(overrides));
    expect((await rulesList()).getByText('Needs review')).toBeVisible();
  });

  it('lists rules that apply before rules that do not, and shows only rule kinds', async () => {
    renderPage(
      baseRoutes({
        '/api/report': json(
          report([
            item('skip', 'regulation', { status: 'not-affected' }),
            item('pay', 'payment-rule'),
            item('k8s', 'k8s-version'),
          ]),
        ),
      }),
    );
    const list = await rulesList();
    expect(list.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Title pay',
      'Title skip',
    ]);
  });

  it('says so when no rule matched', async () => {
    renderPage(baseRoutes());
    expect(await screen.findByText(`No rules matched ${REPO}.`)).toBeVisible();
  });
});

describe('audit trail', () => {
  const routes = () =>
    baseRoutes({
      '/api/audit': json([
        entry('old', 'detected', '2026-11-01T09:00:00Z', ['https://example.test/source']),
        entry('new', 'pr-opened', '2026-11-02T09:00:00Z', ['javascript:alert(1)', 'A check ran.'], {
          pr: PR,
          obligationId: 'ob-9',
          actor: 'a-person',
        }),
      ]),
    });

  it('lists entries newest first with every column', async () => {
    renderPage(routes());
    const table = within(await screen.findByRole('table', { name: `Audit trail for ${REPO}` }));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Time',
      'Action',
      'Change',
      'Obligation',
      'Evidence',
      'Actor',
      'PR',
    ]);
    const [, first, second] = table.getAllByRole('row');
    const cells = within(first).getAllByRole('cell');
    expect(cells[0].querySelector('time')).toHaveAttribute('dateTime', '2026-11-02T09:00:00Z');
    expect(cells.slice(1, 4).map((cell) => cell.textContent)).toEqual(['PR opened', 'new', 'ob-9']);
    expect(cells[5]).toHaveTextContent('a-person');
    expect(within(cells[6]).getByRole('link')).toHaveAttribute('href', PR);
    expect(within(second).getAllByRole('cell')[1]).toHaveTextContent('Detected');
  });

  it('links http evidence and leaves anything else as text', async () => {
    renderPage(routes());
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('javascript:alert(1)').closest('a')).toBeNull();
    expect(table.getByRole('link', { name: /example\.test\/source/ })).toHaveAttribute(
      'href',
      'https://example.test/source',
    );
    const hrefs = table.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs.every((href) => href?.startsWith('https://'))).toBe(true);
  });

  it('exports through the API with the repository encoded', async () => {
    renderPage(routes());
    const region = within(await screen.findByRole('region', { name: 'Audit trail' }));
    const link = region.getByRole('link', { name: 'Export CSV' });
    expect(link).toHaveAttribute('href', `/api/audit.csv?repo=${encodeURIComponent(REPO)}`);
    expect(link).toHaveAttribute('download');
    expect(region.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('says so when there are no entries, and still offers the export', async () => {
    renderPage(baseRoutes());
    const region = within(await screen.findByRole('region', { name: 'Audit trail' }));
    expect(region.getByText(`No audit entries for ${REPO} yet.`)).toBeVisible();
    expect(region.queryByRole('table')).not.toBeInTheDocument();
    expect(region.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  });
});

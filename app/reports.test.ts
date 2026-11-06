import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BehindItem, ScanReport } from '../shared/types.ts';
import { InvalidRepoError } from './git.ts';
import { createReportStore } from './reports.ts';

const REPO = 'refit-example-org/billing-api';
const PR = `https://github.com/${REPO}/pull/41`;

const item = (changeId: string, pr?: string): BehindItem => ({
  repo: REPO,
  dependency: { repo: REPO, kind: 'runtime', name: 'node', declaredIn: [] },
  change: {
    provider: 'node',
    id: changeId,
    kind: 'runtime-eol',
    title: `Illustrative ${changeId}`,
    source: { url: 'https://example.com/illustrative', quote: 'Illustrative.' },
    affects: {},
    dependencyKind: 'runtime',
    dependency: 'node',
  },
  status: pr ? 'pr-open' : 'open',
  ...(pr && { pr }),
});
const report = (repo = REPO, items: BehindItem[] = [item('node-18')]): ScanReport => ({
  repo,
  scannedAt: '2026-11-06T00:00:00Z',
  items,
  costUsd: 0.5,
  errors: [],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-reports-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('createReportStore', () => {
  it('round-trips a report in <encoded repo>.json, with its installation as one extra field', async () => {
    const store = createReportStore(join(dir, 'nested'));
    await store.save(7, report());
    expect(await store.latest(REPO)).toMatchObject(report());
    const NAME = `${encodeURIComponent(REPO)}.json`;
    expect(await readdir(join(dir, 'nested'))).toEqual([NAME]);
    const stored = JSON.parse(await readFile(join(dir, 'nested', NAME), 'utf8')) as ScanReport & {
      installationId: number;
    };
    expect(stored).toEqual({ ...report(), installationId: 7 });
  });

  it('reads a repo with no report, and an empty store, as nothing', async () => {
    const store = createReportStore(join(dir, 'missing'));
    expect(await store.latest(REPO)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('throws on a corrupt report rather than calling the repo unscanned', async () => {
    await writeFile(join(dir, `${encodeURIComponent(REPO)}.json`), '{"repo":');
    await expect(createReportStore(dir).latest(REPO)).rejects.toThrow(SyntaxError);
  });

  it('rejects a repo that is not owner/name, before touching the disk', async () => {
    const store = createReportStore(dir);
    await expect(store.latest('../../etc')).rejects.toBeInstanceOf(InvalidRepoError);
    await expect(store.save(1, report('no-slash'))).rejects.toBeInstanceOf(InvalidRepoError);
  });

  it('lists every repo and removes one repo or a whole installation', async () => {
    const store = createReportStore(dir);
    await store.save(1, report('org/a'));
    await store.save(1, report('org/b'));
    await store.save(2, report('other/c'));
    expect((await store.list()).map((saved) => saved.repo).sort()).toEqual([
      'org/a',
      'org/b',
      'other/c',
    ]);
    await store.remove('org/a');
    expect(await store.latest('org/a')).toBeUndefined();
    await store.save(1, report('org/a'));
    await store.removeInstallation(1);
    expect((await store.list()).map((saved) => saved.repo)).toEqual(['other/c']);
  });

  it('marks every item of a change as pr-open, and leaves other changes alone', async () => {
    const store = createReportStore(dir);
    await store.save(1, report(REPO, [item('node-18'), item('node-18'), item('flask-3')]));
    await store.markPullRequest(REPO, 'node-18', PR);
    const items = (await store.latest(REPO))!.items;
    expect(items.map(({ status, pr }) => [status, pr])).toEqual([
      ['pr-open', PR],
      ['pr-open', PR],
      ['open', undefined],
    ]);
  });

  it.each(['pr-open', 'merged'] as const)(
    'a new scan keeps the %s status and link of the same finding',
    async (status) => {
      const store = createReportStore(dir);
      await store.save(1, report(REPO, [{ ...item('node-18', PR), status }, item('flask-3')]));
      await store.save(1, report(REPO, [item('node-18'), item('flask-3')]));
      const items = (await store.latest(REPO))!.items;
      expect(items[0]).toMatchObject({ status, pr: PR });
      expect(items[1].status).toBe('open');
    },
  );

  it('a new scan carries no PR over a closed one, another change or another dependency', async () => {
    const store = createReportStore(dir);
    const otherDependency = {
      ...item('flask-3', PR),
      dependency: { ...item('flask-3').dependency, name: 'python' },
    };
    await store.save(
      1,
      report(REPO, [{ ...item('node-18', PR), status: 'open' }, otherDependency]),
    );
    await store.save(1, report(REPO, [item('node-18'), item('flask-3'), item('django-5')]));
    const items = (await store.latest(REPO))!.items;
    expect(items.map(({ status, pr }) => [status, pr])).toEqual([
      ['open', undefined],
      ['open', undefined],
      ['open', undefined],
    ]);
  });

  it("a scan's own status for a finding wins over the old one", async () => {
    const store = createReportStore(dir);
    await store.save(1, report(REPO, [item('node-18', PR)]));
    await store.save(1, report(REPO, [{ ...item('node-18'), status: 'not-affected' }]));
    expect((await store.latest(REPO))!.items[0].status).toBe('not-affected');
  });

  it('ignores a PR mark for a repo with no report', async () => {
    const store = createReportStore(dir);
    await store.markPullRequest(REPO, 'node-18', PR);
    expect(await store.latest(REPO)).toBeUndefined();
  });

  it.each([
    ['merged', 'merged'],
    ['closed', 'open'],
    ['edited', 'pr-open'],
  ] as const)('a %s verdict leaves the item %s, with its PR link', async (verdict, status) => {
    const store = createReportStore(dir);
    await store.save(1, report(REPO, [item('node-18', PR), item('flask-3')]));
    await store.markVerdict(PR, verdict);
    const items = (await store.latest(REPO))!.items;
    expect(items[0]).toMatchObject({ status, pr: PR });
    expect(items[1].status).toBe('open');
  });

  it('ignores a verdict on a URL that is not a GitHub PR', async () => {
    const store = createReportStore(dir);
    await store.save(1, report(REPO, [item('node-18', PR)]));
    await store.markVerdict('stub://pr/node-18', 'merged');
    expect((await store.latest(REPO))!.items[0].status).toBe('pr-open');
  });

  it('loses no update when marks and saves arrive together', async () => {
    const store = createReportStore(dir);
    const changes = ['a', 'b', 'c', 'd', 'e'];
    await store.save(
      1,
      report(
        REPO,
        changes.map((id) => item(id)),
      ),
    );
    await Promise.all(changes.map((id) => store.markPullRequest(REPO, id, `${PR}${id}`)));
    const items = (await store.latest(REPO))!.items;
    expect(items.map((saved) => saved.pr)).toEqual(changes.map((id) => `${PR}${id}`));
  });

  it('keeps working after a failed write', async () => {
    const store = createReportStore(join(dir, 'blocked'));
    await writeFile(join(dir, 'blocked'), 'a file where the folder should be');
    await expect(store.save(1, report())).rejects.toThrow();
    await rm(join(dir, 'blocked'));
    await store.save(1, report());
    expect(await store.latest(REPO)).toBeDefined();
  });
});

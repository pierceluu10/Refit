// End to end on the three sample repo fixtures (fixtures/samples/, illustrative stand-ins for the
// demo repos), offline: every AI part is a stub, nothing is run or pushed.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, ExternalChange, OpenPullRequest } from '../shared/types.ts';
import { createDeps } from './deps.ts';
import { createRunRepoJob, createScanRepo } from './index.ts';
import type { LoopDeps } from './loop.ts';
import type { ScanItemReport } from './scan.ts';

const sample = (name: string) =>
  fileURLToPath(new URL(`./fixtures/samples/${name}`, import.meta.url));
const allChanges = JSON.parse(
  await readFile(new URL('./fixtures/external-changes.json', import.meta.url), 'utf8'),
) as ExternalChange[];

let work: string;
let audits: AuditEntry[];

function offline(): Omit<LoopDeps, 'openPullRequest'> {
  const deps = createDeps({
    out: join(work, 'runs.jsonl'),
    reports: join(work, 'reports'),
    watchCache: join(work, 'watch'),
    log: () => {},
  });
  return { ...deps, recordAudit: async (entry) => void audits.push(entry) };
}

const row = (report: ScanItemReport, changeId: string) =>
  report.items.find((i) => i.change.id === changeId);

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  work = await mkdtemp(join(tmpdir(), 'refit-samples-'));
  audits = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

describe('scanRepo on the sample repos', () => {
  it('demo-node-api: the runtime bump moves with its image, version files and CI', async () => {
    const { report, tasks } = await createScanRepo(offline())(
      'refit-dev/demo-node-api',
      sample('demo-node-api'),
    );
    const node = tasks.find((t) => t.change.id === 'node-18-eol')!;
    expect(node.dependencies.map((d) => d.name).sort()).toEqual([
      'actions/setup-node',
      'node',
      'node:18-bookworm',
    ]);
    const runtime = node.dependencies.find((d) => d.name === 'node')!;
    expect(runtime.declaredIn.map((d) => d.file).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.nvmrc',
      'package.json',
    ]);
    // node:18 the image moves to the same target, so it is the same task, never a second one.
    expect(tasks.some((t) => t.change.id === 'node-18-image-eol')).toBe(false);
    expect(row(report, 'node-18-image-eol')).toMatchObject({
      status: 'open',
      taskId: node.id,
    });
    for (const id of [
      'openai-gpt-4-0613-retirement',
      'k8s-ingress-extensions-v1beta1-removed',
      'lambda-nodejs16-deprecated',
    ])
      expect(row(report, id)?.status).toBe('open');
    expect(row(report, 'actions-checkout-v2-node12')).toMatchObject({
      status: 'not-affected',
      reason: expect.stringContaining('v4'),
    });
    // API changes are in the same report and the same task list.
    expect(tasks.some((t) => t.change.dependencyKind === 'api')).toBe(true);
    expect(tasks.map((t) => t.priority)).toEqual(tasks.map((_, i) => i + 1));
  });

  it('demo-next-web: framework, CI action and runner findings', async () => {
    const { report } = await createScanRepo(offline())(
      'refit-dev/demo-next-web',
      sample('demo-next-web'),
    );
    for (const id of [
      'next-13-to-15',
      'actions-checkout-v2-node12',
      'ubuntu-20.04-runner-retired',
      'node-16-eol',
    ])
      expect(row(report, id)?.status).toBe('open');
    expect(row(report, 'node-18-eol')?.status).toBe('not-affected');
    // The sample has no API usage map, so no API change is open for it.
    expect(report.items.filter((i) => i.change.dependencyKind === 'api')).toEqual([]);
  });

  it('demo-python-app: python and every change it faces, each with a verdict', async () => {
    const { report } = await createScanRepo(offline())(
      'refit-dev/demo-python-app',
      sample('demo-python-app'),
    );
    expect(row(report, 'python-3.9-eol')).toMatchObject({
      status: 'open',
      deadline: '2025-10-31',
      dependency: { name: 'python', version: '3.9' },
    });
    expect(row(report, 'flask-1-eol')).toMatchObject({
      status: 'not-affected',
      reason: expect.stringContaining('2.2.5'),
    });
    expect(row(report, 'stripe-charges-source-removed')?.status).toBe('open');
    expect(report.repo).toBe('refit-dev/demo-python-app');
  });

  it('lists open rows by deadline, with undated rows after dated ones', async () => {
    const { report } = await createScanRepo(offline())('demo-node-api', sample('demo-node-api'));
    const dates = report.items
      .filter((i) => i.status === 'open')
      .map((i) => (i.deadline ? Date.parse(i.deadline) : Infinity));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });
});

describe('runRepoJob on the sample repos', () => {
  const opener = () => vi.fn<OpenPullRequest>(async (task) => `https://github.com/pr/${task.id}`);

  it.each(['demo-node-api', 'demo-next-web', 'demo-python-app'])(
    '%s: every change ends in a PR or a verdict, and every step is audited',
    async (name) => {
      const repo = `refit-dev/${name}`;
      const deps = offline();
      const { report } = await createScanRepo(deps)(repo, sample(name));
      audits = [];
      const openPullRequest = opener();
      const records = await createRunRepoJob(deps)({ repo, dir: sample(name), openPullRequest });

      // One record per task or verdict; a merged change shares its task's record.
      const covered = new Set(records.map((r) => r.taskId.slice(repo.length + 1)));
      for (const item of report.items)
        expect(
          covered.has(item.change.id) ||
            (item.taskId && records.some((r) => r.taskId === item.taskId)),
        ).toBe(true);
      expect(records.every((r) => r.outcome !== 'failed')).toBe(true);
      const shipped = records.filter((r) => r.pr);
      expect(shipped.length).toBe(openPullRequest.mock.calls.length);
      expect(shipped.length).toBe(records.filter((r) => r.outcome === 'needs-review').length);

      const actions = (action: AuditEntry['action']) =>
        audits.filter((a) => a.action === action).map((a) => a.changeId);
      expect(actions('detected').sort()).toEqual(report.items.map((i) => i.change.id).sort());
      expect(actions('not-affected').sort()).toEqual(
        report.items
          .filter((i) => i.status === 'not-affected')
          .map((i) => i.change.id)
          .sort(),
      );
      expect(actions('matched')).toHaveLength(shipped.length);
      expect(actions('pr-opened').length).toBeGreaterThanOrEqual(shipped.length);
      expect(audits.every((a) => a.actor === 'refit' && a.repo === repo)).toBe(true);

      // The saved report shows each PR against its rows.
      const saved = JSON.parse(
        await readFile(join(work, 'reports', `refit-dev_${name}.json`), 'utf8'),
      ) as ScanItemReport;
      for (const item of saved.items.filter((i) => i.taskId))
        expect(item).toMatchObject({
          status: 'pr-open',
          pr: `https://github.com/pr/${item.taskId}`,
        });

      const stored = (await readFile(join(work, 'runs.jsonl'), 'utf8')).trim().split('\n');
      expect(stored).toHaveLength(records.length);
    },
  );

  it('gives the PR opener the external change and every declaration it moves', async () => {
    const openPullRequest = opener();
    await createRunRepoJob(offline())({
      repo: 'demo-node-api',
      dir: sample('demo-node-api'),
      openPullRequest,
    });
    const [task] = openPullRequest.mock.calls.find(([t]) => t.change.id === 'node-18-eol')!;
    expect(task.notes).toContain('.nvmrc');
    expect(task.notes).toContain('Dockerfile');
    expect((task as unknown as { dependencies: unknown[] }).dependencies.length).toBe(3);
  });

  it('opens no PRs on a dry run', async () => {
    const openPullRequest = opener();
    const records = await createRunRepoJob(offline())({
      repo: 'demo-next-web',
      dir: sample('demo-next-web'),
      openPullRequest,
      dryRun: true,
    });
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(records.every((r) => !r.pr)).toBe(true);
    expect(audits.some((a) => a.action === 'pr-opened')).toBe(false);
  });

  it('uses only illustrative fixture changes offline', () => {
    expect(allChanges.every((c) => c.source.quote.startsWith('(illustrative)'))).toBe(true);
  });
});

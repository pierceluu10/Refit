import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeScanRepo, fakeRunExternalTask } from './mvp-fake.ts';
import { realOrchestrator, runMvpSmoke } from './mvp.ts';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

describe('MVP smoke test', () => {
  it('runs the three sample repos end to end and passes its own checks', async () => {
    const outcome = await runMvpSmoke();
    expect(outcome.problems).toEqual([]);
    expect(outcome.report).toContain('MVP SMOKE OK');
    expect(outcome.score.attemptedRate).toBe(1);
    expect(outcome.reports.map((r) => r.repo)).toEqual([
      'refit-dev/demo-node-api',
      'refit-dev/demo-python-app',
      'refit-dev/demo-next-web',
    ]);
    expect(Object.keys(outcome.score.byFamily)).toEqual(
      expect.arrayContaining(['runtime', 'model', 'ci', 'framework', 'platform']),
    );
  });

  it('opens no PR on a dry run and still attempts every task', async () => {
    const outcome = await runMvpSmoke({ dryRun: true });
    expect(outcome.problems).toEqual([]);
    const prs = outcome.results.flatMap((r) => r.tasks).filter((t) => t.record?.pr);
    expect(prs).toEqual([]);
  });

  it('moves Node in every declared place together, in a copy', async () => {
    const { tasks } = await createFakeScanRepo()(
      'refit-dev/demo-node-api',
      fixture('demo-node-api'),
    );
    const node = tasks.find((task) => task.change.dependency === 'node');
    expect(node?.dependencies[0].declaredIn.map((place) => place.file).sort()).toEqual([
      '.nvmrc',
      'Dockerfile',
      'package.json',
    ]);
    const record = await fakeRunExternalTask(node!, fixture('demo-node-api'));
    expect(record.outcome).toBe('verified');
    expect(record.diff).toContain('+FROM node:22-bookworm');
    expect(record.diff).toContain('+    "node": ">=22"');
    expect(readFileSync(join(fixture('demo-node-api'), '.nvmrc'), 'utf8').trim()).toBe('18');
  });

  it('records a not-affected verdict with its reason', async () => {
    const { report } = await createFakeScanRepo()(
      'refit-dev/demo-python-app',
      fixture('demo-python-app'),
    );
    const item = report.items.find((i) => i.status === 'not-affected');
    expect(item?.dependency.notes).toContain('flask is at 2.0.3');
  });

  it('falls back to the stand-ins, and says so, until the orchestrator exports scanRepo', async () => {
    const chosen = await realOrchestrator();
    if (chosen.source === 'orchestrator/index.ts') return; // O1 has landed; nothing to fall back from.
    expect(chosen.note).toContain('does not export scanRepo yet');
  });
});

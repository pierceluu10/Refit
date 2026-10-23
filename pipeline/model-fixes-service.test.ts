import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runLocalService } from './local-service.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import type { ServiceTarget } from './service-configuration.ts';

const REVISION = 'c'.repeat(40);
const runs = vi.hoisted(
  () =>
    [] as {
      repository: string;
      checks: unknown;
      publication: unknown;
      handled: unknown;
    }[],
);

vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({ token: 'read', appId: 123, installationId: 456 })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, _method: string, path: string) => ({
    id: 789,
    full_name: path.slice('/repos/'.length),
    archived: false,
    disabled: false,
  })),
}));
// The enrolled repository's poll returns its managed checkout and approved checks.
vi.mock('./service-worker.ts', async (original) => ({
  ...(await original<typeof import('./service-worker.ts')>()),
  pollServiceTarget: vi.fn(async () => ({
    status: 'already-processed',
    previousStatus: 'existing-pr',
    output: '/tmp/evidence',
    checkout: {
      directory: '/tmp/checkout',
      repository: 'example/app',
      base: 'main',
      revision: REVISION,
    },
    checks: { image: 'node:22-alpine', command: ['npm', 'test'] },
  })),
}));
// Each call is recorded; the first opens a draft pull request and later ones find it handled.
vi.mock('./model-fixes.ts', () => ({
  runModelFixes: vi.fn(async (options: (typeof runs)[number]) => {
    runs.push(options);
    return runs.length === 1 || !options.handled
      ? {
          status: 'draft-created',
          reason: 'https://github.com/example/app/pull/9',
          revision: REVISION,
          patchHash: 'p'.repeat(64),
          fixKey: 'k'.repeat(64),
          skipped: false,
          replacements: [],
          stops: [],
          pullRequest: { url: 'https://github.com/example/app/pull/9', number: 9 },
        }
      : { status: 'no-change', reason: 'handled', skipped: true, replacements: [], stops: [] };
  }),
}));

const roots: string[] = [];
afterEach(async () => {
  runs.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('runs model fixes for enrolled repositories only when enabled, and remembers what it opened', async () => {
  const state = await mkdtemp(join(tmpdir(), 'refit-model-fix-service-'));
  roots.push(state);
  const approval = {
    formatVersion: 1,
    kind: 'refit-repository-approval',
    repository: 'example/app',
    base: 'main',
    fingerprint: 'f'.repeat(64),
    files: [],
    reviewedRevision: REVISION,
    approvedAt: '2026-10-01T00:00:00.000Z',
  } as RepositoryApproval;
  const enrolled: ServiceTarget = {
    id: 'app',
    repository: 'example/app',
    base: 'main',
    documentationSources: [],
    approval,
  };
  const base = {
    targets: [enrolled],
    app: { appId: '123', privateKeyFile: 'unused' },
    directory: state,
    port: 0,
    intervalSeconds: 30,
    webhookSecret: 'webhook-secret-for-model-fix-tests-1',
    controlToken: 'control-token-for-model-fix-tests-2',
    now: () => new Date('2026-10-21T12:00:00Z'),
    once: true,
  };
  // Off by default.
  await runLocalService({ ...base, publishDraft: true, signal: new AbortController().signal });
  expect(runs).toEqual([]);

  const first = await runLocalService({
    ...base,
    modelFixes: {},
    publishDraft: true,
    signal: new AbortController().signal,
  });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    repository: '/tmp/checkout',
    checks: { image: 'node:22-alpine', command: ['npm', 'test'] },
    publication: { repository: 'example/app', base: 'main', app: { appId: '123' } },
    handled: null,
  });
  expect(first.registry.modelFixes?.['example/app']).toMatchObject({
    status: 'draft-created',
    revision: REVISION,
    fixKey: 'k'.repeat(64),
    pullRequest: 9,
  });

  // The next poll passes what was opened, and a skipped run keeps the recorded outcome.
  const second = await runLocalService({
    ...base,
    modelFixes: {},
    publishDraft: true,
    signal: new AbortController().signal,
  });
  expect(runs[1].handled).toEqual({ revision: REVISION, fixKey: 'k'.repeat(64), pullRequest: 9 });
  expect(second.registry.modelFixes?.['example/app']).toMatchObject({
    status: 'draft-created',
    pullRequest: 9,
  });

  // Without --publish-draft (which needs its own service state), the run has no publication target.
  const unpublished = await mkdtemp(join(tmpdir(), 'refit-model-fix-service-'));
  roots.push(unpublished);
  await runLocalService({
    ...base,
    directory: unpublished,
    modelFixes: {},
    signal: new AbortController().signal,
  });
  expect(runs[2].publication).toBeUndefined();
});

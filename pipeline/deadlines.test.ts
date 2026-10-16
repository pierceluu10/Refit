import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  alertDue,
  alertStage,
  deadlineBody,
  deadlineTitle,
  parseLeadDays,
  syncDeadlineIssue,
} from './deadline-alerts.ts';
import { agentStatus, configuredIntegrations, findDeadlineExposures } from './deadline-exposure.ts';
import {
  checkDeadlineRegistry,
  daysUntil,
  loadDeadlineRegistry,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import { runLocalService } from './local-service.ts';
import type { RepositoryApproval } from './repository-enrollment.ts';
import type { ServiceTarget } from './service-configuration.ts';

const REVISION = 'c'.repeat(40);
const requests = vi.hoisted(() => [] as { method: string; path: string; body: unknown }[]);
const checkout = vi.hoisted(() => ({ directory: '' }));

vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({ token: 'read', appId: 123, installationId: 456 })),
  authenticateGitHubComment: vi.fn(async () => ({ token: 'comment' })),
  authenticateGitHubIssues: vi.fn(async () => ({ token: 'issues' })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  // A mocked GitHub: repository metadata for access checks, an empty pull request, and recorded
  // issue writes. Created issues are numbered 41.
  requestGitHub: vi.fn(async (_token: string, method: string, path: string, body?: unknown) => {
    if (method !== 'GET') {
      requests.push({ method, path, body });
      return method === 'POST' && path.endsWith('/issues') ? { number: 41 } : { id: 1 };
    }
    if (path.includes('/pulls/')) return [];
    const { GitHubRequestError } = await import('./github.ts');
    if (path.includes('/contents/')) throw new GitHubRequestError(404, method, path);
    return { id: 789, full_name: path.slice('/repos/'.length), archived: false, disabled: false };
  }),
}));
// The approved repository's managed checkout is a local fixture directory.
vi.mock('./service-worker.ts', () => ({
  pollServiceTarget: vi.fn(async ({ target }: { target: ServiceTarget }) => ({
    status: 'already-processed',
    previousStatus: 'existing-pr',
    output: '/tmp/evidence',
    ...(target.approval
      ? {
          checkout: {
            directory: checkout.directory,
            repository: target.repository,
            base: target.base,
            revision: REVISION,
          },
        }
      : {}),
  })),
}));

const roots: string[] = [];
afterEach(async () => {
  requests.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-deadlines-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(
      join(root, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return root;
}

function entry(
  overrides: Partial<DeadlineEntry> & Pick<DeadlineEntry, 'id' | 'provider' | 'versions' | 'date'>,
): DeadlineEntry {
  return {
    kind: overrides.provider === 'openai' ? 'model' : 'api-version',
    summary: `${overrides.id} sunsets.`,
    replacement: null,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-15',
    ...overrides,
  };
}

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry({
      id: 'openai-gpt-4',
      provider: 'openai',
      versions: ['gpt-4', 'gpt-4-0613'],
      date: '2026-10-23',
      replacement: 'gpt-5.6-sol',
    }),
    entry({
      id: 'shopify-2025-10',
      provider: 'shopify',
      versions: ['2025-10'],
      date: '2026-10-16',
    }),
    entry({
      id: 'shopify-2026-01',
      provider: 'shopify',
      versions: ['2026-01'],
      date: '2027-01-16',
    }),
    entry({ id: 'meta-v20', provider: 'meta-graph', versions: ['v20.0'], date: '2026-09-24' }),
    entry({ id: 'meta-v21', provider: 'meta-graph', versions: ['v21.0'], date: '2027-01-21' }),
  ],
};
const NOW = new Date('2026-10-15T23:30:00Z');

it('counts whole UTC days to a deadline and past it', () => {
  expect(daysUntil('2026-10-23', NOW)).toBe(8);
  expect(daysUntil('2026-10-15', NOW)).toBe(0);
  expect(daysUntil('2026-10-14', new Date('2026-10-15T00:00:00Z'))).toBe(-1);
  expect(daysUntil('2027-01-01', new Date('2026-12-31T23:59:59Z'))).toBe(1);
});

it('alerts once per lead time, at the tightest stage reached, and once the date passes', () => {
  const lead = parseLeadDays('7, 90,30');
  expect(lead).toEqual([90, 30, 7]);
  expect(alertStage(91, lead)).toBeNull();
  expect(alertStage(90, lead)).toBe(90);
  expect(alertStage(31, lead)).toBe(90);
  expect(alertStage(20, lead)).toBe(30);
  expect(alertStage(7, lead)).toBe(7);
  expect(alertStage(1, lead)).toBe(7);
  expect(alertStage(0, lead)).toBe(0);
  expect(alertStage(-40, lead)).toBe(0);
  expect(alertDue(null, undefined)).toBe(false);
  expect(alertDue(30, undefined)).toBe(true);
  expect(alertDue(30, 90)).toBe(true);
  expect(alertDue(30, 30)).toBe(false);
  expect(alertDue(90, 30)).toBe(false);
  expect(alertDue(0, 7)).toBe(true);
  expect(alertDue(0, 0)).toBe(false);
  for (const value of ['', '0', '400', '30,30', '1.5', '1,2,3,4,5,6,7', 'soon'])
    expect(() => parseLeadDays(value)).toThrow(/lead times/);
});

it('matches pinned versions and models with file:line evidence and ignores lookalikes', async () => {
  const root = await repository({
    'package.json': {
      dependencies: { 'facebook-nodejs-business-sdk': '^20.0.0', '@shopify/shopify-api': '11.0.0' },
    },
    'src/ai.ts': [
      "const chat = { model: 'gpt-4' };",
      "const other = { model: 'gpt-4o' };",
      '// gpt-4 in a comment is not a pinned string',
      'const snapshot = `gpt-4-0613`;',
    ].join('\n'),
    'src/shop.ts': [
      "import { shopifyApi, ApiVersion } from '@shopify/shopify-api';",
      'shopifyApi({ apiVersion: ApiVersion.October25 });',
      "const legacy = { apiVersion: '2026-01' };",
      "fetch('https://example.myshopify.com/admin/api/2025-10/orders.json');",
    ].join('\n'),
    'src/stripe.ts': "new Stripe(key, { apiVersion: '2025-10' });",
    'src/graph.ts': "export const url = 'https://graph.facebook.com/v21.0/me';",
  });
  const exposures = await findDeadlineExposures(root, registry, NOW);
  expect(exposures.map((item) => [item.deadline.id, item.days])).toEqual([
    ['meta-v20', -21],
    ['shopify-2025-10', 1],
    ['openai-gpt-4', 8],
    ['shopify-2026-01', 93],
    ['meta-v21', 98],
  ]);
  const evidence = (id: string) =>
    exposures
      .find((item) => item.deadline.id === id)!
      .evidence.map((item) => `${item.file}:${item.line} ${item.version}`);
  expect(evidence('openai-gpt-4')).toEqual(['src/ai.ts:1 gpt-4', 'src/ai.ts:4 gpt-4-0613']);
  // Stripe's file has no Shopify context, so its apiVersion string is not a Shopify pin.
  expect(evidence('shopify-2025-10')).toEqual(['src/shop.ts:2 2025-10', 'src/shop.ts:4 2025-10']);
  expect(evidence('shopify-2026-01')).toEqual(['src/shop.ts:3 2026-01']);
  expect(evidence('meta-v20')).toEqual(['package.json:3 v20.0']);
  expect(evidence('meta-v21')).toEqual(['src/graph.ts:1 v21.0']);
});

// Noise found by the deadline benchmark (docs/DEADLINE-BENCHMARK.md) in real repositories.
it('ignores pins in comments, tokenizers and prefix checks, and matches URLs ending at the version', async () => {
  const root = await repository({
    'src/ai.ts': [
      '/**',
      ' * @param model The model to use (e.g., "gpt-4").',
      ' */',
      "// const old = openai('gpt-4');",
      "const encoder = encoding_for_model('gpt-4');",
      "if (model.startsWith('gpt-4') || models.includes('gpt-4')) reason();",
      "const chat = { model: 'gpt-4' }; // was 'gpt-4-0613'",
      'const url = "https://example.com/api"; /* \'gpt-4-0613\' */',
    ].join('\n'),
    'src/graph.ts': [
      "const FB = 'https://graph.facebook.com/'; // 'https://graph.facebook.com/v20.0'",
      'const live = `https://graph.facebook.com/v21.0/${id}/media`;',
    ].join('\n'),
    'src/shop.ts': [
      'export const api = axios.create({ baseURL: `https://${shop}/admin/api/2025-10` });',
      '//   const url = `https://${shop}/admin/api/2026-01/orders.json`;',
      "const later = '/admin/api/2026-01.5';",
    ].join('\n'),
  });
  const exposures = await findDeadlineExposures(root, registry, NOW);
  expect(
    exposures.map((item) => [
      item.deadline.id,
      item.evidence.map((evidence) => `${evidence.file}:${evidence.line}`),
    ]),
  ).toEqual([
    ['shopify-2025-10', ['src/shop.ts:1']],
    ['openai-gpt-4', ['src/ai.ts:7']],
    ['meta-v21', ['src/graph.ts:2']],
  ]);
});

it('matches API versions pinned in .refit.json and reports how a migration can follow', async () => {
  const root = await repository({
    'package.json': { dependencies: { openai: '4.80.0' } },
    '.refit.json': {
      formatVersion: 2,
      integrations: [
        { id: 'shop', providerConfig: './refit/shop.provider.json', apiVersion: '2025-10' },
        { id: 'ai', providerConfig: './refit/ai.provider.json' },
      ],
    },
    'refit/shop.provider.json': { id: 'shop', packageName: '@shopify/shopify-api' },
    'refit/ai.provider.json': { id: 'ai', packageName: 'openai' },
  });
  const exposures = await findDeadlineExposures(root, registry, NOW);
  expect(
    exposures.map((item) => item.evidence.map((e) => `${e.file}:${e.line} ${e.kind}`)),
  ).toEqual([['.refit.json:7 refit-configuration']]);
  const integrations = await configuredIntegrations(root);
  expect(agentStatus('openai', integrations)).toEqual({ state: 'configured', integration: 'ai' });
  expect(agentStatus('meta-graph', integrations)).toEqual({ state: 'none' });
  expect(agentStatus('openai', [])).toEqual({ state: 'available' });
});

it('checks the registry shape and flags past-due entries and entries without a source', async () => {
  const report = checkDeadlineRegistry(
    {
      formatVersion: 1,
      deadlines: [
        entry({ id: 'past', provider: 'openai', versions: ['old-model'], date: '2026-01-01' }),
        {
          ...entry({
            id: 'unsourced',
            provider: 'shopify',
            versions: ['2024-01'],
            date: '2027-01-01',
          }),
          source: null,
        },
        {
          ...entry({
            id: 'Bad.Id',
            provider: 'openai',
            versions: ['old-model'],
            date: '2026-02-30',
          }),
          extra: true,
        },
      ],
    },
    NOW,
  );
  expect(report.pastDue).toEqual([{ id: 'past', date: '2026-01-01', days: 287 }]);
  expect(report.missingSource).toEqual(['unsourced']);
  expect(report.errors).toEqual([
    'Bad.Id: unknown fields extra.',
    'Bad.Id: id must be lowercase letters, digits and hyphens.',
    'Bad.Id: old-model already has another deadline.',
    'Bad.Id: date must be a real YYYY-MM-DD date.',
  ]);
  const path = join(await repository({}), 'registry.json');
  await writeFile(
    path,
    JSON.stringify({
      formatVersion: 1,
      deadlines: [
        entry({ id: 'kept', provider: 'openai', versions: ['a'], date: '2027-01-01' }),
        {
          ...entry({ id: 'dropped', provider: 'openai', versions: ['b'], date: '2027-01-01' }),
          source: null,
        },
      ],
    }),
  );
  expect((await loadDeadlineRegistry(path, NOW)).deadlines.map((item) => item.id)).toEqual([
    'kept',
  ]);
});

it('keeps the shipped registry valid and sourced', async () => {
  const shipped = await loadDeadlineRegistry(undefined, NOW);
  const { readFile } = await import('node:fs/promises');
  const report = checkDeadlineRegistry(
    JSON.parse(await readFile(resolve('data/deadlines.json'), 'utf8')),
    NOW,
  );
  expect(report.errors).toEqual([]);
  expect(report.missingSource).toEqual([]);
  expect(new Set(shipped.deadlines.map((item) => item.provider))).toEqual(
    new Set(['shopify', 'meta-graph', 'openai']),
  );
});

it('opens one issue, then updates it with a comment', async () => {
  const request = vi.fn(async (method: string, path: string) =>
    method === 'POST' && path.endsWith('/issues') ? { number: 12 } : {},
  );
  const options = { request, repository: 'example/app', title: 'T', body: 'B', comment: 'C' };
  expect(await syncDeadlineIssue({ ...options, issue: null })).toEqual({
    issue: 12,
    action: 'opened',
  });
  expect(await syncDeadlineIssue({ ...options, issue: 12 })).toEqual({
    issue: 12,
    action: 'updated',
  });
  expect(request.mock.calls).toEqual([
    ['POST', '/repos/example/app/issues', { title: 'T', body: 'B' }],
    ['PATCH', '/repos/example/app/issues/12', { title: 'T', body: 'B' }],
    ['POST', '/repos/example/app/issues/12/comments', { body: 'C' }],
  ]);
});

async function deliverPullRequest(url: string, secret: string) {
  const body = JSON.stringify({
    action: 'synchronize',
    installation: { id: 456 },
    repository: { full_name: 'example/app' },
    pull_request: {
      number: 7,
      base: { sha: 'a'.repeat(40) },
      head: { sha: randomUUID().replaceAll('-', '').padEnd(40, '0') },
    },
  });
  return fetch(`${url}/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
}

it('alerts enrolled repositories through signed-webhook polls at each lead time, deduplicated in state', async () => {
  checkout.directory = await repository({
    'package.json': { dependencies: { openai: '4.80.0' } },
    'src/ai.ts': "export const model = 'gpt-4';\n",
  });
  const state = await mkdtemp(join(tmpdir(), 'refit-deadline-service-'));
  roots.push(state);
  const registryPath = join(await repository({}), 'registry.json');
  await writeFile(registryPath, JSON.stringify(registry));
  const secret = 'webhook-secret-for-deadline-tests-1';
  const control = 'control-token-for-deadline-tests-2';
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
  const operator: ServiceTarget = {
    id: 'operator',
    repository: 'example/operator',
    base: 'main',
    documentationSources: [],
    workflow: {
      repository: undefined,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      latestStripe: undefined,
      image: 'checks:local',
      command: ['npm', 'test'],
      baselineCommand: undefined,
      providerConfig: undefined,
      apiVersion: undefined,
      fullDiff: false,
    },
    source: { kind: 'file', path: resolve('pipeline/fixtures/after.json') },
  };
  const clock = { now: new Date('2026-10-03T12:00:00Z') };
  const base = {
    targets: [enrolled, operator],
    app: { appId: '123', privateKeyFile: 'unused' },
    directory: state,
    port: 0,
    intervalSeconds: 30,
    webhookSecret: secret,
    controlToken: control,
    now: () => clock.now,
  };
  // Off by default: a poll with an exposure opens nothing.
  await runLocalService({ ...base, once: true, signal: new AbortController().signal });
  expect(requests).toEqual([]);

  // An invalid registry skips alerts with a message instead of stopping the service.
  const broken = join(dirname(registryPath), 'broken.json');
  await writeFile(broken, JSON.stringify({ formatVersion: 1, deadlines: [{ id: 'Bad' }] }));
  const progress: string[] = [];
  await runLocalService({
    ...base,
    deadlineAlerts: { leadDays: [90, 30, 7], registry: broken },
    once: true,
    signal: new AbortController().signal,
    onProgress: (message) => progress.push(message),
  });
  expect(requests).toEqual([]);
  expect(
    progress.some((message) => message.startsWith('Deadline alerts skipped: PipelineInputError')),
  ).toBe(true);

  const deadlineAlerts = { leadDays: [90, 30, 7], registry: registryPath };
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const address = new Promise<string>((resolve) => (ready = resolve));
  const status = async (url: string) =>
    (await (
      await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${control}` } })
    ).json()) as {
      deadlineAlerts?: Record<string, { issue: number; stage: number; status: string }>;
    };
  const settle = async (
    url: string,
    check: (registry: Awaited<ReturnType<typeof status>>) => boolean,
  ) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const registry = await status(url);
      if (check(registry)) return registry;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return status(url);
  };
  const completion = runLocalService({
    ...base,
    deadlineAlerts,
    signal: controller.signal,
    onReady: ready,
  });
  try {
    const url = await address;
    // 20 days left: the startup poll opens one issue at the 30-day stage.
    let registryState = await settle(
      url,
      (value) => value.deadlineAlerts?.['example/app|openai-gpt-4']?.stage === 30,
    );
    expect(registryState.deadlineAlerts).toEqual({
      'example/app|openai-gpt-4': expect.objectContaining({
        issue: 41,
        stage: 30,
        status: 'opened',
      }),
    });
    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      'POST /repos/example/app/issues',
    ]);
    const opened = requests[0].body as { title: string; body: string };
    expect(opened.title).toBe('OpenAI model gpt-4 reaches its sunset on 2026-10-23');
    expect(opened.body).toContain(`https://github.com/example/app/blob/${REVISION}/src/ai.ts#L1`);
    expect(opened.body).toContain('Add it with `refit agents --add openai`');

    // Same stage on the next webhook-driven poll: nothing new.
    expect((await deliverPullRequest(url, secret)).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toHaveLength(1);

    // 5 days left: the 7-day stage updates the same issue and comments.
    clock.now = new Date('2026-10-18T12:00:00Z');
    expect((await deliverPullRequest(url, secret)).status).toBe(202);
    registryState = await settle(
      url,
      (value) => value.deadlineAlerts?.['example/app|openai-gpt-4']?.stage === 7,
    );
    expect(registryState.deadlineAlerts?.['example/app|openai-gpt-4']).toEqual(
      expect.objectContaining({ issue: 41, stage: 7, status: 'updated' }),
    );
    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      'POST /repos/example/app/issues',
      'PATCH /repos/example/app/issues/41',
      'POST /repos/example/app/issues/41/comments',
    ]);
    expect((requests[2].body as { body: string }).body).toBe(
      '5 days left until 2026-10-23. Refit refreshed the evidence above.',
    );
  } finally {
    controller.abort();
    await completion;
  }
  // State survives a restart: the same stage does not alert again, and the operator-workflow target
  // never alerts because only enrolled repositories do.
  await runLocalService({
    ...base,
    deadlineAlerts,
    once: true,
    signal: new AbortController().signal,
  });
  expect(requests).toHaveLength(3);
  expect(requests.some((item) => item.path.includes('example/operator'))).toBe(false);
}, 30_000);

it('renders the deadline issue with evidence, the replacement and the migration path', () => {
  const exposure = {
    deadline: registry.deadlines[0],
    days: -2,
    evidence: [
      {
        file: 'src/a b.ts',
        line: 3,
        kind: 'source' as const,
        version: 'gpt-4',
        text: 'model: `gpt-4`',
      },
    ],
    more: 2,
  };
  expect(deadlineTitle(exposure)).toBe('OpenAI model gpt-4 passed its sunset on 2026-10-23');
  const body = deadlineBody({
    exposure,
    repository: 'example/app',
    revision: null,
    status: { state: 'none' },
    leadDays: [90, 30, 7],
  });
  expect(body).toContain('<!-- refit-deadline:openai-gpt-4 -->');
  expect(body).toContain('| Deadline | 2026-10-23 (passed 2 days ago) |');
  expect(body).toContain("- `src/a b.ts:3`: `model: 'gpt-4'`");
  expect(body).toContain('…and 2 more matches.');
  expect(body).toContain('Refit has no OpenAI agent yet');
});

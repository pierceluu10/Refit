import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  alertDue,
  alertStage,
  deadlineBody,
  deadlineTitle,
  parseLeadDays,
  syncDeadlineIssue,
} from './deadline-alerts.ts';
import {
  agentStatus,
  configuredIntegrations,
  findDeadlineExposures,
  scanDeadlines,
} from './deadline-exposure.ts';
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
vi.mock('./service-worker.ts', async (original) => ({
  ...(await original<typeof import('./service-worker.ts')>()),
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

// How each OpenAI match is used. Only live matches count toward exposure and alerts; the rest are
// classified, not dropped.
const classifying: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    ...registry.deadlines,
    entry({ id: 'openai-o1', provider: 'openai', versions: ['o1'], date: '2026-10-23' }),
    entry({
      id: 'openai-dall-e-3',
      provider: 'openai',
      versions: ['dall-e-3'],
      date: '2026-10-23',
    }),
    entry({
      id: 'anthropic-claude-3-opus',
      provider: 'anthropic',
      kind: 'model',
      versions: ['claude-3-opus-20240229'],
      date: '2026-11-30',
    }),
  ],
};

async function uses(files: Record<string, string>) {
  const scan = await scanDeadlines(await repository(files), classifying, NOW);
  const result: Record<string, string> = {};
  for (const exposure of [...scan.exposures, ...scan.mentions])
    for (const item of [...exposure.evidence, ...exposure.nonLive])
      result[`${item.file}:${item.line} ${item.version}`] = item.use;
  return { scan, result };
}

it('keeps live OpenAI calls live, including lookalikes of lists, tests and checks', async () => {
  const { result } = await uses({
    'src/chat.ts': [
      "await openai.chat.completions.create({ model: 'gpt-4', messages });",
      "const model = process.env.MODEL || 'gpt-4';",
      "export enum Model { Default = 'gpt-4' }",
      // Two models are not yet a list.
      "const pair = ['gpt-4', 'gpt-4o'];",
      // An alias map's string values are what the code sends.
      "const aliases = { 'openai/gpt-4': 'gpt-4', 'gpt-4-0613': 'gpt-4-0613', four: 'gpt-4o' };",
      // Several models as values of one request or settings object are not a table.
      "const settings = { chat: 'gpt-4', fallback: 'gpt-4-0613', vision: 'gpt-4o' };",
      "const picked = models.find((m) => m === input) ?? 'gpt-4';",
    ].join('\n'),
    // Paths that only look like tests or examples.
    'src/contest/run.ts': "send({ model: 'gpt-4' });",
    'src/attestation.ts': "send({ model: 'gpt-4' });",
    'src/exampleData.ts': "send({ model: 'gpt-4' });",
    'src/latest.ts': "send({ model: 'gpt-4' });",
  });
  expect(result).toEqual({
    'src/chat.ts:1 gpt-4': 'live',
    'src/chat.ts:2 gpt-4': 'live',
    'src/chat.ts:3 gpt-4': 'live',
    'src/chat.ts:4 gpt-4': 'live',
    'src/chat.ts:5 gpt-4': 'live',
    'src/chat.ts:5 gpt-4-0613': 'live',
    'src/chat.ts:6 gpt-4': 'live',
    'src/chat.ts:6 gpt-4-0613': 'live',
    'src/chat.ts:7 gpt-4': 'live',
    'src/contest/run.ts:1 gpt-4': 'live',
    'src/attestation.ts:1 gpt-4': 'live',
    'src/exampleData.ts:1 gpt-4': 'live',
    'src/latest.ts:1 gpt-4': 'live',
  });
});

it('classifies OpenAI model lists, type unions, tables and pickers as catalog', async () => {
  const { result } = await uses({
    'src/models.ts': [
      "export const MODELS = ['gpt-4', 'gpt-4o', 'o3'] as const;",
      'export type ChatModel =',
      "  | 'gpt-4-0613'",
      "  | 'gpt-4o';",
      'export interface Options { model: "gpt-4" }',
      'export const PRICES = {',
      "  'gpt-4': { input: 30, output: 60 },",
      "  'o1': { id: 'o1', context: 200_000 },",
      '};',
      'export const PICKER = [',
      "  { id: 'gpt-4', label: 'GPT-4' },",
      "  { id: 'openai/gpt-4o', label: 'GPT-4o' },",
      "  { id: 'openai/o3', label: 'o3' },",
      '];',
      "export enum Known { A = 'gpt-4', B = 'gpt-4o', C = 'o3' }",
      "const price = PRICES['gpt-4-0613'];",
      'const html = `<option value="gpt-4">GPT-4</option>`;',
    ].join('\n'),
    'src/Picker.tsx': 'export const Pick = () => <option value="o1">o1</option>;',
  });
  expect(result).toEqual({
    'src/models.ts:1 gpt-4': 'catalog',
    'src/models.ts:3 gpt-4-0613': 'catalog',
    'src/models.ts:5 gpt-4': 'catalog',
    'src/models.ts:7 gpt-4': 'catalog',
    'src/models.ts:8 o1': 'catalog',
    'src/models.ts:11 gpt-4': 'catalog',
    'src/models.ts:15 gpt-4': 'catalog',
    'src/models.ts:16 gpt-4-0613': 'catalog',
    'src/models.ts:17 gpt-4': 'catalog',
    'src/Picker.tsx:1 o1': 'catalog',
  });
});

it('classifies model-keyed map entries wrapped in satisfies, as, parentheses or assertions as catalog', async () => {
  // The inner key is `model`, not a descriptor key, so only the wrapper unwrap can make these catalog.
  const value = "{ model: 'gpt-4', fallback: 'gpt-4-0613', context: 8192 }";
  const { result } = await uses({
    'src/map.ts': [
      `export const A = { 'gpt-4': ${value} satisfies Model<'x'> };`,
      `export const B = { 'gpt-4': ${value} as const };`,
      `export const C = { 'gpt-4': (${value}) };`,
      `export const D = { 'gpt-4': <Model>${value} };`,
      `export const E = { 'gpt-4': ${value} as const satisfies Model<'x'> };`,
      // A key that is not a model names a request, not a table entry.
      "export const F = { chat: { model: 'gpt-4' } satisfies Model };",
    ].join('\n'),
  });
  expect(result).toEqual({
    'src/map.ts:1 gpt-4': 'catalog',
    'src/map.ts:1 gpt-4-0613': 'catalog',
    'src/map.ts:2 gpt-4': 'catalog',
    'src/map.ts:2 gpt-4-0613': 'catalog',
    'src/map.ts:3 gpt-4': 'catalog',
    'src/map.ts:3 gpt-4-0613': 'catalog',
    'src/map.ts:4 gpt-4': 'catalog',
    'src/map.ts:4 gpt-4-0613': 'catalog',
    'src/map.ts:5 gpt-4': 'catalog',
    'src/map.ts:5 gpt-4-0613': 'catalog',
    'src/map.ts:6 gpt-4': 'live',
  });
});

it('classifies model records and versions arrays as catalog and keeps request and descriptor keys live', async () => {
  // [model, source line, use]. Each line holds one match, so each line is its own result.
  const cases: [string, string, string][] = [
    ['gpt-4', "export const A = { name: 'gpt-4', context_window: 8192 };", 'catalog'],
    // An `id` or `name` counts as a catalog entry only beside a metadata field (#143), so a bare
    // descriptor may still be what a wrapper sends.
    ['gpt-4', "export const B = openAIModelRef({ name: 'gpt-4', info });", 'live'],
    ['gpt-4', "export const C = { id: 'gpt-4', displayName: 'GPT-4' };", 'live'],
    ['gpt-4', "export const D = { label: 'gpt-4' };", 'live'],
    ['gpt-4', "export const E = { title: 'gpt-4' };", 'live'],
    ['gpt-4', "export const F = { slug: 'gpt-4' };", 'live'],
    ['gpt-4', "export const G = { versions: ['gpt-4'] };", 'catalog'],
    ['gpt-4', "export const H = { versions: ['gpt-4', 'o1-mini'] as const };", 'catalog'],
    [
      'claude-3-opus-20240229',
      "export const I = createClaudeModelConfig({ id: 'claude-3-opus-20240229', displayName });",
      'live',
    ],
    // Wrappers send these keys to the provider.
    ['gpt-4', "export const J = { model: 'gpt-4' };", 'live'],
    ['gpt-4', "export const K = { modelName: 'gpt-4' };", 'live'],
    ['gpt-4', "export const L = { modelId: 'gpt-4' };", 'live'],
    ['gpt-4', "export const M = { version: 'gpt-4' };", 'live'],
    ['gpt-4', "export const N = { default: 'gpt-4' };", 'live'],
    // A picker's `value` is what the picker sets, so it is not a descriptor key.
    ['gpt-4', "export const O = { value: 'gpt-4', label: 'GPT-4' };", 'live'],
    // Only an array lists versions, and only a whole value is a descriptor.
    ['gpt-4', "export const P = { versions: 'gpt-4' };", 'live'],
    ['gpt-4', "export const Q = { id: flag ? 'gpt-4' : 'o1-mini' };", 'live'],
  ];
  const { result } = await uses({
    'src/models.ts': cases.map(([, line]) => line).join('\n'),
    // Every element of a versions array is an entry, not only the first.
    'src/versions.ts': "export const R = { versions: ['gpt-4', 'gpt-4-0613'] };",
  });
  expect(result).toEqual({
    ...Object.fromEntries(
      cases.map(([model, , use], index) => [`src/models.ts:${index + 1} ${model}`, use]),
    ),
    'src/versions.ts:1 gpt-4': 'catalog',
    'src/versions.ts:1 gpt-4-0613': 'catalog',
  });
});

it('classifies model IDs inside longer plain strings as prose, but keeps templates, concatenations and JSON model keys live', async () => {
  // [model, source line, use]
  const cases: [string, string, string][] = [
    ['dall-e-3', `export const A = 'Image model to use (e.g. "dall-e-3")';`, 'comment'],
    ['gpt-4', `export const B = 'Model "gpt-4" is deprecated';`, 'comment'],
    ['gpt-4', 'export const C = `Model "gpt-4" only`;', 'comment'],
    [
      'claude-3-opus-20240229',
      `export const D = 'Claude model ("claude-3-opus-20240229")';`,
      'comment',
    ],
    // The word "model" earlier in the text is not a key set just before the ID.
    ['gpt-4', `export const E = 'The model setting: use "gpt-4" here';`, 'comment'],
    // Exactly the model ID is what the code sends.
    ['gpt-4', "export const F = 'gpt-4';", 'live'],
    // JSON and config text that sets a model key can be sent as it is.
    ['gpt-4', `export const G = '{"model":"gpt-4","messages":[]}';`, 'live'],
    ['gpt-4', 'export const H = `{ "model": "gpt-4" }`;', 'live'],
    ['gpt-4', `export const I = '{"modelName": "gpt-4"}';`, 'live'],
    // A CLI flag, an upper-case environment variable and a snake-case key.
    ['gpt-4', `export const P = execSync('codex --model "gpt-4" run');`, 'live'],
    ['gpt-4', `export const Q = 'OPENAI_MODEL="gpt-4"\\n';`, 'live'],
    ['gpt-4', `export const R = '{"model_id": "gpt-4", "x": 1}';`, 'live'],
    ['gpt-4', `export const S = 'run -m "gpt-4" now';`, 'live'],
    // JSON text is data: a retiring ID anywhere in it stays live (D-18).
    ['gpt-4', `export const U = '{"model": "x", "fallback": "gpt-4"}';`, 'live'],
    ['gpt-4', `export const V = '{"list": ["gpt-4"]}';`, 'live'],
    ['gpt-4', `export const W = JSON.parse('{"engine":"gpt-4"}');`, 'live'],
    // A key word that is not directly before the ID stays prose.
    ['gpt-4', `export const T = 'The model_id field says "gpt-4" here';`, 'comment'],
    // Template pieces (head, middle, tail) and concatenated strings can build the value sent.
    ['gpt-4', 'export const J = `Model "gpt-4" only for ${user}`;', 'live'],
    ['gpt-4', 'export const K = `For ${user} the model "gpt-4" or ${other}`;', 'live'],
    ['gpt-4', 'export const L = `For ${user} only "gpt-4"`;', 'live'],
    ['gpt-4', `export const M = 'Model "gpt-4" ' + suffix;`, 'live'],
    ['gpt-4', `export const N = ('Model "gpt-4" ') + suffix;`, 'live'],
    ['gpt-4', `message += 'Model "gpt-4" ';`, 'live'],
  ];
  const { result } = await uses({
    // The last line is never prose, and the prose rule adds no match of its own.
    'src/prose.ts': [...cases.map(([, line]) => line), 'export const O = `gpt-4-${suffix}`;'].join(
      '\n',
    ),
    'src/Note.tsx': 'export const Note = () => <p>Uses "gpt-4"</p>;',
    // Meta and Shopify matches in strings are classified as before, including a descriptor key.
    'src/graph.ts': [
      "export const url = 'https://graph.facebook.com/v21.0/me';",
      "export const api = { name: 'v21.0' };",
    ].join('\n'),
    'src/shop.ts': "fetch('https://example.myshopify.com/admin/api/2025-10/orders.json');",
  });
  const { [`src/prose.ts:${cases.length + 1} gpt-4`]: unmatched, ...rest } = result;
  expect(rest).toEqual({
    ...Object.fromEntries(
      cases.map(([model, , use], index) => [`src/prose.ts:${index + 1} ${model}`, use]),
    ),
    'src/Note.tsx:1 gpt-4': 'live',
    'src/graph.ts:1 v21.0': 'live',
    'src/graph.ts:2 v21.0': 'live',
    'src/shop.ts:1 2025-10': 'live',
  });
  expect([undefined, 'live']).toContain(unmatched);
});

it('classifies model records, versions lists and constant objects as catalog', async () => {
  const { result } = await uses({
    'src/models.ts': [
      // Entries keyed by model, also behind `satisfies`.
      'export const MODELS = {',
      "  'gpt-4': { id: 'gpt-4', contextWindow: 8192 } satisfies Model,",
      '};',
      "const O1 = { name: 'o1', context_window: 200_000, max_output_tokens: 100_000 };",
      "const listed = { id: 'gpt-4-0613', object: 'model', owned_by: 'system' };",
      "const ref = modelRef({ name: 'openai/gpt-4', info: { versions: ['gpt-4-0613'] } });",
      "export const OPENAI = { GPT_4: 'gpt-4', GPT_4O: 'gpt-4o', O3: 'o3' };",
      // Requests and settings stay live: `model` is no record name and these keys are not
      // constant case.
      "send({ model: 'gpt-4', max_output_tokens: 100 });",
      "const record = { id: 'gpt-4', label: 'GPT-4' };",
      "const defaults = { CHAT: 'gpt-4', fast: 'gpt-4o', O3: 'o3' };",
      "const few = { GPT_4: 'gpt-4', GPT_4O: 'gpt-4o' };",
    ].join('\n'),
  });
  expect(result).toEqual({
    'src/models.ts:2 gpt-4': 'catalog',
    'src/models.ts:4 o1': 'catalog',
    'src/models.ts:5 gpt-4-0613': 'catalog',
    'src/models.ts:6 gpt-4-0613': 'catalog',
    'src/models.ts:7 gpt-4': 'catalog',
    'src/models.ts:8 gpt-4': 'live',
    'src/models.ts:9 gpt-4': 'live',
    'src/models.ts:10 gpt-4': 'live',
    'src/models.ts:11 gpt-4': 'live',
  });
});

it('classifies OpenAI tests, examples, comments, tokenizers and checks', async () => {
  const call = "send({ model: 'gpt-4' });";
  const { result } = await uses({
    'src/models.test.ts': call,
    'src/__tests__/chat.ts': call,
    'test/chat.ts': call,
    'examples/chat.ts': call,
    'src/Picker.stories.tsx': call,
    'fixtures/chat.ts': call,
    'src/chat.ts': [
      '/** @param model The model, such as "gpt-4". */',
      "// send({ model: 'gpt-4-0613' });",
      "const tokens = encoding_for_model('gpt-4');",
      "const count = encodingForModel('gpt-4-0613');",
      "if (model === 'gpt-4' || model.startsWith('o1')) reason();",
      'switch (model) {',
      "  case 'gpt-4-0613':",
      '}',
    ].join('\n'),
  });
  expect(result).toEqual({
    'src/models.test.ts:1 gpt-4': 'test',
    'src/__tests__/chat.ts:1 gpt-4': 'test',
    'test/chat.ts:1 gpt-4': 'test',
    'examples/chat.ts:1 gpt-4': 'test',
    'src/Picker.stories.tsx:1 gpt-4': 'test',
    'fixtures/chat.ts:1 gpt-4': 'test',
    'src/chat.ts:1 gpt-4': 'comment',
    'src/chat.ts:2 gpt-4-0613': 'comment',
    'src/chat.ts:3 gpt-4': 'tokenizer',
    'src/chat.ts:4 gpt-4-0613': 'tokenizer',
    'src/chat.ts:5 gpt-4': 'check',
    'src/chat.ts:5 o1': 'check',
    'src/chat.ts:7 gpt-4-0613': 'check',
  });
});

// Anthropic retires models like OpenAI, so its matches get the same use classes. Only exact
// Claude API IDs match: Bedrock and Google Cloud IDs follow the partner's own schedule.
it('matches and classifies Anthropic model IDs like OpenAI ones', async () => {
  const anthropic: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      ...classifying.deadlines,
      entry({
        id: 'anthropic-sonnet-4-5',
        provider: 'anthropic',
        kind: 'model',
        versions: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
        date: '2026-11-30',
        replacement: 'claude-sonnet-5-5',
      }),
      entry({
        id: 'anthropic-claude-2',
        provider: 'anthropic',
        kind: 'model',
        versions: ['claude-2.1'],
        date: '2025-07-21',
      }),
    ],
  };
  const scan = await scanDeadlines(
    await repository({
      'src/claude.ts': [
        "import Anthropic from '@anthropic-ai/sdk';",
        "await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages });",
        "const fallback = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-5-20250929';",
        "const legacy = { model: 'claude-2.1' };",
        // Mixed-provider pickers are catalogs.
        "export const MODELS = ['claude-sonnet-4-5', 'gpt-4o', 'anthropic/claude-3-opus'];",
        "if (model === 'claude-2.1') reason();",
        "// model: 'claude-sonnet-4-5-20250929'",
        // Partner IDs and other dated snapshots are not Claude API pins.
        "const bedrock = 'anthropic.claude-sonnet-4-5-20250929-v1:0';",
        "const vertex = 'claude-sonnet-4-5@20250929';",
        "const newer = 'claude-sonnet-4-5-20991231';",
      ].join('\n'),
      'src/claude.test.ts': "send({ model: 'claude-sonnet-4-5' });",
    }),
    anthropic,
    NOW,
  );
  const result: Record<string, string> = {};
  for (const exposure of [...scan.exposures, ...scan.mentions])
    for (const item of [...exposure.evidence, ...exposure.nonLive])
      result[`${item.file}:${item.line} ${item.version}`] = item.use;
  expect(result).toEqual({
    'src/claude.ts:2 claude-sonnet-4-5': 'live',
    'src/claude.ts:3 claude-sonnet-4-5-20250929': 'live',
    'src/claude.ts:4 claude-2.1': 'live',
    'src/claude.ts:5 claude-sonnet-4-5': 'catalog',
    'src/claude.ts:6 claude-2.1': 'check',
    'src/claude.ts:7 claude-sonnet-4-5-20250929': 'comment',
    'src/claude.test.ts:1 claude-sonnet-4-5': 'test',
  });
  expect(scan.exposures.map((item) => [item.deadline.id, item.deadline.provider])).toEqual([
    ['anthropic-claude-2', 'anthropic'],
    ['anthropic-sonnet-4-5', 'anthropic'],
  ]);
  expect(deadlineTitle(scan.exposures[1])).toBe(
    'Anthropic models claude-sonnet-4-5, claude-sonnet-4-5-20250929 reaches its sunset on 2026-11-30',
  );
});

// Claude Code-style model configs list one model's IDs per platform, and capability sets name a
// couple of models for `.has(model)`: both describe models rather than send one.
it('classifies platform records and membership collections as catalog', async () => {
  const anthropic: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      ...classifying.deadlines,
      entry({
        id: 'anthropic-sonnet-4-5',
        provider: 'anthropic',
        kind: 'model',
        versions: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
        date: '2026-11-30',
        replacement: 'claude-sonnet-5-5',
      }),
    ],
  };
  const scan = await scanDeadlines(
    await repository({
      'src/configs.ts': [
        'export const CLAUDE_SONNET_4_5_CONFIG = {',
        "  firstParty: 'claude-sonnet-4-5-20250929',",
        "  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',",
        "  vertex: 'claude-sonnet-4-5@20250929',",
        "  foundry: 'claude-sonnet-4-5',",
        '} as const;',
        "const small = new Set(['claude-sonnet-4-5', 'gpt-4']);",
        "const limits = new Map([['gpt-4', 8192]]);",
        // No platform form: a request and a settings object with two models stay live.
        "send({ model: 'claude-sonnet-4-5', fallback: 'claude-sonnet-4-5-20250929' });",
        "const pair = ['claude-sonnet-4-5', 'gpt-4'];",
      ].join('\n'),
    }),
    anthropic,
    NOW,
  );
  const result: Record<string, string> = {};
  for (const exposure of [...scan.exposures, ...scan.mentions])
    for (const item of [...exposure.evidence, ...exposure.nonLive])
      result[`${item.file}:${item.line} ${item.version}`] = item.use;
  expect(result).toEqual({
    'src/configs.ts:2 claude-sonnet-4-5-20250929': 'catalog',
    'src/configs.ts:5 claude-sonnet-4-5': 'catalog',
    'src/configs.ts:7 claude-sonnet-4-5': 'catalog',
    'src/configs.ts:7 gpt-4': 'catalog',
    'src/configs.ts:8 gpt-4': 'catalog',
    'src/configs.ts:9 claude-sonnet-4-5': 'live',
    'src/configs.ts:9 claude-sonnet-4-5-20250929': 'live',
    'src/configs.ts:10 claude-sonnet-4-5': 'live',
    'src/configs.ts:10 gpt-4': 'live',
  });
});

// Gemini entries for tests only: the model IDs are from the SDK READMEs, the dates are invented.
const gemini: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    ...classifying.deadlines,
    entry({
      id: 'gemini-flash',
      provider: 'gemini',
      kind: 'model',
      versions: ['gemini-1.5-flash'],
      date: '2026-11-30',
    }),
    entry({
      id: 'gemini-pro',
      provider: 'gemini',
      kind: 'model',
      versions: ['gemini-1.5-pro'],
      date: '2026-09-24',
    }),
    entry({
      id: 'gemini-old-sdk',
      provider: 'gemini',
      kind: 'sdk',
      versions: ['@google/generative-ai'],
      date: '2025-11-30',
      replacement: '@google/genai',
    }),
  ],
};

async function geminiUses(files: Record<string, unknown>) {
  const scan = await scanDeadlines(await repository(files), gemini, NOW);
  const result: Record<string, string> = {};
  for (const exposure of [...scan.exposures, ...scan.mentions])
    for (const item of [...exposure.evidence, ...exposure.nonLive])
      result[`${item.file}:${item.line} ${item.version}`] = `${item.kind} ${item.use}`;
  return { scan, result };
}

it('matches Gemini model pins in both SDK shapes with the OpenAI use classes', async () => {
  expect(checkDeadlineRegistry(gemini, NOW).errors).toEqual([]);
  const { scan, result } = await geminiUses({
    // The call shapes in the @google/genai and @google/generative-ai READMEs.
    'src/genai.ts': [
      "import { GoogleGenAI } from '@google/genai';",
      'const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });',
      "await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: 'Why?' });",
      "await ai.models.generateContentStream({ model: 'models/gemini-1.5-pro', contents });",
      "export const MODELS = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];",
      "export const MIXED = ['gemini-1.5-pro', 'gpt-4o', 'claude-sonnet-4-5'];",
      "if (model === 'gemini-1.5-pro') legacy();",
      "// model: 'gemini-1.5-flash'",
      // Router, Vertex AI resource and other snapshot IDs are not Gemini API pins.
      "const routed = 'google/gemini-1.5-flash';",
      "const vertex = 'publishers/google/models/gemini-1.5-flash';",
      "const snapshot = 'gemini-1.5-flash-002';",
    ].join('\n'),
    'src/legacy.js': [
      "const { GoogleGenerativeAI } = require('@google/generative-ai');",
      'const genAI = new GoogleGenerativeAI(process.env.API_KEY);',
      "const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });",
    ].join('\n'),
    'src/legacy.test.js': "genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });",
    // Gemini-shaped IDs do not turn a pair of OpenAI models into a list.
    'src/openai.ts': "const pair = ['gpt-4', 'gpt-4o', 'gemini-2.0-flash'];",
  });
  expect(result).toEqual({
    'src/genai.ts:3 gemini-1.5-flash': 'source live',
    'src/genai.ts:4 gemini-1.5-pro': 'source live',
    'src/genai.ts:5 gemini-1.5-flash': 'source catalog',
    'src/genai.ts:6 gemini-1.5-pro': 'source catalog',
    'src/genai.ts:7 gemini-1.5-pro': 'source check',
    'src/genai.ts:8 gemini-1.5-flash': 'source comment',
    'src/legacy.js:3 gemini-1.5-flash': 'source live',
    'src/legacy.test.js:1 gemini-1.5-pro': 'source test',
    'src/openai.ts:1 gpt-4': 'source live',
  });
  expect(scan.exposures.map((item) => item.deadline.id)).toEqual([
    'gemini-pro',
    'openai-gpt-4',
    'gemini-flash',
  ]);
  expect(deadlineTitle(scan.exposures[2])).toBe(
    'Gemini model gemini-1.5-flash reaches its sunset on 2026-11-30',
  );
  expect(agentStatus('gemini', [])).toEqual({ state: 'none' });
});

it('reports a declared SDK package whose support ended, outside tests and examples', async () => {
  const legacy = "const { GoogleGenerativeAI } = require('@google/generative-ai');";
  const { scan, result } = await geminiUses({
    'package.json': { name: 'app', dependencies: { '@google/generative-ai': '^0.21.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@google/generative-ai': '^0.21.0' } },
        'node_modules/@google/generative-ai': { version: '0.21.0' },
      },
    },
    'examples/demo/package.json': {
      name: 'demo',
      dependencies: { '@google/generative-ai': '0.24.1' },
    },
    'src/legacy.js': legacy,
  });
  expect(result).toEqual({
    'package.json:4 @google/generative-ai': 'dependency live',
    'examples/demo/package.json:4 @google/generative-ai': 'dependency test',
  });
  const [exposure] = scan.exposures;
  expect(exposure.deadline.id).toBe('gemini-old-sdk');
  expect(exposure.days).toBeLessThan(0);
  expect(exposure.evidence[0].text).toBe(
    '@google/generative-ai 0.21.0 (locked in package-lock.json) is declared in dependencies',
  );
  expect(deadlineTitle(exposure)).toBe(
    'Gemini package @google/generative-ai passed its sunset on 2025-11-30',
  );
  // A manifest whose package no source file names is not read a second time, and the new SDK is
  // not the old one.
  const unused = await geminiUses({
    'package.json': {
      name: 'app',
      dependencies: { '@google/generative-ai': '0.24.1', '@google/genai': '2.30.0' },
    },
    'src/genai.ts': "import { GoogleGenAI } from '@google/genai';",
  });
  expect(unused.result).toEqual({});
});

it('rests exposure on live evidence and keeps the rest as separate, capped non-live evidence', async () => {
  const { scan } = await uses({
    // o1 only appears in a list: a mention, not an exposure.
    'src/models.ts': `export const MODELS = [${Array.from({ length: 25 }, (_, index) => `'gpt-4o-${index}'`).join(', ')}, 'o1', 'gpt-4'];`,
    // A live and a commented match on one line count once, as live.
    'src/chat.ts': "send({ model: 'gpt-4' }); // was 'gpt-4'",
    'src/more.ts': [
      'export const MORE = [',
      ...Array.from({ length: 22 }, () => "'gpt-4-0613', 'gpt-4o', 'o3',"),
      '];',
    ].join('\n'),
  });
  expect(scan.exposures.map((item) => item.deadline.id)).toEqual(['openai-gpt-4']);
  const [exposure] = scan.exposures;
  expect(exposure.evidence.map((item) => `${item.file}:${item.line} ${item.use}`)).toEqual([
    'src/chat.ts:1 live',
  ]);
  expect(exposure.nonLive).toHaveLength(20);
  expect(exposure.nonLive.every((item) => item.use === 'catalog')).toBe(true);
  expect(exposure.nonLiveMore).toBe(3);
  expect(
    scan.mentions.map((item) => [item.deadline.id, item.evidence, item.nonLive.length]),
  ).toEqual([['openai-o1', [], 1]]);
  // The service alerts from findDeadlineExposures, which never returns a mention.
  expect(
    await findDeadlineExposures(
      await repository({ 'src/models.ts': "type M = 'o1';" }),
      classifying,
      NOW,
    ),
  ).toEqual([]);
});

it('counts every non-live match by use before the evidence cap', async () => {
  const { scan } = await uses({
    // 25 catalog matches on separate lines, past the limit of 20 listed matches.
    'src/models.ts': Array.from(
      { length: 25 },
      (_, index) => `export const LIST${index} = ['gpt-4', 'gpt-4o', 'o3'];`,
    ).join('\n'),
    'src/chat.ts': "send({ model: 'gpt-4' });",
    'src/chat.test.ts': "send({ model: 'gpt-4' });",
    'src/note.ts': "// send({ model: 'gpt-4' });",
    // o1 only appears in a list: a mention, not an exposure.
    'src/o1.ts': "export const LIST = ['o1', 'gpt-4o', 'o3'];",
  });
  const [exposure] = scan.exposures;
  expect(exposure.deadline.id).toBe('openai-gpt-4');
  expect(exposure.nonLive).toHaveLength(20);
  expect(exposure.nonLiveMore).toBe(7);
  expect(exposure.nonLiveCounts).toEqual({ catalog: 25, test: 1, comment: 1 });
  expect(scan.mentions.map((item) => [item.deadline.id, item.nonLiveCounts])).toEqual([
    ['openai-o1', { catalog: 1 }],
  ]);
  for (const item of [...scan.exposures, ...scan.mentions])
    expect(item.nonLiveCounts).toBeDefined();

  // No non-live match is an empty object, not a missing field; no match at all is no entry.
  const live = await scanDeadlines(
    await repository({ 'src/live.ts': "send({ model: 'gpt-4' });" }),
    classifying,
    NOW,
  );
  expect(live.exposures.map((item) => item.nonLiveCounts)).toEqual([{}]);
  const none = await scanDeadlines(
    await repository({ 'src/ok.ts': "send({ model: 'gpt-5' });" }),
    classifying,
    NOW,
  );
  expect(none).toEqual({ exposures: [], mentions: [] });
});

it('classifies each of two matches on one line, and a live match hides non-live ones of its own version', async () => {
  const { scan, result } = await uses({
    'src/line.ts': "if (model === 'gpt-4') send({ model: 'gpt-4-0613' }); // was 'gpt-4-0613'",
  });
  expect(result).toEqual({ 'src/line.ts:1 gpt-4': 'check', 'src/line.ts:1 gpt-4-0613': 'live' });
  expect(scan.exposures.map((item) => item.nonLiveCounts)).toEqual([{ check: 1 }]);
});

it('prints the exact non-live count for each use on the terminal', async () => {
  const registryRoot = await repository({ 'registry.json': classifying });
  // Files are read in name order, so the 25 catalog lines fill the 20 listed places and the comment
  // in c.ts is counted but not listed.
  const root = await repository({
    'src/a.ts': Array.from(
      { length: 25 },
      (_, index) => `export const LIST${index} = ['gpt-4', 'gpt-4o', 'o3'];`,
    ).join('\n'),
    'src/b.ts': "send({ model: 'gpt-4' });",
    'src/c.ts': "// send({ model: 'gpt-4' });",
    'src/o1.ts': "export const LIST = ['o1', 'gpt-4o', 'o3'];",
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    resolve('bin/refit.mjs'),
    'deadlines',
    '--repository',
    root,
    '--registry',
    join(registryRoot, 'registry.json'),
  ]);
  // One line per use: the label, the use, its exact count, then the places that are listed. The
  // count stays exact past the limit, and a use with no listed place still gets a line.
  expect(stdout).toMatch(/Not live\s+catalog\s+25\s+src\/a\.ts:1,2,3/);
  expect(stdout).toMatch(/^\s+comment\s+1$/m);
  expect(stdout).toMatch(/^\s+…and 6 more$/m);
  expect(stdout).toMatch(
    /Named only outside live code[\s\S]*Not live\s+catalog\s+1\s+src\/o1\.ts:1/,
  );
});

it('leaves Meta and Shopify matching as it was, apart from listing comments', async () => {
  const { result } = await uses({
    'test/graph.ts': [
      "const base = 'https://graph.facebook.com/v20.0/';",
      "if (version === 'v21.0') upgrade();",
      "// fetch('https://graph.facebook.com/v21.0/me')",
    ].join('\n'),
    'src/shop.ts': [
      "import '@shopify/shopify-api';",
      "export const VERSIONS = ['2025-10', '2026-01', '2025-07'].map((v) => `/admin/api/${v}`);",
      "if (url.includes('/admin/api/2025-10/')) retry();",
    ].join('\n'),
  });
  expect(result).toEqual({
    'test/graph.ts:1 v20.0': 'live',
    'test/graph.ts:2 v21.0': 'live',
    'test/graph.ts:3 v21.0': 'comment',
    'src/shop.ts:3 2025-10': 'check',
  });
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

it('reads .refit.json and adapters only as regular files inside the repository', async () => {
  const outside = await repository({ 'secret.provider.json': { packageName: 'openai' } });
  const root = await repository({
    '.refit.json': {
      formatVersion: 2,
      integrations: [
        { id: 'escape', providerConfig: `../${basename(outside)}/secret.provider.json` },
        { id: 'absolute', providerConfig: join(outside, 'secret.provider.json') },
        { id: 'linked', providerConfig: './refit/linked.provider.json' },
        { id: 'large', providerConfig: './refit/large.provider.json' },
        { id: 'ai', providerConfig: './refit/ai.provider.json' },
      ],
    },
    'refit/ai.provider.json': { packageName: 'openai' },
    'refit/large.provider.json': { packageName: 'openai', padding: 'x'.repeat(200 * 1024) },
  });
  await symlink(join(outside, 'secret.provider.json'), join(root, 'refit/linked.provider.json'));
  const integrations = await configuredIntegrations(root);
  console.log(integrations);
  expect(integrations).toEqual([{ agent: 'openai', integration: 'ai', apiVersion: null }]);

  const linked = await repository({});
  await symlink(join(root, '.refit.json'), join(linked, '.refit.json'));
  await expect(configuredIntegrations(linked)).rejects.toThrow(
    '.refit.json must be a file inside the repository, not a link.',
  );
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
        // Read exactly 30 days before NOW, then 31.
        entry({
          id: 'checked-30',
          provider: 'shopify',
          versions: ['2026-04'],
          date: '2027-04-01',
          checkedAt: '2026-09-15',
        }),
        entry({
          id: 'checked-31',
          provider: 'shopify',
          versions: ['2026-07'],
          date: '2027-07-01',
          checkedAt: '2026-09-14',
        }),
        {
          ...entry({ id: 'derived', provider: 'openai', versions: ['d'], date: '2027-01-01' }),
          derivedDate: false,
        },
      ],
    },
    NOW,
  );
  expect(report.pastDue).toEqual([{ id: 'past', date: '2026-01-01', days: 287 }]);
  expect(report.missingSource).toEqual(['unsourced']);
  expect(report.stale).toEqual([{ id: 'checked-31', checkedAt: '2026-09-14', days: 31 }]);
  expect(report.errors).toEqual([
    'Bad.Id: unknown fields extra.',
    'Bad.Id: id must be lowercase letters, digits and hyphens.',
    'Bad.Id: old-model already has another deadline.',
    'Bad.Id: date must be a real YYYY-MM-DD date.',
    'derived: derivedDate must be true or left out.',
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

it('warns on stale entries from --check-registry without failing it', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const root = await repository({
    'registry.json': {
      formatVersion: 1,
      deadlines: [
        entry({
          id: 'read-today',
          provider: 'shopify',
          versions: ['2030-01'],
          date: '2030-04-01',
          checkedAt: today,
        }),
        entry({
          id: 'read-long-ago',
          provider: 'shopify',
          versions: ['2030-04'],
          date: '2030-07-01',
          checkedAt: '2026-01-02',
        }),
      ],
    },
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    resolve('bin/refit.mjs'),
    'deadlines',
    '--check-registry',
    '--registry',
    join(root, 'registry.json'),
  ]);
  expect(stdout).toMatch(/^Deadline registry is valid$/m);
  expect(stdout).toMatch(
    /^ {2}stale {5}read-long-ago \(checked 2026-01-02, \d+ days ago; read its source again\)$/m,
  );
  expect(stdout).not.toMatch(/read-today/);
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
    new Set([
      'shopify',
      'meta-graph',
      'openai',
      'anthropic',
      'gemini',
      'slack',
      'cloudflare',
      'github',
      'auth0',
      'clerk',
      'firebase',
      'supabase',
      'nextauth',
      'adyen',
      'braintree',
      'coinbase-commerce',
      'easypost',
    ]),
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

it('lets a committed ignore file accept an alert, and never lets an invalid one silence it', async () => {
  const ignoreFile = (reason: string) =>
    JSON.stringify({
      formatVersion: 1,
      ignore: [{ deadline: 'openai-gpt-4', reason, until: '2026-11-30' }],
    });
  checkout.directory = await repository({
    'package.json': { dependencies: { openai: '4.80.0' } },
    'src/ai.ts': "export const model = 'gpt-4';\n",
    '.refit-deadlines-ignore.json': ignoreFile('Swapping to gpt-5.6-sol in the next release.'),
  });
  const registryPath = join(await repository({}), 'registry.json');
  await writeFile(registryPath, JSON.stringify(registry));
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
  const notices: string[] = [];
  const run = async (onProgress?: (message: string) => void) => {
    const state = await mkdtemp(join(tmpdir(), 'refit-deadline-ignore-'));
    roots.push(state);
    await runLocalService({
      targets: [
        { id: 'app', repository: 'example/app', base: 'main', documentationSources: [], approval },
      ],
      app: { appId: '123', privateKeyFile: 'unused' },
      directory: state,
      port: 0,
      webhookSecret: 'webhook-secret-for-deadline-tests-1',
      controlToken: 'control-token-for-deadline-tests-2',
      // 3 days before the gpt-4 deadline: the 7-day stage is due.
      now: () => new Date('2026-10-20T12:00:00Z'),
      deadlineAlerts: { leadDays: [90, 30, 7], registry: registryPath },
      notify: async (text) => void notices.push(text),
      once: true,
      signal: new AbortController().signal,
      onProgress,
    });
  };
  await run();
  expect(requests).toEqual([]);
  expect(notices).toEqual([]);

  await writeFile(join(checkout.directory, '.refit-deadlines-ignore.json'), ignoreFile(' '));
  const progress: string[] = [];
  await run((message) => progress.push(message));
  expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
    'POST /repos/example/app/issues',
  ]);
  expect(notices).toEqual([
    expect.stringMatching(
      /^🚨 \[URGENT\] example\/app: OpenAI model gpt-4 reaches its sunset on 2026-10-23 \(3 days left\); https:\/\/github\.com\/example\/app\/issues\/\d+$/,
    ),
  ]);
  expect(
    progress.some((message) =>
      message.startsWith('[example/app] Deadline ignores not applied: PipelineInputError'),
    ),
  ).toBe(true);

  // A derived date never opens an issue, even with no ignore file.
  requests.length = 0;
  notices.length = 0;
  await rm(join(checkout.directory, '.refit-deadlines-ignore.json'));
  await writeFile(
    registryPath,
    JSON.stringify({
      ...registry,
      deadlines: registry.deadlines.map((item) => ({ ...item, derivedDate: true })),
    }),
  );
  await run();
  expect(requests).toEqual([]);
  expect(notices).toEqual([]);
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
        use: 'live' as const,
        version: 'gpt-4',
        text: 'model: `gpt-4`',
      },
    ],
    more: 2,
    nonLive: (['catalog', 'catalog', 'test'] as const).map((use, index) => ({
      file: `src/models.ts`,
      line: index + 1,
      kind: 'source' as const,
      use,
      version: 'gpt-4',
      text: "'gpt-4',",
    })),
    nonLiveMore: 1,
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
  // Non-live matches are counted, never listed as evidence or linked.
  expect(body).toContain(
    'Not counted: 4 matches outside live code (2 catalog, 1 test, 1 more), such as model lists',
  );
  expect(body).not.toContain('src/models.ts');
  expect(body).toContain('Refit has no OpenAI agent yet');
});

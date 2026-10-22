import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { gitEnvironment } from './git-environment.ts';
import {
  INVENTORY_LIMITS,
  inventorySummary,
  refreshInventory,
  registryDigest,
  scanInventory,
} from './inventory.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  size: 10,
  fetches: 0,
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  transport.native = (args, cwd) => execute('git', args, { cwd, env: gitEnvironment() });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (binary !== 'git' || !args.includes('fetch')) return execute(binary, args, options);
      transport.fetches += 1;
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({ token: 'read', appId: 123, installationId: 456 })),
}));
vi.mock('./github.ts', async (original) => {
  const actual = await original<typeof import('./github.ts')>();
  return {
    ...actual,
    requestGitHub: vi.fn(async (_token: string, method: string, path: string) => {
      if (path === '/repos/example/app')
        return {
          id: 789,
          full_name: 'example/app',
          archived: false,
          disabled: false,
          default_branch: 'main',
          size: transport.size,
        };
      expect(path).toBe('/repos/example/app/git/ref/heads/main');
      if (!transport.head) throw new actual.GitHubRequestError(409, method, path);
      return { object: { type: 'commit', sha: transport.head } };
    }),
  };
});

const NOW = new Date('2026-10-22T12:00:00Z');
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  transport.head = '';
  transport.size = 10;
  transport.fetches = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-inventory-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const STRIPE_AND_OPENAI = {
  'package.json': JSON.stringify({ dependencies: { stripe: '^16.0.0', openai: '^4.20.0' } }),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { stripe: '^16.0.0', openai: '^4.20.0' } },
      'node_modules/stripe': { version: '16.12.0' },
      'node_modules/openai': { version: '4.77.0' },
    },
  }),
  'src/billing.ts': [
    "import Stripe from 'stripe';",
    "const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '2024-06-20' });",
    'export const customers = () => stripe.customers.list();',
  ].join('\n'),
  'src/chat.ts': [
    "import OpenAI from 'openai';",
    'const openai = new OpenAI();',
    'export async function reply(content: string) {',
    "  await openai.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'user', content }] });",
    '  return openai.chat.completions.create({',
    '    model: process.env.MODEL!,',
    "    messages: [{ role: 'user', content }],",
    '  });',
    '}',
    "// gpt-4o is what the next release will use: 'gpt-4o'",
  ].join('\n'),
};

it('inventories Stripe and OpenAI: packages, the pinned API version, deadlines and model calls', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const inventory = await scanInventory(await repository(STRIPE_AND_OPENAI), registry, NOW);
  console.log(JSON.stringify(inventorySummary(inventory)));
  expect(inventory.providers.map(({ id, agent, packages }) => ({ id, agent, packages }))).toEqual([
    {
      id: 'stripe',
      agent: true,
      packages: [{ file: 'package.json', name: 'stripe', version: '^16.0.0', locked: '16.12.0' }],
    },
    {
      id: 'openai',
      agent: true,
      packages: [{ file: 'package.json', name: 'openai', version: '^4.20.0', locked: '4.77.0' }],
    },
  ]);
  expect(inventory.integrations).toEqual([]);
  expect(inventory.apiVersions).toEqual([
    {
      provider: 'stripe',
      file: 'src/billing.ts',
      line: 2,
      kind: 'constructor',
      value: '2024-06-20',
      status: 'literal',
    },
  ]);
  expect(inventory.deadlines.exposures).toHaveLength(1);
  const [exposure] = inventory.deadlines.exposures;
  expect(exposure).toMatchObject({
    deadline: { id: 'openai-2026-10-23-gpt-4', date: '2026-10-23' },
    days: 1,
    evidence: [{ file: 'src/chat.ts', line: 4, use: 'live', version: 'gpt-4' }],
  });
  expect(inventory.models).toEqual([
    {
      provider: 'openai',
      file: 'src/chat.ts',
      line: 4,
      call: 'chat.completions.create',
      model: 'gpt-4',
      test: false,
    },
    {
      provider: 'openai',
      file: 'src/chat.ts',
      line: 5,
      call: 'chat.completions.create',
      model: null,
      test: false,
    },
  ]);
  expect(inventorySummary(inventory)).toEqual({
    providers: ['stripe', 'openai'],
    deadlines: [{ id: 'openai-2026-10-23-gpt-4', date: '2026-10-23', live: 1 }],
    mentions: [],
    apiVersions: ['2024-06-20'],
    models: ['gpt-4'],
    modelCalls: 2,
  });
});

it('inventories an empty repository as having nothing', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const inventory = await scanInventory(
    await repository({ 'README.md': '# Notes\nNothing to see.\n' }),
    registry,
    NOW,
  );
  expect(inventory).toEqual({
    formatVersion: 1,
    providers: [],
    integrations: [],
    apiVersions: [],
    deadlines: { exposures: [], mentions: [] },
    ignores: { file: null, entries: [], error: null },
    models: [],
  });
});

it('keeps committed deadline ignores, and an invalid ignore file as accepting nothing', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const ignore = {
    deadline: 'openai-2026-10-23-gpt-4',
    reason: 'Moving to gpt-5.6-sol in the next release.',
    until: '2026-11-30',
    paths: ['src/legacy'],
  };
  const valid = await scanInventory(
    await repository({
      '.refit-deadlines-ignore.json': JSON.stringify({ formatVersion: 1, ignore: [ignore] }),
    }),
    registry,
    NOW,
  );
  expect(valid.ignores).toEqual({
    file: '.refit-deadlines-ignore.json',
    entries: [ignore],
    error: null,
  });
  const invalid = await scanInventory(
    await repository({
      '.refit-deadlines-ignore.json': JSON.stringify({
        formatVersion: 1,
        ignore: [{ ...ignore, until: '2028-01-01' }],
      }),
    }),
    registry,
    NOW,
  );
  expect(invalid.ignores).toEqual({
    file: '.refit-deadlines-ignore.json',
    entries: [],
    error: expect.stringContaining('ignore[0].until must be within 365 days'),
  });
});

it('attributes packages to each pnpm workspace with their locked versions', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const root = await repository({
    'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@9.15.4' }),
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .: {}',
      '',
      '  apps/assistant:',
      '    dependencies:',
      "      '@anthropic-ai/sdk':",
      '        specifier: ^0.30.0',
      '        version: 0.30.1',
      '',
      '  apps/shop:',
      '    dependencies:',
      "      '@shopify/shopify-api':",
      '        specifier: ^11.0.0',
      '        version: 11.4.0',
      '',
      'packages:',
      '',
      "  '@anthropic-ai/sdk@0.30.1':",
      '    resolution: {integrity: sha512-anthropic}',
      '',
      "  '@shopify/shopify-api@11.4.0':",
      '    resolution: {integrity: sha512-shopify}',
      '',
      'snapshots:',
      '',
      "  '@anthropic-ai/sdk@0.30.1': {}",
      '',
      "  '@shopify/shopify-api@11.4.0': {}",
      '',
    ].join('\n'),
    'apps/assistant/package.json': JSON.stringify({
      name: 'assistant',
      dependencies: { '@anthropic-ai/sdk': '^0.30.0' },
    }),
    'apps/assistant/src/ask.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const client = new Anthropic();',
      'export const ask = (content: string) =>',
      "  client.messages.create({ model: 'claude-3-haiku-20240307', max_tokens: 64, messages: [{ role: 'user', content }] });",
    ].join('\n'),
    'apps/shop/package.json': JSON.stringify({
      name: 'shop',
      dependencies: { '@shopify/shopify-api': '^11.0.0' },
    }),
    'apps/shop/src/shopify.ts': [
      "import { shopifyApi, ApiVersion } from '@shopify/shopify-api';",
      'export const shopify = shopifyApi({ apiVersion: ApiVersion.July25 } as never);',
    ].join('\n'),
  });
  const inventory = await scanInventory(root, registry, NOW);
  console.log(JSON.stringify(inventory.providers));
  expect(inventory.providers.map(({ id, packages }) => ({ id, packages }))).toEqual([
    {
      id: 'anthropic',
      packages: [
        {
          file: 'apps/assistant/package.json',
          name: '@anthropic-ai/sdk',
          version: '^0.30.0',
          locked: '0.30.1',
        },
      ],
    },
    {
      id: 'shopify',
      packages: [
        {
          file: 'apps/shop/package.json',
          name: '@shopify/shopify-api',
          version: '^11.0.0',
          locked: '11.4.0',
        },
      ],
    },
  ]);
  expect(inventory.models).toEqual([
    {
      provider: 'anthropic',
      file: 'apps/assistant/src/ask.ts',
      line: 4,
      call: 'messages.create',
      model: 'claude-3-haiku-20240307',
      test: false,
    },
  ]);
  // Both retired before NOW, so both are past due (negative days).
  expect(
    inventory.deadlines.exposures.map(({ deadline, days, evidence }) => ({
      id: deadline.id,
      days,
      files: evidence.map((item) => `${item.file}:${item.line}`),
    })),
  ).toEqual([
    {
      id: 'anthropic-2026-04-20-claude-3-haiku',
      days: -185,
      files: ['apps/assistant/src/ask.ts:4'],
    },
    { id: 'shopify-admin-2025-07', days: -98, files: ['apps/shop/src/shopify.ts:2'] },
  ]);
});

it('lists model strings found only in tests as mentions, never as exposures', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const inventory = await scanInventory(
    await repository({
      'package.json': JSON.stringify({ devDependencies: { openai: '^4.0.0' } }),
      'src/__tests__/chat.test.ts': [
        "import OpenAI from 'openai';",
        'const client = new OpenAI();',
        "it('replies', () => client.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [] }));",
      ].join('\n'),
      'test/fixtures/models.ts': "export const MODEL = 'gpt-4';\n",
    }),
    registry,
    NOW,
  );
  expect(inventory.deadlines.exposures).toEqual([]);
  expect(
    inventory.deadlines.mentions.map((mention) => ({
      id: mention.deadline.id,
      counts: mention.nonLiveCounts,
    })),
  ).toEqual([
    { id: 'openai-2026-10-23-gpt-3-5-turbo', counts: { test: 1 } },
    { id: 'openai-2026-10-23-gpt-4', counts: { test: 1 } },
  ]);
  expect(inventory.models).toEqual([
    {
      provider: 'openai',
      file: 'src/__tests__/chat.test.ts',
      line: 3,
      call: 'chat.completions.create',
      model: 'gpt-3.5-turbo',
      test: true,
    },
  ]);
  expect(inventorySummary(inventory).models).toEqual([]);
});

// A committed source repository that the mocked git transport fetches from.
async function remote(files: Record<string, string>) {
  transport.source = await repository(files);
  await transport.native!(['init', '--quiet', '--initial-branch=main'], transport.source);
  await transport.native!(['add', '.'], transport.source);
  await transport.native!(
    [
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '--quiet',
      '-m',
      'test: inventory fixture',
    ],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
}

async function refresh(
  limits = INVENTORY_LIMITS,
  previous: { revision: string | null; registry: string | null } | null = null,
) {
  const state = await mkdtemp(join(tmpdir(), 'refit-inventory-state-'));
  cleanups.push(() => rm(state, { recursive: true, force: true }));
  const directory = join(state, 'run');
  const result = await refreshInventory({
    app: APP,
    directory,
    installationId: 456,
    repository: 'example/app',
    registry: await loadDeadlineRegistry(undefined, NOW),
    previous,
    now: NOW,
    signal: new AbortController().signal,
    limits,
  });
  // The checkout never outlives the inventory.
  expect(await readdir(state)).toEqual([]);
  return result;
}

it('takes an inventory from a fresh checkout, deletes it and skips an unchanged revision', async () => {
  await remote(STRIPE_AND_OPENAI);
  const first = await refresh();
  expect(first).toMatchObject({ outcome: 'complete', base: 'main', revision: transport.head });
  expect(first.outcome === 'complete' && inventorySummary(first.inventory).providers).toEqual([
    'stripe',
    'openai',
  ]);
  expect(transport.fetches).toBe(1);
  const registry = registryDigest(await loadDeadlineRegistry(undefined, NOW));
  expect(await refresh(INVENTORY_LIMITS, { revision: transport.head, registry })).toEqual({
    outcome: 'unchanged',
    base: 'main',
    revision: transport.head,
  });
  expect(transport.fetches).toBe(1);
  // A registry change scans the same revision again.
  expect(
    await refresh(INVENTORY_LIMITS, { revision: transport.head, registry: 'older' }),
  ).toMatchObject({ outcome: 'complete' });
  expect(transport.fetches).toBe(2);
});

it('stops with a named reason over each size cap, without fetching an oversized repository', async () => {
  await remote({ 'package.json': '{}', 'a.ts': 'export {};\n', 'b.ts': 'export {};\n' });
  transport.size = INVENTORY_LIMITS.repositoryKilobytes + 1;
  expect(await refresh()).toEqual({
    outcome: 'stopped',
    base: 'main',
    revision: null,
    stop: 'repository-too-large',
    message: `GitHub reports ${INVENTORY_LIMITS.repositoryKilobytes + 1} KB, over the inventory limit of ${INVENTORY_LIMITS.repositoryKilobytes} KB.`,
  });
  expect(transport.fetches).toBe(0);
  transport.size = 10;
  expect(await refresh({ ...INVENTORY_LIMITS, checkoutFiles: 2 })).toMatchObject({
    outcome: 'stopped',
    revision: transport.head,
    stop: 'checkout-too-large',
  });
  expect(await refresh({ ...INVENTORY_LIMITS, checkoutBytes: 10 })).toMatchObject({
    outcome: 'stopped',
    stop: 'checkout-too-large',
  });
});

it('stops on a source file over Refit scan limits and on a branch with no commit', async () => {
  await remote({
    'package.json': '{}',
    'big.ts': `export const x = '${'x'.repeat(2_200_000)}';\n`,
  });
  expect(await refresh()).toMatchObject({
    outcome: 'stopped',
    revision: transport.head,
    stop: 'unreadable',
    message: 'Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).',
  });
  transport.head = '';
  expect(await refresh()).toEqual({
    outcome: 'stopped',
    base: 'main',
    revision: null,
    stop: 'empty',
    message: 'The default branch main has no commit.',
  });
});

it('stops with a timeout when the inventory runs past its time cap', async () => {
  await remote(STRIPE_AND_OPENAI);
  expect(await refresh({ ...INVENTORY_LIMITS, seconds: 0 })).toMatchObject({
    outcome: 'stopped',
    stop: 'timeout',
    message: 'Inventory took longer than 0 seconds.',
  });
});

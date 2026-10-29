import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sdkMajorUpgrade, type Resolve } from './ai-sdk-upgrade.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const lock = (packages: Record<string, unknown>) =>
  `${JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
const before = lock({
  '': { name: 'app', dependencies: { openai: '^3.3.0', express: '^4.0.0' } },
  'node_modules/openai': { version: '3.3.0', dependencies: { axios: '^0.26.0' } },
  'node_modules/axios': { version: '0.26.1' },
  'node_modules/express': { version: '4.21.0' },
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-upgrade-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}
const manifest = JSON.stringify(
  { name: 'app', dependencies: { openai: '^3.3.0', express: '^4.0.0' } },
  null,
  2,
);
const options = (resolve: Resolve) => ({
  packageName: 'openai',
  targetMajor: 6,
  release: '6.49.0',
  resolution: { image: 'node:22-alpine', before: '2026-01-02T00:00:00Z', resolve },
});

it('re-resolves the lockfile and keeps it when only the SDK and what only it reaches change', async () => {
  const seen: Parameters<Resolve>[0][] = [];
  const resolve: Resolve = async (input) => {
    seen.push(input);
    return {
      lockfile: lock({
        '': { name: 'app', dependencies: { openai: '^6.49.0', express: '^4.0.0' } },
        'node_modules/openai': { version: '6.49.0' },
        'node_modules/express': { version: '4.21.0' },
      }),
      before: input.before,
      late: { openai: { spec: '^6.49.0', published: '2026-07-20T00:00:00Z' } },
    };
  };
  const result = await sdkMajorUpgrade(
    await project({ 'package.json': manifest, 'package-lock.json': before }),
    options(resolve),
  );
  expect('upgrade' in result && result.upgrade.from).toBe('3.3.0');
  expect('upgrade' in result && result.upgrade.to).toBe('6.49.0');
  expect(seen[0].manifest).toContain('"openai": "^6.49.0"');
  expect(seen[0].seed).toBe(before);
  expect('upgrade' in result && result.upgrade.warning).toContain('nothing outside openai');
});

it('refuses when the re-resolved lockfile moves anything else', async () => {
  const resolve: Resolve = async (input) => ({
    lockfile: lock({
      '': { name: 'app', dependencies: { openai: '^6.49.0', express: '^4.0.0' } },
      'node_modules/openai': { version: '6.49.0' },
      'node_modules/express': { version: '4.22.0' },
    }),
    before: input.before,
    late: {},
  });
  const result = await sdkMajorUpgrade(
    await project({ 'package.json': manifest, 'package-lock.json': before }),
    options(resolve),
  );
  expect(result).toEqual({ reason: expect.stringContaining('node_modules/express') });
});

it('refuses other managers, workspaces and undeclared companions before resolving', async () => {
  const never: Resolve = async () => {
    throw new Error('must not resolve');
  };
  expect(
    await sdkMajorUpgrade(
      await project({ 'package.json': manifest, 'pnpm-lock.yaml': 'lockfileVersion: 9' }),
      options(never),
    ),
  ).toEqual({ reason: expect.stringContaining('pnpm-lock.yaml') });
  expect(
    await sdkMajorUpgrade(
      await project({
        'package.json': JSON.stringify({ workspaces: ['a'], dependencies: { openai: '^3.3.0' } }),
        'package-lock.json': before,
      }),
      options(never),
    ),
  ).toEqual({ reason: expect.stringContaining('workspaces') });
  const anthropic = JSON.stringify({
    dependencies: { '@anthropic-ai/sdk': '^0.79.0', '@anthropic-ai/bedrock-sdk': '^0.26.4' },
  });
  expect(
    await sdkMajorUpgrade(
      await project({ 'package.json': anthropic, 'package-lock.json': before }),
      {
        ...options(never),
        packageName: '@anthropic-ai/sdk',
        targetMajor: 1,
        release: '1.3.0',
        companions: ['@anthropic-ai/bedrock-sdk'],
      },
    ),
  ).toEqual({ reason: expect.stringContaining('@anthropic-ai/bedrock-sdk') });
});

it('moves only package.json when no lockfile is committed, and says so', async () => {
  const never: Resolve = async () => {
    throw new Error('must not resolve');
  };
  const result = await sdkMajorUpgrade(await project({ 'package.json': manifest }), options(never));
  expect('upgrade' in result && result.upgrade.files.map((file) => file.path)).toEqual([
    'package.json',
  ]);
  expect('upgrade' in result && result.upgrade.warning).toContain('commits no lockfile');
});

it('swaps @google/generative-ai for @google/genai in place, allowing both packages to change', async () => {
  const gemini = `${JSON.stringify({ name: 'app', dependencies: { '@google/generative-ai': '^0.24.1', express: '^4.0.0' } }, null, 2)}\n`;
  const old = lock({
    '': { name: 'app', dependencies: { '@google/generative-ai': '^0.24.1', express: '^4.0.0' } },
    'node_modules/@google/generative-ai': { version: '0.24.1' },
    'node_modules/express': { version: '4.21.0' },
  });
  let manifestSent = '';
  const resolve: Resolve = async (input) => {
    manifestSent = input.manifest;
    return {
      lockfile: lock({
        '': { name: 'app', dependencies: { '@google/genai': '^2.31.0', express: '^4.0.0' } },
        'node_modules/@google/genai': { version: '2.31.0', dependencies: { ws: '^8.18.0' } },
        'node_modules/ws': { version: '8.18.3' },
        'node_modules/express': { version: '4.21.0' },
      }),
      before: input.before,
      late: {},
    };
  };
  const result = await sdkMajorUpgrade(
    await project({ 'package.json': gemini, 'package-lock.json': old }),
    {
      packageName: '@google/genai',
      replaces: '@google/generative-ai',
      targetMajor: 2,
      release: '2.31.0',
      resolution: { image: 'node:22-alpine', before: '2026-01-02T00:00:00Z', resolve },
    },
  );
  expect(manifestSent).toContain('"@google/genai": "^2.31.0"');
  expect(manifestSent).not.toContain('generative-ai');
  expect(manifestSent.indexOf('@google/genai')).toBeLessThan(manifestSent.indexOf('express'));
  expect('upgrade' in result && result.upgrade.warning).toContain(
    'Replaces @google/generative-ai 0.24.1 with @google/genai 2.31.0',
  );
});

it('moves declared platform packages to v1 with @anthropic-ai/sdk and guards them together', async () => {
  const manifest = `${JSON.stringify({ name: 'app', dependencies: { '@anthropic-ai/sdk': '^0.79.0', '@anthropic-ai/vertex-sdk': '^0.14.0' } }, null, 2)}\n`;
  const old = lock({
    '': {
      name: 'app',
      dependencies: { '@anthropic-ai/sdk': '^0.79.0', '@anthropic-ai/vertex-sdk': '^0.14.0' },
    },
    'node_modules/@anthropic-ai/sdk': { version: '0.79.0' },
    'node_modules/@anthropic-ai/vertex-sdk': { version: '0.14.4' },
  });
  let sent = '';
  const resolve: Resolve = async (input) => {
    sent = input.manifest;
    return {
      lockfile: lock({
        '': {
          name: 'app',
          dependencies: { '@anthropic-ai/sdk': '^1.3.0', '@anthropic-ai/vertex-sdk': '^1.1.0' },
        },
        'node_modules/@anthropic-ai/sdk': { version: '1.3.0' },
        'node_modules/@anthropic-ai/vertex-sdk': { version: '1.1.0' },
        'node_modules/google-auth-library': { version: '10.2.0' },
      }),
      before: input.before,
      late: {},
    };
  };
  const result = await sdkMajorUpgrade(
    await project({ 'package.json': manifest, 'package-lock.json': old }),
    {
      packageName: '@anthropic-ai/sdk',
      targetMajor: 1,
      release: '1.3.0',
      companions: ['@anthropic-ai/vertex-sdk', '@anthropic-ai/bedrock-sdk'],
      together: ['@anthropic-ai/vertex-sdk'],
      togetherReleases: { '@anthropic-ai/vertex-sdk': '1.1.0' },
      resolution: { image: 'node:22-alpine', before: '2026-01-02T00:00:00Z', resolve },
    },
  );
  expect(sent).toContain('"@anthropic-ai/vertex-sdk": "^1.1.0"');
  expect('upgrade' in result && result.upgrade.warning).toContain(
    'and @anthropic-ai/vertex-sdk to 1.1.0 with it',
  );
});

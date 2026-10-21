import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { addAgents, detectProviders } from './agent-catalog.ts';
import { parseWorkflowConfigurations } from './workflow-configuration.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-agents-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const MANIFEST = JSON.stringify({
  name: 'app',
  scripts: { test: 'vitest run' },
  dependencies: { stripe: '^17.7.0', openai: '4.80.0', '@anthropic-ai/sdk': '0.40.0' },
});
const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { stripe: '^17.7.0', openai: '4.80.0', '@anthropic-ai/sdk': '0.40.0' } },
    'node_modules/stripe': { version: '17.7.0' },
    'node_modules/openai': { version: '4.80.0' },
    'node_modules/@anthropic-ai/sdk': { version: '0.40.0' },
  },
});

it('detects provider SDKs from manifests, lockfiles and raw API hostnames only', async () => {
  const root = await repository({
    'package.json': MANIFEST,
    'package-lock.json': LOCK,
    'src/meta.ts': "export const insights = 'https://graph.facebook.com/v19.0/me/insights';\n",
    'src/plain.ts': 'export const unrelated = 1;\n',
  });
  const detections = await detectProviders(root);
  expect(
    detections.map((entry) => [
      entry.agent.id,
      Boolean(entry.agent.adapter),
      entry.packages.map((item) => item.locked),
      entry.hostnames.map((item) => `${item.file}:${item.line}`),
    ]),
  ).toEqual([
    ['stripe', true, ['17.7.0'], []],
    ['openai', true, ['4.80.0'], []],
    ['anthropic', false, ['0.40.0'], []],
    ['meta-graph', false, [], ['src/meta.ts:1']],
  ]);
});

it('scaffolds approved agents, converts a v1 configuration and refuses agents it cannot back', async () => {
  const root = await repository({ 'package.json': MANIFEST, 'package-lock.json': LOCK });
  const detections = await detectProviders(root);
  const fresh = addAgents({
    configuration: undefined,
    v1Id: 'stripe',
    detections,
    ids: ['stripe', 'openai'],
    testScript: true,
    lockfile: true,
  });
  expect(fresh.added).toEqual(['stripe', 'openai']);
  expect(fresh.adapterFiles).toEqual([
    { source: 'examples/openai.provider.json', target: 'refit/openai.provider.json' },
  ]);
  const parsed = parseWorkflowConfigurations(
    JSON.stringify(fresh.configuration),
    join(root, '.refit.json'),
  );
  expect(parsed.workflows.map((entry) => entry.id)).toEqual(['stripe', 'openai']);
  expect(parsed.workflows[0].workflow).toMatchObject({
    prepareDependencies: true,
    command: ['npm', 'test'],
  });
  const v1 = {
    formatVersion: 1,
    before: './b.json',
    after: './a.json',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  };
  const converted = addAgents({
    configuration: v1,
    v1Id: 'stripe',
    detections,
    ids: ['openai'],
    testScript: false,
    lockfile: false,
  });
  expect(
    (converted.configuration.integrations as { id: string }[]).map((entry) => entry.id),
  ).toEqual(['stripe', 'openai']);
  expect((converted.configuration.integrations as Record<string, unknown>[])[0]).toMatchObject({
    before: './b.json',
  });
  expect(
    addAgents({
      configuration: fresh.configuration,
      v1Id: 'stripe',
      detections,
      ids: ['stripe'],
      testScript: true,
      lockfile: true,
    }).added,
  ).toEqual([]);
  expect(() =>
    addAgents({
      configuration: undefined,
      v1Id: 'stripe',
      detections,
      ids: ['anthropic'],
      testScript: true,
      lockfile: true,
    }),
  ).toThrow('no Anthropic agent');
  expect(() =>
    addAgents({
      configuration: undefined,
      v1Id: 'stripe',
      detections,
      ids: ['twilio'],
      testScript: true,
      lockfile: true,
    }),
  ).toThrow('was not detected');
});

it('writes added agents through the CLI without duplicating an agent configured under another adapter id', async () => {
  const root = await repository({
    'package.json': MANIFEST,
    'package-lock.json': LOCK,
    'refit/stripe-moves.provider.json': JSON.stringify({
      id: 'stripe-moves',
      packageName: 'stripe',
      defaultImport: true,
      namedExport: null,
      operations: [],
    }),
    '.refit.json': JSON.stringify({
      formatVersion: 1,
      before: './b.json',
      after: './a.json',
      providerConfig: './refit/stripe-moves.provider.json',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
    }),
  });
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await execute(process.execPath, [
          'bin/refit.mjs',
          'agents',
          '--repository',
          root,
          '--json',
          ...args,
        ])
      ).stdout,
    );
  const listed = await run();
  expect(listed.detected.find((entry: { id: string }) => entry.id === 'stripe')).toMatchObject({
    configured: true,
  });
  const added = await run('--add', 'stripe', '--add', 'openai');
  expect(added.added).toEqual(['openai']);
  const written = JSON.parse(await readFile(join(root, '.refit.json'), 'utf8'));
  expect(written.integrations.map((entry: { id: string }) => entry.id)).toEqual([
    'stripe-moves',
    'openai',
  ]);
  expect(
    JSON.parse(await readFile(join(root, 'refit/openai.provider.json'), 'utf8')).packageName,
  ).toBe('openai');
  expect(
    parseWorkflowConfigurations(JSON.stringify(written), join(root, '.refit.json')).workflows,
  ).toHaveLength(2);
}, 30_000);

it('detects both Gemini SDKs and the Gemini API host, with no agent to add', async () => {
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: { '@google/genai': '2.30.0', '@google/generative-ai': '^0.21.0' },
    }),
    'src/rest.ts':
      "const url = 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent';\n",
  });
  const detections = await detectProviders(root);
  expect(
    detections.map((entry) => [
      entry.agent.id,
      entry.agent.adapter,
      entry.packages.map((item) => `${item.name} ${item.version}`),
      entry.hostnames.map((item) => `${item.file}:${item.line}`),
    ]),
  ).toEqual([
    ['gemini', null, ['@google/genai 2.30.0', '@google/generative-ai ^0.21.0'], ['src/rest.ts:1']],
  ]);
  expect(() =>
    addAgents({
      configuration: undefined,
      v1Id: 'stripe',
      detections,
      ids: ['gemini'],
      testScript: true,
      lockfile: true,
    }),
  ).toThrow('no Gemini agent');
});

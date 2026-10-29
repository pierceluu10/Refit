import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { aiMigrationBody, aiMigrationTitle, proposeAiMigrations } from './ai-migrations.ts';
import { loadAiRuleTables } from './ai-rules.ts';
import type { Resolve } from './ai-sdk-upgrade.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const lock = (version: string) =>
  `${JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', dependencies: { openai: `^${version}` } }, 'node_modules/openai': { version } } }, null, 2)}\n`;

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-migrations-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': `${JSON.stringify({ name: 'app', dependencies: { openai: '^3.3.0' } }, null, 2)}\n`,
    'package-lock.json': lock('3.3.0'),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
const resolve: Resolve = async (input) => ({
  lockfile: lock('6.49.0'),
  before: input.before,
  late: {},
});
const settings = {
  image: 'node:22-alpine',
  before: '2026-01-02T00:00:00Z',
  resolve,
  release: '6.49.0',
};
const SOURCE = `const { Configuration, OpenAIApi } = require('openai');
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));
async function ask(text) {
  const result = await openai.createChatCompletion({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }], stream: false });
  return result.data.choices[0].message.content;
}
module.exports = { ask };
`;

it('ships the package move and the code edits as one patch', async () => {
  const proposal = await proposeAiMigrations(
    await project({ 'ask.js': SOURCE }),
    await loadAiRuleTables(),
    settings,
  );
  expect(proposal?.patch).toContain(
    '+const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });',
  );
  expect(proposal?.patch).toContain('"openai": "^6.49.0"');
  expect(proposal?.patch).toContain('"version": "6.49.0"');
  expect(proposal?.calls).toEqual([
    { call: 'chat.completions.create', stream: true, tools: false, json: false },
  ]);
});

it('proposes no partial upgrade when a site would break', async () => {
  const proposal = await proposeAiMigrations(
    await project({
      'ask.js': SOURCE,
      'other.js': 'module.exports = (client) => client.createEdit({ input: "x" });\n',
    }),
    await loadAiRuleTables(),
    settings,
  );
  expect(proposal?.patch).toBeNull();
  expect(proposal?.upgradeRefusal).toContain('no partial upgrade');
});

it('says outputs may differ, reports each proof level and needs review without request proof', async () => {
  const proposal = (await proposeAiMigrations(
    await project({ 'ask.js': SOURCE }),
    await loadAiRuleTables(),
    settings,
  ))!;
  const check = { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
  const body = aiMigrationBody({
    proposal,
    validation: {
      revision: 'a'.repeat(40),
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      baseline: check,
      patched: check,
    },
    requestProof: {
      status: 'pending',
      reason: 'OPENAI_API_KEY is not set in this environment.',
      calls: [],
    },
  });
  expect(aiMigrationTitle(proposal, true)).toBe(
    '[Needs review] fix(deps): upgrade openai to 6.49.0 and migrate its calls',
  );
  expect(body).toContain(
    'outputs, defaults, errors and retries may differ. Please check the quality of the results',
  );
  expect(body).toContain('No request-level proof: OPENAI_API_KEY is not set');
  expect(body).toContain('**(a) Code:**');
  expect(body).toContain('**(b) Request:** pending.');
  expect(body).toContain('**(c) Output shape:** not checked');
  expect(body).toContain('https://github.com/openai/openai-node/discussions/217');
  expect(body).not.toMatch(/equivalent|same behaviou?r/i);
});

it('lists sites of the same provider that fail today, without blocking the upgrade', async () => {
  const proposal = await proposeAiMigrations(
    await project({
      'ask.js': SOURCE,
      'old.js':
        "const { Configuration, OpenAIApi } = require('openai');\nconst openai = new OpenAIApi(new Configuration({ apiKey: 'k' }));\nmodule.exports = async () => (await openai.createCompletion({ model: 'davinci-002', prompt: 'x' })).data.choices[0].text;\n",
    }),
    await loadAiRuleTables(),
    settings,
  );
  expect(proposal?.patch).toContain('openai.completions.create');
  expect(proposal?.stops).toEqual([
    expect.objectContaining({ rule: 'openai-legacy-completions', file: 'old.js', blocking: false }),
  ]);
});

it('reports an Anthropic upgrade blocked only by sampling parameters as optional, not as a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-migrations-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '^0.79.0' } }),
  );
  await writeFile(
    join(root, 'a.ts'),
    "import Anthropic from '@anthropic-ai/sdk';\nconst c = new Anthropic();\nexport const f = () => c.messages.create({ model: 'm', max_tokens: 1, temperature: 0, messages: [] });\n",
  );
  const proposal = await proposeAiMigrations(root, await loadAiRuleTables(), {
    ...settings,
    packageName: '@anthropic-ai/sdk',
    release: '1.3.0',
  });
  expect(proposal?.optionalUpgrade).toBe(true);
  expect(proposal?.patch).toBeNull();
  expect(proposal?.upgradeRefusal).toMatch(
    /^SDK upgrade available, not required \(would change outputs\)/,
  );
});

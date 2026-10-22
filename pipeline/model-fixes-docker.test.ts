import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { EMPTY_MODEL_PARAMETERS } from './model-parameters.ts';
import { runModelFixes } from './model-fixes.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    {
      id: 'openai-gpt-4',
      provider: 'openai',
      kind: 'model',
      versions: ['gpt-4'],
      date: '2026-10-23',
      summary: 'OpenAI shuts down gpt-4.',
      replacement: 'gpt-5.6-sol',
      source: 'https://developers.openai.com/api/docs/deprecations',
      checkedAt: '2026-10-15',
    },
  ],
};

// A committed repository whose check reads the source, so the patched run sees the replacement.
// The SDK is never installed or called: the checks run offline.
async function committed(check: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-fixes-docker-'));
  roots.push(root);
  const files = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { openai: '6.0.0' } }),
    'src/ai.js': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "export const chat = (messages) => openai.chat.completions.create({ model: 'gpt-4', messages });",
    ].join('\n'),
    'check.mjs': check,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const git = (...args: string[]) =>
    execute('git', [
      '-C',
      root,
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
  await git('init', '-q');
  await git('add', '.');
  await git('commit', '-q', '-m', 'test: seed');
  return root;
}

const READ =
  "import { readFileSync } from 'node:fs'; const source = readFileSync('src/ai.js', 'utf8');";

it.skipIf(!process.env.REFIT_DOCKER_IMAGE)(
  'validates a model replacement with the approved checks in offline Docker',
  async () => {
    const image = process.env.REFIT_DOCKER_IMAGE!;
    const passing = await committed(
      `${READ} if (!/model: '[^']+'/.test(source)) process.exit(1); console.log(source.match(/model: '[^']+'/)[0]);`,
    );
    const result = await runModelFixes({
      repository: passing,
      registry,
      parameters: EMPTY_MODEL_PARAMETERS,
      now: new Date('2026-10-20T12:00:00Z'),
      checks: { image, command: ['node', 'check.mjs'] },
    });
    expect(result).toMatchObject({ status: 'validated', skipped: false });
    expect(result.replacements.map((item) => item.to)).toEqual(['gpt-5.6-sol']);

    // A check that depends on the old model fails on the patched code, so nothing is published.
    const pinned = await committed(`${READ} if (!source.includes("'gpt-4'")) process.exit(1);`);
    expect(
      await runModelFixes({
        repository: pinned,
        registry,
        parameters: EMPTY_MODEL_PARAMETERS,
        now: new Date('2026-10-20T12:00:00Z'),
        checks: { image, command: ['node', 'check.mjs'] },
      }),
    ).toMatchObject({ status: 'validation-failed' });
  },
  180_000,
);

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { EMPTY_MODEL_PARAMETERS } from './model-parameters.ts';
import { runModelFixes } from './model-fixes.ts';

const published = vi.hoisted(
  () => [] as { key: string; title: string; body: string; message: string }[],
);
const checks = vi.hoisted(() => ({ patched: 'passed', runs: 0 }));

// Validation runs the proposal on the repository itself and reports the configured outcome, so
// these tests need no Docker; model-fixes-docker.test.ts runs the real sandbox.
vi.mock('./validation.ts', () => ({
  validateSourcePatch: vi.fn(
    async (options: {
      repository: string;
      command: string[];
      propose: (directory: string) => Promise<string | null>;
      skip?: (revision: string, patchHash: string) => boolean;
    }) => {
      const revision = 'a'.repeat(40);
      const diff = await options.propose(options.repository);
      if (!diff) return { status: 'no-patch', revision };
      if (options.skip?.(revision, 'p'.repeat(64)))
        return { status: 'skipped', revision, patchHash: 'p'.repeat(64) };
      checks.runs += 1;
      const output = { exitCode: 0, stdout: '', stderr: checks.patched === 'passed' ? '' : 'boom' };
      return {
        status: checks.patched === 'passed' ? 'passed' : 'regression',
        revision,
        image: 'node:22-alpine@sha256:test',
        command: options.command,
        baselineCommand: options.command,
        diff,
        patchHash: 'p'.repeat(64),
        baseline: { status: 'passed', ...output },
        patched: { status: checks.patched, ...output },
        publicationFiles: [{ path: 'src/ai.ts', mode: '100644', content: 'patched' }],
      };
    },
  ),
}));
vi.mock('./publication.ts', () => ({
  publicationConfiguration: vi.fn(),
  publishFiles: vi.fn(async (_options: unknown, change: (typeof published)[number]) => {
    published.push(change);
    return { status: 'created', url: 'https://github.com/example/app/pull/7', number: 7 };
  }),
}));

const roots: string[] = [];
afterEach(async () => {
  published.length = 0;
  checks.patched = 'passed';
  checks.runs = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-fixes-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app', dependencies: { openai: '6.0.0' } }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

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
const NOW = new Date('2026-10-20T12:00:00Z');
const CHECKS = { image: 'node:22-alpine', command: ['npm', 'test'] };
const SOURCE = [
  "import OpenAI from 'openai';",
  'const openai = new OpenAI();',
  "export const chat = (messages: any[]) => openai.chat.completions.create({ model: 'gpt-4', messages });",
  "export const tuned = (messages: any[]) => openai.chat.completions.create({ model: 'gpt-4', messages, temperature: 0 });",
].join('\n');

it('opens a draft pull request for validated replacements without asking first', async () => {
  const root = await repository({ 'src/ai.ts': SOURCE });
  const result = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: CHECKS,
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  expect(result).toMatchObject({
    status: 'draft-created',
    pullRequest: { url: 'https://github.com/example/app/pull/7', number: 7 },
    skipped: false,
  });
  expect(result.replacements.map((item) => `${item.file}:${item.line} ${item.to}`)).toEqual([
    'src/ai.ts:3 gpt-5.6-sol',
  ]);
  expect(published).toHaveLength(1);
  expect(published[0].title).toBe('fix: replace 1 retiring AI model');
  expect(published[0].key).toBe(`model-fixes:${'a'.repeat(40)}:${result.fixKey}`);
  const body = published[0].body;
  expect(published[0].message).toContain('- src/ai.ts:3: gpt-4 -> gpt-5.6-sol, retires 2026-10-23');
  expect(body).toContain(
    '| `src/ai.ts:3` `chat.completions.create` | `src/ai.ts:3` | `gpt-4` → `gpt-5.6-sol` | 2026-10-23 |',
  );
  expect(body).toContain('[provider page](https://developers.openai.com/api/docs/deprecations)');
  expect(body).toContain('- Patched `npm test`: passed');
  expect(body).toContain('no request reached OpenAI or Anthropic');
  expect(body).toContain('Refit opened this as a draft and never merges it.');
  // The call that sets temperature is listed, not edited.
  expect(body).toContain('## Left for review');
  expect(body).toContain('`src/ai.ts:4` `gpt-4`: The request sets temperature');

  // The same replacements are not validated or published again while their pull request stands,
  // even at a later revision.
  const again = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: CHECKS,
    publication: { repository: 'example/app', base: 'main', token: 'token' },
    handled: { revision: 'b'.repeat(40), fixKey: result.fixKey, pullRequest: 7 },
  });
  expect(again).toMatchObject({ status: 'no-change', skipped: true });
  expect(checks.runs).toBe(1);
  expect(published).toHaveLength(1);
});

it('never publishes a replacement whose checks fail, and stops when nothing is safe to change', async () => {
  checks.patched = 'failed';
  const root = await repository({ 'src/ai.ts': SOURCE });
  const failed = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: CHECKS,
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  expect(failed).toMatchObject({
    status: 'validation-failed',
    reason: 'Validation returned regression; publication was not attempted.',
    pullRequest: null,
  });
  expect(published).toEqual([]);

  const unsafe = await repository({
    'src/ai.ts': SOURCE.split('\n')
      .filter((line) => !line.includes('chat ='))
      .join('\n'),
  });
  expect(
    await runModelFixes({
      repository: unsafe,
      registry,
      parameters: EMPTY_MODEL_PARAMETERS,
      now: NOW,
      checks: CHECKS,
    }),
  ).toMatchObject({
    status: 'needs-review',
    reason: 'No model can be replaced safely; 1 use left for review.',
  });
  const clean = await repository({ 'src/ai.ts': 'export const x = 1;' });
  expect(
    await runModelFixes({
      repository: clean,
      registry,
      parameters: EMPTY_MODEL_PARAMETERS,
      now: NOW,
      checks: CHECKS,
    }),
  ).toMatchObject({ status: 'no-change', reason: 'No traced call sends a retiring model.' });
  // Without a publication target, a passing run is recorded as validated.
  checks.patched = 'passed';
  expect(
    await runModelFixes({
      repository: root,
      registry,
      parameters: EMPTY_MODEL_PARAMETERS,
      now: NOW,
      checks: CHECKS,
    }),
  ).toMatchObject({ status: 'validated' });
});

it('edits a parameterised call only when a table entry proves the literal', async () => {
  const root = await repository({ 'src/ai.ts': SOURCE });
  const source = 'https://developers.openai.com/api/docs/models';
  const parameters = {
    formatVersion: 1 as const,
    models: [
      {
        provider: 'openai' as const,
        model: 'gpt-5.6-sol',
        parameters: { temperature: { accepts: 'any' as const, min: 0, max: 2 } },
        source,
        checkedAt: '2026-10-20',
      },
    ],
  };
  const without = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: CHECKS,
  });
  expect(without.replacements.map((item) => item.line)).toEqual([3]);
  const withTable = await runModelFixes({
    repository: root,
    registry,
    parameters,
    now: NOW,
    checks: CHECKS,
  });
  expect(withTable.replacements.map((item) => item.line)).toEqual([3, 4]);
});

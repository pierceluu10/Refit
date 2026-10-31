import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { EMPTY_MODEL_PARAMETERS } from './model-parameters.ts';
import type { RequestProofTable } from './model-request-proofs.ts';
import { runModelFixes } from './model-fixes.ts';
import { NO_OP_CHECK, NO_OP_REVIEW } from './review.ts';

const published = vi.hoisted(
  () => [] as { key: string; title: string; body: string; message: string }[],
);
const checks = vi.hoisted(() => ({ patched: 'passed', runs: 0, typeErrors: [] as string[] }));

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
      const output = {
        exitCode: checks.typeErrors.length ? 2 : 0,
        stdout: checks.typeErrors.join('\n'),
        stderr: checks.patched === 'passed' ? '' : 'boom',
      };
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
  checks.typeErrors = [];
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

// Owner decision 1: a check that runs no code tests nothing, so the draft says so in its title.
it('titles a draft checked only by node -e 0 [Needs review], with the reason Stripe drafts give', async () => {
  const root = await repository({ 'src/ai.ts': SOURCE });
  const result = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: { ...CHECKS, command: NO_OP_CHECK.split(' ') },
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  expect(result.status).toBe('draft-created');
  expect(published[0].title).toBe('[Needs review] fix: replace 1 retiring AI model');
  expect(published[0].message.split('\n')[0]).toBe('fix: replace 1 retiring AI model');
  const body = published[0].body;
  expect(body.startsWith('## Why this needs review\n')).toBe(true);
  expect(body).toContain(`- ${NO_OP_REVIEW.reason} **Check:** ${NO_OP_REVIEW.check}`);
  expect(body).toContain(`- [ ] ${NO_OP_REVIEW.check}`);
  expect(body).not.toContain('exercises the changed calls');
});

// Apps enrolled with a type check only, which tsc fails before and after the swap: a Convex app
// that commits no convex/_generated folder, and one whose handlers leave a parameter untyped on
// several lines. The gate compares file, code and message, so the draft counts errors that way.
it.each([
  [
    "convex/chat.ts(2,24): error TS2307: Cannot find module './_generated/server' or its corresponding type declarations.",
  ],
  [3, 9, 15].map(
    (line) =>
      `src/ai.ts(${line},10): error TS7006: Parameter 'messages' implicitly has an 'any' type.`,
  ),
])('says what a compared type check checked instead of that it passed (%#)', async (...errors) => {
  checks.typeErrors = errors;
  const root = await repository({ 'src/ai.ts': SOURCE });
  const command = ['npx', 'tsc', '--noEmit'];
  await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    now: NOW,
    checks: { ...CHECKS, command, compareTypeErrors: true },
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  const existing =
    'reported 1 existing type error on the original code, counted by file, code and message, and no error with a new file, code and message on the migrated code';
  expect(published[0].body).toContain(
    `- Patched \`npx tsc --noEmit\`: passed; the type check ${existing}`,
  );
  expect(published[0].message.replace(/\n\s*/g, ' ')).toContain(
    `Checks: npx tsc --noEmit ${existing}, in offline Docker;`,
  );
});

// A request to the replacement that Refit's own key sent in refit-bench Actions.
const PROVEN: RequestProofTable = {
  formatVersion: 1,
  proofs: [
    {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      api: 'chat.completions',
      parameters: ['max_completion_tokens'],
      checks: { request: 'passed', json: 'passed', tools: 'passed', stream: 'passed' },
      run: 'https://github.com/refit-dev/refit-bench/actions/runs/1',
      date: '2026-10-29',
    },
  ],
  pending: [],
};

it('opens a draft pull request for validated replacements without asking first', async () => {
  const root = await repository({ 'src/ai.ts': SOURCE });
  const result = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    proofs: PROVEN,
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
  expect(published[0].body).not.toContain('## Why this needs review');
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
  // Never a claim that the replacement behaves the same.
  expect(body).toContain('## Outputs may differ');
  expect(body).toContain('Check output quality on your own prompts before merging.');
  expect(body).toContain(
    '- `gpt-5.6-sol` `chat.completions`: accepted with `max_completion_tokens`; request, json, tools, stream passed ([run](https://github.com/refit-dev/refit-bench/actions/runs/1), 2026-10-29).',
  );

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

it('marks a draft [Needs review] with the exact reason when a replacement has no request proof', async () => {
  const root = await repository({
    'src/ai.ts': SOURCE,
    '.env.example': 'OPENAI_MODEL=gpt-4\n',
  });
  await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    proofs: {
      formatVersion: 1,
      proofs: [],
      pending: [
        {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          api: 'chat.completions',
          reason: 'Blocked: the proof run was cancelled.',
        },
      ],
    },
    now: NOW,
    checks: CHECKS,
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  expect(published[0].title).toBe('[Needs review] fix: replace 1 retiring AI model');
  const body = published[0].body;
  expect(body.startsWith('## Why this needs review\n')).toBe(true);
  expect(body).toContain(
    '- No request-level proof for `gpt-5.6-sol`: Blocked: the proof run was cancelled. **Check:**',
  );
  expect(body).toContain('- `gpt-5.6-sol`: not proven. Blocked: the proof run was cancelled.');
  // The configuration file is listed, never edited.
  expect(body).toContain('## Alert only');
  expect(body).toContain('- `.env.example:1` `gpt-4` (configuration):');
});

// A fallback an environment variable overrides is edited, but the deployed value is not in the
// repository, so the draft says what to set; a model only the environment sets is listed.
it('marks a draft [Needs review] when an environment variable overrides an edited fallback', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "const MODEL = process.env.OPENAI_MODEL || 'gpt-4';",
      'export const chat = (messages: any[]) => openai.chat.completions.create({ model: MODEL, messages });',
      'export const again = (messages: any[]) => openai.chat.completions.create({ model: MODEL, messages });',
      'export const other = (messages: any[]) => openai.chat.completions.create({ model: process.env.OTHER_MODEL!, messages });',
    ].join('\n'),
  });
  const result = await runModelFixes({
    repository: root,
    registry,
    parameters: EMPTY_MODEL_PARAMETERS,
    proofs: PROVEN,
    now: NOW,
    checks: CHECKS,
    publication: { repository: 'example/app', base: 'main', token: 'token' },
  });
  expect(result.replacements.map((item) => [item.edited.line, item.env])).toEqual([
    [3, ['OPENAI_MODEL']],
  ]);
  expect(published[0].title).toBe('[Needs review] fix: replace 1 retiring AI model');
  const body = published[0].body;
  expect(body).toContain(
    '- `src/ai.ts:3` reads `OPENAI_MODEL` first, and where one is set it overrides the edited value; its value is outside the repository. **Check:** set `OPENAI_MODEL` to `gpt-5.6-sol` wherever it is set, including hosting and CI secrets.',
  );
  expect(body).toContain('## Set in the environment');
  expect(body).toContain('- `src/ai.ts:6` `chat.completions.create` reads `OTHER_MODEL`');
});

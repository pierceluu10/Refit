import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { sandboxInput, validateMigration } from './validation.ts';
import { digest } from './specifications.ts';
import { runWorkflow } from './workflow.ts';

const execute = promisify(execFile);
const directories: string[] = [];
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const options = {
  before: resolve('pipeline/fixtures/before.json'),
  after: resolve('pipeline/fixtures/after.json'),
  apiVersion: '2022-08-01',
  image: IMAGE ?? 'node:22-alpine',
};
const SOURCE = `import Stripe from 'stripe';
const stripe = new Stripe();
export async function history(id) {
  const intent = await stripe.paymentIntents.retrieve(id);
  return intent.charges.data;
}
`;

it('blocks a publishable validation before repository access when API-version applicability is unknown', async () => {
  await expect(
    validateMigration({
      repository: '/missing/repository',
      ...options,
      apiVersion: undefined,
      command: ['npm', 'test'],
      requireApiVersionMatch: true,
    }),
  ).rejects.toThrow(/Application API version is not configured/);
});

async function repository(executable = false, source = SOURCE) {
  const root = await mkdtemp(join(tmpdir(), 'refit-container-test-'));
  directories.push(root);
  await mkdir(join(root, 'node_modules/stripe'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module","dependencies":{"stripe":"test"}}');
  await writeFile(join(root, 'billing.js'), source);
  if (executable) await chmod(join(root, 'billing.js'), 0o755);
  await writeFile(
    join(root, 'node_modules/stripe/package.json'),
    '{"type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(root, 'node_modules/stripe/index.js'),
    `
    const data = [{ id: 'ch_1' }, { id: 'ch_2' }];
    export default class Stripe {
      paymentIntents = { retrieve: async id => ({ id, charges: { data } }) };
      charges = { list: async ({ payment_intent }) => {
        if (payment_intent !== 'pi_test') throw new Error('Incorrect PaymentIntent');
        return { data };
      } };
    }
  `,
  );
  await execute('git', ['init', root]);
  await execute('git', ['-C', root, 'add', '--force', '.']);
  await execute('git', [
    '-C',
    root,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: seed validation repository',
  ]);
  return root;
}

it('rejects declared version conflicts before Docker resolution or dependency installation', async () => {
  const root = await repository();
  await writeFile(
    join(root, 'billing.js'),
    SOURCE.replace('new Stripe()', "new Stripe('test', { apiVersion: '2022-11-15' })"),
  );
  await execute('git', ['-C', root, 'add', 'billing.js']);
  await execute('git', [
    '-C',
    root,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'test: pin conflicting SDK API version',
  ]);
  vi.stubEnv('DOCKER_HOST', 'unix:///missing/refit-version-test.sock');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    validateMigration({
      ...options,
      repository: root,
      image: 'unavailable-version-test-image',
      prepareDependencies: true,
      command: ['npm', 'test'],
      aiPatch: { apiKey: 'unused', model: 'unused' },
    }),
  ).rejects.toThrow(/Declared SDK API version 2022-11-15/);
  expect(fetcher).not.toHaveBeenCalled();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.skipIf(!IMAGE).each(['preserve', 'conflict', 'dynamic'] as const)(
  'checks a controlled AI proposal against verified SDK versions in actual containers: %s',
  async (versionChange) => {
    const original = SOURCE.replace(
      'new Stripe()',
      "new Stripe('test', { apiVersion: '2022-08-01' })",
    );
    const root = await repository(true, original);
    // The model edits the rule-patched code, whose apiVersion literal is already the target.
    const bumped = original.replace("apiVersion: '2022-08-01'", "apiVersion: '2022-11-15'");
    const migrated = bumped.replace(
      'intent.charges.data',
      '(await stripe.charges.list({ payment_intent: intent.id })).data',
    );
    const replacement =
      versionChange === 'conflict'
        ? migrated.replace("apiVersion: '2022-11-15'", "apiVersion: '2023-10-16'")
        : versionChange === 'dynamic'
          ? migrated.replace("apiVersion: '2022-11-15'", 'apiVersion: process.env.RUNTIME_VERSION')
          : migrated;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, request) => {
        const input = JSON.parse(JSON.parse(request.body).input[0].content);
        return new Response(
          JSON.stringify({
            id: 'resp_container_patch',
            model: 'test-model',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      summary: 'Read charge history using Charges list.',
                      uncertainties: ['Review pagination.'],
                      edits: [
                        {
                          file: 'billing.js',
                          original: bumped,
                          replacement,
                          findingId: input.findings[0].id,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
        );
      }),
    );
    const validation = validateMigration({
      ...options,
      repository: root,
      aiPatch: { apiKey: 'test-key', model: 'test-model' },
      command: [
        'node',
        '-e',
        "import('./billing.js').then(async m => require('assert/strict').deepEqual(await m.history('pi_test'), [{id:'ch_1'},{id:'ch_2'}]))",
      ],
    });
    if (versionChange !== 'preserve') {
      await expect(validation).rejects.toThrow(/changes or weakens the verified SDK API-version/);
      return;
    }
    const report = await validation;
    expect(report.validation.status).toBe('passed');
    expect(report.patch).toMatchObject({ generator: 'openai', validation: 'passed' });
    expect(report.publicationFiles).toEqual([
      {
        path: 'billing.js',
        mode: '100755',
        content: migrated,
      },
    ]);
    expect(await readFile(join(root, 'billing.js'), 'utf8')).toBe(original);
  },
  60_000,
);

it('rejects dirty repositories before attempting Docker execution', async () => {
  const root = await repository();
  await writeFile(join(root, 'billing.js'), `${SOURCE}\n// changed`);
  await expect(
    validateMigration({ ...options, repository: root, command: ['node', '--version'] }),
  ).rejects.toThrow(/clean committed repository/);
});

it.skipIf(!IMAGE)(
  'rejects archive substitutions rather than publishing source different from the commit',
  async () => {
    const root = await repository();
    await writeFile(join(root, '.gitattributes'), 'billing.js export-subst\n');
    await writeFile(join(root, 'billing.js'), `${SOURCE}\n// revision: $Format:%H$\n`);
    await execute('git', ['-C', root, 'add', '.']);
    await execute('git', [
      '-C',
      root,
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test: add archive substitution',
    ]);
    await expect(
      validateMigration({ ...options, repository: root, command: ['node', '--version'] }),
    ).rejects.toThrow(/Archived source does not match/);
  },
  60_000,
);

it('rejects malformed command arrays before starting any processes', async () => {
  await expect(
    validateMigration({ ...options, repository: '/unused', command: [] }),
  ).rejects.toThrow(/nonempty JSON array/);
  await expect(
    validateMigration({
      ...options,
      repository: '/unused',
      command: ['node'],
      baselineCommand: [],
    }),
  ).rejects.toThrow(/nonempty JSON array/);
});

it.each([-1, 3, 1.5, NaN])(
  'rejects invalid repair limits before starting processes: %s',
  async (repairAttempts) => {
    await expect(
      validateMigration({
        ...options,
        repository: '/unused',
        command: ['node'],
        repairAttempts,
        aiPatch: { apiKey: 'unused', model: 'unused' },
      }),
    ).rejects.toThrow(/Repair attempts must be/);
  },
);

it('requires AI opt-in before allowing repair attempts', async () => {
  await expect(
    validateMigration({ ...options, repository: '/unused', command: ['node'], repairAttempts: 1 }),
  ).rejects.toThrow(/require --ai-patch/);
});

it
  .skipIf(!IMAGE)
  .each([
    'success',
    'repeat',
    'exhausted',
    'invalid-edit',
    'baseline-failed',
    'disabled',
    'stale',
  ] as const)(
  'bounds AI repair and retains tested candidates in actual containers: %s',
  async (scenario) => {
    const root = await repository();
    let requests = 0;
    const good = '(await stripe.charges.list({ payment_intent: intent.id })).data';
    const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
      requests++;
      const body = JSON.parse(String(request.body));
      const evidence = JSON.parse(body.input[0].content);
      expect(evidence.files[0].content).toBe(SOURCE);
      expect(body.tools).toBeUndefined();
      // The third invalid-edit request is the one corrected request of repair 1 after its edit
      // was rejected, not a second repair.
      const attempt = scenario === 'invalid-edit' ? 1 : requests - 1;
      if (requests > 1) {
        expect(body.instructions).toContain('untrusted check output');
        expect(evidence.repair.attempt).toBe(attempt);
        expect(evidence.repair.failedPatch).toContain(
          attempt === 1 ? '+  return [];' : '+  return [1];',
        );
        expect(evidence.repair.check.stderr.length).toBeLessThanOrEqual(4096);
        expect(evidence.repair.check.truncated).toBe(true);
        expect(evidence.repair.check.stderr).toContain('repair_test_failure');
      }
      if (scenario === 'stale' && requests === 1)
        await writeFile(join(root, 'billing.js'), `${SOURCE}\n// user edit\n`);
      const replacement =
        requests === 1 || scenario === 'repeat'
          ? '[]'
          : scenario === 'exhausted'
            ? `[${requests - 1}]`
            : good;
      return new Response(
        JSON.stringify({
          id: `resp_repair_${requests}`,
          model: 'test-model',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    summary: 'Controlled repair proposal.',
                    uncertainties: ['Review pagination.'],
                    edits: [
                      {
                        file:
                          requests > 1 && scenario === 'invalid-edit'
                            ? 'unrelated.ts'
                            : 'billing.js',
                        original: 'intent.charges.data',
                        replacement,
                        findingId: evidence.findings[0].id,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const progress: string[] = [];
    const result = await validateMigration({
      ...options,
      repository: root,
      aiPatch: { apiKey: 'test-key', model: 'test-model' },
      repairAttempts: scenario === 'disabled' ? 0 : 2,
      onProgress: (message) => progress.push(message),
      command:
        scenario === 'baseline-failed'
          ? ['node', '-e', 'process.exit(9)']
          : [
              'node',
              '-e',
              `import('./billing.js').then(async m => { const result = await m.history('pi_test'); if (result.length !== 2) console.error('repair_test_failure: ' + 'x'.repeat(5000)); require('assert/strict').deepEqual(result, [{id:'ch_1'},{id:'ch_2'}]); })`,
            ],
    });
    const expectedRequests =
      scenario === 'baseline-failed'
        ? 0
        : ['exhausted', 'invalid-edit'].includes(scenario)
          ? 3
          : ['baseline-failed', 'disabled', 'stale'].includes(scenario)
            ? 1
            : 2;
    expect(requests, JSON.stringify(result.validation, null, 2)).toBe(expectedRequests);
    expect(result.validation.repair.requested).toBe(
      scenario === 'invalid-edit' ? 1 : Math.max(0, requests - 1),
    );
    expect(progress.filter((message) => message.includes('Requesting AI repair'))).toHaveLength(
      result.validation.repair.requested,
    );
    expect(progress.join('\n')).not.toContain('test-key');
    expect(result.validation.status).toBe(
      scenario === 'success'
        ? 'passed'
        : scenario === 'baseline-failed'
          ? 'baseline-failed'
          : scenario === 'stale'
            ? 'stale'
            : 'regression',
    );
    expect(result.validation.attempts.length, JSON.stringify(result.validation, null, 2)).toBe(
      scenario === 'baseline-failed'
        ? 0
        : scenario === 'success'
          ? 2
          : scenario === 'exhausted'
            ? 3
            : 1,
    );
    expect(result.validation.patchHash).toBe(digest(result.patch.diff));
    if (scenario !== 'baseline-failed')
      expect(result.validation.attempts.at(-1)?.patchHash).toBe(result.validation.patchHash);
    else {
      expect(fetcher).not.toHaveBeenCalled();
      expect(result.validation.patched.status).toBe('not-run');
      expect(result.publicationFiles).toEqual([]);
    }
    if (scenario === 'success') {
      expect(progress).toEqual([
        'Running baseline checks in offline Docker...',
        'Requesting an AI migration proposal...',
        'Running patched checks in offline Docker...',
        'Patched checks failed. Requesting AI repair 1 of 2...',
        'Running repaired checks in offline Docker...',
      ]);
      expect(result.validation.repair.stopReason).toBe('checks-passed');
      expect(result.validation.attempts.map((attempt) => attempt.check.status)).toEqual([
        'failed',
        'passed',
      ]);
      expect(result.publicationFiles[0].content).toBe(SOURCE.replace('intent.charges.data', good));
    }
    if (scenario === 'repeat')
      expect(result.validation.repair.stopReason).toBe('repeated-proposal');
    if (scenario === 'exhausted') expect(result.validation.repair.stopReason).toBe('attempt-limit');
    if (scenario === 'invalid-edit')
      expect(result.validation.repair.error).toContain('outside its allowed scope');
    if (scenario !== 'stale') expect(await readFile(join(root, 'billing.js'), 'utf8')).toBe(SOURCE);
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'runs baseline and migration in restricted containers without changing the repository',
  async () => {
    const root = await repository();
    vi.stubEnv('REFIT_HOST_SECRET', 'must-not-enter-container');
    const bundle = `${root}-review`;
    directories.push(bundle);
    const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.equal(process.getuid(), 65534);
    assert.throws(() => fs.writeFileSync('/input/changed', 'x'));
    assert.equal(process.env.REFIT_HOST_SECRET, undefined);
    assert.deepEqual(Object.keys(require('node:os').networkInterfaces()), ['lo']);
    import('./billing.js').then(async ({ history }) => {
      assert.deepEqual(await history('pi_test'), [{id:'ch_1'}, {id:'ch_2'}]);
      console.log('charge history passed');
    });
  `;
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'pipeline/validation-cli.ts',
      '--repository',
      root,
      '--before',
      options.before,
      '--after',
      options.after,
      '--image',
      options.image,
      '--command',
      JSON.stringify(['node', '-e', script]),
      '--bundle',
      bundle,
    ]);
    const output = JSON.parse(result.stdout);
    expect(output.directory).toBe(bundle);
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) {
      const content = await readFile(join(bundle, file.path), 'utf8');
      expect(digest(content)).toBe(file.sha256);
      expect(Buffer.byteLength(content)).toBe(file.bytes);
    }
    const report = JSON.parse(await readFile(join(bundle, 'report.json'), 'utf8'));
    expect(await readFile(join(bundle, 'migration.patch'), 'utf8')).toBe(report.patch.diff);
    expect(await readFile(join(bundle, 'pull-request.md'), 'utf8')).toContain(
      'Publication: Local review artifact; Refit has not pushed a branch or opened a pull request.',
    );
    expect(report.validation.status).toBe('passed');
    expect(report.validation.baseline.stdout).toContain('charge history passed');
    expect(report.validation.patched.stdout).toContain('charge history passed');
    expect(report.validation.image).toMatch(/^sha256:/);
    expect(report.validation.publishable).toBe(false);
    expect(report.patch.validation).toBe('passed');
    expect(report.publicationFiles).toEqual([
      {
        path: 'billing.js',
        mode: '100644',
        content: SOURCE.replace(
          'intent.charges.data',
          '(await stripe.charges.list({ payment_intent: intent.id })).data',
        ),
      },
    ]);
    expect(await readFile(join(root, 'billing.js'), 'utf8')).toBe(SOURCE);
    expect((await execute('git', ['-C', root, 'status', '--porcelain'])).stdout).toBe('');
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'distinguishes migration regressions from pre-existing baseline failures',
  async () => {
    const root = await repository();
    const regression = await validateMigration({
      ...options,
      repository: root,
      command: [
        'node',
        '-e',
        "process.exit(require('fs').readFileSync('billing.js','utf8').includes('return intent.charges.data') ? 0 : 7)",
      ],
    });
    expect(regression.validation.status).toBe('regression');
    expect(regression.validation.baseline.exitCode).toBe(0);
    expect(regression.validation.patched.exitCode).toBe(7);
    const baseline = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '-e', 'process.exit(8)'],
    });
    expect(baseline.validation.status).toBe('baseline-failed');
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'records excessive output as an execution error instead of a passing check',
  async () => {
    const root = await repository();
    const report = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    });
    expect(report.validation.status).toBe('error');
    expect(report.validation.baseline.status).toBe('error');
    expect(report.validation.patched.status).toBe('not-run');
    const patched = await validateMigration({
      ...options,
      repository: root,
      baselineCommand: ['node', '--version'],
      command: ['node', '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    });
    expect(patched.validation.baseline.status).toBe('passed');
    expect(patched.validation.patched.status).toBe('error');
    expect(Buffer.byteLength(patched.validation.patched.stdout)).toBeLessThanOrEqual(
      patched.validation.limits.outputBytes,
    );
    expect(report.validation.publishable).toBe(false);
  },
  60_000,
);

it.skipIf(!IMAGE).each(['validated', 'regression', 'published', 'publication-error'] as const)(
  'runs the combined workflow through actual Docker checks: %s',
  async (scenario) => {
    const root = await repository();
    const output = `${root}-workflow`;
    directories.push(output);
    const revision = (await execute('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const tree = 'c'.repeat(40);
    const head = 'd'.repeat(40);
    let branchExists = false;
    const fetcher = vi.fn(async (url: string, request: RequestInit) => {
      const path = decodeURIComponent(
        new URL(url).pathname.replace('/repos/example/application', ''),
      );
      const response = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status });
      if (path === '/git/ref/heads/main')
        return response({ object: { type: 'commit', sha: revision } });
      if (path.startsWith('/git/ref/heads/refit/'))
        return branchExists
          ? response({ object: { type: 'commit', sha: head } })
          : response({}, 404);
      if (path === `/git/commits/${revision}`) return response({ tree: { sha: 'b'.repeat(40) } });
      if (path === '/git/trees') return response({ sha: tree });
      if (path === '/git/commits') return response({ sha: head });
      if (path === '/git/refs') {
        branchExists = true;
        return response({});
      }
      if (path === `/git/commits/${head}`)
        return response({ tree: { sha: tree }, parents: [{ sha: revision }] });
      if (path === '/pulls' && request.method === 'GET') return response([]);
      if (path === '/pulls' && request.method === 'POST')
        return scenario === 'publication-error'
          ? response({}, 503)
          : response({
              number: 1,
              html_url: 'https://github.com/example/application/pull/1',
              head: { sha: head },
              base: { ref: 'main' },
              draft: true,
              state: 'open',
            });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await runWorkflow({
      ...options,
      repository: root,
      output,
      command:
        scenario === 'regression'
          ? [
              'node',
              '-e',
              "process.exit(require('fs').readFileSync('billing.js','utf8').includes('return intent.charges.data') ? 0 : 7)",
            ]
          : [
              'node',
              '-e',
              "import('./billing.js').then(async m => require('assert/strict').deepEqual(await m.history('pi_test'), [{id:'ch_1'},{id:'ch_2'}]))",
            ],
      publication:
        scenario === 'validated'
          ? undefined
          : { repository: 'example/application', base: 'main', token: 'test-private-token' },
    });
    const expected = {
      validated: 'validated',
      regression: 'validation-failed',
      published: 'draft-created',
      'publication-error': 'error',
    }[scenario];
    expect(result.manifest.status).toBe(expected);
    expect(result.manifest.stage).toBe(scenario.startsWith('publi') ? 'publication' : 'validation');
    expect(await readFile(join(root, 'billing.js'), 'utf8')).toBe(SOURCE);
    expect(
      JSON.parse(await readFile(join(output, 'report.json'), 'utf8')).validation.revision,
    ).toBe(revision);
    for (const file of result.manifest.files)
      expect(digest(await readFile(join(output, file.path)))).toBe(file.sha256);
    if (scenario === 'validated' || scenario === 'regression')
      expect(fetcher).not.toHaveBeenCalled();
    if (scenario === 'published')
      expect(JSON.parse(await readFile(join(output, 'publication.json'), 'utf8')).draft).toBe(true);
    if (scenario === 'publication-error')
      expect(result.manifest.error?.message).toContain('HTTP 503');
  },
  60_000,
);

it('makes folders mounted into the sandbox readable by its unprivileged user', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-sandbox-input-'));
  directories.push(root);
  const directory = await sandboxInput(root, 'candidate-');
  expect(directory.startsWith(join(root, 'candidate-'))).toBe(true);
  expect((await stat(directory)).mode & 0o777).toBe(0o755);
});

it.skipIf(!IMAGE)(
  'writes behaviour tests during validation from the original code, never the patch, after both checks pass',
  async () => {
    const root = await repository();
    const test = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../billing.js';
test('returns the charge history', async () => {
  assert.equal((await history('pi_test')).length, 2);
});
`;
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/input_tokens')
        ? new Response(JSON.stringify({ input_tokens: 3000 }))
        : new Response(
            JSON.stringify({
              id: 'resp_behaviour',
              model: 'gpt-6.1-sol',
              status: 'completed',
              usage: { input_tokens: 3000, output_tokens: 2000 },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        summary: 'One test.',
                        uncertainties: [],
                        files: [
                          {
                            path: 'refit-behaviour/history.test.mjs',
                            content: test,
                            findingIds: ['f1'],
                          },
                        ],
                      }),
                    },
                  ],
                },
              ],
            }),
          ),
    );
    vi.stubGlobal('fetch', fetcher);
    // The ledger lives outside the repository, which must stay clean for the result to count.
    const ledger = await mkdtemp(join(tmpdir(), 'refit-behaviour-budget-'));
    directories.push(ledger);
    const report = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '--version'],
      behaviourTestWriter: {
        apiKey: 'test-key',
        model: 'gpt-6.1-sol',
        budget: { directory: ledger, limitUsd: 1 },
      },
    });
    expect(report.validation.status).toBe('passed');
    expect(report.validation.behaviourTestWriter).toMatchObject({
      status: 'generated',
      files: [{ path: 'refit-behaviour/history.test.mjs', sha256: digest(test) }],
    });
    // The written files reach the harness, which needs the stripe-mock settings this run lacks.
    expect(report.validation.behaviour).toMatchObject({
      status: 'unavailable',
      grade: null,
      tests: [{ path: 'refit-behaviour/history.test.mjs', sha256: digest(test) }],
    });
    const sent = fetcher.mock.calls.find(([url]) => !url.endsWith('/input_tokens'))!;
    const evidence = JSON.parse(JSON.parse(String(sent[1]!.body)).input[0].content);
    expect(evidence.files).toEqual([{ path: 'billing.js', content: SOURCE }]);
    expect(JSON.stringify(evidence)).not.toContain(report.patch.diff);
    expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);
  },
  60_000,
);

it.skipIf(!IMAGE)(
  'writes behaviour tests where the baseline fails, never where the patched checks fail',
  async () => {
    const root = await repository();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const behaviourTestWriter = { model: 'gpt-6.1-sol', dryRun: true as const };
    // A broken baseline no longer hides the patch from behaviour tests; the patched checks are
    // not run against a suite that already fails.
    const broken = await validateMigration({
      ...options,
      repository: root,
      command: ['node', '-e', 'process.exit(8)'],
      behaviourTestWriter,
    });
    expect(broken.validation).toMatchObject({
      status: 'baseline-failed',
      patched: { status: 'not-run' },
      behaviourTestWriter: { status: 'dry-run', wouldRun: true, findings: 1 },
    });
    // A patch whose checks ran and failed is never published, so nothing is written for it.
    const regression = await validateMigration({
      ...options,
      repository: root,
      command: [
        'node',
        '-e',
        "process.exit(require('fs').readFileSync('billing.js','utf8').includes('return intent.charges.data') ? 0 : 7)",
      ],
      behaviourTestWriter,
    });
    expect(regression.validation).toMatchObject({
      status: 'regression',
      behaviourTestWriter: {
        status: 'dry-run',
        wouldRun: false,
        reason: 'The patched checks failed, so the patch is not published.',
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
  60_000,
);

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createReviewArtifacts, writeReviewBundle } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';

const directories: string[] = [];
type Report = Awaited<ReturnType<typeof validateMigration>>;

async function report(): Promise<Report> {
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/repository'),
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  return {
    ...scan,
    publicationFiles: [{ path: 'src/billing/history.ts', mode: '100644', content: 'export {};' }],
    patch: { ...scan.patch, validation: 'regression' },
    validation: {
      status: 'regression',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: { status: 'failed', exitCode: 1, stdout: '', stderr: 'expected charge history' },
      limits: { timeoutMs: 120_000, outputBytes: 1024 * 1024, network: 'none' },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for artifact formatting tests.',
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('exports regression evidence without implying that checks passed or a PR exists', async () => {
  const artifacts = createReviewArtifacts(await report());
  expect(artifacts.files['pull-request.md']).toContain('Validation did not pass (regression)');
  expect(artifacts.files['pull-request.md']).toContain('has not pushed a branch');
  expect(artifacts.manifest).toMatchObject({
    published: false,
    reviewRequired: true,
    validationStatus: 'regression',
  });
  expect(JSON.parse(artifacts.files['report.json']).validation.patched.stderr).toBe(
    'expected charge history',
  );
});

it('puts a concise engineer-facing summary before the collapsed machine evidence', async () => {
  const body = createReviewArtifacts(await report()).files['pull-request.md'];
  const visible = body.slice(0, body.indexOf('<details>'));
  expect(visible).toContain('## What changed');
  expect(visible).toContain('API contract removes');
  expect(visible).toContain('payment_intent.charges');
  expect(visible).toContain('`payment_intent.charges`');
  expect(visible).toContain(
    '**API version:** Application pin 2022-08-01 matches the before contract 2022-08-01; proposed contract 2022-11-15.',
  );
  expect(visible).toMatch(/confirmed usages? across 1 file/);
  expect(visible).toContain('`src/billing/history.ts`');
  expect(visible).toContain('## Checks');
  expect(visible).not.toContain('```json');
  expect(visible).not.toContain('## Sources');
  expect(body).toContain('<summary>Technical evidence and exact check commands</summary>');
});

it('refuses inconsistent patch evidence and false passing status', async () => {
  const value = await report();
  value.validation.patchHash = 'wrong';
  expect(() => createReviewArtifacts(value)).toThrow(/consistent patch/);
  value.validation.patchHash = digest(value.patch.diff);
  value.patch.validation = value.validation.status = 'passed';
  expect(() => createReviewArtifacts(value)).toThrow(/two successful/);
});

it('contains Markdown fence characters from repository evidence inside a JSON code block', async () => {
  const value = await report();
  value.findings[0].file = '```\n# forged heading';
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('````json');
  expect(body).toContain('"file": "```\\n# forged heading"');
});

it('adds one short source line per cited passage', async () => {
  const value = await report();
  const passage = {
    id: 'a'.repeat(16),
    provider: 'stripe',
    sourceUrl: 'https://docs.stripe.com/api/charges/list',
    pageSha256: 'b'.repeat(64),
    headingPath: ['Charges', 'charges'],
    kind: 'doc' as const,
    text: `${'PaymentIntent charge history '.repeat(20)}unique-passage-body`,
  };
  value.patch = {
    ...value.patch,
    generator: 'openai',
    provider: 'openai',
    model: 'test-model',
    responseId: 'resp_sources',
    evidenceHash: 'e'.repeat(64),
    usage: null,
    budget: null,
    retrieval: {
      indexSha256: 'c'.repeat(64),
      findings: [
        {
          findingId: 'finding',
          file: 'billing.ts',
          line: 8,
          query: { provider: 'stripe', fields: ['charges'] },
          passages: [{ id: passage.id, score: 1 }],
          citedPassageIds: [passage.id],
          unresolvedReason: null,
        },
      ],
      passages: [passage],
    },
  } as Report['patch'];
  const body = createReviewArtifacts(value).files['pull-request.md'];
  const visible = body.slice(0, body.indexOf('<details>'));
  expect(visible).toContain('## Sources');
  expect(visible).toContain('https://docs.stripe.com/api/charges/list');
  expect(visible).toContain('Documentation under Charges / charges explains the cited change.');
  expect(visible).not.toContain(passage.text);
});

it('creates a private bundle and refuses to replace any existing bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-review-test-'));
  directories.push(root);
  const destination = join(root, 'review');
  const value = await report();
  await writeReviewBundle(destination, value);
  const original = await readFile(join(destination, 'report.json'), 'utf8');
  await expect(writeReviewBundle(destination, value)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(destination, 'report.json'), 'utf8')).toBe(original);
  if (process.platform !== 'win32') {
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, 'report.json'))).mode & 0o777).toBe(0o600);
  }
});

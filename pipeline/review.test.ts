import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
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

it('accepts a compared typecheck that exits nonzero on errors that predate the patch', async () => {
  const base = await report();
  const passed: Report = {
    ...base,
    patch: { ...base.patch, validation: 'passed' },
    validation: {
      ...base.validation,
      status: 'passed',
      baseline: { status: 'passed', exitCode: 2, stdout: 'a.ts(1,1): error TS7006: x', stderr: '' },
      patched: { status: 'passed', exitCode: 2, stdout: 'a.ts(1,1): error TS7006: x', stderr: '' },
    },
  };
  expect(() => createReviewArtifacts(passed)).toThrow('two successful check results');
  const compared = { ...passed, validation: { ...passed.validation, compareTypeErrors: true } };
  expect(createReviewArtifacts(compared).files['pull-request.md']).toContain('passed');
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

it('follows the PR template: five sections, single-sentence bullets and no emoji', async () => {
  const value = await report();
  value.changes.unshift({
    id: 'unrelated',
    schema: 'invoice',
    property: 'subscription',
    pointer: '/components/schemas/invoice/properties/subscription',
  });
  const { files, manifest } = createReviewArtifacts(value);
  const body = files['pull-request.md'];
  expect(manifest.title).toBe('fix(stripe): restore payment history after charges removal');
  expect(manifest.title.length).toBeLessThanOrEqual(70);
  expect(body.split('\n').filter((entry) => entry.startsWith('## '))).toEqual([
    '## Overview',
    '## API Impact & Spec Changes',
    '## Key Changes',
    '## Code Changes',
    '## Automated Verification Gates',
    '## Related Telemetry',
  ]);
  expect(body).toContain('A deterministic Refit rule migrates');
  expect(body).toContain('- Breaking Changes: Removes response fields `payment_intent.charges`');
  expect(body).toContain('- `billing.ts`: Migrates reads of `payment_intent.charges`');
  expect(body).toContain('- Test Suite Output: **Validation did not pass (regression).**');
  expect(body).toContain('- Security Scans: Not run.');
  expect(body).toContain('`billing.ts:7` in `chargeHistory()`');
  expect(body).toContain('```diff');
  expect(body).not.toContain('invoice.subscription');
  expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
});

async function renameReport(evidence?: Record<string, unknown>): Promise<Report> {
  const root = await mkdtemp(join(tmpdir(), 'refit-review-rename-'));
  directories.push(root);
  const contract = (property: string, version: string) => ({
    openapi: '3.0.3',
    info: { title: 'Simulated OpenAI contract', version },
    paths: {
      '/models/{model}': {
        get: {
          responses: {
            '200': {
              description: 'Model',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Model' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Model: {
          type: 'object',
          required: ['id', property],
          properties: { id: { type: 'string' }, [property]: { type: 'string' } },
        },
      },
    },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract('owned_by', '2.3.0')));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract('owner_name', '2.4.0')));
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/openai/repository'),
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: resolve('pipeline/fixtures/openai/provider-renames.json'),
    apiVersion: '2.3.0',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  const passed = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const value = {
    ...scan,
    publicationFiles: [{ path: 'models.js', mode: '100644', content: '' }],
    patch: { ...scan.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      command: ['npm', 'run', 'test:after'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: passed,
      patched: passed,
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: true,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for artifact formatting tests.',
    },
  } as Report;
  if (!evidence) return value;
  // Simulates an AI proposal for the same diff, without the configured rename rule.
  return {
    ...value,
    adapter: { ...value.adapter, propertyRenames: undefined },
    patch: { ...value.patch, generator: 'openai', model: 'test-model', evidence },
  } as unknown as Report;
}

function visibleBody(value: Report) {
  return createReviewArtifacts(value, 'github').files['pull-request.md'];
}

it('shows the exact changed lines and the configured rule behind a deterministic rename', async () => {
  const visible = visibleBody(await renameReport());
  expect(visible).toContain('Replaces `Model.owned_by` → `Model.owner_name`.');
  expect(visible).toContain('- `models.js`: Migrates reads of `Model.owned_by`');
  expect(visible).toContain('- Review: An operator-configured rename rule maps `Model.owned_by`');
  expect(visible).toContain('`npm run test:after` on the migrated code in offline Docker.');
});

it('warns when only the name and type support an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [{ schema: 'Model', property: 'owner_name', type: 'string' }],
    }),
  );
  expect(visible).toContain(
    'same type (string). Nothing documents it as the replacement for `owned_by`',
  );
  expect(visible).toContain('AI (`test-model`), checked by Refit, migrates');
});

it('quotes the contract description that documents an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [
        {
          schema: 'Model',
          property: 'owner_name',
          type: 'string',
          description: 'Replaces owned_by. Values are unchanged.',
        },
      ],
    }),
  );
  expect(visible).toContain(
    'The after contract documents `owner_name` as the replacement: “Replaces owned\\_by. Values are unchanged.”',
  );
  expect(visible).not.toContain('⚠️');
});

it('quotes the vendor note sentence that explains an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [{ schema: 'Model', property: 'owner_name', type: 'string' }],
      documentation: [
        {
          label: 'Changelog',
          url: 'https://docs.example.com/changelog',
          content:
            'API 2.4.0 ships today.\nModel.owned_by was renamed to Model.owner_name. Values are unchanged.',
        },
      ],
    }),
  );
  expect(visible).toContain(
    'The attached vendor note (Changelog, https://docs.example.com/changelog) says “Model.owned\\_by was renamed to Model.owner\\_name.”',
  );
  expect(visible).not.toContain('⚠️');
});

it('refuses inconsistent patch evidence and false passing status', async () => {
  const value = await report();
  value.validation.patchHash = 'wrong';
  expect(() => createReviewArtifacts(value)).toThrow(/consistent patch/);
  value.validation.patchHash = digest(value.patch.diff);
  value.patch.validation = value.validation.status = 'passed';
  expect(() => createReviewArtifacts(value)).toThrow(/two successful/);
});

it('keeps Markdown from repository file names out of the PR text structure', async () => {
  const value = await report();
  value.findings[0].file = '```\n# forged heading';
  value.findings[0].untraced = true;
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('````` # forged heading');
  expect(body).not.toContain('\n# forged heading');
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

it('says when the open-enum repair restored widened Stripe enum values', async () => {
  const value = await report();
  const plain = createReviewArtifacts(value).files['pull-request.md'];
  expect(plain).not.toContain('OtherString');
  value.validation.repair.stopReason = 'open-enum-repair';
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    'Restores the known values of the Stripe enums that stripe-node 22.4.0 widened with `OtherString`',
  );
});

it('marks a draft with an untraced read for review and keeps it out of the confirmed count', async () => {
  const value = await report();
  value.findings.push({
    ...value.findings[0],
    file: 'legacy.ts',
    confidence: 'review',
    untraced: true,
  });
  value.patch.unresolvedFindings = 1;
  const artifacts = createReviewArtifacts(value);
  expect(artifacts.manifest.title).toMatch(/^\[Needs review\] /);
  const body = artifacts.files['pull-request.md'];
  expect(body).toContain(
    '0 confirmed usages of the breaking changes remain, plus 1 untraced read of removed field names.',
  );
  expect(body).toContain(
    'Leaves 1 untraced read of removed field names unchanged for manual review',
  );
  expect(body).not.toContain('still unmigrated');
});

it('says when npm installed the committed lockfile with --legacy-peer-deps', async () => {
  const value = await report();
  expect(createReviewArtifacts(value).files['pull-request.md']).not.toContain('legacy-peer-deps');
  value.validation.environment = { installation: { legacyPeerDeps: true } };
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    "- Dependency Installation: `npm ci` rejected the committed lockfile's peer dependencies (ERESOLVE), so Refit installed the same lockfile with `--legacy-peer-deps`.",
  );
});

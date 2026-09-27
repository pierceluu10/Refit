import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { findRemovedProperties, readSpecification } from './specifications.ts';
import type { Repository } from './types.ts';

const FIXTURES = resolve('pipeline/fixtures');
const before = join(FIXTURES, 'before.json');
const after = join(FIXTURES, 'after.json');
const changes = [
  {
    id: 'charges-removed',
    schema: 'payment_intent',
    property: 'charges',
    pointer: '/components/schemas/payment_intent/properties/charges',
  },
];
const directories: string[] = [];
const execute = promisify(execFile);

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'refit-test-'));
  directories.push(directory);
  return directory;
}

function analyze(content: string) {
  const repository: Repository = {
    root: '/virtual',
    files: [{ path: 'billing.ts', content }],
    dependencies: [],
    warnings: [],
  };
  return analyzeRepository(repository, changes);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Stripe historical replay', () => {
  it('writes a parseable CLI report and refuses to overwrite an existing file', async () => {
    const directory = await temporaryRepository();
    const output = join(directory, 'report.json');
    const argumentsList = [
      '--import',
      'tsx',
      'pipeline/cli.ts',
      '--repository',
      join(FIXTURES, 'repository'),
      '--before',
      before,
      '--after',
      after,
      '--output',
      output,
    ];
    await execute(process.execPath, argumentsList);
    const original = await readFile(output, 'utf8');
    expect(JSON.parse(original).status).toBe('affected');
    await expect(execute(process.execPath, argumentsList)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('EEXIST'),
    });
    expect(await readFile(output, 'utf8')).toBe(original);
  });

  it('exits unsuccessfully with actionable usage when required CLI inputs are missing', async () => {
    await expect(
      execute(process.execPath, ['--import', 'tsx', 'pipeline/cli.ts']),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--repository') });
  });
  it('detects the real removed field with location evidence, stable hashes and no repository changes', async () => {
    const repository = join(FIXTURES, 'repository');
    const source = await readFile(join(repository, 'billing.ts'), 'utf8');
    const report = await runPipeline({ repository, before, after });
    expect(report.status).toBe('affected');
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].property).toBe('charges');
    expect(report.findings).toEqual([
      expect.objectContaining({ file: 'billing.ts', line: 7, confidence: 'confirmed' }),
    ]);
    expect(report.repository.dependencies[0].version).toBe('^10.0.0');
    expect(report.runId).toBe((await runPipeline({ repository, before, after })).runId);
    expect(await readFile(join(repository, 'billing.ts'), 'utf8')).toBe(source);
    expect(report.patch.status).toBe('not-generated');
  });

  it('does not call a repository unaffected when wrappers cannot be resolved', async () => {
    const repository = await temporaryRepository();
    await writeFile(join(repository, 'package.json'), '{"dependencies":{"stripe":"^10"}}');
    await writeFile(
      join(repository, 'billing.ts'),
      'export const history = (payment: any) => payment.charges;',
    );
    const report = await runPipeline({ repository, before, after });
    expect(report.status).toBe('needs-review');
    expect(report.findings[0].confidence).toBe('review');
  });

  it('reports no Stripe signal without claiming that dynamic integrations are safe', async () => {
    const repository = await temporaryRepository();
    await writeFile(join(repository, 'index.js'), 'export const value = 1;');
    expect((await runPipeline({ repository, before, after })).status).toBe('no-stripe-signal');
  });
});

describe('symbol-based impact analysis', () => {
  const prefix = `import Payments from 'stripe'; const client = new Payments('test');`;
  it('tracks import aliases, client aliases, response aliases, literal indexes and destructuring', () => {
    const result = analyze(`${prefix}
      const alias = client;
      async function read() {
        const intent = await alias.paymentIntents.retrieve('pi_test');
        const response = intent;
        const { charges: history } = response;
        return response['charges'];
      }`);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.confidence === 'confirmed')).toBe(true);
  });
  it('does not confuse a shadowed client parameter with the imported Stripe client', () => {
    const result = analyze(`${prefix} async function read(client: any) {
      const intent = await client.paymentIntents.retrieve('pi_test'); return intent.charges;
    }`);
    expect(result.calls).toHaveLength(0);
    expect(result.findings[0].confidence).toBe('review');
  });
  it('does not confuse a shadowed response with the traced response', () => {
    const result = analyze(`${prefix} async function read() {
      const intent = await client.paymentIntents.retrieve('pi_test');
      function other(intent: any) { return intent.charges; }
      return intent.charges;
    }`);
    expect(result.findings.map((finding) => finding.confidence)).toEqual(['review', 'confirmed']);
  });
  it('keeps mutable bindings and computed fields in review', () => {
    const result = analyze(`${prefix} async function read(key: string) {
      let value = await client.paymentIntents.retrieve('pi_test');
      const intent = await client.paymentIntents.retrieve('pi_test');
      return [value.charges, intent[key]];
    }`);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
  });
  it('does not match comments, strings or unrelated fields without a Stripe signal', () => {
    expect(
      analyze(
        '// intent.charges\nconst text = "stripe.paymentIntents.retrieve"; const result = other.charges;',
      ).findings,
    ).toEqual([]);
  });
  it('recognizes CommonJS as requiring review', () => {
    const result = analyze(
      `const Stripe = require('stripe'); const stripe = new Stripe('test'); async function read() { const intent = await stripe.paymentIntents.retrieve('pi_test'); return intent.charges; }`,
    );
    expect(result.stripeDetected).toBe(true);
    expect(result.findings[0].confidence).toBe('review');
  });
  it('fails on malformed source rather than generating misleading evidence', () => {
    expect(() => analyze('const value = ;')).toThrow(/billing.ts/);
  });
});

describe('input and specification boundaries', () => {
  it('does not infer removed fields from composed schemas or added fields', () => {
    expect(
      findRemovedProperties(
        { item: { properties: { old: {} } } },
        { item: { allOf: [], properties: {} } },
      ),
    ).toEqual([]);
    expect(
      findRemovedProperties(
        { item: { properties: { id: {} } } },
        { item: { properties: { id: {}, added: {} } } },
      ),
    ).toEqual([]);
  });
  it('rejects invalid specifications', async () => {
    const directory = await temporaryRepository();
    const path = join(directory, 'invalid.json');
    await writeFile(path, '{"openapi":"3.0.0"}');
    await expect(readSpecification(path)).rejects.toThrow(/components.schemas/);
    await writeFile(path, '{');
    await expect(readSpecification(path)).rejects.toThrow(/valid JSON/);
  });
  it('discovers workspace manifests and excludes dependencies and symbolic links', async () => {
    const directory = await temporaryRepository();
    await mkdir(join(directory, 'packages', 'billing'), { recursive: true });
    await mkdir(join(directory, 'node_modules'));
    await writeFile(
      join(directory, 'packages', 'billing', 'package.json'),
      '{"dependencies":{"stripe":"10"}}',
    );
    await writeFile(join(directory, 'node_modules', 'ignored.js'), 'broken syntax = ;');
    await symlink(join(directory, 'node_modules'), join(directory, 'linked'));
    const repository = await readRepository(directory);
    expect(repository.dependencies[0].file).toBe('packages/billing/package.json');
    expect(repository.files).toEqual([]);
    expect(repository.warnings).toEqual(['Skipped symbolic link: linked']);
  });
});

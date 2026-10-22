import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  loadApprovedRepository,
  readRepositoryApproval,
  RepositoryApprovalError,
} from './repository-enrollment.ts';
import { readServiceConfiguration } from './service-configuration.ts';
import {
  commit,
  enrollmentFixture,
  multipleIntegrationsCheckout,
} from './test/enrollment-fixture.ts';

// One approval for a profile with two integrations. Single-integration enrollment is in
// repository-enrollment.test.ts.
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const multipleIntegrations = enrollmentFixture(multipleIntegrationsCheckout);

it('approves all integration inputs together and loads only an explicitly selected workflow', async () => {
  const sample = await multipleIntegrations();
  expect(sample.approval).toMatchObject({ formatVersion: 2, integrations: ['catalog', 'stripe'] });
  expect(await readRepositoryApproval(sample.output)).toEqual(sample.approval);
  expect(sample.approval.files.map(({ role, integration }) => [role, integration ?? null])).toEqual(
    [
      ['workflow', null],
      ['baseline', 'catalog'],
      ['adapter', 'catalog'],
      ['baseline', 'stripe'],
    ],
  );
  for (const integration of ['catalog', 'stripe']) {
    const loaded = await loadApprovedRepository({
      repository: sample.repository,
      approval: sample.approval,
      stateDirectory: join(sample.root, 'cache'),
      integration,
    });
    expect(loaded.workflow.integration).toBe(integration);
    expect(loaded.workflow.before).toContain(`${integration}.baseline.json`);
    expect(loaded.fingerprint).toBe(sample.approval.fingerprint);
    if (integration === 'catalog')
      expect(loaded.workflow.providerConfig).toContain('catalog.adapter.json');
    else expect(loaded.workflow.providerConfig).toBeUndefined();
  }
  for (const integration of [undefined, 'missing'])
    await expect(
      loadApprovedRepository({
        repository: sample.repository,
        approval: sample.approval,
        stateDirectory: join(sample.root, 'cache'),
        integration,
      }),
    ).rejects.toBeInstanceOf(RepositoryApprovalError);
});

it('keeps another integration loadable when a sibling current contract becomes invalid', async () => {
  const sample = await multipleIntegrations();
  await writeFile(join(sample.repository, 'stripe-after.json'), 'not valid JSON or YAML');
  await commit(sample.repository);
  const input = {
    repository: sample.repository,
    approval: sample.approval,
    stateDirectory: join(sample.root, 'cache'),
  };
  expect(
    (await loadApprovedRepository({ ...input, integration: 'catalog' })).workflow.integration,
  ).toBe('catalog');
  await expect(loadApprovedRepository({ ...input, integration: 'stripe' })).rejects.toBeInstanceOf(
    RepositoryApprovalError,
  );
});

it('keeps another integration loadable when a sibling SDK version conflicts with its pin', async () => {
  const sample = await multipleIntegrations();
  await writeFile(
    join(sample.repository, 'src/stripe.ts'),
    "import Stripe from 'stripe'; export const stripe = new Stripe('test', { apiVersion: '2022-11-15' });",
  );
  await commit(sample.repository);
  const input = {
    repository: sample.repository,
    approval: sample.approval,
    stateDirectory: join(sample.root, 'cache'),
  };
  expect(
    (await loadApprovedRepository({ ...input, integration: 'catalog' })).workflow.integration,
  ).toBe('catalog');
  await expect(loadApprovedRepository({ ...input, integration: 'stripe' })).rejects.toThrow(
    /conflicts with the application pin/,
  );
});

it('requires reapproval for changed sibling baselines before loading any integration', async () => {
  const sample = await multipleIntegrations();
  await writeFile(
    join(sample.repository, 'stripe-before.json'),
    (await readFile(join(sample.repository, 'stripe-before.json'), 'utf8')) + '\n',
  );
  await commit(sample.repository);
  for (const integration of ['catalog', 'stripe'])
    await expect(
      loadApprovedRepository({
        repository: sample.repository,
        approval: sample.approval,
        stateDirectory: join(sample.root, 'cache'),
        integration,
      }),
    ).rejects.toThrow(/Approved repository inputs changed/);
});

it('expands one approval into separately named service workers and constrains per-integration overrides', async () => {
  const sample = await multipleIntegrations();
  const service = join(sample.root, 'multi-service.json');
  const target = {
    id: 'billing',
    repository: 'Example/Application',
    base: 'main',
    approval: './multi-approval.json',
  };
  await writeFile(
    service,
    JSON.stringify({
      formatVersion: 1,
      targets: [
        {
          ...target,
          integrations: {
            stripe: { source: { kind: 'stripe-latest' } },
            catalog: {
              source: { kind: 'https', url: 'https://example.com/catalog.json' },
              documentationSources: [{ label: 'Catalog', url: 'https://example.com/changelog' }],
            },
          },
        },
      ],
    }),
  );
  const targets = await readServiceConfiguration(service, APP);
  expect(targets.map(({ id, integration }) => [id, integration])).toEqual([
    ['billing.catalog', 'catalog'],
    ['billing.stripe', 'stripe'],
  ]);
  expect(targets[0].source).toEqual({ kind: 'https', url: 'https://example.com/catalog.json' });
  expect(targets[0].documentationSources).toHaveLength(1);
  expect(targets[1].source).toEqual({ kind: 'stripe-latest' });
  for (const change of [
    { source: { kind: 'file', path: './current.json' } },
    { integrations: { missing: {} } },
    { integrations: { stripe: { command: ['npm', 'test'] } } },
    { integrations: { stripe: { source: { kind: 'file', path: 'bad\0.json' } } } },
  ]) {
    await writeFile(
      service,
      JSON.stringify({ formatVersion: 1, targets: [{ ...target, ...change }] }),
    );
    await expect(readServiceConfiguration(service, APP)).rejects.toBeInstanceOf(Error);
  }
});

it('rejects changed integration membership and scoped file associations in approval receipts', async () => {
  const sample = await multipleIntegrations();
  for (const changed of [
    { ...sample.approval, integrations: ['catalog', 'other'] },
    {
      ...sample.approval,
      files: sample.approval.files.map((file) =>
        file.integration === 'stripe' ? { ...file, integration: 'catalog' } : file,
      ),
    },
    { ...sample.approval, files: sample.approval.files.slice(0, -1) },
    { ...sample.approval, integrations: ['catalog', 'catalog'] },
    { ...sample.approval, formatVersion: '2' },
  ]) {
    await writeFile(sample.output, JSON.stringify(changed));
    await expect(readRepositoryApproval(sample.output)).rejects.toBeInstanceOf(Error);
  }
});

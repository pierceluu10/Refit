import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  collectApiOperationCandidates,
  collectSdkMethodCandidates,
  suggestProviderAdapter,
} from './adapter-suggestions.ts';
import { readRepository } from './repository.ts';
import { parseSpecification } from './specifications.ts';
import { runPipeline } from './run.ts';

const roots: string[] = [];

// These tests price gpt-5.4-mini on purpose, so they name it as the AI model override.
beforeEach(() => vi.stubEnv('REFIT_AI_MODEL_OVERRIDE', 'gpt-5.4-mini'));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'refit-adapter-suggestion-'));
  roots.push(root);
  return root;
}

async function sampleRepository(root: string) {
  const repository = join(root, 'repository');
  await mkdir(repository);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ dependencies: { '@example/ledger': '2.4.0' } }),
  );
  await writeFile(
    join(repository, 'client.ts'),
    `import Ledger from '@example/ledger';
const client = new Ledger();
const privateToken = 'do-not-send-this-source-value';
await client.customers.retrieve('cus_1');
await client.customers.list({});
`,
  );
  return repository;
}

const identity = {
  id: 'example-ledger',
  packageName: '@example/ledger',
  defaultImport: true,
  namedExport: null,
};

const contract = {
  openapi: '3.0.3',
  info: { title: 'Ledger', version: '1' },
  paths: {
    '/customers/{id}': {
      get: {
        operationId: 'retrieveCustomer',
        responses: {
          '200': {
            description: 'Customer',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } },
          },
        },
      },
    },
    '/customers': {
      get: {
        operationId: 'listCustomers',
        responses: {
          '200': {
            description: 'Customers',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CustomerList' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Customer: { type: 'object', properties: { id: { type: 'string' } } },
      CustomerList: { type: 'object', properties: { data: { type: 'array' } } },
    },
  },
};

function openAiResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: 'resp_adapter_test',
      model: 'gpt-5.4-mini',
      status: 'completed',
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
        },
      ],
    }),
    { status: 200 },
  );
}

it('collects only direct two-level SDK calls from the configured imported constructor', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  await writeFile(
    join(repositoryPath, 'shadowed.ts'),
    `function shadowedClient(client: unknown) { return client.customers.deleteAll(); }
function shadowedConstructor(Ledger: new () => unknown) {
  const client = new Ledger();
  return client.customers.deleteAll();
}
`,
  );
  const repository = await readRepository(repositoryPath, identity.packageName);
  expect(collectSdkMethodCandidates(repository, identity)).toMatchObject([
    { resource: 'customers', method: 'list', callCount: 1 },
    { resource: 'customers', method: 'retrieve', callCount: 1 },
  ]);
});

it('matches named constructor imports and aliases by binding identity', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  await writeFile(
    join(repositoryPath, 'named.ts'),
    `import { Client as LedgerClient } from '@example/ledger';
const api = new LedgerClient();
await api.invoices.retrieve('inv_1');
`,
  );
  const repository = await readRepository(repositoryPath, identity.packageName);
  expect(
    collectSdkMethodCandidates(repository, {
      ...identity,
      defaultImport: false,
      namedExport: 'Client',
    }),
  ).toMatchObject([{ resource: 'invoices', method: 'retrieve', callCount: 1 }]);
});

it('collects shared clients through relative named imports without including arguments or source comments', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  await writeFile(
    join(repositoryPath, 'shared.ts'),
    `import Ledger from '@example/ledger';
export const ledger = new Ledger('private-constructor-value');
`,
  );
  await writeFile(
    join(repositoryPath, 'billing.ts'),
    `import { ledger as billing } from './shared.ts';
await billing /* private-source-comment */ .payments.retrieve('private-payment-id');
function shadowed(billing: unknown) { return billing.payments.refund('private-payment-id'); }
`,
  );
  const repository = await readRepository(repositoryPath, identity.packageName);
  const candidates = collectSdkMethodCandidates(repository, identity);
  expect(candidates).toContainEqual({
    resource: 'payments',
    method: 'retrieve',
    callCount: 1,
    samples: [{ file: 'billing.ts', line: 2, column: 7, expression: 'billing.payments.retrieve' }],
  });
  expect(candidates.some((candidate) => candidate.method === 'refund')).toBe(false);
  expect(JSON.stringify(candidates)).not.toContain('private-');
});

it('keeps namespace imports and re-exported clients outside the suggestion inventory', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  await writeFile(
    join(repositoryPath, 'shared.ts'),
    `import Ledger from '@example/ledger'; export const ledger = new Ledger();`,
  );
  await writeFile(join(repositoryPath, 'reexport.ts'), `export { ledger } from './shared.ts';`);
  await writeFile(
    join(repositoryPath, 'unresolved.ts'),
    `import * as shared from './shared.ts';
import { ledger } from './reexport.ts';
await shared.ledger.payments.retrieve('pay_1');
await ledger.payments.refund('pay_1');
`,
  );
  const candidates = collectSdkMethodCandidates(
    await readRepository(repositoryPath, identity.packageName),
    identity,
  );
  expect(candidates.some((candidate) => candidate.resource === 'payments')).toBe(false);
});

it('offers only unique JSON component-response operations and supports explicit narrowing', () => {
  const parsed = parseSpecification(JSON.stringify(contract), 'contract');
  const candidates = collectApiOperationCandidates(parsed.document, parsed.schemas);
  expect(candidates).toEqual([
    {
      operationId: 'listCustomers',
      path: '/customers',
      httpMethod: 'GET',
      responseSchema: 'CustomerList',
    },
    {
      operationId: 'retrieveCustomer',
      path: '/customers/{id}',
      httpMethod: 'GET',
      responseSchema: 'Customer',
    },
  ]);
  expect(
    collectApiOperationCandidates(parsed.document, parsed.schemas, ['retrieveCustomer']),
  ).toHaveLength(1);
  expect(() =>
    collectApiOperationCandidates(parsed.document, parsed.schemas, ['missingOperation']),
  ).toThrow(/missing, ambiguous, or has no supported component response schema/);
});

it('sends bounded call/spec evidence, validates the model mapping and returns a reviewable adapter', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  const specificationPath = join(root, 'openapi.json');
  await writeFile(specificationPath, JSON.stringify(contract));
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    return url.endsWith('/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: 1200 }), { status: 200 })
      : openAiResponse(
          JSON.stringify({
            operations: [
              {
                resource: 'customers',
                method: 'retrieve',
                operationId: 'retrieveCustomer',
                schema: 'Customer',
              },
            ],
            uncertainties: ['Confirm this SDK method returns the declared customer schema.'],
          }),
        );
  });
  vi.stubGlobal('fetch', fetcher);

  const result = await suggestProviderAdapter({
    repositoryPath,
    specificationPath,
    identity,
    ai: {
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      budget: { directory: join(root, 'budget'), limitUsd: 1 },
    },
  });

  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.adapter.operations).toEqual([
    {
      resource: 'customers',
      method: 'retrieve',
      schema: 'Customer',
      operationId: 'retrieveCustomer',
    },
  ]);
  expect(result.mappedOperations).toMatchObject([
    {
      sdkMethod: 'customers.retrieve',
      endpoint: 'GET /customers/{id}',
      observedCalls: 1,
    },
  ]);
  expect(result.unmappedMethods.map(({ method }) => method)).toEqual(['list']);
  expect(result.uncertainties).toHaveLength(1);
  expect(result.budget).toMatchObject({ limitUsd: 1 });
  expect(JSON.stringify(requests)).not.toContain('do-not-send-this-source-value');
  expect(JSON.stringify(requests)).not.toContain('privateToken');
  const evidence = requests[1].body.input as { content: string }[];
  expect(evidence[0].content).toContain('customers.retrieve');
  expect(evidence[0].content).toContain('customers.list');
});

it('rejects hallucinated SDK methods and OpenAPI schemas instead of writing an adapter', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  const specificationPath = join(root, 'openapi.json');
  await writeFile(specificationPath, JSON.stringify(contract));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/input_tokens')
        ? new Response(JSON.stringify({ input_tokens: 800 }), { status: 200 })
        : openAiResponse(
            JSON.stringify({
              operations: [
                {
                  resource: 'customers',
                  method: 'deleteAll',
                  operationId: 'deleteEverything',
                  schema: 'Customer',
                },
              ],
              uncertainties: [],
            }),
          ),
    ),
  );
  await expect(
    suggestProviderAdapter({
      repositoryPath,
      specificationPath,
      identity,
      ai: {
        apiKey: 'test-key',
        model: 'gpt-5.4-mini',
        budget: { directory: join(root, 'budget'), limitUsd: 1 },
      },
    }),
  ).rejects.toThrow(/SDK method was not observed/);
});

it('does not create an empty adapter when the model cannot confirm any mapping', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  const specificationPath = join(root, 'openapi.json');
  await writeFile(specificationPath, JSON.stringify(contract));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/input_tokens')
        ? new Response(JSON.stringify({ input_tokens: 800 }), { status: 200 })
        : openAiResponse(
            JSON.stringify({ operations: [], uncertainties: ['Names do not establish behavior.'] }),
          ),
    ),
  );
  await expect(
    suggestProviderAdapter({
      repositoryPath,
      specificationPath,
      identity,
      ai: {
        apiKey: 'test-key',
        model: 'gpt-5.4-mini',
        budget: { directory: join(root, 'budget'), limitUsd: 1 },
      },
    }),
  ).rejects.toThrow(/No confident adapter mappings were returned/);
});

it('uses a reviewed suggestion in the normal scanner and leaves migration generation off', async () => {
  const root = await temporaryRoot();
  const repositoryPath = await sampleRepository(root);
  await writeFile(
    join(repositoryPath, 'client.ts'),
    `import Ledger from '@example/ledger';
const client = new Ledger();
export async function customerName(id: string) {
  const customer = await client.customers.retrieve(id);
  return customer.name;
}
`,
  );
  const beforeDocument = {
    ...contract,
    info: { ...contract.info, version: '1' },
    components: {
      schemas: {
        ...contract.components.schemas,
        Customer: {
          ...contract.components.schemas.Customer,
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
    },
  };
  const afterDocument = JSON.parse(JSON.stringify(beforeDocument)) as typeof beforeDocument;
  delete (afterDocument.components.schemas.Customer.properties as Record<string, unknown>).name;
  afterDocument.info.version = '2';
  const beforePath = join(root, 'before.json');
  const afterPath = join(root, 'after.json');
  const suggestionSpecPath = join(root, 'suggestion-spec.json');
  const providerConfigPath = join(root, 'provider.json');
  await Promise.all([
    writeFile(beforePath, JSON.stringify(beforeDocument)),
    writeFile(afterPath, JSON.stringify(afterDocument)),
    writeFile(suggestionSpecPath, JSON.stringify(beforeDocument)),
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/input_tokens')
        ? new Response(JSON.stringify({ input_tokens: 900 }), { status: 200 })
        : openAiResponse(
            JSON.stringify({
              operations: [
                {
                  resource: 'customers',
                  method: 'retrieve',
                  operationId: 'retrieveCustomer',
                  schema: 'Customer',
                },
              ],
              uncertainties: ['Verify the SDK response matches the Customer schema.'],
            }),
          ),
    ),
  );

  const suggestion = await suggestProviderAdapter({
    repositoryPath,
    specificationPath: suggestionSpecPath,
    identity,
    ai: {
      apiKey: 'test-key',
      model: 'gpt-5.4-mini',
      budget: { directory: join(root, 'budget'), limitUsd: 1 },
    },
  });
  await writeFile(providerConfigPath, JSON.stringify(suggestion.adapter));
  const report = await runPipeline({
    repository: repositoryPath,
    before: beforePath,
    after: afterPath,
    providerConfig: providerConfigPath,
  });

  expect(report.provider).toBe('example-ledger');
  expect(report.findings).toMatchObject([
    { file: 'client.ts', expression: '.name', confidence: 'confirmed' },
  ]);
  expect(report.status).toBe('affected');
  expect(report.patch.status).toBe('not-generated');
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  collectApiOperationCandidates,
  collectSdkMethodCandidates,
  suggestProviderAdapter,
} from './adapter-suggestions.ts';
import { readRepository } from './repository.ts';
import { parseSpecification } from './specifications.ts';

const roots: string[] = [];

afterEach(async () => {
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

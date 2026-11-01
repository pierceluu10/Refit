import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_KINDS, clearFetchCache, type FetchLike } from '../toolkit/index.ts';
import {
  checkParams,
  clearSpecMemory,
  createToolPack,
  decodeParam,
  encodeParam,
  loadApiVersions,
  loadSpecExcerpt,
  matchSdkOperation,
  parseHttpOperation,
  reduceOperation,
  reduceSchema,
  resolveVersion,
  specRefFor,
  toolPack,
  versionsBetween,
} from './tools.ts';

const ctx = { repoDir: '.' };
const offline = createToolPack({ fetch: null });
const tool = (name: string, pack = offline) => {
  const found = pack.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

const dataDir = new URL('./tools-data/', import.meta.url);

describe('tool pack', () => {
  it('has the stripe tools plus search_docs, with valid names', () => {
    expect(toolPack.provider).toBe('stripe');
    expect(toolPack.tools.map((t) => t.name)).toEqual([
      'stripe_api_versions',
      'stripe_check_params',
      'stripe_webhook_events',
      'stripe_search_docs',
    ]);
    for (const t of toolPack.tools) expect(t.name).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('loads a playbook for every migration kind', () => {
    for (const kind of MIGRATION_KINDS) {
      expect(toolPack.playbooks[kind], kind).toBeTruthy();
      expect(toolPack.playbooks[kind]).not.toContain('reviewed: false');
    }
    expect(toolPack.playbooks['api-version']).toContain('stripe_api_versions');
  });

  it('keeps tools-data small, dated and sourced', () => {
    for (const file of readdirSync(dataDir)) {
      const path = join(dataDir.pathname, file);
      expect(statSync(path).size, file).toBeLessThan(300_000);
      const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(json.retrieved, file).toBe('2026-11-01');
      if (file !== 'docs-index.json') expect(json.source, file).toBeTruthy();
    }
  });
});

describe('versions data', () => {
  const data = loadApiVersions()!;

  it('knows the named releases and the current version', () => {
    expect(data.releases.map((r) => r.name)).toEqual([
      'acacia',
      'basil',
      'clover',
      'dahlia',
      'endive',
    ]);
    expect(data.currentVersion).toBe('2026-10-28.endive');
    expect(data.versions.find((v) => v.version === '2025-03-31.basil')?.kind).toBe('major');
    expect(data.versions.find((v) => v.version === '2025-04-30.basil')?.kind).toBe('monthly');
    expect(data.versions.find((v) => v.version === '2020-08-27')?.kind).toBe('legacy');
  });

  it('resolves versions, release names, previews and junk', () => {
    expect(resolveVersion('2025-03-31', data)).toMatchObject({
      status: 'found',
      entry: { version: '2025-03-31.basil' },
    });
    expect(resolveVersion('basil', data)).toMatchObject({
      status: 'found',
      entry: { version: '2025-03-31.basil' },
    });
    const preview = resolveVersion('2025-04-30.preview', data);
    expect(preview.status === 'found' && preview.note).toContain('public-preview');
    expect(resolveVersion('2011-01-01', data).status).toBe('known');
    expect(resolveVersion('2099-01-01', data).status).toBe('unknown');
    expect(resolveVersion('banana', data).status).toBe('unknown');
  });

  it('lists versions between two dates', () => {
    const between = versionsBetween(data, '2024-06-20', '2025-03-31.basil').map((v) => v.version);
    expect(between[0]).toBe('2024-09-30.acacia');
    expect(between.at(-1)).toBe('2025-03-31.basil');
  });

  it('maps API versions to openapi tags', () => {
    expect(specRefFor(data, '2024-06-20').ref).toBe('v1267');
    expect(specRefFor(data, undefined).ref).toBe('master');
    expect(specRefFor(data, '2026-10-28.endive').ref).toBe('master');
    expect(specRefFor(data, '2019-01-01').ref).toBe('master');
  });
});

describe('stripe_api_versions', () => {
  const run = (input: unknown) => tool('stripe_api_versions').run(input, ctx);

  it('summarises releases with no input', async () => {
    const out = await run({});
    expect(out).toContain('2026-10-28.endive');
    expect(out).toContain('basil: starts 2025-03-31.basil');
    expect(out).toContain('Stripe-Version');
  });

  it('lists breaking changes between versions with links', async () => {
    const out = await run({ version: '2024-06-20', target: '2025-03-31.basil' });
    expect(out).toContain('Major release starts crossed: 2024-09-30.acacia, 2025-03-31.basil');
    expect(out).toContain('https://docs.stripe.com/changelog/basil/2025-03-31/');
    expect(out).toContain('stripe-node v16.0.0 pins it');
    expect(out).toContain('tag v1267');
  });

  it('filters by query and notes monthly releases are non-breaking', async () => {
    const out = await run({ version: '2025-04-30.basil', target: '2025-08-27.basil' });
    expect(out).toContain('No major release start is crossed');
    const filtered = await run({ version: '2024-06-20', query: 'upcoming invoice', max: 3 });
    expect(filtered).toContain('Filtered by "upcoming invoice"');
    expect(filtered).toContain('invoice-preview-api-deprecations');
  });

  it('handles downgrades, same versions and unknown input without refusing', async () => {
    expect(await run({ version: '2025-09-30.clover', target: '2025-03-31.basil' })).toContain(
      'Downgrade',
    );
    expect(await run({ version: 'basil', target: '2025-03-31.basil' })).toContain(
      'nothing to migrate',
    );
    const unknown = await run({ version: '2099-12-01' });
    expect(unknown).toContain('not in the snapshot');
    expect(unknown).toContain('Nearest earlier version');
  });

  it('reports SDK pins', async () => {
    const out = await run({ sdk: 'stripe-node@18' });
    expect(out).toContain('v18 (2025-04-01): pins 2025-03-31.basil');
    expect(await run({ sdk: 'go v87' })).toContain('2026-09-30.endive');
    expect(await run({ sdk: 'python 2' })).toContain('not in the snapshot table');
    expect(await run({ sdk: 'cobol' })).toContain('not recognised');
  });
});

describe('spec reduction and matching', () => {
  const spec = {
    info: { version: '2024-06-20' },
    components: {
      schemas: {
        thing: { 'x-resourceId': 'thing', 'x-expandableFields': ['customer'], properties: {} },
      },
    },
    paths: {
      '/v1/things': {
        post: {
          operationId: 'PostThings',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  required: ['amount'],
                  properties: {
                    amount: { type: 'integer' },
                    mode: { type: 'string', enum: ['a', 'b'] },
                    note: {
                      anyOf: [
                        { type: 'string', maxLength: 5 },
                        { type: 'string', enum: [''] },
                      ],
                    },
                    old: { type: 'string', deprecated: true },
                    tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
                    metadata: { type: 'object', additionalProperties: { type: 'string' } },
                    opts: {
                      type: 'object',
                      required: ['on'],
                      properties: {
                        on: { type: 'boolean' },
                        deep: {
                          type: 'object',
                          properties: {
                            deeper: { type: 'object', properties: { x: { type: 'string' } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/thing' } } },
            },
          },
        },
        get: {
          parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' } }],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    properties: { data: { items: { $ref: '#/components/schemas/thing' } } },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/things/{thing}': {
        get: { parameters: [{ in: 'path', name: 'thing', required: true }] },
        post: {},
        delete: {},
      },
      '/v1/things/{thing}/confirm': { post: {} },
      '/v1/things/search': { get: {} },
    },
  };
  const keys = [
    'POST /v1/things',
    'GET /v1/things',
    'GET /v1/things/{thing}',
    'POST /v1/things/{thing}',
    'DELETE /v1/things/{thing}',
    'POST /v1/things/{thing}/confirm',
    'GET /v1/things/search',
  ];

  it('reduces params with enums, empty strings, deprecation and depth', () => {
    const op = reduceOperation(spec, '/v1/things', 'post')!;
    expect(op.operationId).toBe('PostThings');
    expect(op.params.amount).toMatchObject({ type: 'integer', required: true });
    expect(op.params.mode.enum).toEqual(['a', 'b']);
    expect(op.params.note).toMatchObject({ type: 'string', emptyAllowed: true });
    expect(op.params.note.enum).toBeUndefined();
    expect(op.params.old.deprecated).toBe(true);
    expect(op.params.tags).toMatchObject({ type: 'array<string>', enum: ['x', 'y'] });
    expect(op.params.metadata.freeform).toBe(true);
    expect(op.params.opts.props?.on.required).toBe(true);
    expect(op.params.opts.props?.deep.props?.deeper.deeper).toBe(true);
    expect(op.expandable).toEqual(['customer']);
    expect(reduceOperation(spec, '/v1/things', 'get')?.expandable).toEqual(['data.customer']);
    expect(reduceSchema(spec, { type: 'string' }, 0).type).toBe('string');
  });

  it('checks params against a reduced operation', () => {
    const op = reduceOperation(spec, '/v1/things', 'post')!;
    const report = checkParams(op, {
      mode: 'c',
      note: '',
      old: 'x',
      tags: ['x', 'z'],
      metadata: { anything: '1' },
      opts: { deep: { deeper: { x: 1 } }, extra: true },
      amout: 1,
      expand: ['customer', 'nope'],
    });
    expect(report.missingRequired).toEqual(['opts.on', 'amount']);
    // expand is not declared in this tiny spec, so it is unknown here too.
    expect(report.unknown.map((u) => u.path)).toEqual(['opts.extra', 'amout', 'expand']);
    expect(report.unknown[1].suggestions).toContain('amount');
    expect(report.enumMismatch.map((m) => m.path)).toEqual(['mode', 'tags[1]']);
    expect(report.deprecated).toEqual(['old']);
    expect(report.unchecked[0]).toContain('opts.deep.deeper');
    expect(report.expandNotes.join(' ')).toContain('nope');
  });

  it('round-trips the compact excerpt encoding', () => {
    const op = reduceOperation(spec, '/v1/things', 'post')!;
    for (const param of Object.values(op.params)) {
      expect(decodeParam(encodeParam(param))).toEqual(param);
    }
    expect(decodeParam('@d0!', { d0: { $: 'object', on: 'boolean!' } })).toEqual({
      type: 'object',
      required: true,
      props: { on: { type: 'boolean', required: true } },
    });
    expect(decodeParam('@missing')).toEqual({ type: 'any' });
  });

  it('parses HTTP operations and resolves SDK calls', () => {
    expect(parseHttpOperation('post payment_intents')).toEqual({
      method: 'POST',
      path: '/v1/payment_intents',
    });
    expect(parseHttpOperation('GET https://api.stripe.com/v1/customers/cus_1?expand[]=x')).toEqual({
      method: 'GET',
      path: '/v1/customers/cus_1',
    });
    expect(parseHttpOperation('things.create')).toBeUndefined();
    expect(matchSdkOperation('things.create', keys)).toEqual(['POST /v1/things']);
    expect(matchSdkOperation('stripe.Thing.retrieve', keys)).toEqual(['GET /v1/things/{thing}']);
    expect(matchSdkOperation('$stripe->things->update', keys)).toEqual(['POST /v1/things/{thing}']);
    expect(matchSdkOperation('client.v1.things.list', keys)).toEqual(['GET /v1/things']);
    expect(matchSdkOperation('thing.Del', keys)).toEqual(['DELETE /v1/things/{thing}']);
    expect(matchSdkOperation('things.search', keys)).toEqual(['GET /v1/things/search']);
    expect(matchSdkOperation('things.confirm', keys)).toEqual(['POST /v1/things/{thing}/confirm']);
    expect(matchSdkOperation('create', keys)).toEqual([]);
  });
});

describe('stripe_check_params offline', () => {
  const run = (input: unknown) => tool('stripe_check_params').run(input, ctx);

  it('has an excerpt covering the common operations', () => {
    const excerpt = loadSpecExcerpt()!;
    for (const key of [
      'POST /v1/payment_intents',
      'POST /v1/checkout/sessions',
      'POST /v1/billing_portal/sessions',
      'POST /v1/subscriptions',
      'GET /v1/events',
      'POST /v1/account_links',
      'POST /v1/invoiceitems',
    ]) {
      expect(excerpt.operations[key], key).toBeTruthy();
    }
    expect(
      excerpt.operations['POST /v1/payment_intents'].params.payment_method_options.props,
    ).toBeTruthy();
  });

  it('flags a removed param with changelog context, typos and enum mismatches', async () => {
    const out = await run({
      operation: 'POST /v1/payment_intents',
      params: {
        amount: 1000,
        currency: 'usd',
        payment_method_types: ['card'],
        automatic_payment_methods: { enabled: true, allow_redirect: 'never' },
        capture_method: 'manul',
        metadata: { order: '1' },
      },
      apiVersion: '2024-06-20',
    });
    expect(out).toContain('offline excerpt');
    expect(out).toContain('- payment_method_types');
    expect(out).toContain('allowed_payment_method_types');
    expect(out).toContain('removes-the-payment-method-types-parameter-from-payment-intents');
    expect(out).toContain(
      'automatic_payment_methods.allow_redirect — did you mean allow_redirects',
    );
    expect(out).toContain('capture_method = "manul"');
    expect(out).toContain('Version gap: you target 2024-06-20');
    expect(out).toContain('Expandable fields');
  });

  it('reports missing required params and resolves SDK-style operations', async () => {
    const out = await run({ operation: 'paymentIntents.create', params: { amount: 5 } });
    expect(out).toContain('POST /v1/payment_intents');
    expect(out).toContain('Required params missing: currency');
    expect(out).toContain('No apiVersion given');
    const checkout = await run({
      operation: 'stripe.checkout.Session.create',
      params: { mode: 'payment' },
    });
    expect(checkout).toContain('POST /v1/checkout/sessions');
    const portal = await run({
      operation: 'billingPortal.sessions.create',
      params: { customer: 'cus_1' },
    });
    expect(portal).toContain('No problems found');
  });

  it('matches concrete ids, path params and expand', async () => {
    const out = await run({
      operation: 'GET /v1/customers/cus_123',
      params: { expand: ['subscriptions', 'nope'] },
    });
    expect(out).toContain('GET /v1/customers/{customer}');
    expect(out).toContain('expand "nope"');
    const retrieve = await run({ operation: 'customers.retrieve', params: { id: 'cus_1' } });
    expect(retrieve).toContain('Path params (not checked as body params): id');
    const split = await run({
      method: 'POST',
      path: '/v1/refunds',
      params: { payment_intent: 'pi_1' },
    });
    expect(split).toContain('No problems found');
  });

  it('answers for operations outside the excerpt instead of refusing', async () => {
    const out = await run({ operation: 'POST /v1/issuing/cards', params: {} });
    expect(out).toContain('not found in this spec excerpt');
    expect(out).toContain('https://docs.stripe.com/api');
    expect(await run({ params: {} })).toContain('Pass "operation"');
  });
});

describe('stripe_check_params live', () => {
  const tinySpec = (version: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      info: { version },
      paths: {
        '/v1/payment_intents': {
          post: {
            operationId: 'PostPaymentIntents',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    required: ['amount', 'currency'],
                    properties: {
                      amount: { type: 'integer' },
                      currency: { type: 'string' },
                      payment_method_types: { type: 'array', items: { type: 'string' } },
                      ...extra,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

  beforeEach(() => {
    clearFetchCache();
    clearSpecMemory();
  });

  it('fetches the tag for the requested version and caches it on disk', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stripe-spec-'));
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => tinySpec('2024-06-20') };
    };
    const pack = createToolPack({ fetch, specCacheDir: cacheDir });
    const out = await tool('stripe_check_params', pack).run(
      {
        operation: 'POST /v1/payment_intents',
        params: { amount: 1, currency: 'usd', payment_method_types: ['card'] },
        apiVersion: '2024-06-20',
      },
      ctx,
    );
    expect(calls).toEqual([
      'https://raw.githubusercontent.com/stripe/openapi/v1267/openapi/spec3.json',
    ]);
    expect(out).toContain('live stripe/openapi tag v1267');
    expect(out).toContain('No problems found');
    expect(readdirSync(cacheDir)).toEqual(['v1267-spec3.json']);

    clearFetchCache();
    clearSpecMemory();
    const failing: FetchLike = async () => {
      throw new Error('network down');
    };
    const cached = await tool(
      'stripe_check_params',
      createToolPack({ fetch: failing, specCacheDir: cacheDir }),
    ).run(
      { operation: 'POST /v1/payment_intents', params: { amount: 1 }, apiVersion: '2024-06-20' },
      ctx,
    );
    expect(cached).toContain('tag v1267');
    expect(cached).toContain('Required params missing: currency');
  });

  it('uses master without a version and resolves operations from the full spec', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => tinySpec('2026-09-30.endive', { mode: { type: 'string', enum: ['x'] } }),
      };
    };
    const out = await tool(
      'stripe_check_params',
      createToolPack({ fetch, specCacheDir: null }),
    ).run(
      { operation: 'paymentIntents.create', params: { amount: 1, currency: 'usd', mode: 'y' } },
      ctx,
    );
    expect(calls[0]).toContain('/master/openapi/spec3.json');
    expect(out).toContain('Enum mismatch: mode = "y"');
  });

  it('falls back to the excerpt when the live spec cannot be loaded', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, text: async () => 'nope' });
    const out = await tool(
      'stripe_check_params',
      createToolPack({ fetch, specCacheDir: null }),
    ).run({ operation: 'POST /v1/customers', params: { email: 'a@b.c' } }, ctx);
    expect(out).toContain('Live spec unavailable (HTTP 503)');
    expect(out).toContain('offline excerpt');
  });

  it('can be told to skip the live spec', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('should not be called');
    };
    const out = await tool(
      'stripe_check_params',
      createToolPack({ fetch, specCacheDir: null }),
    ).run({ operation: 'POST /v1/customers', params: {}, live: false }, ctx);
    expect(out).toContain('offline excerpt');
  });
});

describe('stripe_webhook_events', () => {
  const run = (input: unknown) => tool('stripe_webhook_events').run(input, ctx);

  it('describes a known event', async () => {
    const out = await run({ type: 'invoice.payment_succeeded', apiVersion: '2025-03-31.basil' });
    expect(out).toContain('data.object is one of: invoice');
    expect(out).toContain('enabled_events');
    expect(out).toContain('api_version=2025-03-31.basil');
  });

  it('suggests close names, lists prefixes and explains thin events', async () => {
    expect(await run({ type: 'invoice.paymnet_succeeded' })).toContain(
      'Did you mean: invoice.payment_succeeded',
    );
    const prefix = await run({ type: 'customer.subscription.' });
    expect(prefix).toContain('customer.subscription.created');
    expect(await run({ type: 'v2.core.account.updated' })).toContain('thin (v2) event');
    expect(await run({ type: 'treasury.received_credit.created' })).toContain(
      'enabled_events enum but not on the docs',
    );
    expect(await run({})).toContain('Pass "type"');
  });
});

describe('stripe_search_docs', () => {
  it('searches the snapshot offline', async () => {
    const out = await tool('stripe_search_docs').run(
      { query: 'webhook endpoint api_version upgrade' },
      ctx,
    );
    expect(out).toContain('docs.stripe.com');
    expect(out).toContain('(snapshot)');
    const rate = await tool('stripe_search_docs').run({ query: 'rate limit 429' }, ctx);
    expect(rate).toContain('https://docs.stripe.com/rate-limits');
  });
});

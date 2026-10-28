import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { BEHAVIOUR_HARNESS } from './behaviour-harness.ts';
import {
  behaviourInstructions,
  behaviourTestFeedback,
  behaviourTestRequest,
  behaviourTestSkip,
  INSTRUCTIONS,
  parseBehaviourTests,
  writeBehaviourTests,
  type BehaviourTestFile,
} from './behaviour-test-writer.ts';
import {
  changedStripeLines,
  compareBehaviourRuns,
  writeBehaviourHarness,
} from './behaviour-tests.ts';
import { typescriptDirectory } from './generated-checks.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import { readRepository } from './repository.ts';
import { removedRequestParameters } from './request-removals.ts';
import { runPipeline } from './run.ts';
import { digest, readSpecification } from './specifications.ts';
import type { Finding } from './types.ts';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Emmah-oo/spotify-clone at 23f84d4d703ea005c12f60bc9ae42148158cc0f8 (dev-30): libs/stripe.ts and
// libs/helpers.ts' toDateTime as committed, libs/supabaseAdmin.ts cut to the Supabase client and
// manageSubscriptionStatusChange's Stripe path.
const SPOTIFY = {
  'libs/stripe.ts': `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2023-10-16",
  appInfo: {
    name: "Spotify Clone",
    version: "0.1.0",
  },
});
`,
  'libs/helpers.ts': `// Define a function named toDateTime to convert seconds to a Date object
export const toDateTime = (secs: number) => {
  // Create a new Date object with a base date of "1970-01-01T00:30:00Z"
  var t = new Date("1970-01-01T00:30:00Z");

  // Set the seconds of the Date object to the provided value
  t.setSeconds(secs);

  // Return the updated Date object
  return t;
};
`,
  'libs/supabaseAdmin.ts': `import { createClient } from "@supabase/supabase-js";

import { stripe } from "./stripe";
import { toDateTime } from "./helpers";

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  // Get customer's UUID from mapping table.
  const { data: customerData, error: noCustomerError } = await supabaseAdmin
    .from("customers")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (noCustomerError) throw noCustomerError;

  const { id: uuid } = customerData!;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });
  const subscriptionData = {
    id: subscription.id,
    user_id: uuid,
    current_period_start: toDateTime(
      subscription.current_period_start
    ).toISOString(),
    current_period_end: toDateTime(
      subscription.current_period_end
    ).toISOString(),
  };

  const { error } = await supabaseAdmin
    .from("subscriptions")
    .upsert([subscriptionData]);
  if (error) throw error;
};

export { manageSubscriptionStatusChange };
`,
};

// nicuk/docsflow at 3e6fd7136b36f30fe6ef70ff4a2ebf3b3de4343a (dev-30): lib/stripe-client.ts' client
// and createCheckoutSession as committed.
const DOCSFLOW_CLIENT = `import Stripe from 'stripe';

// Make Stripe optional during build time
const stripeKey = process.env.STRIPE_SECRET_KEY;

export const stripe = stripeKey ? new Stripe(stripeKey, {
  apiVersion: '2025-08-27.basil',
  appInfo: {
    name: 'DocsFlow',
    version: '1.0.0',
  },
}) : null;

// Create checkout session
export async function createCheckoutSession({
  priceId,
  tenantId,
  userEmail,
  successUrl,
  cancelUrl,
}: {
  priceId: string;
  tenantId: string;
  userEmail: string;
  successUrl: string;
  cancelUrl: string;
}) {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: userEmail,
      metadata: {
        tenantId,
      },
      subscription_data: {
        metadata: {
          tenantId,
        },
      },
    });

    return { session, error: null };
  } catch (error) {
    return { session: null, error: error as Error };
  }
}
`;
const DOCSFLOW = { 'lib/stripe-client.ts': DOCSFLOW_CLIENT };
const CHECKOUT_FIELDS = [
  'mode',
  'line_items',
  'success_url',
  'cancel_url',
  'customer_email',
  'metadata',
  'subscription_data',
];

const ADAPTER = {
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
};

// Shaped like Stripe's basil and endive Checkout Session create bodies.
function checkoutContract(version: string, fields: string[]) {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: Object.fromEntries(
                    fields.map((name) => [
                      name,
                      name.endsWith('payment_method_types')
                        ? {
                            type: 'array',
                            description: `A list of the types of payment methods (${name}).`,
                          }
                        : {},
                    ]),
                  ),
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
}

async function scenario(name: 'spotify' | 'docsflow', extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-'));
  roots.push(root);
  const directory = join(root, 'repository');
  const files = { ...(name === 'spotify' ? SPOTIFY : DOCSFLOW), ...extra };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies: { stripe: name === 'spotify' ? '14.5.0' : '18.5.0' } }),
  );
  const before = join(root, 'before.json');
  const after = join(root, 'after.json');
  const providerConfig = join(root, 'provider.json');
  if (name === 'spotify') {
    // The reviewed subscription-period projection, at the versions the repository moves between.
    const fixture = 'pipeline/fixtures/stripe-webhooks';
    for (const [path, version] of [
      [before, '2023-10-16'],
      [after, '2025-03-31.basil'],
    ]) {
      const document = JSON.parse(
        await readFile(join(fixture, path.slice(root.length + 1)), 'utf8'),
      );
      await writeFile(path, JSON.stringify({ ...document, info: { ...document.info, version } }));
    }
    await writeFile(
      providerConfig,
      JSON.stringify({
        ...ADAPTER,
        id: 'stripe-subscriptions',
        operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
      }),
    );
  } else {
    await writeFile(
      before,
      JSON.stringify(
        checkoutContract('2025-08-27.basil', [...CHECKOUT_FIELDS, 'payment_method_types']),
      ),
    );
    await writeFile(
      after,
      JSON.stringify(
        checkoutContract('2026-09-30.endive', [...CHECKOUT_FIELDS, 'allowed_payment_method_types']),
      ),
    );
    await writeFile(
      providerConfig,
      JSON.stringify({
        ...ADAPTER,
        id: 'stripe-checkout',
        operations: [
          {
            resource: 'checkout.sessions',
            method: 'create',
            schema: 'checkout.session',
            operationId: 'PostCheckoutSessions',
          },
        ],
      }),
    );
  }
  const report = await runPipeline({
    repository: directory,
    before,
    after,
    providerConfig,
    apiVersion: name === 'spotify' ? '2023-10-16' : '2025-08-27.basil',
    proposePatch: true,
  });
  const specifications = {
    before: await readSpecification(before),
    after: await readSpecification(after),
  };
  return {
    root,
    directory,
    report,
    inputs: {
      repository: await readRepository(directory),
      findings: report.findings,
      changes: report.changes,
      // As validation computes them for the writer.
      removals: removedRequestParameters(
        report.adapter,
        specifications.before.document,
        specifications.after.document,
      ),
      ...specifications,
    },
  };
}

const ai = (directory: string, limitUsd = 1) => ({
  apiKey: 'test-key',
  model: 'gpt-6.1-sol',
  budget: { directory, limitUsd },
});

// A recorded Responses API answer carrying `answer` as the model's JSON output.
function respond(answer: unknown, usage = { input_tokens: 9000, output_tokens: 7000 }) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: usage.input_tokens }))
      : new Response(
          JSON.stringify({
            id: 'resp_behaviour',
            model: 'gpt-6.1-sol-2026-10-01',
            status: 'completed',
            usage,
            output: [
              { type: 'reasoning' },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(answer) }],
              },
            ],
          }),
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

// The test a model would write for docsflow's checkout: it holds on both versions, and fails when a
// migration drops the card restriction or keeps sending the removed parameter.
const CHECKOUT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createCheckoutSession } = await import('../lib/stripe-client.ts');

test('creates a card-only subscription checkout session for the tenant', async () => {
  globalThis.__refitStripe.reset();
  const result = await createCheckoutSession({
    priceId: 'price_123',
    tenantId: 'tenant_1',
    userEmail: 'buyer@example.com',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
  });
  assert.equal(result.error, null);
  assert.equal(result.session.object, 'checkout.session');
  const [request] = globalThis.__refitStripe.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/checkout/sessions');
  assert.equal(request.body.mode, 'subscription');
  assert.equal(request.body.customer_email, 'buyer@example.com');
  assert.equal(request.body.metadata.tenantId, 'tenant_1');
  assert.deepEqual(request.body.payment_method_types ?? request.body.allowed_payment_method_types, ['card']);
});
`;
const CHECKOUT_ANSWER = {
  summary: 'One test runs createCheckoutSession and checks the session and the request it sends.',
  files: [
    {
      path: 'refit-behaviour/create-checkout-session.test.mjs',
      content: CHECKOUT_TEST,
      findingIds: ['f1'],
    },
  ],
  uncertainties: [],
};

it('sends the original modules, their imports and the contract change, never the patch (Emmah-oo/spotify-clone at 23f84d4)', async () => {
  const sample = await scenario('spotify');
  expect(sample.report.patch).toMatchObject({ status: 'proposed', generator: 'deterministic' });
  const diff = (sample.report.patch as { diff: string }).diff;
  expect(diff).toContain('getSubscriptionPeriodEnd');
  const fetcher = respond({
    summary: 'No test can run offline.',
    files: [],
    uncertainties: [
      'manageSubscriptionStatusChange reads the customer from Supabase before it calls Stripe; the sandbox has no database.',
    ],
  });
  const { record } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  const sent = fetcher.mock.calls.find(([url]) => !url.endsWith('/input_tokens'))!;
  const body = JSON.parse(String(sent[1]!.body));
  const prompt = `${body.instructions}\n${body.input[0].content}`;
  // Nothing the patch writes reaches the model: not the helpers, the pin it moves to, or the diff.
  for (const written of ['getSubscriptionPeriod', 'stripe-subscription-period', diff])
    expect(prompt).not.toContain(written);
  const evidence = JSON.parse(body.input[0].content);
  expect(evidence.files).toEqual([
    { path: 'libs/supabaseAdmin.ts', content: SPOTIFY['libs/supabaseAdmin.ts'] },
  ]);
  expect(evidence.contextFiles.map((file: { path: string }) => file.path)).toEqual([
    'libs/stripe.ts',
    'libs/helpers.ts',
  ]);
  expect(evidence.versions).toEqual({ before: '2023-10-16', after: '2025-03-31.basil' });
  expect(evidence.findings).toEqual([
    expect.objectContaining({
      id: 'f1',
      file: 'libs/supabaseAdmin.ts',
      line: 33,
      change: {
        kind: 'removed-response-field',
        schema: 'subscription',
        property: 'current_period_start',
      },
    }),
    expect.objectContaining({
      id: 'f2',
      line: 36,
      change: expect.objectContaining({ property: 'current_period_end' }),
    }),
  ]);
  expect(evidence.contract.removedResponseFields).toContainEqual({
    schema: 'subscription',
    property: 'current_period_end',
    before: { type: 'integer' },
    after: 'removed',
  });
  // The owner policies the tests must respect are part of every request.
  expect(body.instructions).toBe(INSTRUCTIONS);
  expect(INSTRUCTIONS).toContain('never assert that it is absent');
  expect(INSTRUCTIONS).toContain("webhook endpoint's own API version");
  expect(record).toMatchObject({
    status: 'declined',
    findings: 2,
    files: [],
    uncertainties: [expect.stringContaining('Supabase')],
    context: { files: ['libs/stripe.ts', 'libs/helpers.ts'], omitted: [] },
  });
});

it('names a removed request parameter and its contract replacement, from the original code only (nicuk/docsflow at 3e6fd71)', async () => {
  const sample = await scenario('docsflow');
  // The kept rename covers the finding, so run.ts dropped its requestParameter; the writer still
  // names the removed parameter from the removal the finding cites.
  expect(sample.report.findings).toEqual([
    expect.objectContaining({
      changeId: 'request-parameter:PostCheckoutSessions.payment_method_types',
    }),
  ]);
  expect(sample.report.findings[0].requestParameter).toBeUndefined();
  const request = behaviourTestRequest(sample.inputs);
  expect(request.evidence.files).toEqual([
    { path: 'lib/stripe-client.ts', content: DOCSFLOW_CLIENT },
  ]);
  expect(request.evidence.findings).toEqual([
    expect.objectContaining({
      id: 'f1',
      line: 31,
      change: {
        kind: 'removed-request-parameter',
        operationId: 'PostCheckoutSessions',
        parameter: 'payment_method_types',
      },
    }),
  ]);
  expect(request.evidence.contract.removedRequestParameters).toEqual([
    {
      operationId: 'PostCheckoutSessions',
      parameter: 'payment_method_types',
      before: {
        type: 'array',
        description: 'A list of the types of payment methods (payment_method_types).',
      },
      after: 'removed',
      addedParameters: ['allowed_payment_method_types'],
    },
  ]);
  const patch = sample.report.patch as { diff?: string };
  if (patch.diff) expect(JSON.stringify(request)).not.toContain(patch.diff);
  expect(JSON.stringify(request.evidence)).not.toContain("'2026-09-30.endive'");
});

it('trims imported context to its cap and refuses modules over the input limit without a request', async () => {
  // A generated database types file larger than the context cap, as spotify-clone's types_db.ts grows.
  const types = `export type Json = string | number | boolean | null;\n${'export interface Row { id: string; created_at: string }\n'.repeat(3000)}`;
  const sample = await scenario('spotify', {
    'types_db.ts': types,
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    'libs/supabaseAdmin.ts': `import { Database } from "@/types_db";\n${SPOTIFY['libs/supabaseAdmin.ts']}`,
  });
  const request = behaviourTestRequest(sample.inputs);
  expect(request.context.omitted).toEqual([
    { path: 'types_db.ts', bytes: Buffer.byteLength(types) },
  ]);
  expect(request.context.files).toEqual(['libs/stripe.ts', 'libs/helpers.ts']);
  expect(Buffer.byteLength(JSON.stringify(request.evidence))).toBeLessThanOrEqual(MAX_INPUT_BYTES);

  const huge = `${SPOTIFY['libs/supabaseAdmin.ts']}\n${'// padding\n'.repeat(30000)}`;
  const large = await scenario('spotify', { 'libs/supabaseAdmin.ts': huge });
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...large.inputs, ai: ai(large.root) });
  expect(record).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('256 KiB'),
    promptHash: null,
  });
  expect(files).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it('refuses before sending when the request could exceed the budget, and sends nothing to generate', async () => {
  const sample = await scenario('docsflow');
  const fetcher = respond(CHECKOUT_ANSWER);
  // gpt-6.1-sol reserves 9,000 input tokens and 25,000 output tokens: about $0.27, above $0.10.
  const { record, files } = await writeBehaviourTests({
    ...sample.inputs,
    ai: ai(sample.root, 0.1),
  });
  expect(record).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('AI budget exhausted'),
    costUsd: null,
    responseId: null,
  });
  expect(record.promptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(files).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toMatch(/\/input_tokens$/);
});

it('records the model, prompt hash, tokens, cost and file hashes of one request, and never asks again', async () => {
  const sample = await scenario('docsflow');
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  const request = behaviourTestRequest(sample.inputs);
  expect(record).toMatchObject({
    status: 'generated',
    model: 'gpt-6.1-sol-2026-10-01',
    responseId: 'resp_behaviour',
    promptHash: digest(JSON.stringify({ instructions: INSTRUCTIONS, evidence: request.evidence })),
    usage: { inputTokens: 9000, outputTokens: 7000 },
    findings: 1,
    uncoveredFindings: [],
    refusals: [],
    files: [
      {
        path: 'refit-behaviour/create-checkout-session.test.mjs',
        sha256: digest(CHECKOUT_TEST),
        bytes: Buffer.byteLength(CHECKOUT_TEST),
        findingIds: ['f1'],
      },
    ],
  });
  // gpt-6.1-sol: $2 per million input tokens and $10 per million output tokens.
  expect(record.costUsd).toBeCloseTo(0.018 + 0.07, 9);
  expect(files.map((file) => file.content)).toEqual([CHECKOUT_TEST]);
  expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);

  // A refused answer is recorded, not regenerated.
  const refused = respond({
    ...CHECKOUT_ANSWER,
    files: [{ ...CHECKOUT_ANSWER.files[0], path: 'test/x.test.mjs' }],
  });
  const second = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  expect(second.record).toMatchObject({
    status: 'refused',
    files: [],
    costUsd: expect.any(Number),
  });
  expect(refused.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);
});

it('builds the same request in a dry run and estimates its tokens and cost without sending it (nicuk/docsflow at 3e6fd71)', async () => {
  const sample = await scenario('docsflow');
  // Built before fetch is stubbed: the pipeline looks up stripe-node releases on npm.
  const huge = `${SPOTIFY['libs/supabaseAdmin.ts']}\n${'// padding\n'.repeat(30000)}`;
  const large = await scenario('spotify', { 'libs/supabaseAdmin.ts': huge });
  const fetcher = respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({
    ...sample.inputs,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(files).toEqual([]);
  const request = behaviourTestRequest(sample.inputs);
  const inputTokens = Math.ceil(
    (Buffer.byteLength(INSTRUCTIONS) +
      Buffer.byteLength(JSON.stringify(request.evidence)) +
      Buffer.byteLength(JSON.stringify(request.schema))) /
      3.5,
  );
  expect(record).toMatchObject({
    status: 'dry-run',
    wouldRun: true,
    model: 'gpt-6.1-sol',
    // The real run's request, byte for byte.
    promptHash: digest(JSON.stringify({ instructions: INSTRUCTIONS, evidence: request.evidence })),
    findings: 1,
    estimate: { inputTokens },
  });
  // gpt-6.1-sol: $2 per million input tokens, $10 per million output tokens; a typical answer of
  // 8,000 output tokens and the 64,000 every writer request reserves.
  expect(record.estimate!.inputUsd).toBeCloseTo(inputTokens * 2e-6, 9);
  expect(record.estimate!.typicalUsd).toBeCloseTo(inputTokens * 2e-6 + 0.08, 9);
  expect(record.estimate!.maximumUsd).toBeCloseTo(inputTokens * 2e-6 + 0.64, 9);

  const refused = await writeBehaviourTests({
    ...large.inputs,
    ai: { model: 'gpt-6.1-sol', dryRun: true },
  });
  expect(refused.record).toMatchObject({
    status: 'dry-run',
    wouldRun: false,
    reason: expect.stringContaining('256 KiB'),
  });
  // The scan may look up stripe-node releases; nothing reaches OpenAI.
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.openai.com'))).toEqual([]);
  expect(behaviourTestSkip({ model: 'gpt-6.1-sol', dryRun: true }, 'why')).toEqual({
    status: 'dry-run',
    wouldRun: false,
    reason: 'why',
  });
  expect(behaviourTestSkip(ai(sample.root), 'why')).toEqual({ status: 'skipped', reason: 'why' });
});

const REPOSITORY = {
  root: '/repository',
  files: [
    { path: 'lib/stripe-client.ts', content: DOCSFLOW_CLIENT },
    {
      path: 'lib/billing.ts',
      content: "import Stripe from 'stripe';\nexport const plan = 'pro';\n",
    },
    { path: 'lib/db.ts', content: 'export const db = {};\n' },
    { path: 'lib/checkout.ts', content: "export { plan } from './billing';\n" },
  ],
  dependencies: [],
  lockfiles: [],
  warnings: [],
};
const parse = (files: { path: string; content: string; findingIds?: string[] }[], extra = {}) =>
  parseBehaviourTests(
    JSON.stringify({
      summary: 'Tests.',
      uncertainties: [],
      files: files.map((file) => ({ findingIds: ['f1'], ...file })),
      ...extra,
    }),
    { repository: REPOSITORY, findingIds: ['f1', 'c1'], protectedFiles: ['lib/stripe-client.ts'] },
  );
const MOCK = "import { mock } from 'node:test';";
const testFile = (body: string, imports = '') => `import { test } from 'node:test';
import assert from 'node:assert/strict';
${imports}
test('behaviour', async () => {
${body}
});
`;

it('accepts version-neutral tests that stub other services, read env and write only under mkdtemp', () => {
  const content = testFile(
    `  const dir = await mkdtemp(join(tmpdir(), 'refit-'));
  await writeFile(join(dir, 'payload.json'), '{}');
  globalThis.fetch = async () => new Response('{}');
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const { createCheckoutSession } = await import('../lib/stripe-client.ts');
  assert.equal(typeof createCheckoutSession, 'function');
  await rm(dir, { recursive: true, force: true });`,
    `import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';`,
  );
  const parsed = parse([{ path: 'refit-behaviour/checkout.test.mjs', content }]);
  expect(parsed.refusals).toEqual([]);
  expect(parsed.files).toEqual([
    {
      path: 'refit-behaviour/checkout.test.mjs',
      content,
      sha256: digest(content),
      findingIds: ['f1'],
    },
  ]);
  expect(
    parse([{ path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST }]).refusals,
  ).toEqual([]);
  // Stripe fields and parameters that share a name with an fs function are not file writes.
  const stripeFields = testFile(
    `  const link = { link: { persistent_token: 'tok' } };
  const { open } = { open: true };
  assert.equal(link.link.persistent_token, 'tok');
  assert.equal(open, true);
  assert.equal({ status: 'open' }.status, 'open');`,
  );
  expect(
    parse([{ path: 'refit-behaviour/fields.test.mjs', content: stripeFields }]).refusals,
  ).toEqual([]);
});

it.each([
  [
    'a path outside refit-behaviour/',
    { path: 'test/checkout.test.mjs' },
    'is not a refit-behaviour/<name>.test.mjs path',
  ],
  [
    'an absolute path',
    { path: '/tmp/refit-behaviour/checkout.test.mjs' },
    'is not a refit-behaviour',
  ],
  [
    'a path that climbs out',
    { path: 'refit-behaviour/../checkout.test.mjs' },
    'is not a refit-behaviour',
  ],
  ['a subdirectory', { path: 'refit-behaviour/a/checkout.test.mjs' }, 'is not a refit-behaviour'],
  [
    'a file that is not .test.mjs',
    { path: 'refit-behaviour/checkout.mjs' },
    'is not a refit-behaviour',
  ],
  ['a .test.js file', { path: 'refit-behaviour/checkout.test.js' }, 'is not a refit-behaviour'],
  [
    'an http import',
    { content: testFile('', "import http from 'node:http';") },
    "imports 'node:http', which is not an allowed module",
  ],
  [
    'a fetch call',
    { content: testFile("  await fetch('https://api.stripe.com/v1/customers');") },
    'calls fetch',
  ],
  [
    'a globalThis.fetch call',
    { content: testFile("  await globalThis.fetch('https://example.com');") },
    'calls fetch',
  ],
  [
    'a WebSocket',
    { content: testFile("  new WebSocket('wss://example.com');") },
    'opens a WebSocket',
  ],
  [
    'child_process',
    { content: testFile("  execSync('ls');", "import { execSync } from 'node:child_process';") },
    "imports 'node:child_process'",
  ],
  [
    'child_process through import()',
    { content: testFile("  await import('child_process');") },
    "imports 'child_process'",
  ],
  [
    'a computed import()',
    { content: testFile("  const name = 'child_process';\n  await import(name);") },
    'imports a computed module specifier',
  ],
  ['require', { content: testFile("  require('node:child_process');") }, 'calls require'],
  [
    'a write outside a temporary directory',
    {
      content: testFile(
        "  writeFileSync('/etc/hosts', '');",
        "import { writeFileSync } from 'node:fs';",
      ),
    },
    'writeFileSync writes outside a temporary directory',
  ],
  [
    'a write into the repository',
    {
      content: testFile(
        "  await fs.rm(join(process.cwd(), 'lib'), { recursive: true });",
        "import fs from 'node:fs/promises';\nimport { join } from 'node:path';",
      ),
    },
    'rm writes outside a temporary directory',
  ],
  [
    'mkdtemp outside os.tmpdir()',
    {
      content: testFile(
        "  await mkdtemp('lib/x-');",
        "import { mkdtemp } from 'node:fs/promises';",
      ),
    },
    'creates a directory outside os.tmpdir()',
  ],
  [
    'a renamed writer',
    {
      content: testFile(
        "  save('/etc/hosts', '');",
        "import { writeFileSync as save } from 'node:fs';",
      ),
    },
    'save writes outside a temporary directory',
  ],
  [
    'a destructured writer',
    {
      content: testFile(
        "  const { writeFileSync: save } = fs;\n  save('x', '');",
        "import fs from 'node:fs';",
      ),
    },
    'save writes outside a temporary directory',
  ],
  [
    'a writer passed on',
    {
      content: testFile(
        "  const save = promisify(fs.writeFile);\n  await save('x', '');",
        "import fs from 'node:fs';\nimport { promisify } from 'node:util';",
      ),
    },
    'passes writeFile on instead of calling it on a temporary path',
  ],
  [
    'a write through fs.promises',
    {
      content: testFile(
        "  await fsp.writeFile('/etc/hosts', '');",
        "import { promises as fsp } from 'node:fs';",
      ),
    },
    'writeFile writes outside a temporary directory',
  ],
  [
    'a write through a dynamically imported fs',
    {
      content: testFile(
        "  const fs = await import('node:fs/promises');\n  await fs.rm('lib', { recursive: true });",
      ),
    },
    'rm writes outside a temporary directory',
  ],
  [
    'test.skip',
    { content: `import { test } from 'node:test';\ntest.skip('later', () => {});\n` },
    'skips or narrows tests with .skip',
  ],
  [
    'the skip option',
    { content: `import { test } from 'node:test';\ntest('later', { skip: true }, () => {});\n` },
    'skips or narrows tests with the skip option',
  ],
  [
    'it.only',
    { content: `import { it } from 'node:test';\nit.only('one', () => {});\n` },
    'skips or narrows tests with .only',
  ],
  ['process.exit', { content: testFile('  process.exit(0);') }, 'uses process.exit'],
  ['eval', { content: testFile("  eval('1');") }, 'calls eval'],
  [
    'an npm package',
    { content: testFile('', "import axios from 'axios';") },
    "imports 'axios', which is not an allowed module",
  ],
  [
    'a missing repository file',
    { content: testFile("  await import('../lib/missing.ts');") },
    "imports '../lib/missing.ts', which is not a repository file",
  ],
  [
    'a file outside the repository',
    { content: testFile("  await import('../../secrets.ts');") },
    'which is not a repository file',
  ],
  [
    'a replaced request log',
    { content: testFile('  globalThis.__refitStripe = { requests: [] };') },
    "replaces the harness's request log",
  ],
  [
    'no tests',
    { content: "import assert from 'node:assert/strict';\nassert.ok(true);\n" },
    'defines no node:test tests',
  ],
  ['a syntax error', { content: testFile('  const = 1;') }, 'does not parse'],
  [
    'a mock of stripe',
    { content: testFile("  mock.module('stripe', { defaultExport: class {} });", MOCK) },
    "mocks 'stripe'; Stripe is never replaced",
  ],
  [
    'a mock of the module holding the Stripe code',
    { content: testFile("  mock.module('../lib/stripe-client.ts', {});", MOCK) },
    'Stripe is never replaced',
  ],
  [
    'a mock of another repository module that imports stripe',
    {
      content: testFile("  mock.module('../lib/billing.ts', {});", MOCK),
    },
    'which holds or reaches Stripe code',
  ],
  [
    'a mock of a repository module that reaches stripe through another module',
    { content: testFile("  mock.module('../lib/checkout.ts', {});", MOCK) },
    'which holds or reaches Stripe code',
  ],
  [
    "a mock of Node's network",
    { content: testFile("  mock.module('node:https', {});", MOCK) },
    "mocks Node's 'node:https' module",
  ],
  [
    'a mock by alias',
    { content: testFile("  mock.module('@/lib/db', {});", MOCK) },
    'not a package the harness covers',
  ],
  [
    'a computed mock',
    { content: testFile('  mock.module(process.env.MODULE, {});', MOCK) },
    'mocks a computed module specifier',
  ],
  [
    'a mocked Stripe method',
    {
      content: testFile(
        "  const stripe = new Stripe('sk_test_123');\n  mock.method(stripe.checkout.sessions, 'create', async () => ({}));",
        `${MOCK}\nimport Stripe from 'stripe';`,
      ),
    },
    'only mock.module and mock.fn may be used',
  ],
  [
    'a renamed mock',
    { content: testFile("  m.module('stripe', {});", "import { mock as m } from 'node:test';") },
    'renames mock',
  ],
  [
    "a mock taken from the test's context",
    {
      content:
        "import { test } from 'node:test';\ntest('x', ({ mock: m }) => m.module('stripe', {}));\n",
    },
    'renames mock',
  ],
  [
    'a computed mock member',
    { content: testFile("  mock['module']('stripe', {});", MOCK) },
    'uses mock other than as mock.<member>(...)',
  ],
  [
    'a mock passed on',
    { content: testFile("  mock.module.call(mock, 'stripe', {});", MOCK) },
    'uses mock other than as mock.<member>(...)',
  ],
  [
    'a destructured mock',
    { content: testFile("  const { module: replace } = mock;\n  replace('stripe', {});", MOCK) },
    'uses mock other than as mock.<member>(...)',
  ],
  [
    'a Stripe method redefined',
    {
      content: testFile(
        "  const stripe = new Stripe('sk_test_123');\n  Object.defineProperty(stripe.customers, 'create', { value: async () => ({}) });",
        "import Stripe from 'stripe';",
      ),
    },
    'changes part of the Stripe SDK',
  ],
  [
    'a Stripe method replaced by mock.fn',
    {
      content: testFile(
        "  const stripe = new Stripe('sk_test_123');\n  stripe.customers.create = mock.fn(async () => ({}));",
        `${MOCK}\nimport Stripe from 'stripe';`,
      ),
    },
    'replaces part of the Stripe SDK',
  ],
  [
    'a replaced Stripe method',
    {
      content: testFile(
        "  const stripe = new Stripe('sk_test_123');\n  stripe.checkout.sessions.create = async () => ({ id: 'cs_1' });",
        "import Stripe from 'stripe';",
      ),
    },
    'replaces part of the Stripe SDK',
  ],
])('refuses %s', (_name, change, reason) => {
  const parsed = parse([
    { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST, ...change },
  ]);
  expect(parsed.files).toEqual([]);
  expect(parsed.refusals.join('\n')).toContain(reason);
});

it('drops a citation of an id it did not supply, and keeps the file', () => {
  const parsed = parse([
    { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST, findingIds: ['f1', 'f9'] },
  ]);
  expect(parsed.refusals).toEqual([]);
  expect(parsed.files[0].findingIds).toEqual(['f1']);
  expect(parsed.rejectedCitations).toEqual([
    'File "refit-behaviour/checkout.test.mjs" cites ids that were not supplied: "f9".',
  ]);
});

it('accepts test doubles for application dependencies: libraries and repository modules without Stripe code', () => {
  const content = testFile(
    `  mock.module('@prisma/client', prismaClient({ user: [] }));
  mock.module('next/headers', nextHeaders({ headers: { 'stripe-signature': 'sig' } }));
  mock.module('../lib/db.ts', { namedExports: { db: prisma({ user: [{ id: 'u1' }] }) } });
  const user = { stripeCustomerId: null };
  user.stripeCustomerId = 'cus_1';
  const { createCheckoutSession } = await import('../lib/stripe-client.ts');
  assert.equal(typeof createCheckoutSession, 'function');`,
    `${MOCK}\nimport { nextHeaders, prisma, prismaClient } from 'refit-behaviour/harness';`,
  );
  const parsed = parse([{ path: 'refit-behaviour/checkout.test.mjs', content }]);
  expect(parsed.refusals).toEqual([]);
  expect(parsed.files).toHaveLength(1);
});

it('tells the writer which Stripe it runs against and which test doubles it may use', () => {
  const testMode = behaviourInstructions('test-environment');
  expect(INSTRUCTIONS).toContain('stripe-mock is stateless');
  expect(testMode).not.toContain('stripe-mock');
  expect(testMode).toContain('Create, in the test, every object the code reads');
  expect(testMode).toContain('never invented IDs');
  for (const instructions of [INSTRUCTIONS, testMode]) {
    expect(instructions).toContain('mock.module(specifier, options)');
    expect(instructions).toContain('never stripe, a module that imports stripe');
    expect(instructions).toContain('evidence.previousAttempt');
  }
});

it('sends an answer again after a timeout, and asks for fewer, smaller files after one cut off at the output limit', async () => {
  const sample = await scenario('docsflow');
  const completed = (status: string) =>
    new Response(
      JSON.stringify({
        id: 'resp_behaviour',
        model: 'gpt-6.1-sol-2026-10-01',
        status,
        usage: { input_tokens: 9000, output_tokens: status === 'completed' ? 7000 : 64000 },
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output:
          status === 'completed'
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: JSON.stringify(CHECKOUT_ANSWER) }],
                },
              ]
            : [],
      }),
    );
  const sent: { max_output_tokens: number; instructions: string }[] = [];
  let generation = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/input_tokens'))
        return new Response(JSON.stringify({ input_tokens: 9000 }));
      sent.push(JSON.parse(String(init!.body)));
      generation++;
      if (generation === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
      return completed(generation === 2 ? 'incomplete' : 'completed');
    }),
  );
  // Every attempt reserves 64,000 output tokens ($0.64), and an aborted one keeps its reservation.
  const { record, files } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root, 5) });
  expect(record.status).toBe('generated');
  expect(files).toHaveLength(1);
  expect(record.retries).toEqual(['timed out after 300 seconds', 'cut off at 64000 output tokens']);
  expect(sent.map((body) => body.max_output_tokens)).toEqual([64000, 64000, 64000]);
  expect(sent[2].instructions).toContain('Write at most 2 files');
  expect(sent[1].instructions).not.toContain('Write at most 2 files');
  // The cut-off answer was billed (9,000 input and 64,000 output tokens), and so was the last.
  expect(record.costUsd).toBeCloseTo(0.018 + 0.64 + 0.018 + 0.07, 6);

  // A second failure of the same kind is final.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/input_tokens'))
        return new Response(JSON.stringify({ input_tokens: 9000 }));
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }),
  );
  const failed = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root, 5) });
  expect(failed.record).toMatchObject({
    status: 'error',
    retries: ['timed out after 300 seconds'],
    reason: expect.stringContaining('TimeoutError'),
  });
});

it('sends back what the files did on the original code only, never the patched side', () => {
  const files = [{ path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST }];
  const result = {
    status: 'not-passing',
    sides: {
      original: {
        tests: [
          {
            id: 'a > creates a session',
            ok: false,
            phase: 'test',
            error: 'AssertionError: 400 !== 200',
          },
          { id: 'a > rejects a missing price', ok: true },
        ],
      },
      patched: { tests: [{ id: 'a > patched secret', ok: false, error: 'PATCHED ONLY' }] },
    },
    coverage: {
      missing: {
        original: { 'lib/stripe-client.ts': [31] },
        patched: { 'lib/stripe-client.ts': [40] },
      },
    },
    sandbox: {
      requests: {
        original: [
          {
            method: 'POST',
            path: '/v1/checkout/sessions',
            status: 400,
            message: "No such price: 'price_123'",
            version: '2025-08-27.basil',
          },
        ],
        patched: [{ method: 'POST', path: '/v1/patched', status: 500, message: 'PATCHED ONLY' }],
      },
    },
  };
  const feedback = behaviourTestFeedback(result, files, 1)!;
  expect(feedback).toEqual({
    round: 1,
    files,
    failures: [
      { test: 'a > creates a session', phase: 'test', error: 'AssertionError: 400 !== 200' },
    ],
    stripeRequests: [
      {
        method: 'POST',
        path: '/v1/checkout/sessions',
        status: 400,
        message: "No such price: 'price_123'",
      },
    ],
    missingLines: [{ file: 'lib/stripe-client.ts', lines: [31] }],
  });
  expect(JSON.stringify(feedback)).not.toContain('PATCHED');
  // Nothing to fix, a regression to keep, or a run that never happened: no further round.
  expect(
    behaviourTestFeedback(
      {
        ...result,
        sides: { original: { tests: [{ id: 'a', ok: true }] } },
        coverage: { missing: { original: {} } },
      },
      files,
      1,
    ),
  ).toBeUndefined();
  expect(behaviourTestFeedback({ ...result, status: 'regression' }, files, 1)).toBeUndefined();
  expect(behaviourTestFeedback({ status: 'unavailable' }, files, 1)).toBeUndefined();
  // The writer's next request carries it as evidence.
  const request = behaviourTestRequest({
    repository: REPOSITORY,
    findings: [
      {
        file: 'lib/stripe-client.ts',
        line: 31,
        column: 7,
        expression: 'payment_method_types',
        confidence: 'confirmed',
        changeId: 'request-parameter:PostCheckoutSessions.payment_method_types',
      } as Finding,
    ],
    changes: [],
    removals: [],
    before: { document: { info: { version: 'a' } }, schemas: {} },
    after: { document: { info: { version: 'b' } }, schemas: {} },
    previousAttempt: feedback,
  });
  expect(request.evidence.previousAttempt).toEqual(feedback);
});

it('test doubles for application libraries keep what the code writes and never touch Stripe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-harness-'));
  roots.push(root);
  await writeFile(join(root, 'harness.mjs'), BEHAVIOUR_HARNESS);
  expect(BEHAVIOUR_HARNESS).not.toMatch(/stripe/i);
  const harnessModule = await import(join(root, 'harness.mjs'));
  const { defaultExport: express } = harnessModule.express();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.post('/items/:id', async (request: any, response: any) =>
    response.status(201).json({ id: request.params.id, body: request.body }),
  );
  app.use('/api', router);
  app.post('/webhook', express.raw(), (request: any, response: any) =>
    response.send(Buffer.isBuffer(request.body) ? request.body.toString() : 'parsed'),
  );
  app.get('/broken', () => {
    throw new Error('broken');
  });
  app.listen(3000);
  expect(await harnessModule.request('POST', '/api/items/7', { body: { a: 1 } })).toMatchObject({
    status: 201,
    body: { id: '7', body: { a: 1 } },
  });
  expect((await harnessModule.request('POST', '/webhook', { body: '{"id":"evt_1"}' })).body).toBe(
    '{"id":"evt_1"}',
  );
  expect((await harnessModule.request('GET', '/broken')).status).toBe(500);
  expect((await harnessModule.request('GET', '/missing')).status).toBe(404);

  const tables = {
    profiles: [{ id: 'u1', stripe_customer_id: 'cus_1' }] as Record<string, unknown>[],
  };
  const supabase = harnessModule.supabase({ tables }).namedExports.createClient();
  expect(await supabase.from('profiles').select('*').eq('id', 'u1').single()).toMatchObject({
    data: { id: 'u1' },
    error: null,
  });
  await supabase.from('profiles').update({ plan: 'pro' }).eq('id', 'u1');
  expect(tables.profiles[0].plan).toBe('pro');
  expect((await supabase.auth.getUser()).data.user.email).toBe('refit-test@example.com');
  const signedOut = harnessModule.supabase({ user: null }).namedExports.createServerClient();
  expect((await signedOut.auth.getUser()).error).toBeTruthy();

  const users = { user: [{ id: 'u1', email: 'a@example.com' }] as Record<string, unknown>[] };
  const db = harnessModule.prisma(users);
  expect(await db.user.findUnique({ where: { id: 'u1' } })).toMatchObject({
    email: 'a@example.com',
  });
  await db.user.update({ where: { id: 'u1' }, data: { stripeCustomerId: 'cus_2' } });
  expect(users.user[0].stripeCustomerId).toBe('cus_2');
  await expect(db.user.update({ where: { id: 'none' }, data: {} })).rejects.toMatchObject({
    code: 'P2025',
  });

  const { headers, cookies } = harnessModule.nextHeaders({
    headers: { 'stripe-signature': 'sig' },
    cookies: { session: 's' },
  }).namedExports;
  expect(headers().get('stripe-signature')).toBe('sig');
  expect((await headers()).get('stripe-signature')).toBe('sig');
  expect((await cookies()).get('session').value).toBe('s');

  const web = harnessModule.firestore({ users: { u1: { credits: 1 } } }).namedExports;
  const store = web.getFirestore();
  await web.updateDoc(web.doc(store, 'users', 'u1'), { credits: web.increment(2) });
  expect((await web.getDoc(web.doc(store, 'users/u1'))).data()).toEqual({ credits: 3 });
  expect(
    (await web.getDocs(web.query(web.collection(store, 'users'), web.where('credits', '==', 3))))
      .size,
  ).toBe(1);
  const admin = harnessModule.firestoreAdmin({});
  await admin.defaultExport.firestore().collection('users').doc('u2').set({ plan: 'pro' });
  expect((await admin.namedExports.getFirestore().collection('users').doc('u2').get()).exists).toBe(
    true,
  );

  expect(await harnessModule.clerk().namedExports.auth()).toMatchObject({
    userId: 'user_refit_test',
  });
  expect(
    await harnessModule.kinde(null).namedExports.getKindeServerSession().isAuthenticated(),
  ).toBe(false);
  expect(await harnessModule.nextAuth().namedExports.getServerSession()).toMatchObject({
    user: { email: 'refit-test@example.com' },
  });
});

it('refuses every file when one breaks the contract, and answers that do not match the schema', () => {
  const parsed = parse([
    { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
    {
      path: 'refit-behaviour/network.test.mjs',
      content: testFile("  await fetch('https://example.com');"),
    },
  ]);
  expect(parsed.files).toEqual([]);
  expect(parsed.refusals).toEqual([
    expect.stringContaining('refit-behaviour/network.test.mjs:5 calls fetch'),
  ]);
  expect(
    parse([
      { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
      { path: 'refit-behaviour/checkout.test.mjs', content: CHECKOUT_TEST },
    ]).refusals,
  ).toEqual(['File "refit-behaviour/checkout.test.mjs" appears twice.']);
  expect(parse([], { extra: true }).refusals).toEqual([
    'The answer does not match the behaviour-test schema.',
  ]);
  expect(() =>
    parseBehaviourTests('not json', { repository: REPOSITORY, findingIds: ['f1'] }),
  ).toThrow();
});

// SIMULATED stripe-mock and SDK, real harness: the harness's own runner, reporter, V8 coverage and
// grading (behaviour-tests.ts) run outside Docker against a loopback stand-in that, like stripe-mock,
// rejects a parameter its API version does not define, with stripe-node's request shape (an HTTPS
// request to api.stripe.com, the form body written after secureConnect). The two-version
// stripe-mock harness runs the same files in offline Docker on refit-bench.
const SDK = `import https from 'node:https';
const form = (value, prefix) => Array.isArray(value)
  ? value.flatMap((item, index) => form(item, prefix + '[' + index + ']'))
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => form(item, prefix ? prefix + '[' + key + ']' : key))
    : [encodeURIComponent(prefix) + '=' + encodeURIComponent(value)];
export default class Stripe {
  constructor(key, config = {}) {
    const request = (method, path, params) => new Promise((resolve, reject) => {
      const body = form(params, '').join('&');
      const req = https.request({ host: 'api.stripe.com', port: 443, path, method, agent: new https.Agent(),
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body), 'Stripe-Version': config.apiVersion } });
      req.on('response', (res) => { let data = ''; res.on('data', (chunk) => (data += chunk));
        res.on('end', () => res.statusCode < 400 ? resolve(JSON.parse(data))
          : reject(Object.assign(new Error(JSON.parse(data).error.message), { statusCode: res.statusCode }))); });
      req.on('error', reject);
      req.once('socket', (socket) => socket.once('secureConnect', () => req.end(body)));
    });
    this.checkout = { sessions: { create: (params) => request('POST', '/v1/checkout/sessions', params) } };
  }
}
`;
const PACKAGE = {
  'node_modules/stripe/package.json': JSON.stringify({
    name: 'stripe',
    type: 'module',
    main: 'index.js',
  }),
  'node_modules/stripe/index.js': SDK,
};
const PARAMETERS = {
  before: [...CHECKOUT_FIELDS, 'payment_method_types'],
  after: [...CHECKOUT_FIELDS, 'allowed_payment_method_types'],
};

async function harness(
  tests: BehaviourTestFile[],
  findings: Finding[],
  patchedClient: string,
  sides = { original: 'before', patched: 'after' } as const,
  extra: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-behaviour-run-'));
  roots.push(root);
  const app = async (name: string, client: string) => {
    for (const [path, content] of Object.entries({
      ...PACKAGE,
      ...extra,
      'lib/stripe-client.ts': client,
    })) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(join(root, name, path), content);
    }
    return readRepository(join(root, name), 'stripe');
  };
  const sources = {
    original: await app('original', DOCSFLOW_CLIENT),
    patched: await app('patched', patchedClient),
  };
  const changed = changedStripeLines(sources.original, sources.patched, findings);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await writeBehaviourHarness(tools, tests, changed, sources);
  let parameters = PARAMETERS.before;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const sent = new Set(
        body.split('&').map((pair) => decodeURIComponent(pair.split('=')[0]).split('[')[0]),
      );
      const unknown = [...sent].filter((name) => !parameters.includes(name));
      response.statusCode = unknown.length ? 400 : 200;
      response.end(
        JSON.stringify(
          unknown.length
            ? {
                error: {
                  type: 'invalid_request_error',
                  message: `Received unknown parameter: ${unknown[0]}`,
                },
              }
            : {
                id: 'cs_test_123',
                object: 'checkout.session',
                url: 'https://checkout.stripe.com/c/pay/cs_test_123',
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // One side as the sandbox runs it: the tests copied in, then the harness's runner.
  const run = async (side: 'original' | 'patched'): Promise<CheckResult> => {
    const directory = sources[side].root;
    parameters = PARAMETERS[sides[side]];
    await mkdir(join(directory, 'refit-behaviour'), { recursive: true });
    for (const test of tests) await writeFile(join(directory, test.path), test.content);
    const { stdout, stderr } = await execute(process.execPath, [join(tools, 'behaviour.mjs')], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        REFIT_STRIPE_MOCK_PORT: String((server.address() as { port: number }).port),
        REFIT_GENERATED_ROOT: `${directory}/`,
        REFIT_GENERATED_SIDE: side === 'original' ? 'before' : 'after',
        REFIT_TYPESCRIPT: join(typescriptDirectory(), 'lib', 'typescript.js'),
        STRIPE_SECRET_KEY: 'sk_test_123',
      },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 'passed', exitCode: 0, stdout, stderr };
  };
  try {
    const original = await run('original');
    const patched = await run('patched');
    return compareBehaviourRuns({ tests, changed, sources, original, patched });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

it("SIMULATED stripe-mock: the generated test passes the card rule's patch (a mock never grants grade A) and counts known-wrong patches as regressions (nicuk/docsflow at 3e6fd71)", async () => {
  const sample = await scenario('docsflow');
  respond(CHECKOUT_ANSWER);
  const { record, files } = await writeBehaviourTests({ ...sample.inputs, ai: ai(sample.root) });
  expect(record.status).toBe('generated');
  // The card rule's migration (docs/STRIPE-PAYMENT-METHOD-TYPES.md) with the endive pin.
  const correct = DOCSFLOW_CLIENT.replace('2025-08-27.basil', '2026-09-30.endive').replace(
    "payment_method_types: ['card']",
    "allowed_payment_method_types: ['card']",
  );
  // Deleting the removed parameter, which owner policy forbids, and not migrating at all.
  const dropped = correct.replace("      allowed_payment_method_types: ['card'],\n", '');
  const unmigrated = DOCSFLOW_CLIENT.replace('2025-08-27.basil', '2026-09-30.endive');
  expect(dropped).not.toContain('payment_method_types');
  const findings = sample.report.findings;
  const passed = await harness(files, findings, correct);
  expect(passed).toMatchObject({ status: 'passed', grade: null, missing: [], regressions: [] });
  // Both changed lines (the pin and the parameter) ran on both sides.
  expect(passed.coverage!.covered).toEqual({
    original: { 'lib/stripe-client.ts': [7, 31] },
    patched: { 'lib/stripe-client.ts': [7, 31] },
  });
  const deleted = await harness(files, findings, dropped);
  expect(deleted).toMatchObject({ status: 'regression', grade: null });
  expect(deleted.regressions[0].error).toContain('Expected values to be strictly deep-equal');
  const kept = await harness(files, findings, unmigrated);
  expect(kept).toMatchObject({ status: 'regression', grade: null });
  expect(kept.regressions[0].error).toContain('Expected values to be strictly equal');
  // The unchanged code against the after version fails the same test: it sees the API change.
  const unchanged = await harness(files, findings, DOCSFLOW_CLIENT);
  expect(unchanged).toMatchObject({ status: 'regression' });
}, 120_000);

it('SIMULATED stripe-mock: a test replaces an application module with a harness double through mock.module in the real runner, and the real Stripe call still runs', async () => {
  const sample = await scenario('docsflow');
  const content = CHECKOUT_TEST.replace(
    "import assert from 'node:assert/strict';\n",
    `import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { prisma } from 'refit-behaviour/harness';

const tenants = { tenant: [{ id: 'tenant_1' }] };
mock.module('../lib/tenants.ts', { namedExports: { db: prisma(tenants) } });
const { db } = await import('../lib/tenants.ts');
test('the double answers instead of the database', async () => {
  assert.deepEqual(await db.tenant.findUnique({ where: { id: 'tenant_1' } }), { id: 'tenant_1' });
});
`,
  );
  const files = [
    {
      path: 'refit-behaviour/create-checkout-session.test.mjs',
      content,
      sha256: digest(content),
      findingIds: ['f1'],
    },
  ];
  const correct = DOCSFLOW_CLIENT.replace('2025-08-27.basil', '2026-09-30.endive').replace(
    "payment_method_types: ['card']",
    "allowed_payment_method_types: ['card']",
  );
  const result = await harness(files, sample.report.findings, correct, undefined, {
    'lib/tenants.ts':
      "export const db = { tenant: { findUnique() { throw new Error('no database'); } } };\n",
  });
  expect(result).toMatchObject({ status: 'passed', missing: [], regressions: [] });
  expect(result.coverage!.covered.original).toEqual({ 'lib/stripe-client.ts': [7, 31] });
}, 120_000);

it('names the lines a patch changes, never the patch, so the tests can reach every one', async () => {
  const sample = await scenario('spotify');
  const request = behaviourTestRequest({
    ...sample.inputs,
    // libs/stripe.ts has no finding; a changed line there brings the module in for testing.
    changedLines: { 'libs/stripe.ts': [3], 'libs/supabaseAdmin.ts': [12, 13], 'gone.ts': [1] },
  });
  expect(request.evidence.changedLines).toEqual([
    { id: 'c1', file: 'libs/stripe.ts', lines: [3] },
    { id: 'c2', file: 'libs/supabaseAdmin.ts', lines: [12, 13] },
  ]);
  // A file may cite a finding or a file of changed lines, and nothing else (a strict schema enum):
  // on heldout-30, 3 answers were refused for citing an id for a changed line with no finding.
  expect(request.citable).toEqual(['f1', 'f2', 'c1', 'c2']);
  expect(
    (request.schema.properties.files.items.properties.findingIds.items as { enum: string[] }).enum,
  ).toEqual(['f1', 'f2', 'c1', 'c2']);
  expect(request.protectedFiles.sort()).toEqual(['libs/stripe.ts', 'libs/supabaseAdmin.ts']);
  expect(request.evidence.files.map((file) => file.path).sort()).toEqual([
    'libs/stripe.ts',
    'libs/supabaseAdmin.ts',
  ]);
  expect(request.instructions).toContain('evidence.changedLines');
  expect(behaviourTestRequest(sample.inputs).evidence).not.toHaveProperty('changedLines');
});

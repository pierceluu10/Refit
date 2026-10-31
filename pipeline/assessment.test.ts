import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { assessMigration, assessmentConfiguration, buildAssessmentEvidence } from './assessment.ts';

const OPTIONS = { apiKey: 'test-key', model: 'gpt-6.1-sol' };
const INPUTS = {
  repository: 'pipeline/fixtures/repository',
  before: 'pipeline/fixtures/before.json',
  after: 'pipeline/fixtures/after.json',
};

async function evidence() {
  const report = await runPipeline(INPUTS);
  return buildAssessmentEvidence(
    await readRepository(INPUTS.repository),
    report.changes,
    report.findings,
  );
}

function response(assessment: unknown) {
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      model: OPTIONS.model,
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(assessment) }],
        },
      ],
    }),
  );
}

function assessment(id: string) {
  return {
    decision: 'migration-candidate',
    summary: 'Review replacement of the removed charge list.',
    findingIds: [id],
    uncertainties: ['API version applicability is unknown.'],
    migrationPlan: ['Review pagination and test charge history behavior.'],
  };
}

afterEach(() => vi.unstubAllGlobals());

// Founder decision (2026-10-28): the webhook payload policy no longer blocks the advisory
// assessment, but evidence without traced provenance still does.
it('refuses advisory assessment of untraced evidence before making a paid request', async () => {
  const input = await evidence();
  input.findings[0].webhook = {
    schema: 'payment_intent',
    eventTypes: ['payment_intent.succeeded'],
    origin: { file: 'handler.ts', line: 1, column: 1 },
    apiVersion: 'unverified',
  };
  input.findings[0].declaredType = { schema: 'payment_intent' };
  input.findings[0].confidence = 'review';
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/^Declared Stripe types/);
  expect(fetch).not.toHaveBeenCalled();
});

it('sends bounded source evidence only when requested and keeps the model advisory', async () => {
  const input = await evidence();
  const fetcher = vi.fn().mockResolvedValue(response(assessment(input.findings[0].id)));
  vi.stubGlobal('fetch', fetcher);
  const plain = await runPipeline(INPUTS);
  expect(plain.assessment.status).toBe('not-requested');
  expect(fetcher).not.toHaveBeenCalled();
  const report = await runPipeline({ ...INPUTS, assessment: OPTIONS });
  expect(report.status).toBe(plain.status);
  expect(report.assessment).toMatchObject({
    status: 'completed',
    advisoryOnly: true,
    responseId: 'resp_test',
  });
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  expect(request.redirect).toBe('error');
  const body = JSON.parse(request.body);
  expect(body.store).toBe(false);
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
  expect(body.max_output_tokens).toBeGreaterThan(0);
  expect(body.tools).toBeUndefined();
  expect(body.instructions).toContain('untrusted repository data');
  expect(JSON.parse(body.input[0].content).findings[0].context.text).toContain(
    'return intent.charges.data',
  );
  expect(JSON.stringify(report)).not.toContain(OPTIONS.apiKey);
});

it.each([
  { findingIds: ['invented'] },
  { publish: true },
  { decision: 'safe' },
  { summary: '' },
  { uncertainties: [2] },
])('rejects unsupported assessment output: %j', async (modification) => {
  const input = await evidence();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(response({ ...assessment(input.findings[0].id), ...modification })),
  );
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow();
});

it('requires a confirmed cited finding for a migration candidate', async () => {
  const input = await evidence();
  input.findings[0].confidence = 'review';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(assessment(input.findings[0].id))));
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/confirmed finding/);
});

it('rejects a migration-candidate assessment when breaking operation impacts remain unresolved', async () => {
  const input = await evidence();
  input.operationImpacts = [
    {
      operationId: 'retrieveCustomer',
      path: '/customers/{id}',
      httpMethod: 'GET',
      text: 'api removed without deprecation',
      changes: [
        {
          id: 'api-removed-without-deprecation',
          level: 3,
          text: 'api removed without deprecation',
        },
      ],
      usages: [{ file: 'billing.ts', line: 4, column: 24, method: 'customers.retrieve' }],
    },
  ];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(assessment(input.findings[0].id))));
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/unresolved operation impacts/);
});

it.each(['incomplete', 'failed'])(
  'does not accept a %s response even if it contains JSON',
  async (status) => {
    const input = await evidence();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status,
            id: 'resp_test',
            model: OPTIONS.model,
            output: [],
          }),
        ),
      ),
    );
    await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/incomplete or invalid/);
  },
);

it('records refusal as an explicit error, without fabricating an assessment', async () => {
  const input = await evidence();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          id: 'resp_test',
          model: OPTIONS.model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'Declined.' }],
            },
          ],
        }),
      ),
    ),
  );
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/refused/);
});

it('rejects missing configuration and oversized input before networking', async () => {
  const input = await evidence();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(assessMigration(input, { ...OPTIONS, apiKey: '' })).rejects.toThrow(
    /OPENAI_API_KEY/,
  );
  input.findings[0].context.text = 'x'.repeat(256 * 1024);
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/256 KiB/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('retries rate limits a bounded number of times without exposing the API error body', async () => {
  const input = await evidence();
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response('sensitive upstream error detail', {
        status: 429,
        headers: { 'retry-after-ms': '0' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const error = await assessMigration(input, OPTIONS).catch((caught: Error) => caught);
  expect(String(error)).toContain('HTTP 429 after 4 retries.');
  expect(String(error)).not.toContain('sensitive');
  expect(fetcher).toHaveBeenCalledTimes(5);
  // Other failures are not retried.
  fetcher.mockClear().mockImplementation(async () => new Response('', { status: 500 }));
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow('HTTP 500. No retry was made.');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reads reasoning effort and the escalation step from the environment', () => {
  const base = { OPENAI_API_KEY: 'key', OPENAI_MODEL: 'gpt-6.1-sol' };
  expect(assessmentConfiguration(true, base)).toMatchObject({
    escalation: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  });
  expect(assessmentConfiguration(true, base)).not.toHaveProperty('reasoningEffort');
  expect(
    assessmentConfiguration(true, {
      ...base,
      OPENAI_REASONING_EFFORT: 'xhigh',
      OPENAI_ESCALATION_MODEL: 'gpt-other',
    }),
  ).toMatchObject({
    reasoningEffort: 'xhigh',
    escalation: { model: 'gpt-other', reasoningEffort: 'max' },
  });
  // The strongest effort has no step above it.
  expect(
    assessmentConfiguration(true, { ...base, OPENAI_REASONING_EFFORT: 'max' }),
  ).not.toHaveProperty('escalation');
  expect(
    assessmentConfiguration(true, { ...base, OPENAI_ESCALATION_EFFORT: 'none' }),
  ).not.toHaveProperty('escalation');
  expect(() =>
    assessmentConfiguration(true, { ...base, OPENAI_REASONING_EFFORT: 'extreme' }),
  ).toThrow(/OPENAI_REASONING_EFFORT must be one of low, medium, high, xhigh, max/);
});

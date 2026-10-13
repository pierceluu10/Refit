import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';

const OPTIONS = { apiKey: 'test-key', model: 'configured-test-model' };
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

it('rejects a migration-candidate assessment when removed operations remain unresolved', async () => {
  const input = await evidence();
  input.operationImpacts = [
    {
      operationId: 'retrieveCustomer',
      path: '/customers/{id}',
      httpMethod: 'GET',
      text: 'api removed without deprecation',
      usages: [{ file: 'billing.ts', line: 4, column: 24, method: 'customers.retrieve' }],
    },
  ];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(assessment(input.findings[0].id))));
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/removed-operation impacts/);
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
  input.findings[0].context.text = 'x'.repeat(64 * 1024);
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow(/64 KiB/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not retry rate limits or expose the API error body', async () => {
  const input = await evidence();
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response('sensitive upstream error detail', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(assessMigration(input, OPTIONS)).rejects.toThrow('HTTP 429. No retry was made.');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

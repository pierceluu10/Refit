import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildAssessmentEvidence } from './assessment.ts';
import { evalCases } from './ai-eval-cases.ts';
import { prepareCase, runCaseAttempt } from './ai-eval.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';

const OPTIONS = { apiKey: 'test-key', model: 'gpt-6.1-sol' };
const scratch: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Every model request gets these edits.
function respond(edits: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_eval',
            model: OPTIONS.model,
            status: 'completed',
            usage: { input_tokens: 1000, output_tokens: 100 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({ summary: 'Migrate.', uncertainties: [], edits }),
                  },
                ],
              },
            ],
          }),
        ),
    ),
  );
}

it('scores an owner-policy stop as a refusal, like the substitution guard', async () => {
  const testCase = evalCases('tuning').find((entry) => entry.id === 'models/unrelated-same-type')!;
  expect(testCase.category).toBe('decline');
  const root = await mkdtemp(join(tmpdir(), 'refit-eval-'));
  scratch.push(root);
  const prepared = await prepareCase(testCase, root);
  const inputs = {
    repository: prepared.repository,
    before: prepared.before,
    after: prepared.after,
    providerConfig: prepared.adapter,
    apiVersion: '2.3.0',
  };
  const report = await runPipeline(inputs);
  const repository = await readRepository(prepared.repository, report.adapter.packageName);
  const [finding] = buildAssessmentEvidence(repository, report.changes, report.findings).findings;
  // The model drops the request's only argument while migrating the read.
  respond([
    {
      file: 'src/client.js',
      original: 'const model = await client.models.retrieve(id);\n  return model.owned_by',
      replacement: 'const model = await client.models.retrieve();\n  return model.id',
      findingId: finding.id,
    },
  ]);
  const attempt = await runCaseAttempt(testCase, prepared, OPTIONS, 1, root);
  expect(attempt).toMatchObject({ outcome: 'rejected', pass: true, critical: false });
  expect(attempt.detail).toMatch(
    /^Rejected by an owner-policy stop, as an invented migration should be\. AI patch drops or changes argument 1 from models\.retrieve \(src\/client\.js:\d+\)/,
  );
  // The refused proposal's evidence and usage are kept, as for a substitution-guard rejection.
  expect(attempt.changedLines).toContain('const model = await client.models.retrieve();');
  expect(attempt.model).toBe(OPTIONS.model);
  expect(attempt.inputTokens).toBe(1000);
});

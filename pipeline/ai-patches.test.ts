import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { buildAssessmentEvidence } from './assessment.ts';
import { proposeAiPatch } from './ai-patches.ts';

const INPUTS = {
  repository: 'pipeline/fixtures/repository',
  before: 'pipeline/fixtures/before.json',
  after: 'pipeline/fixtures/after.json',
};
const OPTIONS = { apiKey: 'test-key', model: 'test-model' };
const REPLACEMENT = '(await stripe.charges.list({ payment_intent: intent.id })).data';

async function fixture() {
  const repository = await readRepository(INPUTS.repository);
  const report = await runPipeline(INPUTS);
  const evidence = buildAssessmentEvidence(repository, report.changes, report.findings);
  const edit = {
    file: 'billing.ts',
    original: 'intent.charges.data',
    replacement: REPLACEMENT,
    findingId: evidence.findings[0].id,
  };
  return { repository, report, edit };
}

function respond(edits: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_patch',
          model: OPTIONS.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    summary: 'Retrieve the charge list separately.',
                    uncertainties: ['Review pagination.'],
                    edits,
                  }),
                },
              ],
            },
          ],
        }),
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

it('produces a syntax-checked proposal through the public pipeline without changing source', async () => {
  const { edit, repository } = await fixture();
  respond([edit]);
  const report = await runPipeline({ ...INPUTS, aiPatch: OPTIONS });
  expect(report.patch).toMatchObject({
    status: 'proposed',
    generator: 'openai',
    edits: 1,
    unresolvedFindings: 0,
    validation: 'not-run',
  });
  if (!('diff' in report.patch)) throw new Error('Expected proposed diff');
  expect(report.patch.diff).toContain(REPLACEMENT);
  expect((await readRepository(INPUTS.repository)).files).toEqual(repository.files);
});

it.each([
  { file: '../outside.ts' },
  { findingId: 'invented' },
  { original: 'does not exist' },
  { original: 'process.env.STRIPE_SECRET_KEY!' },
  { replacement: '' },
  { replacement: 'intent.charges.data' },
  { replacement: '(()' },
  { execute: 'npm test' },
])('rejects invalid or ungrounded edits: %j', async (modification) => {
  const { edit, repository, report } = await fixture();
  respond([{ ...edit, ...modification }]);
  await expect(
    proposeAiPatch(repository, report.changes, report.findings, OPTIONS),
  ).rejects.toThrow();
});

it('rejects overlapping edits and ambiguous original text', async () => {
  const { edit, repository, report } = await fixture();
  respond([edit, edit]);
  await expect(
    proposeAiPatch(repository, report.changes, report.findings, OPTIONS),
  ).rejects.toThrow(/overlap/);
  repository.files[0].content += '\nconst example = "intent.charges.data";';
  respond([edit]);
  await expect(
    proposeAiPatch(repository, report.changes, report.findings, OPTIONS),
  ).rejects.toThrow(/exactly one/);
});

it('allows a no-edit response without inventing a patch', async () => {
  const { repository, report } = await fixture();
  respond([]);
  expect(await proposeAiPatch(repository, report.changes, report.findings, OPTIONS)).toMatchObject({
    status: 'unsupported',
    edits: 0,
    diff: '',
    unresolvedFindings: 1,
  });
});

it('includes imported context but prevents a model from editing read-only modules', async () => {
  const { edit, repository, report } = await fixture();
  repository.files[0].content =
    "import {shared} from './shared.ts';\n" + repository.files[0].content;
  repository.files.push({ path: 'shared.ts', content: 'export const shared = true;' });
  const findings = report.findings.map((finding) => ({ ...finding, line: finding.line + 1 }));
  respond([]);
  const proposal = await proposeAiPatch(repository, report.changes, findings, OPTIONS);
  expect(proposal.evidence.contextFiles).toEqual([
    { path: 'shared.ts', content: 'export const shared = true;' },
  ]);
  respond([{ ...edit, file: 'shared.ts', original: 'true', replacement: 'false' }]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    /outside its allowed scope/,
  );
});

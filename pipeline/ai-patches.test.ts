import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { buildAssessmentEvidence } from './assessment.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { digest } from './specifications.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import { FieldSubstitutionError } from './substitution-guard.ts';

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

const scratch: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeSnapshot(
  content: string,
  contentType = 'text/markdown',
  source: { label: string; url: string } = {
    label: 'Provider changelog',
    url: 'https://docs.example.com/changelog',
  },
) {
  const hash = digest(content);
  const directory = await mkdtemp(join(tmpdir(), 'refit-vendor-note-'));
  scratch.push(directory);
  const path = join(directory, `${hash}.json`);
  await writeFile(
    path,
    `${JSON.stringify({
      formatVersion: 1,
      kind: 'refit-documentation-snapshot',
      label: source.label,
      url: source.url,
      revision: hash,
      hash,
      content,
      contentType,
    })}\n`,
  );
  return { path, hash, ...source, content };
}

function modelEvidence() {
  const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(request?.body));
  return {
    body,
    evidence: JSON.parse(body.input[0].content) as {
      documentation?: Array<{ content: string; truncated: boolean; hash: string }>;
      documentationOmissions?: Array<{ reason: string; hash: string }>;
      addedProperties?: Array<{ schema: string; property: string; type?: string }>;
    },
  };
}

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

it('attaches one saved vendor page to the model request', async () => {
  const { repository, report } = await fixture();
  const page = await writeSnapshot('Use the Charges list filtered by payment_intent.');
  respond([]);
  const proposal = await proposeAiPatch(
    repository,
    report.changes,
    report.findings,
    OPTIONS,
    undefined,
    undefined,
    undefined,
    [page.path, page.path],
  );
  const { body, evidence } = modelEvidence();
  expect(evidence.documentation).toEqual([
    {
      label: page.label,
      url: page.url,
      hash: page.hash,
      content: page.content,
      truncated: false,
    },
  ]);
  expect(evidence.documentationOmissions).toBeUndefined();
  expect(body.instructions).toContain('saved vendor page');
  expect(proposal.evidence.documentation).toEqual(evidence.documentation);
});

it('marks a truncated vendor page and stays inside the evidence limit', async () => {
  const { repository, report } = await fixture();
  const page = await writeSnapshot(`${'charge history '.repeat(8000)}end.`);
  respond([]);
  await proposeAiPatch(
    repository,
    report.changes,
    report.findings,
    OPTIONS,
    undefined,
    undefined,
    undefined,
    [page.path],
  );
  const { evidence } = modelEvidence();
  const note = evidence.documentation?.[0];
  expect(note?.truncated).toBe(true);
  expect(note?.content.endsWith('\n[truncated]')).toBe(true);
  expect(note?.content.startsWith('charge history ')).toBe(true);
  expect(note?.content).not.toContain('end.');
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(MAX_INPUT_BYTES);
});

it('records a feed snapshot as omitted review text', async () => {
  const { repository, report } = await fixture();
  const page = await writeSnapshot('PaymentIntent charges moved to the Charges list.');
  const feed = await writeSnapshot('Entry: charges removed', 'application/atom+xml', {
    label: 'SDK releases',
    url: 'https://github.com/example/sdk/releases.atom',
  });
  respond([]);
  await proposeAiPatch(
    repository,
    report.changes,
    report.findings,
    OPTIONS,
    undefined,
    undefined,
    {
      attempt: 1,
      failedPatch: '--- failed\n',
      check: { exitCode: 1, stdout: '', stderr: 'failed', truncated: false },
    },
    [feed.path, page.path],
  );
  const { body, evidence } = modelEvidence();
  expect(evidence.documentation?.map((note) => note.hash)).toEqual([page.hash]);
  expect(evidence.documentationOmissions).toEqual([
    { label: feed.label, url: feed.url, hash: feed.hash, reason: 'feed' },
  ]);
  expect(JSON.stringify(evidence.documentation)).not.toContain('Entry: charges removed');
  expect(body.instructions).toContain('untrusted check output');
  expect(body.instructions).toContain('feed entries stay in the human review diff');
});

it('leaves scans without --ai-patch unchanged when a vendor note is available', async () => {
  const without = await runPipeline(INPUTS);
  const withNote = await runPipeline({
    ...INPUTS,
    documentationSnapshots: ['/tmp/refit-missing-vendor-note.json'],
  });
  expect(withNote).toEqual(without);
});

it('rejects more saved notes than a watch configuration can capture', async () => {
  const { repository, report } = await fixture();
  await expect(
    proposeAiPatch(
      repository,
      report.changes,
      report.findings,
      OPTIONS,
      undefined,
      undefined,
      undefined,
      Array.from({ length: 9 }, (_, index) => `note-${index}.json`),
    ),
  ).rejects.toThrow(/at most 8/);
});

it('shows the model fields the after contract adds to an affected schema', async () => {
  respond([]);
  await runPipeline({ ...INPUTS, aiPatch: OPTIONS });
  const { body, evidence } = modelEvidence();
  expect(evidence.addedProperties).toEqual([
    { schema: 'payment_intent', property: 'latest_charge', type: 'string' },
  ]);
  expect(body.instructions).toContain('candidates, not proven replacements');
});

async function openaiInputs(
  replacement: Record<string, Record<string, unknown>> = { owner_name: { type: 'string' } },
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-openai-rename-'));
  scratch.push(root);
  const model = (fields: Record<string, Record<string, unknown>>) => ({
    openapi: '3.0.3',
    info: { title: 'Simulated OpenAI contract', version: Object.keys(fields).join(',') },
    paths: {
      '/models/{model}': {
        parameters: [{ name: 'model', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          responses: {
            '200': {
              description: 'Model',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Model' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Model: {
          type: 'object',
          required: ['id', 'object', ...Object.keys(fields)],
          properties: { id: { type: 'string' }, object: { type: 'string' }, ...fields },
        },
      },
    },
  });
  await writeFile(
    join(root, 'before.json'),
    JSON.stringify(model({ owned_by: { type: 'string' } })),
  );
  await writeFile(join(root, 'after.json'), JSON.stringify(model(replacement)));
  const inputs = {
    repository: 'pipeline/fixtures/openai/repository',
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: 'pipeline/fixtures/openai/provider.json',
  };
  const report = await runPipeline(inputs);
  const repository = await readRepository(inputs.repository, 'openai');
  const [finding] = buildAssessmentEvidence(
    repository,
    report.changes,
    report.findings,
    report.adapter,
  ).findings;
  const edit = (replacement: string) => ({
    file: 'models.js',
    original: 'model.owned_by.toLowerCase()',
    replacement,
    findingId: finding.id,
  });
  return { inputs, edit };
}

it('lets the model see a renamed OpenAI field instead of guessing a substitute', async () => {
  const { inputs } = await openaiInputs();
  respond([]);
  await runPipeline({ ...inputs, aiPatch: OPTIONS });
  expect(modelEvidence().evidence.addedProperties).toEqual([
    { schema: 'Model', property: 'owner_name', type: 'string' },
  ]);
});

it('accepts the verified Stripe migration that passes a pre-existing field to an SDK call', async () => {
  const { edit } = await fixture();
  respond([edit]);
  const report = await runPipeline({ ...INPUTS, aiPatch: OPTIONS });
  expect(edit.replacement).toContain('payment_intent: intent.id');
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
});

it('accepts a replacement that reads a field added in the after contract', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit('model.owner_name.toLowerCase()')]);
  const report = await runPipeline({ ...inputs, aiPatch: OPTIONS });
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
});

it('rejects a pre-existing field substituted for the removed field', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit('model.id.toLowerCase()')]);
  const rejection = runPipeline({ ...inputs, aiPatch: OPTIONS });
  await expect(rejection).rejects.toBeInstanceOf(FieldSubstitutionError);
  await expect(rejection).rejects.toThrow(
    'AI replacement substitutes pre-existing field Model.id for removed Model.owned_by in models.js:5.',
  );
});

it.each(['String(model.id).toLowerCase()', '`${model.object}`.toLowerCase()'])(
  'rejects a pre-existing field read outside an SDK call argument: %s',
  async (replacement) => {
    const { inputs, edit } = await openaiInputs();
    respond([edit(replacement)]);
    await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toThrow(
      /substitutes pre-existing field Model\.(id|object)/,
    );
  },
);

it('rejects an added field whose type differs from the removed field', async () => {
  const { inputs, edit } = await openaiInputs({ context_window: { type: 'integer' } });
  respond([edit('String(model.context_window).toLowerCase()')]);
  await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toThrow(
    'AI replacement reads added field Model.context_window (integer) in place of removed Model.owned_by (string) in models.js:5.',
  );
});

it.each([['the contract describes it', { type: 'object', description: 'Replaces owned_by.' }]])(
  'accepts a different-typed added field when %s',
  async (_name, owner) => {
    const { inputs, edit } = await openaiInputs({ owner });
    respond([edit('model.owner.name.toLowerCase()')]);
    const report = await runPipeline({ ...inputs, aiPatch: OPTIONS });
    expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
  },
);

it('rejects an undocumented different-typed added field', async () => {
  const { inputs, edit } = await openaiInputs({ owner: { type: 'object' } });
  respond([edit('model.owner.name.toLowerCase()')]);
  await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toThrow(
    /reads added field Model\.owner \(object\)/,
  );
});

it('rejects a pure fallback that keeps reading the removed field', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit("(model.owned_by ?? '').toLowerCase()")]);
  await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toThrow(
    'AI replacement still reads removed field Model.owned_by in models.js:5 without reading any added field.',
  );
});

it('accepts a backward-compatible fallback that reads the added field first', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit('(model.owner_name ?? model.owned_by).toLowerCase()')]);
  const report = await runPipeline({ ...inputs, aiPatch: OPTIONS });
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
});

it('accepts a different-typed added field when a vendor note documents the replacement', async () => {
  const { inputs, edit } = await openaiInputs({ owner: { type: 'object' } });
  const note = await writeSnapshot('API 2.4.0: Model.owned_by moved to Model.owner.name.');
  respond([edit('model.owner.name.toLowerCase()')]);
  const report = await runPipeline({
    ...inputs,
    aiPatch: OPTIONS,
    documentationSnapshots: [note.path],
  });
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
});

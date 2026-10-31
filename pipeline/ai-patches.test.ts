import { SHOPIFY } from './shopify-pipeline.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { buildAssessmentEvidence } from './assessment.ts';
import { AiPolicyStop, proposeAiPatch, TYPE_ERROR_CHANGE } from './ai-patches.ts';
import { digest } from './specifications.ts';
import { MAX_INPUT_BYTES } from './openai.ts';
import { FieldSubstitutionError } from './substitution-guard.ts';

const INPUTS = {
  repository: 'pipeline/fixtures/repository',
  before: 'pipeline/fixtures/before.json',
  after: 'pipeline/fixtures/after.json',
};
const OPTIONS = { apiKey: 'test-key', model: 'gpt-6.1-sol' };
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

// Request n gets answers[n], and every later request the last answer, so a rejected answer is
// also the corrected request's answer unless a test supplies one.
function respond(...answers: unknown[][]) {
  let requests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const edits = answers[Math.min(requests++, answers.length - 1)];
      return new Response(
        JSON.stringify({
          id: `resp_patch_${requests}`,
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
      );
    }),
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

function requestBodies() {
  return vi
    .mocked(fetch)
    .mock.calls.map(([, request]) => JSON.parse(String((request as RequestInit).body)));
}

it('gives the model one corrected request, with the reason, after a mechanical edit rejection', async () => {
  const { edit, repository, report } = await fixture();
  respond([edit, edit], [edit]);
  const proposal = await proposeAiPatch(repository, report.changes, report.findings, OPTIONS);
  expect(proposal).toMatchObject({
    status: 'proposed',
    edits: 1,
    responseId: 'resp_patch_2',
    rejectedProposals: ['AI replacements overlap.'],
    usage: { inputTokens: 2000, outputTokens: 200 },
  });
  const [first, second] = requestBodies();
  expect(first.instructions).not.toContain('rejectedProposal');
  expect(JSON.parse(first.input[0].content)).not.toHaveProperty('rejectedProposal');
  expect(second.instructions).toContain('evidence.rejectedProposal is why Refit rejected');
  expect(JSON.parse(second.input[0].content).rejectedProposal).toEqual({
    reason: 'AI replacements overlap.',
    edit: { file: 'billing.ts', findingId: edit.findingId },
  });
});

it('stops when the corrected answer is rejected too, without a third request', async () => {
  const { edit, repository, report } = await fixture();
  respond([edit, edit], [{ ...edit, original: 'does not exist' }]);
  await expect(
    proposeAiPatch(repository, report.changes, report.findings, OPTIONS),
  ).rejects.toThrow('AI replacement must match exactly one source occurrence.');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('records no rejected proposal when the first answer is accepted', async () => {
  const { edit, repository, report } = await fixture();
  respond([edit]);
  const proposal = await proposeAiPatch(repository, report.changes, report.findings, OPTIONS);
  expect(proposal).not.toHaveProperty('rejectedProposals');
  expect(proposal.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
  expect(fetch).toHaveBeenCalledTimes(1);
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

it('keeps the nearest imported modules that fit a coverage request and says the context is partial', async () => {
  const { repository, report } = await fixture();
  const CHAIN = 26;
  // Large enough that the whole chain is over the 256 KiB input limit.
  const filler = `// ${'x'.repeat(12 * 1024)}\n`;
  repository.files[0].content = "import './0.ts';\n" + repository.files[0].content;
  for (let index = 0; index < CHAIN; index++)
    repository.files.push({
      path: `${index}.ts`,
      content: `${index + 1 < CHAIN ? `import './${index + 1}.ts';\n` : ''}${filler}`,
    });
  const findings = report.findings.map((finding) => ({ ...finding, line: finding.line + 1 }));
  const coverage = (targets: typeof findings) =>
    proposeAiPatch(
      repository,
      report.changes,
      findings,
      OPTIONS,
      undefined,
      {},
      undefined,
      undefined,
      {},
      [],
      { files: repository.files, rules: repository.files, targets },
    );
  respond([]);
  const proposal = await coverage(findings);
  const context = (proposal.evidence as { contextFiles: { path: string }[] }).contextFiles;
  expect(context.length).toBeGreaterThan(0);
  expect(context.length).toBeLessThan(24);
  expect(context.map((file) => file.path)).toEqual(
    Array.from({ length: context.length }, (_, index) => `${index}.ts`),
  );
  expect(proposal.evidence).toMatchObject({ contextPartial: true });
  expect(modelEvidence().body.instructions).toContain('evidence.contextPartial');
  // The first patch keeps refusing.
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    /context exceeds 24/,
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
  const page = await writeSnapshot(`${'charge history '.repeat(20000)}end.`);
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

it('never gives the substitution guard a corrected request', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit('model.id.toLowerCase()')], [edit('model.owner_name.toLowerCase()')]);
  await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toBeInstanceOf(
    FieldSubstitutionError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
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

it('rejects a fallback that reads the removed field through Reflect.get', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([
    edit("String(Reflect.get(model, 'owned_by') ?? Reflect.get(model, 'owned_by')).toLowerCase()"),
  ]);
  await expect(runPipeline({ ...inputs, aiPatch: OPTIONS })).rejects.toThrow(
    'AI replacement still reads removed field Model.owned_by by string key in models.js:5 without reading any added field.',
  );
});

it('accepts a version-tolerant string-key read split across lines', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit("String(Reflect.get(model, 'owned_by') ??\n    model.owner_name).toLowerCase()")]);
  const report = await runPipeline({ ...inputs, aiPatch: OPTIONS });
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
});

it('accepts a string-key fallback next to a read of the added field', async () => {
  const { inputs, edit } = await openaiInputs();
  respond([edit("String(model.owner_name ?? Reflect.get(model, 'owned_by')).toLowerCase()")]);
  const report = await runPipeline({ ...inputs, aiPatch: OPTIONS });
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 1 });
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

const CHECKOUT = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
export async function checkout(metadata: Record<string, string>) {
  await stripe.checkout.sessions.create({
    mode: 'subscription',
    subscription_data: {
      trial_from_plan: true,
      metadata,
    },
  });
  return 'done';
}
export function created(event: Stripe.Event) {
  switch (event.type) {
    case 'customer.subscription-created':
      return true;
  }
  return false;
}
`;

// A tsc error as validation reports it, at a position in `content` (the failed candidate's
// checkout.ts); tsc points at `subscription_data`, not at the property it rejects.
async function typeErrorFixture(content = CHECKOUT, search = 'subscription_data') {
  const { repository, report } = await fixture();
  repository.files.push({ path: 'checkout.ts', content: CHECKOUT });
  const lines = content.split('\n');
  const line = lines.findIndex((text) => text.includes(search));
  const typeError = {
    file: 'checkout.ts',
    line: line + 1,
    column: lines[line].indexOf(search) + 1,
    changeId: TYPE_ERROR_CHANGE,
    expression: 'TS2322',
    confidence: 'confirmed' as const,
    reason: "Type '{ trial_from_plan: true; }' is not assignable to type 'SubscriptionData'.",
  };
  const [findingId] = buildAssessmentEvidence(repository, report.changes, [typeError]).findings.map(
    (finding) => finding.id,
  );
  return { repository, report, findings: [...report.findings, typeError], findingId };
}

// A type-error fix that keeps every request parameter the code sends.
const TRIAL_EDIT = {
  file: 'checkout.ts',
  original: 'trial_from_plan: true,\n      metadata,',
  replacement: 'trial_from_plan: true,\n      metadata: { ...metadata },',
};

it('lets a type-error fix edit inside the statement enclosing the reported position', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([{ ...TRIAL_EDIT, findingId }]);
  const proposal = await proposeAiPatch(repository, report.changes, findings, OPTIONS);
  expect(proposal.diff).toContain('+      metadata: { ...metadata },');
});

it('stops a type-error fix that drops the request parameter the new types reject', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([{ ...TRIAL_EDIT, replacement: 'metadata,', findingId }]);
  const stop = proposeAiPatch(repository, report.changes, findings, OPTIONS);
  await expect(stop).rejects.toThrow(
    'AI patch drops or changes subscription_data.trial_from_plan from checkout.sessions.create (checkout.ts:7); removing or replacing what a request sends changes its behavior, so it stops for review.',
  );
  // The stop keeps the refused diff and the request's usage for the evidence.
  await expect(stop).rejects.toBeInstanceOf(AiPolicyStop);
  await expect(stop).rejects.toMatchObject({
    proposal: {
      diff: expect.stringContaining('-      trial_from_plan: true,'),
      model: OPTIONS.model,
      usage: { inputTokens: 1000, outputTokens: 100 },
    },
  });
  // A policy stop gets no corrected request.
  expect(fetch).toHaveBeenCalledTimes(1);
});

// Founder decision (2026-10-28): a repair where a policy used to stop.
const POLICY_REPAIR = {
  attempt: 1,
  policies: ["Removed request parameters: the upgraded types reject 'trial_from_plan'."],
  failedPatch: '',
  check: { exitCode: 2, stdout: '', stderr: '', truncated: false },
};
const TRIAL_REPLACEMENT = {
  ...TRIAL_EDIT,
  replacement: 'trial_period_days: 14,\n      metadata,',
  source: 'https://docs.stripe.com/payments/checkout/free-trials',
};

it('lets a policy repair replace a rejected request parameter it explains and cites', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  const why =
    'Replaces trial_from_plan, which the new types reject, with trial_period_days; the trial length is now fixed.';
  respond([{ ...TRIAL_REPLACEMENT, why, findingId }]);
  const proposal = await proposeAiPatch(
    repository,
    report.changes,
    findings,
    OPTIONS,
    undefined,
    undefined,
    POLICY_REPAIR,
  );
  expect(proposal.diff).toContain('+      trial_period_days: 14,');
  expect(proposal.explanations).toEqual([
    {
      file: 'checkout.ts',
      line: 6,
      error:
        "TS2322: Type '{ trial_from_plan: true; }' is not assignable to type 'SubscriptionData'.",
      why,
      source: TRIAL_REPLACEMENT.source,
    },
  ]);
  const [request] = vi.mocked(fetch).mock.calls;
  expect(String(request[1]?.body)).toContain('repair.policies names the owner policies');
});

it('lets a policy repair past a contract review that stops other AI requests', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  const reviewed = findings.map((finding, index) =>
    index
      ? finding
      : { ...finding, contractReview: 'Stripe removed this operation; it needs review.' },
  );
  respond([{ ...TRIAL_EDIT, why: 'Keeps trial_from_plan.', source: 'none', findingId }]);
  await expect(proposeAiPatch(repository, report.changes, reviewed, OPTIONS)).rejects.toThrow(
    'Stripe removed this operation; it needs review.',
  );
  const proposal = await proposeAiPatch(
    repository,
    report.changes,
    reviewed,
    OPTIONS,
    undefined,
    undefined,
    POLICY_REPAIR,
  );
  expect(proposal.diff).toContain('+      metadata: { ...metadata },');
});

it('lets a policy repair replace a removed operation it names, and only then', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  const replaced = {
    file: 'checkout.ts',
    original: "await stripe.checkout.sessions.create({\n    mode: 'subscription',",
    replacement: "await stripe.checkout.sessions.createPreview({\n    mode: 'subscription',",
    source: 'https://docs.stripe.com/changelog',
    findingId,
  };
  respond([{ ...replaced, why: 'Calls createPreview because the version removed create.' }]);
  const proposal = await proposeAiPatch(
    repository,
    report.changes,
    findings,
    OPTIONS,
    undefined,
    undefined,
    POLICY_REPAIR,
  );
  expect(proposal.diff).toContain('+  await stripe.checkout.sessions.createPreview({');
  respond([{ ...replaced, why: 'Calls the documented replacement.' }]);
  await expect(
    proposeAiPatch(
      repository,
      report.changes,
      findings,
      OPTIONS,
      undefined,
      undefined,
      POLICY_REPAIR,
    ),
  ).rejects.toThrow('AI patch drops or changes');
});

it('still stops a policy repair that changes a request parameter without naming it', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([{ ...TRIAL_REPLACEMENT, why: 'Uses a fixed trial.', findingId }]);
  await expect(
    proposeAiPatch(
      repository,
      report.changes,
      findings,
      OPTIONS,
      undefined,
      undefined,
      POLICY_REPAIR,
    ),
  ).rejects.toThrow('AI patch drops or changes subscription_data.trial_from_plan');
});

it('rejects a policy repair edit without its reason and source', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([{ ...TRIAL_EDIT, findingId }]);
  await expect(
    proposeAiPatch(
      repository,
      report.changes,
      findings,
      OPTIONS,
      undefined,
      undefined,
      POLICY_REPAIR,
    ),
  ).rejects.toThrow('AI patch contains an invalid or unchanged replacement.');
});

it('stops a type-error fix that silences the error with a cast', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([
    {
      ...TRIAL_EDIT,
      replacement: 'trial_from_plan: true as any,\n      metadata,',
      findingId,
    },
  ]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    'AI patch silences type checks with any (checkout.ts:7); a type-only workaround hides the break instead of migrating it, so it stops for review.',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects a type-error fix outside the statement enclosing the reported position', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([
    { file: 'checkout.ts', original: "return 'done';", replacement: "return 'ok';", findingId },
  ]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    /^AI replacement does not cover its cited finding location \(checkout\.ts:\d+:\d+\)\.$/,
  );
});

it('stops a fix that renames a webhook event type for review', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture(
    CHECKOUT,
    "case 'customer",
  );
  respond([
    {
      file: 'checkout.ts',
      original: "case 'customer.subscription-created':",
      replacement: "case 'customer.subscription.created':",
      findingId,
    },
  ]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    "AI patch changes webhook event type 'customer.subscription-created'; event names stop for review.",
  );
  // A policy stop is not an edit rejection, so the model gets no corrected request.
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('stops a fix that chooses a subscription item for the billing period', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  const edit = (period: string) => ({
    ...TRIAL_EDIT,
    replacement: `trial_from_plan: true,\n      metadata: { ...metadata, period: ${period} },`,
    findingId,
  });
  respond([edit('getSubscriptionPeriodEnd(metadata, (items) => items[0])')]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    'AI patch chooses a subscription item for the billing period; item selection needs a reviewed policy and stops for review.',
  );
  respond([edit('getSubscriptionPeriodEnd(metadata)')]);
  const proposal = await proposeAiPatch(repository, report.changes, findings, OPTIONS);
  expect(proposal.diff).toContain('period: getSubscriptionPeriodEnd(metadata)');
});

it.each([
  'subscription.items.data[0].current_period_end',
  'subscription.items.data[index]!.current_period_start',
  'subscription.items.data.at(-1)?.current_period_end',
  '(subscription.items.data.find((item) => item.price.id === PRICE))?.current_period_end',
])('stops a fix that reads the billing period from an item it picks: %s', async (period) => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([
    {
      ...TRIAL_EDIT,
      replacement: `trial_from_plan: true,\n      metadata: { ...metadata, period: ${period} },`,
      findingId,
    },
  ]);
  await expect(proposeAiPatch(repository, report.changes, findings, OPTIONS)).rejects.toThrow(
    'AI patch chooses a subscription item for the billing period; item selection needs a reviewed policy and stops for review.',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('lets a fix read fields other than the billing period from a picked item', async () => {
  const { repository, report, findings, findingId } = await typeErrorFixture();
  respond([
    {
      ...TRIAL_EDIT,
      replacement:
        'trial_from_plan: true,\n      metadata: { ...metadata, price: subscription.items.data[0].price.id },',
      findingId,
    },
  ]);
  const proposal = await proposeAiPatch(repository, report.changes, findings, OPTIONS);
  expect(proposal.diff).toContain('price: subscription.items.data[0].price.id');
});

it('repairs the failed candidate at its type-error positions and guards every AI edit since the rules', async () => {
  const previous = `// earlier repair\n${CHECKOUT}`;
  const { repository, report, findings, findingId } = await typeErrorFixture(previous);
  const repairRound = (content: string) =>
    proposeAiPatch(
      repository,
      report.changes,
      findings,
      OPTIONS,
      undefined,
      {},
      undefined,
      undefined,
      {},
      [],
      {
        files: [
          ...repository.files.filter((file) => file.path !== 'checkout.ts'),
          { path: 'checkout.ts', content },
        ],
      },
    );
  respond([{ ...TRIAL_EDIT, findingId }]);
  const proposal = await repairRound(previous);
  expect(modelEvidence().body.input[0].content).toContain('// earlier repair');
  expect(proposal.diff).toContain('+// earlier repair');
  expect(proposal.diff).toContain('+      metadata: { ...metadata },');

  // An event name an earlier round changed is caught even when this round edits elsewhere.
  respond([{ ...TRIAL_EDIT, findingId }]);
  await expect(
    repairRound(previous.replace('subscription-created', 'subscription.created')),
  ).rejects.toThrow(/event names stop for review/);
});

it('stops an AI patch that edits a file on a test path, with no corrected request', async () => {
  const { repository, report, edit } = await fixture();
  for (const path of ['billing.test.ts', '__tests__/billing.ts']) {
    const moved = {
      ...repository,
      files: repository.files.map((file) =>
        file.path === 'billing.ts' ? { ...file, path } : file,
      ),
    };
    const findings = report.findings.map((finding) => ({ ...finding, file: path }));
    const [findingId] = buildAssessmentEvidence(moved, report.changes, findings).findings.map(
      (finding) => finding.id,
    );
    respond([{ ...edit, file: path, findingId }]);
    const stop = proposeAiPatch(moved, report.changes, findings, OPTIONS);
    await expect(stop).rejects.toThrow(
      `AI patch edits ${path} on the repository's test paths; the checks that judge a migration stay as the repository wrote them, so it stops for review.`,
    );
    await expect(stop).rejects.toBeInstanceOf(AiPolicyStop);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

it('stops an AI patch that changes a line the rules wrote, and keeps one that repeats it', async () => {
  const { repository, report, edit } = await fixture();
  const client = 'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);';
  const bumped = `const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-09-30.endive' });`;
  const content = repository.files.find((file) => file.path === 'billing.ts')!.content;
  const start = content.indexOf(client);
  expect(start).toBeGreaterThan(0);
  const rule = {
    file: 'billing.ts',
    start,
    end: start + client.length,
    replacement: bumped,
    changeId: 'api-version',
  };
  // One replacement from the client to the read, as the model sends for a whole function.
  const ruled = content.replace(client, bumped);
  const original = ruled.slice(
    ruled.indexOf(bumped),
    ruled.indexOf(edit.original) + edit.original.length,
  );
  const propose = (line: string) => {
    respond([
      {
        ...edit,
        original,
        replacement: original.replace(bumped, line).replace(edit.original, REPLACEMENT),
      },
    ]);
    return proposeAiPatch(
      repository,
      report.changes,
      report.findings,
      OPTIONS,
      undefined,
      {},
      undefined,
      undefined,
      {},
      [rule],
    );
  };
  await expect(propose(client)).rejects.toThrow(
    "AI patch changes billing.ts:3, which the deterministic rules already changed, and drops what the rule introduced there; a rule's edit may be adjusted only while its new field, parameter or version stays, so it stops for review.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const proposal = await propose(bumped);
  expect(proposal.diff).toContain(`+${bumped}`);
  expect(proposal.diff).toContain(REPLACEMENT);
});

it('never lets the model edit package files, which are not editable sources', async () => {
  const { repository, report, edit } = await fixture();
  for (const file of ['package.json', 'package-lock.json']) {
    respond([
      { ...edit, file, original: '"stripe": "^14.0.0"', replacement: '"stripe": "^20.0.0"' },
    ]);
    await expect(
      proposeAiPatch(repository, report.changes, report.findings, OPTIONS),
    ).rejects.toThrow(
      `AI patch references a file or confirmed finding outside its allowed scope: ${JSON.stringify(file)}.`,
    );
  }
});

it('asks the stronger step once when the first answer proposes no edit', async () => {
  const { repository, report, edit } = await fixture();
  respond([], [edit]);
  const escalated = { ...OPTIONS, escalation: { model: 'strong-model', reasoningEffort: 'high' } };
  const proposal = await proposeAiPatch(repository, report.changes, report.findings, escalated);
  const bodies = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  expect(bodies.map((body) => [body.model, body.reasoning?.effort])).toEqual([
    ['test-model', undefined],
    ['strong-model', 'high'],
  ]);
  expect(proposal).toMatchObject({
    status: 'proposed',
    escalation: { model: 'strong-model', reasoningEffort: 'high', edits: 1 },
  });
  expect(proposal.diff).toContain(REPLACEMENT);
});

it('holds an escalated answer to the same checks as the first', async () => {
  const { repository, report, edit } = await fixture();
  respond([], [{ ...edit, file: 'elsewhere.ts' }]);
  const escalated = { ...OPTIONS, escalation: { model: 'strong-model', reasoningEffort: 'high' } };
  await expect(
    proposeAiPatch(repository, report.changes, report.findings, escalated),
  ).rejects.toThrow(/outside its allowed scope/);
  // The escalated answer gets no corrected request: two requests in all.
  expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
});

it('sends one request when no stronger step is configured or the first answer has edits', async () => {
  const { repository, report, edit } = await fixture();
  respond([]);
  const none = await proposeAiPatch(repository, report.changes, report.findings, OPTIONS);
  expect(none).not.toHaveProperty('escalation');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  respond([edit]);
  const escalated = { ...OPTIONS, escalation: { model: 'strong-model', reasoningEffort: 'high' } };
  await proposeAiPatch(repository, report.changes, report.findings, escalated);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});

it('gives a Shopify repair Shopify instructions and a Stripe one none', async () => {
  const { repository, report } = await fixture();
  respond([]);
  await proposeAiPatch(repository, report.changes, report.findings, OPTIONS);
  expect(modelEvidence().body.instructions).not.toContain('This is a Shopify app.');
  vi.unstubAllGlobals();
  respond([]);
  await proposeAiPatch(repository, report.changes, report.findings, OPTIONS, SHOPIFY);
  const { instructions } = modelEvidence().body;
  expect(instructions).toContain('This is a Shopify app.');
  expect(instructions).toContain('Do not edit GraphQL documents');
});

it('repairs a Shopify candidate at the tsc error naming an @shopify type', async () => {
  const webhook = `import type { WebhookHandler } from '@shopify/shopify-api';
export const handler: WebhookHandler = async (topic, shop, body, webhookId, apiVersion) => {
  console.log(webhookId);
};
`;
  const repository = {
    root: '/repository',
    files: [{ path: 'web/webhooks.ts', content: webhook }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const typeError = {
    file: 'web/webhooks.ts',
    line: 2,
    column: 14,
    changeId: TYPE_ERROR_CHANGE,
    expression: 'TS2322',
    confidence: 'confirmed' as const,
    reason:
      "Type '(topic, shop, body, webhookId, apiVersion) => Promise<void>' is not assignable to type 'WebhookHandler'.",
  };
  const [findingId] = buildAssessmentEvidence(repository, [], [typeError], SHOPIFY).findings.map(
    (finding) => finding.id,
  );
  respond([
    {
      file: 'web/webhooks.ts',
      original: 'console.log(webhookId);',
      replacement: 'console.log(webhookId as string);',
      findingId,
    },
  ]);
  const proposal = await proposeAiPatch(
    repository,
    [],
    [typeError],
    OPTIONS,
    SHOPIFY,
    {},
    {
      attempt: 1,
      failedPatch: '',
      check: { exitCode: 2, stdout: '', stderr: '', truncated: false },
    },
    undefined,
    {},
    [],
    { files: repository.files, rules: repository.files },
  );
  expect(modelEvidence().body.instructions).toContain('This is a Shopify app.');
  expect(proposal.diff).toContain('+  console.log(webhookId as string);');
});

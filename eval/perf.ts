import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { proposeAiPatch } from '../pipeline/ai-patches.ts';
import { createPassageIndex } from '../pipeline/passages.ts';
import { readRepository } from '../pipeline/repository.ts';
import { retrieve } from '../pipeline/retrieval.ts';
import { runPipeline } from '../pipeline/run.ts';
import { writeResult } from './write-result.ts';

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS = join(ROOT, 'eval/results');
const BUILDS = 5;
const QUERIES = 1000;

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function percentile(values: number[], percent: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function estimateTokens(characters: number) {
  return Math.ceil(characters / 4);
}

async function timeIndex(provider: string) {
  const samples: number[] = [];
  let passages = 0;
  for (let attempt = 0; attempt < BUILDS; attempt += 1) {
    const started = performance.now();
    const index = await createPassageIndex({ provider });
    samples.push(performance.now() - started);
    passages = index.passages.length;
  }
  return { provider, builds: BUILDS, passages, samplesMs: samples, medianMs: median(samples) };
}

type Capture = { body: string; evidence: string; called: boolean };

function installCapture(): { restore: () => void; take: () => Capture } {
  const original = globalThis.fetch;
  let capture: Capture = { body: '', evidence: '', called: false };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const parsed = JSON.parse(body) as { input?: { content?: string }[] };
    capture = { body, evidence: parsed.input?.[0]?.content ?? '', called: true };
    return new Response(
      JSON.stringify({
        id: 'resp_measure',
        model: 'measure',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  summary: 'Measurement only.',
                  uncertainties: [],
                  edits: [],
                }),
              },
            ],
          },
        ],
      }),
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    take: () => capture,
  };
}

async function promptSize(
  name: string,
  input: {
    repository: string;
    before: string;
    after: string;
    providerConfig?: string;
  },
) {
  const report = await runPipeline(input);
  const repository = await readRepository(input.repository, report.adapter.packageName);
  const modes = ['required', 'disabled'] as const;
  const measured = [];
  for (const retrieval of modes) {
    const capture = installCapture();
    try {
      await proposeAiPatch(
        repository,
        report.changes,
        report.findings,
        { apiKey: 'measure', model: 'measure' },
        report.adapter,
        {},
        undefined,
        { retrieval },
      );
    } finally {
      capture.restore();
    }
    const taken = capture.take();
    const evidence = taken.evidence
      ? (JSON.parse(taken.evidence) as { passages?: { text: string }[] })
      : null;
    const passageCharacters = (evidence?.passages ?? []).reduce(
      (total, passage) => total + passage.text.length,
      0,
    );
    measured.push({
      retrieval,
      fetchCalled: taken.called,
      evidenceCharacters: taken.evidence.length,
      requestCharacters: taken.body.length,
      passageCharacters,
      estimatedEvidenceTokens: estimateTokens(taken.evidence.length),
      estimatedRequestTokens: estimateTokens(taken.body.length),
    });
  }
  const on = measured.find((item) => item.retrieval === 'required');
  const off = measured.find((item) => item.retrieval === 'disabled');
  return {
    case: name,
    on,
    off,
    extraEvidenceCharacters: (on?.evidenceCharacters ?? 0) - (off?.evidenceCharacters ?? 0),
    extraRequestCharacters: (on?.requestCharacters ?? 0) - (off?.requestCharacters ?? 0),
    extraEstimatedEvidenceTokens:
      (on?.estimatedEvidenceTokens ?? 0) - (off?.estimatedEvidenceTokens ?? 0),
    tokenEstimate:
      'ceil(characters / 4). This is not the API tokenizer and not usage from a model response.',
  };
}

async function openAiInput() {
  const root = await mkdtemp(join(tmpdir(), 'refit-perf-openai-'));
  const before = {
    openapi: '3.0.3',
    info: { title: 'OpenAI offline conformance fixture', version: 'before' },
    paths: {},
    components: {
      schemas: {
        Model: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            owned_by: {
              type: 'string',
              description:
                'Organization that owns the model, returned by models.retrieve as owned_by.',
            },
          },
        },
      },
    },
  };
  const after = structuredClone(before);
  const properties = after.components.schemas.Model.properties as Record<string, unknown>;
  delete properties.owned_by;
  properties.owner_name = { type: 'string' };
  const beforePath = join(root, 'before.json');
  const afterPath = join(root, 'after.json');
  await writeFile(beforePath, JSON.stringify(before));
  await writeFile(afterPath, JSON.stringify(after));
  return {
    input: {
      repository: join(ROOT, 'pipeline/fixtures/openai/repository'),
      before: beforePath,
      after: afterPath,
      providerConfig: join(ROOT, 'pipeline/fixtures/openai/provider.json'),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function hyperfine() {
  try {
    const result = await execute('hyperfine', ['--version'], { timeout: 10_000 });
    return { installed: true, version: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    return {
      installed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function latestPatchQuality() {
  let names: string[] = [];
  try {
    names = (await readdir(RESULTS)).filter((name) => name.startsWith('patch-quality-'));
  } catch {
    return null;
  }
  names.sort();
  const name = names.at(-1);
  if (!name) return null;
  return {
    file: join(RESULTS, name),
    value: JSON.parse(await readFile(join(RESULTS, name), 'utf8')),
  };
}

const labels = JSON.parse(await readFile(join(ROOT, 'eval/retrieval-labels.json'), 'utf8')) as {
  provider: string;
  operation: string;
  field: string;
}[];
const index = await createPassageIndex({ provider: 'stripe' });
const retrievalSamples: number[] = [];
for (let query = 0; query < QUERIES; query += 1) {
  const label = labels[query % labels.length];
  const started = performance.now();
  retrieve({ provider: label.provider, operation: label.operation, fields: [label.field] }, index);
  retrievalSamples.push(performance.now() - started);
}

const indexBuilds = [];
for (const provider of ['stripe', 'openai', 'anthropic'])
  indexBuilds.push(await timeIndex(provider));

const openai = await openAiInput();
let prompts;
try {
  prompts = [
    await promptSize('stripe-replay', {
      repository: join(ROOT, 'pipeline/fixtures/repository'),
      before: join(ROOT, 'pipeline/fixtures/before.json'),
      after: join(ROOT, 'pipeline/fixtures/after.json'),
    }),
    await promptSize('openai-rename-proof', openai.input),
    await promptSize('anthropic-fixture', {
      repository: join(ROOT, 'pipeline/fixtures/anthropic/repository'),
      before: join(ROOT, 'pipeline/fixtures/anthropic/before.json'),
      after: join(ROOT, 'pipeline/fixtures/anthropic/after.json'),
      providerConfig: join(ROOT, 'pipeline/fixtures/anthropic/provider.json'),
    }),
  ];
} finally {
  await openai.cleanup();
}

const patchQuality = await latestPatchQuality();
const stageTimings = {
  status: 'skipped' as const,
  reason:
    'Layer 3 did not produce Detect, Understand, Validate, or Review timings. Validate is dominated by Docker when that path runs.',
  patchQualityFile: patchQuality?.file ?? null,
  patchQualityStatus:
    patchQuality &&
    typeof patchQuality.value === 'object' &&
    patchQuality.value &&
    'status' in patchQuality.value
      ? patchQuality.value.status
      : null,
};

const model = process.env.OPENAI_MODEL?.trim() || null;
const modelMeasurements = {
  status: process.env.OPENAI_API_KEY?.trim() && model ? 'not-run' : 'skipped',
  model,
  reason: process.env.OPENAI_API_KEY?.trim()
    ? 'OPENAI_MODEL is unset, so model latency and token usage were not requested.'
    : 'OPENAI_API_KEY is unset, so no model call latency or response usage was collected.',
};

const commandTiming = await hyperfine();
const result = {
  measuredAt: new Date().toISOString(),
  machine: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  indexBuilds,
  retrieval: {
    queries: QUERIES,
    labels: labels.length,
    p50Ms: percentile(retrievalSamples, 50),
    p95Ms: percentile(retrievalSamples, 95),
    maxMs: Math.max(...retrievalSamples),
    percentile: 'nearest-rank, ceil(percent/100*n)-1',
  },
  promptSize: prompts,
  model: modelMeasurements,
  stageTimings,
  hyperfine: commandTiming.installed
    ? { installed: true, version: commandTiming.version, runs: 'not executed in this script' }
    : {
        installed: false,
        detail: 'detail' in commandTiming ? commandTiming.detail : 'hyperfine is not installed',
        compared: false,
      },
};
const file = await writeResult('perf', result);
console.log(file);
console.log(
  JSON.stringify(
    {
      retrieval: result.retrieval,
      indexMedianMs: indexBuilds.map((item) => ({
        provider: item.provider,
        medianMs: item.medianMs,
      })),
      extraEvidenceCharacters: prompts.map((item) => ({
        case: item.case,
        extraEvidenceCharacters: item.extraEvidenceCharacters,
        passageCharacters: item.on?.passageCharacters,
      })),
    },
    null,
    2,
  ),
);

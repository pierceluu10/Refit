import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeAiPatch } from '../pipeline/ai-patches.ts';
import { createPassageIndex } from '../pipeline/passages.ts';
import { readRepository } from '../pipeline/repository.ts';
import { formatHitRates, labeledChanges, topHitRates } from '../pipeline/retrieval.ts';
import { runPipeline } from '../pipeline/run.ts';
import type { ProviderAdapter } from '../pipeline/providers.ts';

const runs = Number(
  process.argv.find((argument) => argument.startsWith('--runs='))?.slice('--runs='.length) ?? 5,
);
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim();

const cases: {
  provider: string;
  repository: string;
  before: string;
  after: string;
  providerConfig?: string;
  adapter?: ProviderAdapter;
}[] = [
  {
    provider: 'stripe',
    repository: 'pipeline/fixtures/repository',
    before: 'pipeline/fixtures/before.json',
    after: 'pipeline/fixtures/after.json',
  },
  {
    provider: 'anthropic',
    repository: 'pipeline/fixtures/anthropic/repository',
    before: 'pipeline/fixtures/anthropic/before.json',
    after: 'pipeline/fixtures/anthropic/after.json',
    providerConfig: 'pipeline/fixtures/anthropic/provider.json',
  },
];

async function openAiCase() {
  const root = await mkdtemp(join(tmpdir(), 'refit-rag-openai-'));
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
    provider: 'openai',
    repository: 'pipeline/fixtures/openai/repository',
    before: beforePath,
    after: afterPath,
    providerConfig: 'pipeline/fixtures/openai/provider.json',
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const index = await createPassageIndex({ provider: 'stripe' });
const rates = topHitRates(index, await labeledChanges());
console.log(formatHitRates(rates));

if (!apiKey || !model || !Number.isInteger(runs) || runs < 1) {
  console.error(
    'Model comparison was not run. Set OPENAI_API_KEY and OPENAI_MODEL, then run: node --import tsx eval/rag-eval.ts --runs=5',
  );
  process.exitCode = 2;
} else {
  const openai = await openAiCase();
  const summaries = [];
  try {
    for (const item of [...cases, openai]) {
      const report = await runPipeline({
        repository: item.repository,
        before: item.before,
        after: item.after,
        providerConfig: item.providerConfig,
      });
      const repository = await readRepository(item.repository, report.adapter.packageName);
      for (const mode of ['required', 'disabled'] as const) {
        let accepted = 0;
        let rejected = 0;
        let repairAttempts = 0;
        for (let attempt = 0; attempt < runs; attempt += 1) {
          try {
            const proposal = await proposeAiPatch(
              repository,
              report.changes,
              report.findings,
              { apiKey, model },
              report.adapter,
              {},
              undefined,
              {
                retrieval: mode,
                document: undefined,
              },
            );
            if (proposal.edits > 0) accepted += 1;
            else rejected += 1;
          } catch {
            rejected += 1;
            repairAttempts += 1;
          }
        }
        summaries.push({
          provider: item.provider,
          retrieval: mode,
          runs,
          accepted,
          rejected,
          passRate: accepted / runs,
          averageRepairAttempts: repairAttempts / runs,
        });
      }
    }
  } finally {
    await openai.cleanup();
  }
  console.log(JSON.stringify({ model, runs, summaries }, null, 2));
}

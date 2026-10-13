import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateMigration } from '../pipeline/validation.ts';
import { writeReviewBundle } from '../pipeline/review.ts';
import { writeResult } from './write-result.ts';

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const runs = Number(
  process.argv.find((argument) => argument.startsWith('--runs='))?.slice('--runs='.length) ?? 5,
);
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const model = process.env.OPENAI_MODEL?.trim() ?? '';

type CaseSpec = {
  id: string;
  retrievalModes: ('on' | 'off')[];
  blockers: string[];
  run?: () => Promise<unknown>;
};

async function dockerStatus() {
  try {
    const result = await execute('docker', ['info'], { timeout: 15_000 });
    return { available: true, detail: result.stderr.trim() || 'docker info exited 0' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, detail: message };
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const billingConfig = join(ROOT, 'examples/billing-demo.refit.json');
const billingRepository = resolve(dirname(billingConfig), '../../refit-billing-demo');
const docker = await dockerStatus();
const globalBlockers = [
  ...(!apiKey ? ['OPENAI_API_KEY is unset.'] : []),
  ...(!model ? ['OPENAI_MODEL is unset.'] : []),
  ...(!docker.available ? [`Docker is not available. ${docker.detail}`] : []),
  ...(!Number.isInteger(runs) || runs < 1
    ? [`--runs must be a positive integer, got ${runs}.`]
    : []),
];

const cases: CaseSpec[] = [
  {
    id: 'stripe-billing-demo',
    retrievalModes: ['off', 'on'],
    blockers: [
      ...(!(await exists(billingRepository))
        ? [
            `Billing demo repository is not present at ${billingRepository}. examples/billing-demo.refit.json points there.`,
          ]
        : []),
      'Retrieval off cannot be selected on validateMigration. proposeAiPatch accepts retrieval: disabled, and the scan/validation path does not.',
    ],
    run:
      globalBlockers.length === 0 && (await exists(billingRepository))
        ? async () =>
            validateMigration({
              repository: billingRepository,
              before: resolve(
                dirname(billingConfig),
                '../../refit-billing-demo/docs/contracts/before.json',
              ),
              after: resolve(
                dirname(billingConfig),
                '../../refit-billing-demo/docs/contracts/after.json',
              ),
              image: 'refit-billing-check:history',
              apiVersion: '2022-08-01',
              repairAttempts: 1,
              aiPatch: { apiKey, model },
              baselineCommand: [
                'sh',
                '-c',
                'ln -s /opt/billing/node_modules node_modules && npm test && node --import tsx /opt/refit-checks/billing-pagination.mjs before',
              ],
              command: [
                'sh',
                '-c',
                'ln -s /opt/billing/node_modules node_modules && npm test && npm run test:after && npm run typecheck && node --import tsx /opt/refit-checks/billing-pagination.mjs before && node --import tsx /opt/refit-checks/billing-pagination.mjs after',
              ],
            })
        : undefined,
  },
  {
    id: 'openai-rename-proof',
    retrievalModes: ['off', 'on'],
    blockers: [
      'The OpenAI rename proof is built from pipeline/fixtures/openai/repository plus temporary before/after specs in eval/rag-eval.ts. That repository is not a Git root, and no Docker image is recorded for it.',
      'Retrieval off cannot be selected on validateMigration.',
    ],
  },
  {
    id: 'anthropic-fixture',
    retrievalModes: ['off', 'on'],
    blockers: [
      'pipeline/fixtures/anthropic/repository is not a Git root, and no Docker image or check command is recorded for that fixture.',
      'Retrieval off cannot be selected on validateMigration.',
    ],
  },
];

const caseResults = [];
const sampleNotes: string[] = [];
for (const item of cases) {
  const blockers = [...globalBlockers, ...item.blockers];
  if (blockers.length || !item.run) {
    caseResults.push({
      id: item.id,
      status: 'skipped',
      blockers,
      runs: [],
    });
    continue;
  }
  const rows = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    try {
      const report = await item.run();
      if (index < 5 && report && typeof report === 'object' && 'validation' in report) {
        const directory = join(ROOT, 'eval/results/samples', `${item.id}-on-${index + 1}`);
        await writeReviewBundle(directory, report as Parameters<typeof writeReviewBundle>[1]);
        sampleNotes.push(directory);
      }
      const validation =
        report && typeof report === 'object' && 'validation' in report
          ? (report.validation as {
              status?: string;
              repair?: { requested?: number };
              attempts?: { retrieval?: { findings?: { citedPassageIds?: string[] }[] } }[];
            })
          : undefined;
      const patch =
        report && typeof report === 'object' && 'patch' in report
          ? (report.patch as {
              unresolvedFindings?: number;
              retrieval?: {
                findings?: { citedPassageIds?: string[]; unresolvedReason?: string | null }[];
              };
            })
          : undefined;
      rows.push({
        retrieval: 'on',
        finalStatus: validation?.status ?? 'unknown',
        patchPassedChecks: validation?.status === 'passed',
        repairAttemptsUsed: validation?.repair?.requested ?? null,
        rejectedEdits: [],
        unresolvedFindings: patch?.unresolvedFindings ?? null,
        unresolvedReasons: (patch?.retrieval?.findings ?? [])
          .map((finding) => finding.unresolvedReason)
          .filter((reason) => reason),
        citedPassageIds: (patch?.retrieval?.findings ?? []).flatMap(
          (finding) => finding.citedPassageIds ?? [],
        ),
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      rows.push({
        retrieval: 'on',
        finalStatus: 'error',
        patchPassedChecks: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        elapsedMs: performance.now() - started,
      });
    }
  }
  caseResults.push({ id: item.id, status: 'ran', retrieval: 'on', runs: rows });
}

const result = {
  measuredAt: new Date().toISOString(),
  model: model || null,
  runsRequested: runs,
  repairAttempts: 1,
  docker: docker.available,
  status: caseResults.every((item) => item.status === 'skipped') ? 'skipped' : 'partial',
  samplePullRequests: sampleNotes,
  cases: caseResults,
};
const file = await writeResult('patch-quality', result);
console.log(
  JSON.stringify({ file, status: result.status, model: result.model, docker: docker.available }),
);

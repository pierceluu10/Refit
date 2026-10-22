// Scores Refit workflow bundles from the AI patch reliability eval (docs/AI-PATCH-RELIABILITY.md):
// what happened on the AI path of each frozen case, from the bundle's manifest and report alone.
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const AI_PATCH_OUTCOMES = [
  'pass',
  'regression',
  'guard-rejected',
  'input-rejected',
  'declined',
  'repeated',
  'review-stop',
  'evidence-limit',
  'error',
  'not-reached',
  'missing',
] as const;
export type AiPatchOutcome = (typeof AI_PATCH_OUTCOMES)[number];

export interface AiPatchCaseResult {
  id: string;
  outcome: AiPatchOutcome;
  // Final validation status, when validation ran.
  validation: string | null;
  // Generator of the final proposal: deterministic rules or openai.
  generator: string | null;
  // AI responses whose candidate reached the checks; rejected proposals are not attempts.
  aiAttempts: number;
  // Attempts whose first answer Refit rejected as edits and the model corrected.
  corrections: number;
  repairs: number;
  repairStop: string | null;
  // Recorded cost of the AI attempts, including corrected requests. A request whose answer was
  // finally rejected, or that failed, leaves no cost in the bundle, so costComplete is false
  // whenever one may have happened; the run's ledger has the total.
  costUsd: number;
  costComplete: boolean;
  detail: string | null;
}

interface Manifest {
  status?: string;
  stage?: string;
  reason?: string;
  error?: { name: string; message: string } | null;
}

interface Attempt {
  responseId?: string | null;
  costUsd?: number | null;
  rejectedProposals?: string[];
}

interface Report {
  patch?: { generator?: string; status?: string };
  validation?: {
    status?: string;
    attempts?: Attempt[];
    repair?: { requested?: number; stopReason?: string; error?: string | null };
  };
}

// The substitution guard's messages (pipeline/substitution-guard.ts).
const GUARD =
  /AI replacement (substitutes pre-existing field|reads added field|still reads removed)/;
const EVIDENCE_LIMIT = /exceeds the 64 KiB input limit|exceeds the token limit/;
// proposeAiPatch's checks on the model's edits before any guard: scope, matching, overlap, syntax,
// event names and subscription item choice.
const INPUT_CHECK = /^(PipelineInputError: )?AI (patch|replacement|replacements) /;
const NO_PROPOSAL = /No supported patch proposal is available/;
// The eval's runs are offline apart from OpenAI, so a failed fetch or an aborted request is the
// model request's.
const AI_ERROR = /OpenAI|\bAI\b|fetch failed|operation was aborted|aborted due to timeout/;

function rejection(message: string): AiPatchOutcome {
  if (GUARD.test(message)) return 'guard-rejected';
  if (EVIDENCE_LIMIT.test(message)) return 'evidence-limit';
  if (INPUT_CHECK.test(message)) return 'input-rejected';
  if (NO_PROPOSAL.test(message)) return 'declined';
  return 'error';
}

export function scoreBundle(
  id: string,
  manifest: Manifest | undefined,
  report: Report | undefined,
): AiPatchCaseResult {
  const attempts = report?.validation?.attempts ?? [];
  // The open-enum restore re-records the proposal it restored, response and cost included.
  const ai = attempts.filter(
    (attempt, index) =>
      attempt.responseId &&
      attempts.findIndex((other) => other.responseId === attempt.responseId) === index,
  );
  const repair = report?.validation?.repair;
  const result: AiPatchCaseResult = {
    id,
    outcome: 'missing',
    validation: report?.validation?.status ?? null,
    generator: report?.patch?.generator ?? null,
    aiAttempts: ai.length,
    corrections: ai.filter((attempt) => attempt.rejectedProposals?.length).length,
    repairs: repair?.requested ?? 0,
    repairStop: repair?.stopReason ?? null,
    costUsd: ai.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    costComplete: ai.every((attempt) => typeof attempt.costUsd === 'number'),
    detail: null,
  };
  if (!manifest) return result;
  if (manifest.status === 'error') {
    const message = manifest.error?.message ?? manifest.reason ?? '';
    const outcome = rejection(message);
    // Other errors, such as a refused dependency preparation or a scan failure, never asked the model.
    const reached = outcome !== 'error' || AI_ERROR.test(message);
    return {
      ...result,
      outcome: reached ? outcome : 'not-reached',
      costComplete: result.costComplete && !reached,
      detail: message,
    };
  }
  if (!report?.validation)
    return { ...result, outcome: 'not-reached', detail: manifest.reason ?? null };
  // The repair step's review stops, before a request (only review items left, a property the
  // upgraded types reject) or after one; a request's discarded response leaves no cost.
  if (result.repairStop === 'review-required')
    return {
      ...result,
      outcome: 'review-stop',
      costComplete: result.costComplete && !result.repairs,
      detail: repair?.error ?? null,
    };
  const aiUsed = result.generator === 'openai' || result.repairs > 0;
  if (!aiUsed || result.validation === 'baseline-failed')
    return { ...result, outcome: 'not-reached', detail: manifest.reason ?? null };
  if (result.validation === 'passed') return { ...result, outcome: 'pass' };
  const stop = result.repairStop;
  if (stop === 'repair-error')
    return {
      ...result,
      outcome: rejection(repair?.error ?? ''),
      costComplete: false,
      detail: repair?.error ?? null,
    };
  if (stop === 'no-proposal') return { ...result, outcome: 'declined', costComplete: false };
  if (stop === 'repeated-proposal') return { ...result, outcome: 'repeated', costComplete: false };
  return {
    ...result,
    outcome: result.validation === 'regression' ? 'regression' : 'error',
    detail: manifest.reason ?? null,
  };
}

// A bundle is a directory with a refit-workflow manifest. Stripe benchmark bundles sit at
// repos/<owner__repo>/run; any other bundle is named by its directory.
export function bundleId(directory: string) {
  return basename(dirname(dirname(directory))) === 'repos'
    ? basename(dirname(directory)).replace('__', '/')
    : basename(directory);
}

export async function findBundles(root: string) {
  const bundles = new Map<string, string>();
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries.filter((path) => basename(path) === 'manifest.json')) {
    const directory = join(root, dirname(entry));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.kind !== 'refit-workflow') continue;
    const id = bundleId(directory);
    if (bundles.has(id))
      throw new Error(`Two bundles for ${id}: ${bundles.get(id)} and ${directory}`);
    bundles.set(id, directory);
  }
  return bundles;
}

export async function scoreRun(root: string, ids: string[]) {
  const bundles = await findBundles(root);
  const read = async (directory: string | undefined, file: string) =>
    directory
      ? (JSON.parse(await readFile(join(directory, file), 'utf8').catch(() => 'null')) ?? undefined)
      : undefined;
  return Promise.all(
    ids.map(async (id) =>
      scoreBundle(
        id,
        await read(bundles.get(id), 'manifest.json'),
        await read(bundles.get(id), 'report.json'),
      ),
    ),
  );
}

export function summarizeRun(results: AiPatchCaseResult[]) {
  const counts = Object.fromEntries(AI_PATCH_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    AiPatchOutcome,
    number
  >;
  for (const result of results) counts[result.outcome]++;
  const reached = results.filter(
    (result) => result.outcome !== 'not-reached' && result.outcome !== 'missing',
  );
  return {
    cases: results.length,
    reached: reached.length,
    counts,
    repairsRequested: results.reduce((sum, result) => sum + result.repairs, 0),
    recordedCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
  };
}

const usd = (value: number) => `$${value.toFixed(4)}`;

export function comparisonTable(runs: { label: string; results: AiPatchCaseResult[] }[]) {
  const ids = runs[0].results.map((result) => result.id);
  const header = `| Case | ${runs.map((run) => run.label).join(' | ')} |`;
  const rule = `|---|${runs.map(() => '---').join('|')}|`;
  const rows = ids.map((id) => {
    const cells = runs.map((run) => {
      const result = run.results.find((candidate) => candidate.id === id);
      if (!result) return 'not run';
      const repair = result.repairs ? `, ${result.repairs} repair (${result.repairStop})` : '';
      const corrected = result.corrections ? `, ${result.corrections} corrected` : '';
      const cost =
        result.aiAttempts || result.outcome !== 'not-reached'
          ? `, ${usd(result.costUsd)}${result.costComplete ? '' : '+'}`
          : '';
      return `${result.outcome}${repair}${corrected}${cost}`;
    });
    return `| ${id} | ${cells.join(' | ')} |`;
  });
  return [header, rule, ...rows].join('\n');
}

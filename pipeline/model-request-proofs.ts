import { readFile } from 'node:fs/promises';
import { validDate } from './deadline-registry.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Request-level proof for replacement models: the smallest request each API accepts for a model,
// (JSON output, structured output with a JSON schema, a tool call, a stream), sent with Refit's own key from refit-bench Actions (`scripts/model-request-proof.mjs`), never a
// customer's. It shows the provider serves the model with those parameter names and that the
// response parses (JSON output, a tool call, a stream). It never shows the model answers a
// customer's prompts as well as the retired one did.
export const DEFAULT_REQUEST_PROOFS = new URL('../data/model-request-proofs.json', import.meta.url);
export const PROOF_APIS = ['chat.completions', 'responses', 'messages', 'generateContent'] as const;
export type ProofApi = (typeof PROOF_APIS)[number];
const CHECKS = ['request', 'json', 'schema', 'tools', 'stream'] as const;
const PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);
const RUN = /^https:\/\/github\.com\/refit-dev\/refit-bench\/actions\/runs\/\d+$/;

export interface RequestProof {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
  api: ProofApi;
  // The request parameters the proof sent beside `model` and the input.
  parameters: string[];
  // `passed` for each check that ran; a check that did not apply is absent.
  checks: Partial<Record<(typeof CHECKS)[number], 'passed'>>;
  // Parameters a retired model took that this model answered with HTTP 400, sent one at a time.
  rejected?: string[];
  run: string;
  date: string;
}

// A replacement no request has proven yet, with the exact reason.
export interface PendingProof {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
  api: ProofApi;
  reason: string;
}

export interface RequestProofTable {
  formatVersion: 1;
  proofs: RequestProof[];
  pending: PendingProof[];
}

export const EMPTY_REQUEST_PROOFS: RequestProofTable = {
  formatVersion: 1,
  proofs: [],
  pending: [],
};

// The API family of a traced call, such as `chat.completions` for `beta.chat.completions.parse`.
export function proofApi(call: string): ProofApi | null {
  if (/(?:^|\.)chat\.completions\.|createChatCompletion|\/chat\/completions/.test(call))
    return 'chat.completions';
  if (/(?:^|\.)responses\.|\/responses/.test(call)) return 'responses';
  if (/(?:^|\.)messages\.|\/v1\/messages/.test(call)) return 'messages';
  if (/generateContent/.test(call)) return 'generateContent';
  return null;
}

export function checkRequestProofs(value: unknown): { errors: string[] } {
  const errors: string[] = [];
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.proofs) ||
    !Array.isArray(value.pending)
  )
    return { errors: ['Request proofs require formatVersion: 1, proofs and pending arrays.'] };
  const seen = new Set<string>();
  const common = (item: Record<string, unknown>, label: string) => {
    if (!PROVIDERS.has(item.provider as string)) errors.push(`${label}: unknown provider.`);
    if (typeof item.model !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(item.model))
      errors.push(`${label}: model must be a model ID.`);
    if (!PROOF_APIS.includes(item.api as ProofApi)) errors.push(`${label}: unknown api.`);
    const key = `${item.provider}\t${item.model}\t${item.api}`;
    if (seen.has(key)) errors.push(`${label}: ${item.model} ${item.api} is listed twice.`);
    seen.add(key);
  };
  value.proofs.forEach((item, index) => {
    const label = `proof ${index}`;
    if (!isObject(item)) return errors.push(`${label}: must be an object.`);
    common(item, label);
    if (!Array.isArray(item.parameters) || item.parameters.some((name) => typeof name !== 'string'))
      errors.push(`${label}: parameters must be names.`);
    if (
      !isObject(item.checks) ||
      item.checks.request !== 'passed' ||
      Object.entries(item.checks).some(
        ([name, status]) => !CHECKS.includes(name as never) || status !== 'passed',
      )
    )
      errors.push(`${label}: checks must hold passed checks, request among them.`);
    if (
      Object.hasOwn(item, 'rejected') &&
      (!Array.isArray(item.rejected) || item.rejected.some((name) => typeof name !== 'string'))
    )
      errors.push(`${label}: rejected must be parameter names.`);
    if (typeof item.run !== 'string' || !RUN.test(item.run))
      errors.push(`${label}: run must be a refit-bench Actions run URL.`);
    if (!validDate(item.date)) errors.push(`${label}: date must be YYYY-MM-DD.`);
  });
  value.pending.forEach((item, index) => {
    const label = `pending ${index}`;
    if (!isObject(item)) return errors.push(`${label}: must be an object.`);
    common(item, label);
    if (typeof item.reason !== 'string' || !item.reason.trim())
      errors.push(`${label}: reason is required.`);
  });
  return { errors };
}

export async function loadRequestProofs(path: string | URL = DEFAULT_REQUEST_PROOFS) {
  const value = parseObject(await readFile(path, 'utf8'), 'Request proofs');
  const { errors } = checkRequestProofs(value);
  if (errors.length)
    throw new PipelineInputError(`Request proofs are invalid: ${errors.slice(0, 5).join(' ')}`);
  return value as unknown as RequestProofTable;
}

// What a draft can say about one replacement: its proof, or why there is none.
export function requestProof(
  table: RequestProofTable,
  provider: string,
  model: string,
  call: string,
): { proof: RequestProof } | { pending: string } {
  const api = proofApi(call);
  if (!api) return { pending: `Refit has no request-level proof for calls like ${call}.` };
  const proof = table.proofs.find(
    (item) => item.provider === provider && item.model === model && item.api === api,
  );
  if (proof) return { proof };
  const pending = table.pending.find(
    (item) => item.provider === provider && item.model === model && item.api === api,
  );
  return {
    pending:
      pending?.reason ??
      `No request to ${model} through ${api} has been sent with Refit's test key yet.`,
  };
}

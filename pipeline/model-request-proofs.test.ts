import { describe, expect, it } from 'vitest';
import {
  checkRequestProofs,
  loadRequestProofs,
  proofApi,
  requestProof,
  type RequestProofTable,
  unavailableTargets,
} from './model-request-proofs.ts';

const table: RequestProofTable = {
  formatVersion: 1,
  proofs: [
    {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      api: 'chat.completions',
      parameters: ['max_completion_tokens'],
      checks: { request: 'passed', tools: 'passed' },
      rejected: ['max_tokens'],
      run: 'https://github.com/refit-dev/refit-bench/actions/runs/123',
      date: '2026-10-29',
    },
  ],
  pending: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      api: 'messages',
      reason: 'Blocked: no ANTHROPIC_API_KEY.',
    },
  ],
};

describe('proofApi', () => {
  it.each([
    ['chat.completions.create', 'chat.completions'],
    ['beta.chat.completions.parse', 'chat.completions'],
    ['createChatCompletion', 'chat.completions'],
    ['responses.stream', 'responses'],
    ['messages.create', 'messages'],
    ['beta.messages.stream', 'messages'],
    ['POST https://api.anthropic.com/v1/messages', 'messages'],
    ['embeddings.create', null],
  ])('%s → %s', (call, api) => expect(proofApi(call)).toBe(api));
});

describe('requestProof', () => {
  it('finds the proof for the call family, or says exactly why there is none', () => {
    expect(requestProof(table, 'openai', 'gpt-5.6-sol', 'chat.completions.create')).toEqual({
      proof: table.proofs[0],
    });
    expect(requestProof(table, 'openai', 'gpt-5.6-sol', 'responses.create')).toEqual({
      pending:
        "No request to gpt-5.6-sol through responses has been sent with Refit's test key yet.",
    });
    expect(requestProof(table, 'anthropic', 'claude-sonnet-5-5', 'messages.create')).toEqual({
      pending: 'Blocked: no ANTHROPIC_API_KEY.',
    });
    expect(requestProof(table, 'openai', 'gpt-5.6-sol', 'embeddings.create')).toEqual({
      pending: 'Refit has no request-level proof for calls like embeddings.create.',
    });
  });
});

describe('checkRequestProofs', () => {
  it('accepts a valid table', () => expect(checkRequestProofs(table).errors).toEqual([]));

  it('rejects a proof without a passed request, a run outside refit-bench, or a duplicate', () => {
    const bad = {
      ...table,
      proofs: [
        { ...table.proofs[0], checks: { tools: 'passed' } },
        { ...table.proofs[0], run: 'https://example.com/run/1' },
      ],
      pending: [{ ...table.pending[0], reason: ' ' }],
    };
    expect(checkRequestProofs(bad).errors).toEqual([
      'proof 0: checks must hold passed checks, request among them.',
      'proof 1: gpt-5.6-sol chat.completions is listed twice.',
      'proof 1: run must be a refit-bench Actions run URL.',
      'pending 0: reason is required.',
    ]);
  });
});

describe('unavailableTargets', () => {
  const run = 'https://github.com/refit-dev/refit-bench/actions/runs/40940798473';
  const missing = {
    provider: 'openai' as const,
    model: 'gpt-5-codex-mini',
    api: 'responses' as const,
    reason: 'The smallest request returned HTTP 404 on 2026-10-29.',
    status: 404,
    run,
  };

  it('lists only targets a proof got HTTP 404 for, with the run', () => {
    const value = {
      ...table,
      pending: [
        ...table.pending,
        missing,
        { ...missing, api: 'chat.completions' as const, status: 500 },
      ],
    };
    expect(checkRequestProofs(value).errors).toEqual([]);
    expect(unavailableTargets(value)).toEqual([
      { provider: 'openai', model: 'gpt-5-codex-mini', api: 'responses', run },
    ]);
  });

  it('requires an HTTP status and a refit-bench run together', () => {
    const value = {
      ...table,
      pending: [
        { ...missing, run: undefined },
        { ...missing, api: 'chat.completions', status: 4040 },
      ],
    };
    expect(checkRequestProofs(value).errors).toEqual([
      'pending 0: status needs an HTTP status and the refit-bench run that got it.',
      'pending 1: status needs an HTTP status and the refit-bench run that got it.',
    ]);
  });

  it('flags gpt-5-codex-mini in the shipped table on both APIs', async () => {
    expect(
      unavailableTargets(await loadRequestProofs())
        .filter((item) => item.model === 'gpt-5-codex-mini')
        .map((item) => item.api)
        .sort(),
    ).toEqual(['chat.completions', 'responses']);
  });
});

it('ships a valid table whose pending entries each give a reason', async () => {
  const shipped = await loadRequestProofs();
  expect([...shipped.proofs, ...shipped.pending].length).toBeGreaterThan(0);
  for (const item of shipped.pending) expect(item.reason).toMatch(/^(?:Blocked|Not run yet|The )/);
});

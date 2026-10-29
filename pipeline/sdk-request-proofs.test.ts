import { expect, it } from 'vitest';
import {
  loadSdkProofTable,
  parseSdkProofTable,
  proveSdkTable,
  storedRequestProof,
} from './sdk-request-proofs.ts';

const RUN = 'https://github.com/refit-dev/refit-bench/actions/runs/123';
const table = parseSdkProofTable({
  formatVersion: 1,
  proofs: [
    {
      package: 'openai',
      major: 6,
      call: 'chat.completions.create',
      stream: true,
      status: 'accepted',
      release: '6.49.0',
      detail: 'text parsed, stream parsed',
      run: RUN,
      date: '2026-10-29',
    },
  ],
  pending: [
    {
      package: '@anthropic-ai/sdk',
      major: 1,
      call: 'messages.create',
      reason: 'ANTHROPIC_API_KEY is not a refit-bench secret yet.',
    },
  ],
});

it('cites a stored proof only when it covers every feature the call uses', () => {
  expect(
    storedRequestProof(table, 'openai', 6, [{ call: 'chat.completions.create', stream: true }])
      .status,
  ).toBe('accepted');
  const tools = storedRequestProof(table, 'openai', 6, [
    { call: 'chat.completions.create', tools: true },
  ]);
  expect(tools.status).toBe('pending');
  expect(tools.reason).toContain('with tools');
  expect(storedRequestProof(table, 'openai', 7, [{ call: 'chat.completions.create' }]).status).toBe(
    'pending',
  );
  expect(
    storedRequestProof(table, '@anthropic-ai/sdk', 1, [{ call: 'messages.create' }]).reason,
  ).toContain('ANTHROPIC_API_KEY is not a refit-bench secret yet.');
  expect(storedRequestProof(table, 'openai', 6, []).status).toBe('pending');
});

it('refuses proofs without a refit-bench run or on another major', () => {
  const proof = {
    package: 'openai',
    major: 6,
    call: 'models.list',
    status: 'accepted',
    release: '6.1.0',
    detail: 'x',
    run: RUN,
    date: '2026-10-29',
  };
  expect(() =>
    parseSdkProofTable({
      formatVersion: 1,
      proofs: [{ ...proof, run: 'https://example.com/run' }],
      pending: [],
    }),
  ).toThrow(/refit-bench/);
  expect(() =>
    parseSdkProofTable({ formatVersion: 1, proofs: [{ ...proof, release: '5.1.0' }], pending: [] }),
  ).toThrow(/not major 6/);
});

it('keeps every target pending when no key or release is present', async () => {
  const proved = await proveSdkTable({
    table,
    sdkDirectory: '/nonexistent',
    releases: { openai: '6.49.0' },
    run: RUN,
    date: '2026-10-29',
    env: {},
  });
  expect(proved.proofs).toEqual([]);
  expect(proved.pending.map((item) => item.reason)).toEqual([
    expect.stringContaining('OPENAI_API_KEY is not set'),
    '@anthropic-ai/sdk 1.x was not installed for this run.',
  ]);
});

it('ships a readable table', async () => {
  const shipped = await loadSdkProofTable();
  expect(shipped.pending.length).toBeGreaterThan(0);
});

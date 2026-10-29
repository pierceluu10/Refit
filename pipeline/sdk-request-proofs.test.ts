import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('writes a 403 for a model outside the project as pending, without the project ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-sdk-proof-'));
  try {
    const sdk = join(directory, 'node_modules', 'openai');
    await mkdir(sdk, { recursive: true });
    await writeFile(join(directory, 'package.json'), '{}');
    await writeFile(
      join(sdk, 'package.json'),
      JSON.stringify({ name: 'openai', version: '6.49.0', main: 'index.js' }),
    );
    await writeFile(
      join(sdk, 'index.js'),
      `class OpenAI {
  constructor() {
    const refuse = async (body) => {
      throw Object.assign(new Error('Project \`proj_AbC123xYz789\` does not have access to model \`' + body.model + '\`'), { status: 403 });
    };
    this.chat = { completions: { create: refuse } };
  }
}
module.exports = { OpenAI };
`,
    );
    const proved = await proveSdkTable({
      table: parseSdkProofTable({
        formatVersion: 1,
        proofs: [],
        pending: [{ package: 'openai', major: 6, call: 'chat.completions.create', reason: 'x' }],
      }),
      sdkDirectory: directory,
      releases: { openai: '6.49.0' },
      run: RUN,
      date: '2026-10-29',
      env: { OPENAI_API_KEY: 'test-key' },
    });
    expect(proved.proofs).toEqual([]);
    expect(proved.pending[0].reason).toBe(
      "pending: model not enabled for Refit's project (HTTP 403: Project `[redacted]` does not have access to model `gpt-6.1-sol`)",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('ships a readable table', async () => {
  const shipped = await loadSdkProofTable();
  expect(shipped.pending.length).toBeGreaterThan(0);
});

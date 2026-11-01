import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AREA_MODEL, CALL_RESERVE_USD, MAIN_MODEL, runInventory } from './agent.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import { AREA_READER } from './prompt.ts';
import { fakeModel, fakeResult, makeRepo, removeRepo } from './test-fixtures.ts';

const BILLING = `import Stripe from 'stripe';
import { client } from './client';

export async function charge(amount: number) {
  const intent = await client.paymentIntents.create({ amount, currency: 'usd' });
  return intent.client_secret;
}

export async function forecast(city: string) {
  const response = await fetch(\`\${process.env.WEATHER_URL}/v2/forecast?q=\${city}\`);
  return (await response.json()).daily;
}
`;

let repoDir: string;
let outside: string;
beforeAll(async () => {
  repoDir = await makeRepo({
    'package.json': '{\n  "dependencies": {\n    "stripe": "^14.2.0"\n  }\n}\n',
    'src/client.ts':
      "import Stripe from 'stripe';\nexport const client = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '2023-10-16' });\n",
    'src/billing.ts': BILLING,
  });
  outside = await mkdtemp(path.join(os.tmpdir(), 'inventory-outside-'));
  await symlink(outside, path.join(repoDir, 'escape'));
});
afterAll(async () => {
  await removeRepo(repoDir);
  await rm(outside, { recursive: true, force: true });
});

describe('runInventory with a fake model', () => {
  it('returns what the agent recorded, keeps only verified lines and charges the ledger', async () => {
    const logPath = path.join(outside, 'spend.jsonl');
    const ledger = await BudgetLedger.open({ capUsd: 6, logPath });
    const { runner, outputs } = fakeModel([
      { tool: 'repo_map', input: {} },
      { tool: 'find_http_calls', input: {} },
      { tool: 'read_file', input: { path: 'src/billing.ts' } },
      {
        tool: 'record_usage',
        input: {
          provider: 'stripe',
          via: 'sdk',
          purpose: 'payments',
          sdk: { name: 'stripe', version: '^14.2.0' },
          pinnedVersion: { value: '2023-10-16', file: 'src/client.ts', line: 2 },
          callSites: [
            {
              file: 'src/billing.ts',
              line: 5,
              operation: 'paymentIntents.create',
              fields: ['amount', 'currency'],
              notes: 'returns client_secret',
            },
            { file: 'src/billing.ts', line: 99, operation: 'paymentIntents.create' },
          ],
        },
      },
      {
        tool: 'record_usage',
        input: {
          provider: 'WEATHER_URL host (unknown vendor)',
          via: 'http',
          callSites: [
            {
              file: 'src/billing.ts',
              line: 10,
              operation: 'GET /v2/forecast',
              notes: 'reads daily',
            },
          ],
        },
      },
    ]);
    const report = await runInventory(repoDir, 'acme/shop', { ledger, runner });
    console.log(JSON.stringify(report, null, 1));

    const recordOutput = JSON.parse(outputs[3]);
    expect(recordOutput.accepted).toEqual([
      { file: 'src/billing.ts', line: 5, text: expect.stringContaining('paymentIntents.create') },
    ]);
    expect(recordOutput.rejected[0]).toMatchObject({ line: 99 });
    expect(recordOutput.pinnedVersion).toMatchObject({ accepted: true });

    expect(report.usages).toHaveLength(2);
    const stripe = report.usages.find((usage) => usage.provider === 'stripe');
    expect(stripe).toMatchObject({
      repo: 'acme/shop',
      via: 'sdk',
      sdk: { name: 'stripe', version: '^14.2.0' },
      pinnedVersion: { value: '2023-10-16', file: 'src/client.ts', line: 2 },
      callSites: [{ file: 'src/billing.ts', line: 5, operation: 'paymentIntents.create' }],
    });
    expect(stripe).not.toHaveProperty('purpose');
    expect(report.purposes).toEqual({ stripe: 'payments' });
    expect(report.summary).toContain(
      'stripe for payments through stripe ^14.2.0, pinned to 2023-10-16 in 1 place',
    );
    expect(report.outcome).toBe('success');
    expect(report.costUsd).toBe(0.02);

    expect(ledger.spentUsd).toBeCloseTo(0.02);
    const spend = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(spend.map((entry) => entry.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(spend.at(-1).cumulativeUsd).toBeCloseTo(0.02);
  });

  it('gives the agent only read-only repo tools plus subagents, with no settings or shell', async () => {
    const { runner, requests } = fakeModel([]);
    await runInventory(repoDir, 'acme/shop', {
      ledger: new BudgetLedger({ capUsd: 1 }),
      runner,
      runCapUsd: 0.5,
    });
    const { options, tools } = requests[0];
    expect(options.tools).toEqual(['Agent']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.model).toBe(MAIN_MODEL);
    expect(options.maxBudgetUsd).toBeCloseTo(0.5 - CALL_RESERVE_USD);
    expect(
      options.allowedTools?.every(
        (name) => name === 'Agent' || name.startsWith('mcp__inventory__'),
      ),
    ).toBe(true);
    expect(tools.map((candidate) => candidate.name).sort()).toEqual([
      'find_env_names',
      'find_graphql_documents',
      'find_http_calls',
      'find_imports',
      'find_webhook_signals',
      'grep',
      'list_files',
      'list_manifests',
      'list_recorded_usages',
      'locked_versions',
      'read_file',
      'record_usage',
      'remove_usage',
      'repo_map',
    ]);
    const reader = options.agents?.[AREA_READER];
    expect(reader?.model).toBe(AREA_MODEL);
    expect(reader?.tools).toContain('mcp__inventory__record_usage');
    expect(reader?.tools).not.toContain('mcp__inventory__remove_usage');
    expect(Object.keys(options.env ?? {}).some((name) => name.startsWith('CLAUDE_CODE_'))).toBe(
      false,
    );
  });

  it('turns tool errors into text for the model, including paths outside the repo', async () => {
    const { runner, outputs } = fakeModel([
      { tool: 'read_file', input: { path: '../../etc/passwd' } },
      { tool: 'read_file', input: { path: 'escape/anything' } },
      { tool: 'grep', input: { pattern: '(' } },
    ]);
    await runInventory(repoDir, 'acme/shop', { ledger: new BudgetLedger({ capUsd: 1 }), runner });
    console.log(outputs);
    expect(outputs[0]).toMatch(/^OutsideRepoError/);
    expect(outputs[1]).toMatch(/^(OutsideRepoError|Error)/);
    expect(outputs[2]).toMatch(/^SyntaxError/);
  });

  it('caps the run at what remains and refuses to start when the reserve is not left', async () => {
    const { runner, requests } = fakeModel([]);
    await runInventory(repoDir, 'acme/shop', {
      ledger: new BudgetLedger({ capUsd: 1, spentUsd: 0.8 }),
      runner,
    });
    expect(requests[0].options.maxBudgetUsd).toBeCloseTo(0.2 - CALL_RESERVE_USD);

    const starved = fakeModel([]);
    await expect(
      runInventory(repoDir, 'acme/shop', {
        ledger: new BudgetLedger({ capUsd: 1, spentUsd: 0.97 }),
        runner: starved.runner,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(starved.requests).toHaveLength(0);
  });

  it('keeps partial results and charges the cost when the run stops at its budget', async () => {
    const ledger = new BudgetLedger({ capUsd: 1 });
    const { runner } = fakeModel(
      [
        {
          tool: 'record_usage',
          input: {
            provider: 'stripe',
            via: 'sdk',
            callSites: [{ file: 'src/billing.ts', line: 5, operation: 'paymentIntents.create' }],
          },
        },
      ],
      fakeResult({
        subtype: 'error_max_budget_usd',
        errors: ['Reached maximum budget'],
        total_cost_usd: 0.3,
        modelUsage: {},
      } as never),
    );
    const report = await runInventory(repoDir, 'acme/shop', { ledger, runner });
    expect(report.outcome).toBe('error_max_budget_usd');
    expect(report.usages).toHaveLength(1);
    expect(report.summary).toContain('may be incomplete');
    expect(ledger.spentUsd).toBeCloseTo(0.3);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AREA_MODEL, CALL_RESERVE_USD, MAIN_MODEL, runInventory } from './agent.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import { cleanCommit } from './cache.ts';
import { AREA_READER } from './prompt.ts';
import { fakeModel, fakeResult, makeRepo, noScan, removeRepo } from './test-fixtures.ts';

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
    'node_modules/stripe/package.json': JSON.stringify({
      name: 'stripe',
      homepage: 'https://github.com/stripe/stripe-node',
      repository: { type: 'git', url: 'git+https://github.com/stripe/stripe-node.git' },
      bugs: { url: 'https://github.com/stripe/stripe-node/issues' },
    }),
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

  it('records hints, rejects malformed ones with a reason, merges them and returns them', async () => {
    const site = { file: 'src/billing.ts', line: 5, operation: 'paymentIntents.create' };
    const { runner, outputs } = fakeModel([
      { tool: 'package_links', input: { package: 'stripe' } },
      { tool: 'package_links', input: { package: 'left-pad' } },
      {
        tool: 'record_usage',
        input: {
          provider: 'stripe',
          via: 'sdk',
          sdk: { name: 'stripe', version: '^14.2.0' },
          callSites: [site],
          hints: {
            packages: ['stripe', 'stripe', 'has space'],
            hosts: ['API.Stripe.com', 'https://api.stripe.com/v1', '${shop}.example.com'],
            docsUrls: [
              'https://github.com/stripe/stripe-node#readme',
              'docs.stripe.com/changelog',
              'https://user:pass@docs.stripe.com',
            ],
          },
        },
      },
      {
        tool: 'record_usage',
        input: {
          provider: 'stripe',
          via: 'sdk',
          sdk: { name: 'stripe', version: '^14.2.0' },
          callSites: [],
          hints: {
            hosts: ['api.stripe.com', 'files.stripe.com'],
            docsUrls: ['https://docs.stripe.com/changelog'],
          },
        },
      },
      {
        tool: 'record_usage',
        input: {
          provider: 'api.weather.example.org',
          via: 'http',
          callSites: [{ file: 'src/billing.ts', line: 10, operation: 'GET /v2/forecast' }],
        },
      },
    ]);
    // No code scan here, so only the agent's own hints are in the report.
    const report = await runInventory(repoDir, 'acme/shop', {
      ledger: new BudgetLedger({ capUsd: 1 }),
      runner,
      scan: noScan,
    });
    console.log(outputs.join('\n---\n'));

    expect(JSON.parse(outputs[0])).toEqual([
      {
        file: 'node_modules/stripe/package.json',
        links: {
          homepage: 'https://github.com/stripe/stripe-node',
          repository: 'https://github.com/stripe/stripe-node',
          bugs: 'https://github.com/stripe/stripe-node/issues',
        },
      },
    ]);
    expect(outputs[1]).toBe('left-pad is not installed in the checkout.');

    const first = JSON.parse(outputs[2]).hints;
    expect(first.accepted).toEqual({
      packages: ['stripe'],
      hosts: ['api.stripe.com'],
      docsUrls: ['https://github.com/stripe/stripe-node'],
    });
    expect(first.rejected.map((hint: { value: string }) => hint.value)).toEqual([
      'has space',
      'https://api.stripe.com/v1',
      '${shop}.example.com',
      'docs.stripe.com/changelog',
      'https://user:pass@docs.stripe.com',
    ]);
    expect(first.rejected[1].reason).toContain('Did you mean "api.stripe.com"?');
    expect(first.rejected[4].reason).toContain('credentials');

    const stripe = report.usages.find((usage) => usage.provider === 'stripe');
    expect(stripe?.hints).toEqual({
      packages: ['stripe'],
      hosts: ['api.stripe.com', 'files.stripe.com'],
      docsUrls: ['https://github.com/stripe/stripe-node', 'https://docs.stripe.com/changelog'],
    });
    const weather = report.usages.find((usage) => usage.provider === 'api.weather.example.org');
    expect(weather).not.toHaveProperty('hints');
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
        (name) => name === 'Agent' || name === 'Task' || name.startsWith('mcp__inventory__'),
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
      'package_links',
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
    const report = await runInventory(repoDir, 'acme/shop', { ledger, runner, scan: noScan });
    expect(report.outcome).toBe('error_max_budget_usd');
    expect(report.usages).toHaveLength(1);
    expect(report.summary).toContain('may be incomplete');
    expect(ledger.spentUsd).toBeCloseTo(0.3);
  });
});

describe('runInventory: the code scan first, then the agent', () => {
  it('records the scan before the agent runs and hands the agent its usages and leads', async () => {
    const { runner, requests, outputs } = fakeModel([
      { tool: 'list_recorded_usages', input: {} },
      // The agent settles a lead: the weather API the scan could not place.
      {
        tool: 'record_usage',
        input: {
          provider: 'api.weather.example.org',
          via: 'http',
          callSites: [{ file: 'src/billing.ts', line: 10, operation: 'GET /v2/forecast' }],
        },
      },
      // A record without an sdk joins the scan's Stripe usage instead of making a second one.
      {
        tool: 'record_usage',
        input: {
          provider: 'stripe',
          via: 'sdk',
          callSites: [{ file: 'src/billing.ts', line: 5, operation: 'paymentIntents.create' }],
        },
      },
    ]);
    const report = await runInventory(repoDir, 'acme/shop', {
      ledger: new BudgetLedger({ capUsd: 1 }),
      runner,
      cacheDir: false,
    });
    const prompt = requests[0].prompt;
    expect(prompt).toContain('What the code scan found (no AI)');
    expect(prompt).toContain('stripe via sdk stripe ^14.2.0, pins 2023-10-16: 1 call site(s)');
    expect(prompt).toContain('WEATHER_URL');
    // Before the agent's first record, the scan's usage is already there.
    expect(JSON.parse(outputs[0])).toEqual([expect.objectContaining({ key: 'stripe|sdk|stripe' })]);
    expect(report.usages.map((usage) => `${usage.provider}|${usage.via}`).sort()).toEqual([
      'api.weather.example.org|http',
      'stripe|sdk',
    ]);
    expect(report.scan).toMatchObject({ usages: 1, callSites: 1 });
    expect(report.scan?.leads).toBeGreaterThan(0);
  });

  it('serves an unchanged commit from the cache at $0 and caches only a finished run', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'inventory-cache-'));
    const commit = 'a'.repeat(40);
    const ledger = new BudgetLedger({ capUsd: 1 });

    const partial = fakeModel(
      [],
      fakeResult({ subtype: 'error_max_turns', errors: ['turns'], total_cost_usd: 0.1 } as never),
    );
    await runInventory(repoDir, 'acme/shop', { ledger, runner: partial.runner, cacheDir, commit });
    const first = fakeModel([]);
    const read = await runInventory(repoDir, 'acme/shop', {
      ledger,
      runner: first.runner,
      cacheDir,
      commit,
    });
    expect(first.requests).toHaveLength(1); // the partial run was not cached
    expect(read.cached).toBeUndefined();
    expect(read.costUsd).toBe(0.02);

    const again = fakeModel([]);
    const spent = ledger.spentUsd;
    const served = await runInventory(repoDir, 'acme/shop', {
      ledger,
      runner: again.runner,
      cacheDir,
      commit,
    });
    expect(again.requests).toHaveLength(0);
    expect(served.costUsd).toBe(0);
    expect(served.cached).toMatchObject({ costUsd: 0.02 });
    expect(served.usages).toEqual(read.usages);
    expect(ledger.spentUsd).toBe(spent);

    // Another commit is another inventory.
    const moved = fakeModel([]);
    await runInventory(repoDir, 'acme/shop', {
      ledger,
      runner: moved.runner,
      cacheDir,
      commit: 'b'.repeat(40),
    });
    expect(moved.requests).toHaveLength(1);
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('falls back to the agent reading everything when the scan fails', async () => {
    const { runner, requests } = fakeModel([
      {
        tool: 'record_usage',
        input: {
          provider: 'stripe',
          via: 'sdk',
          callSites: [{ file: 'src/billing.ts', line: 5, operation: 'paymentIntents.create' }],
        },
      },
    ]);
    const report = await runInventory(repoDir, 'acme/shop', {
      ledger: new BudgetLedger({ capUsd: 1 }),
      runner,
      cacheDir: false,
      scan: async () => {
        throw new Error('a file the scan could not parse');
      },
    });
    expect(requests[0].prompt).toContain(
      'The code scan failed (Error: a file the scan could not parse)',
    );
    expect(requests[0].prompt).toContain('read it yourself');
    expect(report.usages).toHaveLength(1);
    expect(report.scan).toMatchObject({
      usages: 0,
      failed: 'Error: a file the scan could not parse',
    });
  });

  it('finds no commit to cache by outside a clean git checkout', async () => {
    expect(await cleanCommit(repoDir)).toBeUndefined();
  });

  it('caches by the commit of a clean checkout only', async () => {
    const checkout = await makeRepo({ 'src/app.ts': 'export const x = 1;\n' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      'x',
    );
    expect(await cleanCommit(checkout)).toBe(git('rev-parse', 'HEAD'));
    // A folder inside the checkout is not a checkout of its own.
    expect(await cleanCommit(path.join(checkout, 'src'))).toBeUndefined();
    // Uncommitted edits, tracked or not, are not what the commit describes.
    await writeFile(path.join(checkout, 'src/new.ts'), 'export const y = 2;\n');
    expect(await cleanCommit(checkout)).toBeUndefined();
    await rm(path.join(checkout, 'src/new.ts'));
    await writeFile(path.join(checkout, 'src/app.ts'), 'export const x = 3;\n');
    expect(await cleanCommit(checkout)).toBeUndefined();
    await removeRepo(checkout);
  });
});

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { parseProviderAdapter, STRIPE } from './providers.ts';
import {
  parseStripeSubscriptionPeriodPolicy,
  validateStripeSubscriptionPeriodContract,
} from './stripe-subscription-periods.ts';
import { analyzeRepository } from './analyzer.ts';
import { findRemovedProperties } from './specifications.ts';
import { applySourceEdits } from './patches.ts';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';
import { resolveDockerImage } from './docker-sandbox.ts';
import { migrationReviewReason } from './migration-review.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { watchOnce } from './watch.ts';
import { readEvidence } from './state-files.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/stripe-webhooks');
const POLICY = {
  priceId: 'price_primary',
  beforeApiVersion: '2025-02-24.acacia',
  afterApiVersion: '2025-03-31.basil',
};
const provider = {
  ...STRIPE,
  id: 'stripe-subscription-periods',
  stripeSubscriptionPeriods: POLICY,
};
const before = JSON.parse(await readFile(join(FIXTURE, 'before.json'), 'utf8'));
const after = JSON.parse(await readFile(join(FIXTURE, 'after.json'), 'utf8'));
const client = await readFile(join(FIXTURE, 'repository/client.js'), 'utf8');
const application = await readFile(join(FIXTURE, 'repository/entitlements.js'), 'utf8');
const changes = findRemovedProperties(
  before.components.schemas,
  after.components.schemas,
  provider.id,
);
const roots: string[] = [];
const PROCESS_TIMEOUT_MS = 120_000;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function analyze(source = application) {
  return analyzeRepository(
    {
      root: '/subscription-policy',
      files: [
        { path: 'client.js', content: client },
        { path: 'entitlements.js', content: source },
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    changes,
    provider,
    before.components.schemas,
  );
}

it('creates one atomic policy patch with incoming-event evidence and no remaining removed-field findings', () => {
  const result = analyze();
  expect(result.edits).toHaveLength(1);
  expect(result.edits[0].rule).toBe('stripe-subscription-periods-price-id');
  expect(result.findings.some((finding) => finding.subscriptionPeriod)).toBe(false);
  expect(result.findings).toHaveLength(4);
  expect(
    result.findings.every(
      (finding) =>
        finding.webhook?.migration?.rule === 'stripe-subscription-periods-price-id' &&
        finding.webhook.migration.priceId === POLICY.priceId,
    ),
  ).toBe(true);
  expect(migrationReviewReason({ ...result, adapter: provider })).toMatch(/migration-policy/);
  expect(migrationReviewReason({ ...result, adapter: provider }, true)).toBeUndefined();
  expect(
    migrationReviewReason(
      {
        ...result,
        adapter: { ...provider, stripeSubscriptionPeriods: { ...POLICY, priceId: 'price_other' } },
      },
      true,
    ),
  ).toMatch(/migration-policy/);
  const migrated = applySourceEdits(application, result.edits);
  expect(analyze(migrated).findings).toEqual([]);
  expect(migrated).toContain('event.api_version');
  expect(migrated).not.toContain('items.data[0]');
});

it('keeps the configured price policy ahead of an item the file selects', () => {
  const result = analyze(
    `${application}\nexport function firstItem(subscription) { return subscription.items.data[0]; }\n`,
  );
  expect(result.edits.map((edit) => edit.rule)).toEqual(['stripe-subscription-periods-price-id']);
  expect(result.findings.some((finding) => finding.subscriptionPeriod)).toBe(false);
});

it('keeps direct AI generation blocked even when the deterministic policy is supported', async () => {
  const result = analyze();
  const fetch = vi.fn(() => {
    throw new Error('Webhook policy must not call AI.');
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    proposeAiPatch(
      { root: '/fixture', files: [], dependencies: [], lockfiles: [], warnings: [] },
      changes,
      result.findings,
      { apiKey: 'unused', model: 'unused' },
      provider,
      before.components.schemas,
    ),
  ).rejects.toThrow(/migration-policy/);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { ...POLICY, priceId: 'price_"injection' },
  { ...POLICY, priceId: 'price_missing space' },
  { ...POLICY, priceId: '' },
  { ...POLICY, afterApiVersion: '2025-04-30.basil' },
  { ...POLICY, beforeApiVersion: '2024-06-20' },
  { ...POLICY, selection: 'first' },
])('rejects an unsupported or malformed subscription policy: %j', (policy) => {
  expect(() => parseStripeSubscriptionPeriodPolicy(policy)).toThrow(/requires a literal priceId/);
});

it('accepts only Stripe policy adapters and checks the recorded historical field move', () => {
  expect(parseProviderAdapter(provider).stripeSubscriptionPeriods).toEqual(POLICY);
  expect(() => parseProviderAdapter({ ...provider, packageName: 'another-sdk' })).toThrow(
    /only for the Stripe/,
  );
  expect(() => validateStripeSubscriptionPeriodContract(POLICY, before, after)).not.toThrow();
  expect(() => validateStripeSubscriptionPeriodContract(POLICY, before, before)).not.toThrow();
  for (const alter of [
    (document: typeof after) => {
      document.info.version = 'unknown';
    },
    (document: typeof after) => {
      delete document.components.schemas.subscription_item.properties.price;
    },
    (document: typeof after) => {
      document.components.schemas.subscription_item.properties.current_period_end.type = 'string';
    },
    (document: typeof after) => {
      document.components.schemas.subscription_item_list.properties.has_more.type = 'string';
    },
  ]) {
    const changed = structuredClone(after);
    alter(changed);
    expect(() => validateStripeSubscriptionPeriodContract(POLICY, before, changed)).toThrow(
      /does not match/,
    );
  }
});

it('accepts Stripe inline item lists and refuses ambiguous compositions', () => {
  const changed = structuredClone(after);
  changed.components.schemas.subscription.properties.items =
    changed.components.schemas.subscription_item_list;
  delete changed.components.schemas.subscription_item_list;
  expect(() => validateStripeSubscriptionPeriodContract(POLICY, before, changed)).not.toThrow();
  changed.components.schemas.subscription.properties.items.anyOf = [{ type: 'object' }];
  expect(() => validateStripeSubscriptionPeriodContract(POLICY, before, changed)).toThrow(
    /does not match/,
  );
});

it.each([
  application.replace(
    'const event = stripe.webhooks.constructEvent(body, signature, secret);',
    'const event = JSON.parse(body);',
  ),
  application.replace('stripe.webhooks.constructEvent(', 'stripe.webhooks?.constructEvent('),
  application.replace(
    'const subscription = event.data.object;',
    'const subscription = event.data.object; subscription.current_period_end = 0;',
  ),
  application.replaceAll('subscription', 'items'),
])('keeps unsupported or mutated handlers under review', (source) => {
  const result = analyze(source);
  expect(result.edits).toEqual([]);
  expect(result.findings.some((finding) => finding.webhook?.migration)).toBe(false);
});

it.each([
  application.replace(
    'export class MissingSubscriptionPeriodError extends Error {}',
    'export class MissingSubscriptionPeriodError extends Error { constructor(message) { super(message); } }',
  ),
  application.replace(
    'startsAt: subscription.current_period_start,',
    'startsAt: transform(subscription.current_period_start),',
  ),
  application.replace(
    'const subscription = event.data.object;',
    'const subscription = event.data.object; mutate(subscription);',
  ),
  application.replace(
    'export function handleWebhook(body, signature, secret)',
    'export function handleWebhook(body, signature, secret, Reflect)',
  ),
  `const refitSubscriptionPeriod = 'occupied';\n${application}`,
])(
  'reads periods through the helper with the configured price item where the policy handler does not apply',
  (source) => {
    const result = analyze(source);
    expect(result.edits.every((edit) => edit.rule === 'stripe-subscription-periods-helper')).toBe(
      true,
    );
    expect(result.findings.length).toBeGreaterThan(0);
    expect(
      result.findings.every(
        (finding) =>
          finding.webhook?.migration?.rule === 'stripe-subscription-periods-helper' &&
          finding.subscriptionPeriod?.rareCase === 'price-policy',
      ),
    ).toBe(true);
    const patched = applySourceEdits(
      source,
      result.edits.filter((edit) => edit.file === 'entitlements.js'),
    );
    expect(patched).toContain(
      `getSubscriptionPeriodEnd(subscription, (items) => items.find((item) => item.price?.id === "${POLICY.priceId}"))`,
    );
  },
);

async function scenario(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-period-policy-'));
  roots.push(root);
  const repository = join(root, 'application');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  await writeFile(join(repository, '.gitignore'), 'node_modules/\n');
  await execute(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `stripe@${version}`],
    { cwd: repository, timeout: PROCESS_TIMEOUT_MS },
  );
  const git = (args: string[]) =>
    execute('git', ['-C', repository, '-c', 'commit.gpgsign=false', ...args]);
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-m',
    'test: seed unchanged webhook application',
  ]);
  const options = {
    repository,
    before: join(FIXTURE, 'before.json'),
    after: join(FIXTURE, 'after.json'),
    providerConfig: join(FIXTURE, 'provider-price-policy.json'),
    apiVersion: POLICY.beforeApiVersion,
    apiVersionPolicy: 'source-verified' as const,
  };
  return { root, repository, options, git };
}

it.skipIf(!process.env.REFIT_STRIPE_SDK).each(['17.7.0', '19.1.0'])(
  'preserves historical events and rejects ambiguous item periods with actual Stripe %s over HTTP',
  async (version) => {
    const sample = await scenario(version);
    const harness = join(FIXTURE, 'contract.mjs');
    await expect(
      execute(process.execPath, [harness, sample.repository, 'after']),
    ).rejects.toMatchObject({ code: 1 });
    const fetch = vi.fn(() => {
      throw new Error('Configured policy must not request a model or GitHub.');
    });
    vi.stubGlobal('fetch', fetch);
    const report = await runPipeline({
      ...sample.options,
      proposePatch: true,
      aiPatch: { apiKey: 'unused', model: 'unused' },
      assessment: { apiKey: 'unused', model: 'unused' },
    });
    expect(report.patch).toMatchObject({
      generator: 'deterministic',
      status: 'proposed',
      unresolvedFindings: 0,
    });
    expect(report.assessment.status).toBe('blocked');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(sample.repository, 'entitlements.js'), 'utf8')).toBe(application);
    const migrated = join(sample.root, 'migrated');
    await cp(sample.repository, migrated, { recursive: true });
    const analysis = analyze();
    await writeFile(
      join(migrated, 'entitlements.js'),
      applySourceEdits(application, analysis.edits),
    );
    const result = JSON.parse(
      (await execute(process.execPath, [harness, migrated, 'migrated'])).stdout,
    );
    expect(
      result.deliveries.filter((delivery: { status: number }) => delivery.status === 422),
    ).toHaveLength(14);
    expect(
      result.deliveries.filter((delivery: { status: number }) => delivery.status === 400),
    ).toHaveLength(3);
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
  },
  PROCESS_TIMEOUT_MS,
);

it
  .skipIf(!process.env.REFIT_STRIPE_SDK || !IMAGE || !process.env.REFIT_NPM_PREPARE)
  .each(['passed', 'failed'])(
  'runs the configured policy through the full workflow with %s checks and no AI repair',
  async (checks) => {
    const sample = await scenario('17.7.0');
    const context = join(sample.root, 'checks');
    await mkdir(context);
    await cp(join(FIXTURE, 'contract.mjs'), join(context, 'contract.mjs'));
    const image = `refit-period-policy:${sample.root.split('/').at(-1)!.toLowerCase()}`;
    const baseImage = `${image}-base`;
    await execute('docker', ['image', 'tag', await resolveDockerImage(IMAGE!), baseImage]);
    await writeFile(
      join(context, 'Dockerfile'),
      `FROM ${baseImage}\nCOPY contract.mjs /opt/refit-checks/contract.mjs\n`,
    );
    let built = false;
    try {
      await execute(
        'docker',
        ['build', '--pull=false', '--network=none', '--tag', image, context],
        { timeout: PROCESS_TIMEOUT_MS },
      );
      built = true;
      const fetch = vi.fn(() => {
        throw new Error('Configured policy must not request a model or GitHub.');
      });
      vi.stubGlobal('fetch', fetch);
      const result = await runWorkflow({
        ...sample.options,
        image,
        prepareDependencies: true,
        baselineCommand: ['node', '/opt/refit-checks/contract.mjs', '.', 'regression'],
        command:
          checks === 'passed'
            ? ['node', '/opt/refit-checks/contract.mjs', '.', 'migrated']
            : ['node', '-e', 'process.exit(1)'],
        aiPatch: { apiKey: 'unused', model: 'unused' },
        repairAttempts: 2,
        output: join(sample.root, 'workflow'),
      });
      expect(result.manifest.status).toBe(checks === 'passed' ? 'validated' : 'validation-failed');
      const report = JSON.parse((await readEvidence(result.directory, 'report.json'))!);
      expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
      expect(report.validation).toMatchObject({
        baseline: { status: 'passed' },
        patched: { status: checks },
        repair: { requested: 0 },
      });
      expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
        'entitlements.js',
      ]);
      const review = await readFile(join(result.directory, 'pull-request.md'), 'utf8');
      expect(review).toContain(
        'Selects subscription periods from the single item priced `price_primary`, keyed on the signed event `api_version`.',
      );
      expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
      if (checks === 'passed') {
        const worker = {
          configuration: {
            ...sample.options,
            image,
            prepareDependencies: true,
            fullDiff: false,
            baselineCommand: ['node', '/opt/refit-checks/contract.mjs', '.', 'regression'],
            command: ['node', '/opt/refit-checks/contract.mjs', '.', 'migrated'],
            aiPatch: { apiKey: 'unused', model: 'unused' },
            repairAttempts: 2,
          },
          source: { kind: 'file' as const, path: sample.options.after },
          stateDirectory: join(sample.root, 'worker'),
        };
        const first = await watchOnce(worker);
        expect(first.status).toBe('processed');
        if (first.status === 'processed') expect(first.result.manifest.status).toBe('validated');
        expect((await watchOnce(worker)).status).toBe('already-processed');
      }
      expect(fetch).not.toHaveBeenCalled();
      expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
    } finally {
      if (built) await execute('docker', ['image', 'rm', image], { timeout: PROCESS_TIMEOUT_MS });
      await execute('docker', ['image', 'rm', baseImage], { timeout: PROCESS_TIMEOUT_MS });
    }
  },
  180_000,
);

it.skipIf(!process.env.REFIT_STRIPE_SDK)(
  'typechecks the original and migrated TypeScript application with the historical Stripe SDK',
  async () => {
    const sample = await scenario('17.7.0');
    await execute(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-dev',
        '--save-exact',
        'typescript@5.9.3',
        '@types/node@22.15.30',
      ],
      { cwd: sample.repository, timeout: PROCESS_TIMEOUT_MS },
    );
    const typedApplication = application.replace(
      'handleWebhook(body, signature, secret)',
      'handleWebhook(body: Buffer | string, signature: string, secret: string)',
    );
    await rm(join(sample.repository, 'client.js'));
    await rm(join(sample.repository, 'entitlements.js'));
    await writeFile(join(sample.repository, 'client.ts'), client);
    await writeFile(join(sample.repository, 'entitlements.ts'), typedApplication);
    await writeFile(
      join(sample.repository, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'build',
          skipLibCheck: true,
        },
        include: ['*.ts'],
      }),
    );
    const compile = () =>
      execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
        cwd: sample.repository,
        timeout: PROCESS_TIMEOUT_MS,
      });
    await compile();
    const harness = join(FIXTURE, 'contract.mjs');
    await execute(process.execPath, [harness, join(sample.repository, 'build'), 'before']);
    await expect(
      execute(process.execPath, [harness, join(sample.repository, 'build'), 'after']),
    ).rejects.toMatchObject({ code: 1 });
    const report = await runPipeline({ ...sample.options, proposePatch: true });
    expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
    const sources = {
      root: sample.repository,
      files: [
        { path: 'client.ts', content: client },
        { path: 'entitlements.ts', content: typedApplication },
      ],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    };
    const result = analyzeRepository(sources, changes, provider, before.components.schemas);
    expect(result.edits).toHaveLength(1);
    await writeFile(
      join(sample.repository, 'entitlements.ts'),
      applySourceEdits(typedApplication, result.edits),
    );
    await compile();
    const migrated = JSON.parse(
      (await execute(process.execPath, [harness, join(sample.repository, 'build'), 'migrated']))
        .stdout,
    );
    expect(migrated.simulated).toBe(true);
  },
  PROCESS_TIMEOUT_MS,
);

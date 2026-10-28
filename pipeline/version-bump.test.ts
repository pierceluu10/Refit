import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publishDraft } from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { repositoryOutcome } from './stripe-benchmark-score.ts';
import { stripePackageUpgrade } from './stripe-package-upgrade.ts';
import { validateMigration } from './validation.ts';
import { NO_USAGE_REASON, runWorkflow, versionBumpBlock } from './workflow.ts';

vi.mock('./stripe-package-upgrade.ts', async (original) => ({
  ...(await original<typeof import('./stripe-package-upgrade.ts')>()),
  stripePackageUpgrade: vi.fn(),
}));
vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
vi.mock('./publication.ts', async (original) => ({
  ...(await original<typeof import('./publication.ts')>()),
  publishDraft: vi.fn(),
}));
// The workflow's scan with a stand-in full contract diff, so no oasdiff binary is needed.
vi.mock('./run.ts', async (original) => {
  const actual = await original<typeof import('./run.ts')>();
  return { ...actual, runPipeline: vi.fn(actual.runPipeline) };
});

const BEFORE = '2026-08-26.dahlia';
const TARGET = '2026-09-30.endive';
const MANIFEST = '{"dependencies":{"stripe":"22.6.2"}}\n';
const UPGRADED = '{"dependencies":{"stripe":"23.0.0"}}\n';
const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const contract = (version: string, fields: string[]) => ({
  openapi: '3.0.0',
  info: { version },
  paths: {
    '/v1/checkout/sessions': {
      post: {
        operationId: 'PostCheckoutSessions',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: Object.fromEntries(fields.map((name) => [name, {}])),
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
  },
});

const provider = (operationId?: string) => ({
  id: 'stripe-checkout',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      ...(operationId ? { operationId } : {}),
    },
  ],
});

const client = (version: string) =>
  `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: ${version} });\nexport const pay = () => stripe.checkout.sessions.create({ mode: 'payment' });\n`;

async function fixture(
  files: Record<string, string> = { 'lib/stripe.ts': client(`'${BEFORE}'`) },
  operationId: string | undefined = 'PostCheckoutSessions',
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-version-bump-'));
  roots.push(root);
  const repository = join(root, 'repository');
  for (const [path, content] of Object.entries({ 'package.json': MANIFEST, ...files })) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  // The target removes a request field the code never sends.
  await writeFile(
    join(root, 'before.json'),
    JSON.stringify(contract(BEFORE, ['mode', 'payment_method_types'])),
  );
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(TARGET, ['mode'])));
  await writeFile(join(root, 'provider.json'), JSON.stringify(provider(operationId)));
  return {
    repository,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: BEFORE,
    output: join(root, 'run'),
  };
}

type Inputs = Awaited<ReturnType<typeof fixture>>;
type Scan = Awaited<ReturnType<typeof runPipeline>>;
const UNUSED = { id: 'request-property-removed', level: 2, reach: 'unused' };

// A full-diff scan as oasdiff would leave it: these changes, each with its reach.
const withDiff = (scan: Scan, changes: Record<string, unknown>[] = [UNUSED]) =>
  ({ ...scan, specificationDiff: { engine: 'oasdiff', changes } }) as unknown as Scan;

const scan = (inputs: Inputs, versionBump = false) =>
  runPipeline({ ...inputs, proposePatch: true, leaveReviewedFindings: true, versionBump });

function upgrades() {
  vi.mocked(stripePackageUpgrade).mockResolvedValue({
    upgrade: {
      from: '22.6.2',
      to: '23.0.0',
      files: [{ path: 'package.json', before: MANIFEST, after: UPGRADED }],
    },
  });
}

// The scan with passing checks, as validation reports them; no Docker ran.
function passed(report: Scan, status = 'passed') {
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  const ran = { status, exitCode: status === 'passed' ? 0 : 1, stdout: '', stderr: '' };
  return {
    ...report,
    patch: { ...report.patch, validation: status },
    publicationFiles: [{ path: 'package.json', mode: '100644', content: UPGRADED }],
    validation: {
      status,
      revision: 'a'.repeat(40),
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      patchHash: digest(report.patch.diff),
      baseline: { ...ran, status: 'passed', exitCode: 0 },
      patched: ran,
    },
  } as unknown as Awaited<ReturnType<typeof validateMigration>>;
}

it('allows a bump only when every Stripe call is traced, mapped and unaffected', async () => {
  const inputs = await fixture();
  const report = withDiff(await scan(inputs));
  expect(report.findings).toEqual([]);
  expect(await versionBumpBlock(report, inputs.repository)).toBeUndefined();
  expect(
    await versionBumpBlock(
      { ...report, specificationDiff: { engine: 'none' } } as unknown as Scan,
      inputs.repository,
    ),
  ).toBe('The full contract diff did not run, so the contract cannot show the code is unaffected.');
  for (const reach of ['reached', 'unknown', undefined])
    expect(
      await versionBumpBlock(withDiff(report, [UNUSED, { level: 2, reach }]), inputs.repository),
    ).toBe('1 breaking contract change is reached by traced code or of unknown reach.');
  // Additive changes (level 1) never block.
  expect(
    await versionBumpBlock(withDiff(report, [{ level: 1, reach: 'reached' }]), inputs.repository),
  ).toBeUndefined();
  const finding = { file: 'lib/stripe.ts', line: 3, confidence: 'review' };
  expect(
    await versionBumpBlock(
      { ...report, findings: [finding] } as unknown as Scan,
      inputs.repository,
    ),
  ).toBe('Refit found 1 usage to review.');
});

it('does not need a contract operation for a webhook signature check', async () => {
  const inputs = await fixture({
    'lib/stripe.ts': client(`'${BEFORE}'`),
    'app/webhook.ts':
      "import { stripe } from '../lib/stripe';\nexport const POST = (body: string, signature: string) => stripe.webhooks.constructEvent(body, signature, 'whsec');\n",
  });
  const report = withDiff(await scan(inputs));
  expect(report.sdkCalls.map((call) => `${call.resource}.${call.method}`).sort()).toEqual([
    'checkout.sessions.create',
    'webhooks.constructEvent',
  ]);
  expect(await versionBumpBlock(report, inputs.repository)).toBeUndefined();
});

it('refuses a bump when a call is untraced, unmapped or a file or version is unknown', async () => {
  const untraced = await fixture({
    'lib/stripe.ts': client(`'${BEFORE}'`),
    'lib/customers.ts':
      "import type Stripe from 'stripe';\nexport const add = (stripe: Stripe) => stripe.customers.create({});\n",
  });
  expect(await versionBumpBlock(withDiff(await scan(untraced)), untraced.repository)).toBe(
    '1 of 2 detected Stripe calls is untraced and might use something the version changed.',
  );

  const unmapped = await fixture(undefined, '');
  expect(await versionBumpBlock(withDiff(await scan(unmapped)), unmapped.repository)).toBe(
    '1 traced Stripe call is not mapped to a contract operation, so the contract diff cannot check it: checkout.sessions.create.',
  );

  const dynamic = await fixture({ 'lib/stripe.ts': client('process.env.STRIPE_VERSION!') });
  expect(await versionBumpBlock(withDiff(await scan(dynamic)), dynamic.repository)).toBe(
    'Refit cannot resolve the API version set at lib/stripe.ts:2.',
  );

  const broken = await fixture({
    'lib/stripe.ts': client(`'${BEFORE}'`),
    'lib/broken.ts': 'export const = ;\n',
  });
  expect(await versionBumpBlock(withDiff(await scan(broken)), broken.repository)).toBe(
    'The scan skipped files, so it cannot show the code is unaffected.',
  );
});

it('moves the pin only together with the stripe-node upgrade', async () => {
  const inputs = await fixture();
  expect((await scan(inputs)).patch.status).not.toBe('proposed');
  expect(stripePackageUpgrade).not.toHaveBeenCalled();

  upgrades();
  const { patch } = await scan(inputs, true);
  if (!('versionBump' in patch)) throw new Error(`Expected a version bump: ${patch.status}`);
  expect(patch).toMatchObject({
    generator: 'deterministic',
    status: 'proposed',
    unresolvedFindings: 0,
    sdkUpgrade: { from: '22.6.2', to: '23.0.0' },
  });
  expect(patch.diff).toContain(
    `-export const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '${BEFORE}' });`,
  );
  expect(patch.diff).toContain(
    `+export const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '${TARGET}' });`,
  );
  expect(patch.diff).toContain('+{"dependencies":{"stripe":"23.0.0"}}');

  vi.mocked(stripePackageUpgrade).mockResolvedValue({ reason: 'The lockfile is not supported.' });
  expect((await scan(inputs, true)).patch).toEqual({
    status: 'not-generated',
    reason:
      'The version bump moves the pin only together with stripe-node, which cannot be upgraded: The lockfile is not supported.',
  });
});

it('writes a bump pull request that names every traced call and the webhook check', async () => {
  upgrades();
  const report = passed(await scan(await fixture(), true));
  const { manifest, files } = createReviewArtifacts(report, 'github');
  expect(manifest.title).toBe(`fix(stripe): upgrade Stripe API to ${TARGET}`);
  const body = files['pull-request.md'];
  expect(body).toContain(
    `Refit traced 1 Stripe call in this code, and none uses anything Stripe API ${TARGET} changes. This patch moves every \`apiVersion\` pin to ${TARGET} and upgrades \`stripe\` from \`22.6.2\` to \`23.0.0\` in the package manifest and lockfile. The checks passed before and after the change.`,
  );
  expect(body).toContain(
    '## Traced Stripe Calls\n\n- `lib/stripe.ts:3` `checkout.sessions.create`',
  );
  expect(body).toContain(
    "- [ ] Check each webhook endpoint's API version in the Stripe Dashboard (Developers > Webhooks). Endpoints have their own version, which this pull request does not change.",
  );
});

it('ends a checked bump as version-bump and an unchecked one as the honest stop', async () => {
  const inputs = await fixture();
  const actual = (await vi.importActual<typeof import('./run.ts')>('./run.ts')).runPipeline;
  vi.mocked(runPipeline).mockImplementation(async (options) => withDiff(await actual(options)));
  upgrades();
  const bump = await actual({ ...inputs, proposePatch: true, versionBump: true });
  vi.mocked(validateMigration).mockResolvedValueOnce(passed(bump));
  const checked = await runWorkflow({
    ...inputs,
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    allowUnresolved: true,
  });
  expect(checked.manifest).toMatchObject({ status: 'version-bump', stage: 'validation' });
  // An evidence grade of D keeps the draft's [Needs review] title, not the outcome.
  const graded = passed(bump);
  Object.assign(graded.validation, {
    grade: {
      letter: 'D',
      level: 'none',
      reason: 'The patch changes no source file a check could reach.',
    },
  });
  vi.mocked(validateMigration).mockResolvedValueOnce(graded);
  const ungraded = await runWorkflow({
    ...inputs,
    output: `${inputs.output}-graded`,
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    allowUnresolved: true,
  });
  expect(ungraded.manifest).toMatchObject({ status: 'version-bump' });
  expect(ungraded.manifest.reason).toContain('its draft is [Needs review] for its evidence');
  expect(vi.mocked(validateMigration).mock.calls[0][0]).toMatchObject({ versionBump: true });

  vi.mocked(validateMigration).mockResolvedValueOnce(passed(bump, 'regression'));
  const failed = await runWorkflow({
    ...inputs,
    output: `${inputs.output}-failed`,
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
  });
  expect(failed.manifest.status).toBe('needs-review');
  expect(failed.manifest.reason).toMatch(new RegExp(`^${NO_USAGE_REASON.replace(/\./g, '\\.')}`));
  expect(failed.manifest.reason).toMatch(
    /nothing was published\. Validation returned regression\.$/,
  );
  // Only the retry without the move would run for a migration; a bump has nothing to retry.
  expect(validateMigration).toHaveBeenCalledTimes(3);
  expect(publishDraft).not.toHaveBeenCalled();
  expect(await readFile(join(`${inputs.output}-failed`, 'manifest.json'), 'utf8')).toContain(
    '"status": "needs-review"',
  );
});

it('scores a bump correct only on a repository with nothing breaking', () => {
  const workflow = { status: 'version-bump', patch: 'proposed' } as never;
  expect(
    repositoryOutcome({ verdict: 'unaffected', reads: [], requests: [] } as never, [], workflow),
  ).toEqual({ outcome: 'correct', reason: 'version bump' });
  expect(
    repositoryOutcome({ verdict: 'affected', reads: [], requests: [] } as never, [], workflow),
  ).toEqual({ outcome: 'incorrect', reason: 'version bump on a repository with breaking usage' });
});

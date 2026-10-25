import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { unresolvedSites } from './migration-review.ts';
import { createReviewArtifacts, writeReviewBundle } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';

const directories: string[] = [];
type Report = Awaited<ReturnType<typeof validateMigration>>;

async function report(): Promise<Report> {
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/repository'),
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  return {
    ...scan,
    publicationFiles: [{ path: 'src/billing/history.ts', mode: '100644', content: 'export {};' }],
    patch: { ...scan.patch, validation: 'regression' },
    validation: {
      status: 'regression',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      runtime: {
        configured: 'node:22-alpine',
        image: 'node:22-alpine',
        nodeVersion: '22.23.3',
        declarations: [],
        reason: 'The repository declares no Node.js version.',
      },
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: { status: 'failed', exitCode: 1, stdout: '', stderr: 'expected charge history' },
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for artifact formatting tests.',
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('accepts a compared typecheck that exits nonzero on errors that predate the patch', async () => {
  const base = await report();
  const passed: Report = {
    ...base,
    patch: { ...base.patch, validation: 'passed' },
    validation: {
      ...base.validation,
      status: 'passed',
      baseline: { status: 'passed', exitCode: 2, stdout: 'a.ts(1,1): error TS7006: x', stderr: '' },
      patched: { status: 'passed', exitCode: 2, stdout: 'a.ts(1,1): error TS7006: x', stderr: '' },
    },
  };
  expect(() => createReviewArtifacts(passed)).toThrow('two successful check results');
  const compared = { ...passed, validation: { ...passed.validation, compareTypeErrors: true } };
  expect(createReviewArtifacts(compared).files['pull-request.md']).toContain('passed');
});

it('exports regression evidence without implying that checks passed or a PR exists', async () => {
  const artifacts = createReviewArtifacts(await report());
  expect(artifacts.files['pull-request.md']).toContain('Validation did not pass (regression)');
  expect(artifacts.files['pull-request.md']).toContain('has not pushed a branch');
  expect(artifacts.manifest).toMatchObject({
    published: false,
    reviewRequired: true,
    validationStatus: 'regression',
  });
  expect(JSON.parse(artifacts.files['report.json']).validation.patched.stderr).toBe(
    'expected charge history',
  );
});

it('follows the PR template: its sections, single-sentence bullets and no emoji', async () => {
  const value = await report();
  value.changes.unshift({
    id: 'unrelated',
    schema: 'invoice',
    property: 'subscription',
    pointer: '/components/schemas/invoice/properties/subscription',
  });
  const { files, manifest } = createReviewArtifacts(value);
  const body = files['pull-request.md'];
  expect(manifest.title).toBe('fix(stripe): restore payment history after charges removal');
  expect(manifest.title.length).toBeLessThanOrEqual(70);
  expect(body.split('\n').filter((entry) => entry.startsWith('## '))).toEqual([
    '## Overview',
    '## API Impact & Spec Changes',
    '## Key Changes',
    '## Code Changes',
    '## Automated Verification Gates',
    '## Not Verified',
    '## Rollback',
    '## Reviewer Checklist',
    '## Related Telemetry',
  ]);
  expect(body).toContain('A deterministic Refit rule migrates');
  expect(body).toContain('- Revert this pull request. It changes 1 file');
  expect(body).toContain(
    '- [ ] Read each change under Code Changes against the provider page linked in Overview.',
  );
  expect(body).toContain('Stripe documents the change: [docs.stripe.com/api/charges/list]');
  expect(body).toContain('- Refit made no request to Stripe, and the checks did not pass');
  expect(body).toContain('- Breaking Changes: Removes response fields `payment_intent.charges`');
  expect(body).toContain('- `billing.ts`: Migrates reads of `payment_intent.charges`');
  expect(body).toContain('- Test Suite Output: **Validation did not pass (regression).**');
  expect(body).toContain('- Security Scans: Not run.');
  expect(body).toContain('`billing.ts:7` in `chargeHistory()`');
  expect(body).toContain('```diff');
  expect(body).not.toContain('invoice.subscription');
  expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
});

async function renameReport(evidence?: Record<string, unknown>): Promise<Report> {
  const root = await mkdtemp(join(tmpdir(), 'refit-review-rename-'));
  directories.push(root);
  const contract = (property: string, version: string) => ({
    openapi: '3.0.3',
    info: { title: 'Simulated OpenAI contract', version },
    paths: {
      '/models/{model}': {
        get: {
          responses: {
            '200': {
              description: 'Model',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Model' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Model: {
          type: 'object',
          required: ['id', property],
          properties: { id: { type: 'string' }, [property]: { type: 'string' } },
        },
      },
    },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract('owned_by', '2.3.0')));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract('owner_name', '2.4.0')));
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/openai/repository'),
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: resolve('pipeline/fixtures/openai/provider-renames.json'),
    apiVersion: '2.3.0',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  const passed = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const value = {
    ...scan,
    publicationFiles: [{ path: 'models.js', mode: '100644', content: '' }],
    patch: { ...scan.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      runtime: {
        configured: 'node:22-alpine',
        image: 'node:22-alpine',
        nodeVersion: '22.23.3',
        declarations: [],
        reason: 'The repository declares no Node.js version.',
      },
      command: ['npm', 'run', 'test:after'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: passed,
      patched: passed,
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: true,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for artifact formatting tests.',
    },
  } as Report;
  if (!evidence) return value;
  // Simulates an AI proposal for the same diff, without the configured rename rule.
  return {
    ...value,
    adapter: { ...value.adapter, propertyRenames: undefined },
    patch: { ...value.patch, generator: 'openai', model: 'test-model', evidence },
  } as unknown as Report;
}

function visibleBody(value: Report) {
  return createReviewArtifacts(value, 'github').files['pull-request.md'];
}

it('shows the exact changed lines and the configured rule behind a deterministic rename', async () => {
  const visible = visibleBody(await renameReport());
  expect(visible).toContain('Replaces `Model.owned_by` → `Model.owner_name`.');
  expect(visible).toContain('- `models.js`: Migrates reads of `Model.owned_by`');
  expect(visible).toContain('- Review: An operator-configured rename rule maps `Model.owned_by`');
  expect(visible).toContain('`npm run test:after` on the migrated code in offline Docker.');
});

it('warns when only the name and type support an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [{ schema: 'Model', property: 'owner_name', type: 'string' }],
    }),
  );
  expect(visible).toContain(
    'same type (string). Nothing documents it as the replacement for `owned_by`',
  );
  expect(visible).toContain('AI (`test-model`), checked by Refit, migrates');
});

it('quotes the contract description that documents an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [
        {
          schema: 'Model',
          property: 'owner_name',
          type: 'string',
          description: 'Replaces owned_by. Values are unchanged.',
        },
      ],
    }),
  );
  expect(visible).toContain(
    'The after contract documents `owner_name` as the replacement: “Replaces owned\\_by. Values are unchanged.”',
  );
  expect(visible).not.toContain('⚠️');
});

it('quotes the vendor note sentence that explains an AI replacement', async () => {
  const visible = visibleBody(
    await renameReport({
      addedProperties: [{ schema: 'Model', property: 'owner_name', type: 'string' }],
      documentation: [
        {
          label: 'Changelog',
          url: 'https://docs.example.com/changelog',
          content:
            'API 2.4.0 ships today.\nModel.owned_by was renamed to Model.owner_name. Values are unchanged.',
        },
      ],
    }),
  );
  expect(visible).toContain(
    'The attached vendor note (Changelog, https://docs.example.com/changelog) says “Model.owned\\_by was renamed to Model.owner\\_name.”',
  );
  expect(visible).not.toContain('⚠️');
});

it('refuses inconsistent patch evidence and false passing status', async () => {
  const value = await report();
  value.validation.patchHash = 'wrong';
  expect(() => createReviewArtifacts(value)).toThrow(/consistent patch/);
  value.validation.patchHash = digest(value.patch.diff);
  value.patch.validation = value.validation.status = 'passed';
  expect(() => createReviewArtifacts(value)).toThrow(/two successful/);
});

it('keeps Markdown from repository file names out of the PR text structure', async () => {
  const value = await report();
  value.findings[0].file = '```\n# forged heading';
  value.findings[0].untraced = true;
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('````` # forged heading');
  expect(body).not.toContain('\n# forged heading');
});

it('creates a private bundle and refuses to replace any existing bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-review-test-'));
  directories.push(root);
  const destination = join(root, 'review');
  const value = await report();
  await writeReviewBundle(destination, value);
  const original = await readFile(join(destination, 'report.json'), 'utf8');
  await expect(writeReviewBundle(destination, value)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(destination, 'report.json'), 'utf8')).toBe(original);
  if (process.platform !== 'win32') {
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, 'report.json'))).mode & 0o777).toBe(0o600);
  }
});

it('says when the open-enum repair restored widened Stripe enum values', async () => {
  const value = await report();
  const plain = createReviewArtifacts(value).files['pull-request.md'];
  expect(plain).not.toContain('OtherString');
  value.validation.repair.stopReason = 'open-enum-repair';
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    'Restores the known values of the Stripe enums that stripe-node 22.4.0 widened with `OtherString`',
  );
  // A restore of part of the errors, before an AI repair fixed the rest, is disclosed too.
  value.validation.repair.stopReason = 'checks-passed';
  value.validation.repair.openEnumRestored = true;
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    'Restores the known values of the Stripe enums that stripe-node 22.4.0 widened with `OtherString`',
  );
});

it('marks a draft that keeps sending an untyped request property for review', async () => {
  const value = await report();
  value.validation.repair.stopReason = 'open-enum-repair';
  value.validation.repair.keptProperties = ['trial_from_plan'];
  value.validation.repair.enumsUnchanged = true;
  const artifacts = createReviewArtifacts(value);
  expect(artifacts.manifest.title).toMatch(/^\[Needs review\] /);
  const body = artifacts.files['pull-request.md'];
  expect(body).toContain('**Keeps sending `subscription_data.trial_from_plan` unchanged.**');
  expect(body).toContain('`subscription_data.trial_period_days`');
  expect(body).toContain('(https://docs.stripe.com/api/checkout/sessions/create)');
  // Only the property was kept, so nothing claims an enum restore.
  expect(body).not.toContain('OtherString');
});

it('marks a draft with an untraced read for review and keeps it out of the confirmed count', async () => {
  const value = await report();
  value.findings.push({
    ...value.findings[0],
    file: 'legacy.ts',
    confidence: 'review',
    untraced: true,
  });
  value.patch.unresolvedFindings = 1;
  const artifacts = createReviewArtifacts(value);
  expect(artifacts.manifest.title).toMatch(/^\[Needs review\] /);
  const body = artifacts.files['pull-request.md'];
  expect(body).toContain(
    '0 usages of the breaking changes remain, plus 1 untraced read of removed field names.',
  );
  expect(body).toContain(
    "## Usages left for you\n\n**Don't merge until you have migrated or checked each usage Refit left.** Refit could not trace 1 read of removed field names to a Stripe object, so it left it unchanged; it is listed under Left Unchanged.\n\n## Overview",
  );
  expect(body).not.toContain('still unmigrated');
});

it('says when npm installed the committed lockfile with --legacy-peer-deps', async () => {
  const value = await report();
  expect(createReviewArtifacts(value).files['pull-request.md']).not.toContain('legacy-peer-deps');
  value.validation.environment = { installation: { legacyPeerDeps: true } };
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    "- Dependency Installation: `npm ci` rejected the committed lockfile's peer dependencies (ERESOLVE), so Refit installed the same lockfile with `--legacy-peer-deps`.",
  );
});

it('says how many glibc-only packages Refit removed after the verified npm install', async () => {
  const value = await report();
  expect(createReviewArtifacts(value).files['pull-request.md']).not.toContain('glibc');
  // The patched lockfile's install can prune more than the baseline's; the larger count is stated.
  value.validation.environment = { installation: { prunedGlibcPackages: 3 } };
  value.validation.patchedEnvironment = { installation: { prunedGlibcPackages: 4 } };
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    '- Dependency Installation: after the verified `npm ci`, Refit removed 4 installed native packages declared for glibc only, which cannot load on the Alpine (musl) image. The lockfile is unchanged.',
  );
});

it('counts only generated stripe-mock entries that ran on the original code', async () => {
  const value = await report();
  const entry = { file: 'src/billing/history.ts', name: 'history', parameters: 0 };
  const hashes = { contract: 'd'.repeat(64), fixtures: 'e'.repeat(64) };
  const generated = (notRunnable: { id: string; error: string }[]) => ({
    engine: 'stripe-mock' as const,
    image: `sha256:${'f'.repeat(64)}`,
    binaryHash: 'f'.repeat(64),
    inputs: { before: hashes, after: hashes },
    claim: 'Synthetic generated checks.',
    entryPoints: [entry, { ...entry, name: 'refund' }],
    uncoveredFindings: 0,
    notRunnable,
    regressions: [],
    baseline: { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' },
    patched: { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' },
  });
  const body = (notRunnable: { id: string; error: string }[]) =>
    createReviewArtifacts({
      ...value,
      validation: { ...value.validation, generated: generated(notRunnable) },
    }).files['pull-request.md'];
  const missing = { id: 'src/billing/history.ts#history', error: 'Cannot find module' };
  expect(body([missing, { ...missing, id: 'src/billing/history.ts#refund' }])).toContain(
    'Generated stripe-mock checks could not run any of 2 exported functions on their own.',
  );
  expect(body([missing])).toContain(
    'Generated stripe-mock checks passed on 1 of 2 exported functions.',
  );
});

it('lists each usage the migrated code still has, counts a site once and names the failing side', async () => {
  const value = await report();
  const [finding] = value.findings;
  const untraced = { ...finding, file: 'legacy.ts', line: 7, expression: 'item.price' };
  // One expression that reads two removed fields, as afdon/music-app's `.price` does.
  value.findings.push(
    { ...untraced, changeId: 'invoiceitem-price', confidence: 'review', untraced: true },
    { ...untraced, changeId: 'line-item-price', confidence: 'review', untraced: true },
  );
  if (!('diff' in value.patch)) throw new Error('Expected fixture patch');
  value.patch.unresolvedFindings = 3;
  value.patch.unresolvedSites = unresolvedSites([
    { ...finding, line: 14 },
    { ...untraced, changeId: 'invoiceitem-price', confidence: 'review', untraced: true },
    { ...untraced, changeId: 'line-item-price', confidence: 'review', untraced: true },
  ]);
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('A deterministic Refit rule migrates 0 of 1 confirmed usage in 1 file');
  expect(body).toContain(
    "**Don't merge until you have migrated or checked each usage Refit left.** 1 usage of the breaking changes is still unmigrated: no rule changed it. It is listed under Left Unchanged. Refit could not trace 1 read",
  );
  expect(body).not.toContain('The checks passed without');
  expect(body).toContain(
    'Migrate each one before merging:\n\n- `billing.ts:14` reads `.charges` (`payment_intent.charges`)\n\nRefit could not trace',
  );
  // The two findings at legacy.ts:7 are one site everywhere the body counts them.
  expect(body).toContain('Refit could not trace 1 read of removed field names');
  expect(body).toContain('1 usage of the breaking changes remains, plus 1 untraced read of');
  expect(body).toContain('- 1 untraced read was left unchanged; see Left Unchanged.');
  expect(body).toContain(
    '- Evidence Strength: **None.** The checks did not pass, so nothing in this patch is verified.\n- Test Suite Output: **Validation did not pass (regression).** `npm test` failed on the migrated code with exit code 1.',
  );
  expect(body).toContain('- [ ] Migrate the 1 usage Refit left unmigrated (see Left Unchanged).');
});

it('lists untraced reads at their migrated lines and leaves operation calls with no site to the run report', async () => {
  const value = await report();
  const [finding] = value.findings;
  const untraced = {
    ...finding,
    file: 'legacy.ts',
    line: 7,
    expression: 'item.price',
    confidence: 'review' as const,
    untraced: true as const,
  };
  value.findings.push(untraced);
  if (!('diff' in value.patch)) throw new Error('Expected fixture patch');
  // The patch added a line above the untraced read, and one changed-operation call has no site.
  value.patch.unresolvedFindings = 3;
  value.patch.unresolvedSites = unresolvedSites([
    { ...finding, line: 14 },
    { ...untraced, line: 8 },
  ]);
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('- `legacy.ts:8` reads `item.price`');
  expect(body).not.toContain('legacy.ts:7');
  expect(body).toContain(
    '2 usages of the breaking changes are still unmigrated: no rule changed them',
  );
  expect(body).toContain(
    "1 is listed under Left Unchanged; the other 1 (a call to a changed operation) is in Refit's run report.",
  );
  expect(body).not.toContain('less certainty');
});

it('counts a traced site with two removed fields once and says how many of those left are confirmed', async () => {
  const value = await report();
  const [finding] = value.findings;
  const [change] = value.changes;
  // brunobola-portfolio/GitHub-Repo-Manager's `.price` resolves to an invoice item and a line item,
  // both traced with review confidence.
  value.changes.push(
    { ...change, id: 'invoiceitem-price', schema: 'invoiceitem', property: 'price' },
    { ...change, id: 'line-item-price', schema: 'line_item', property: 'price' },
  );
  const price = { ...finding, line: 29, expression: '.price', confidence: 'review' as const };
  if (!('diff' in value.patch)) throw new Error('Expected fixture patch');
  value.patch.unresolvedFindings = 3;
  value.patch.unresolvedSites = unresolvedSites([
    { ...finding, line: 14 },
    { ...price, changeId: 'invoiceitem-price' },
    { ...price, changeId: 'line-item-price' },
  ]);
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain(
    '2 usages of the breaking changes (1 confirmed, 1 traced with less certainty) are still unmigrated: no rule changed them.',
  );
  expect(body).toContain(
    '- `billing.ts:14` reads `.charges` (`payment_intent.charges`)\n- `billing.ts:29` reads `.price` (`invoiceitem.price` or `line_item.price`)\n',
  );
  expect(body).toContain('- 2 usages are still unmigrated.');
  expect(body).toContain('- [ ] Migrate the 2 usages Refit left unmigrated (see Left Unchanged).');
  // A field-move rule's page is cited in the Overview and with the file it edits.
  const url =
    'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end';
  Object.assign(value.patch, { sources: [{ url, files: ['billing.ts'] }] });
  const cited = createReviewArtifacts(value).files['pull-request.md'];
  const page = `[${url.slice('https://'.length)}](${url})`;
  expect(cited).toMatch(
    new RegExp(
      `^Stripe API .* Stripe documents the change: .*${page.replace(/[[\]().]/g, '\\$&')}`,
      'm',
    ),
  );
  expect(cited.split('\n').find((line) => line.startsWith('- `billing.ts`: '))).toContain(
    `Stripe documents it: ${page}.`,
  );
  // A request rule's page in a file that also moves the pin cites the request change, not the pin.
  const move = 'https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-request-move';
  value.apiVersion = { ...value.apiVersion, application: '2022-08-01', after: '2025-03-31.basil' };
  value.patch.diff += [
    'diff --git a/client.ts b/client.ts',
    '--- a/client.ts',
    '+++ b/client.ts',
    '@@ -1 +1 @@',
    "-export const stripe = new Stripe(key, { apiVersion: '2022-08-01' });",
    "+export const stripe = new Stripe(key, { apiVersion: '2025-03-31.basil' });",
    '',
  ].join('\n');
  value.validation.patchHash = digest(value.patch.diff);
  Object.assign(value.patch, { sources: [{ url: move, files: ['client.ts'] }] });
  const client = createReviewArtifacts(value)
    .files['pull-request.md'].split('\n')
    .find((line) => line.startsWith('- `client.ts`: '));
  expect(client).toBe(
    `- \`client.ts\`: Updates Stripe requests for the new contract. Stripe documents it: [${move.slice('https://'.length)}](${move}). Moves the pinned API version from \`2022-08-01\` to \`2025-03-31.basil\`.`,
  );
});

it.each([
  [['npx', 'tsc', '--noEmit'], false, '**Type-checked only.** No code ran.'],
  [['npm', 'run', 'typecheck'], false, '**Type-checked only.** No code ran.'],
  [
    ['npx', 'tsc', '--noEmit'],
    true,
    '**Type-checked only.** No code ran except the generated stripe-mock checks below.',
  ],
  [
    ['node', '-e', '0'],
    false,
    '**No meaningful check.** `node -e 0` runs no code and no generated',
  ],
  [['node', '-e', '0'], true, '**Generated checks only.** `node -e 0` runs no code;'],
  [['pnpm', 'test'], false, "**The repository's test command.** Refit does not measure"],
  [['npm', 'run', 'lint'], false, '**A configured command.** Refit does not measure'],
])(
  'grades the evidence of a passing %j check, generated checks %s',
  async (command, generated, grade) => {
    const value = await report();
    const check = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
    value.patch.validation = value.validation.status = 'passed';
    value.validation.patched = check;
    value.validation.command = value.validation.baselineCommand = command;
    if (generated)
      value.validation.generated = {
        entryPoints: ['chargeHistory'],
        notRunnable: [],
        baseline: check,
        patched: check,
      } as unknown as NonNullable<Report['validation']['generated']>;
    expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
      `- Evidence Strength: ${grade}`,
    );
  },
);

it('says a check that could not finish on the original code never ran on the migrated code', async () => {
  const value = await report();
  value.patch.validation = value.validation.status = 'error';
  value.validation.baseline = {
    status: 'error',
    exitCode: null,
    stdout: '',
    stderr: '',
    error: 'Check exceeded 120 seconds; the container was stopped.',
  };
  value.validation.patched = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    '- Test Suite Output: **Validation did not pass (error).** `npm test` could not finish on the original code (Check exceeded 120 seconds; the container was stopped). Refit did not run the checks on the migrated code.',
  );
});

it("keeps a check's raw error output out of the body, and names only its exit code", async () => {
  const value = await report();
  value.patch.validation = value.validation.status = 'error';
  value.validation.baseline = {
    status: 'error',
    exitCode: 137,
    stdout: '',
    stderr: 'PRIVATE STDERR',
    error: 'Command failed: docker run --rm /Users/someone/checkout\nPRIVATE STDERR',
  };
  value.validation.patched = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('`npm test` could not finish on the original code (exit code 137).');
  expect(body).not.toContain('PRIVATE');
  expect(body).not.toContain('/Users/someone');
});

it('names the first type error a patch introduced, once, from the compared type check', async () => {
  const value = await report();
  const error =
    "app/api/create-checkout-session/route.ts(39,9): error TS2322: Type '{ trial_from_plan: true; }' is not assignable to type 'SubscriptionData'.";
  value.validation.command = value.validation.baselineCommand = ['npx', 'tsc', '--noEmit'];
  value.validation.compareTypeErrors = true;
  value.validation.patched = {
    status: 'failed',
    exitCode: 2,
    // As afdon/music-app's stored check lists it: the same error twice, then tsc's own output.
    stdout: `Type errors this patch introduced:\n${error}\n${error}\n\n${error}\n`,
    stderr: '',
  };
  expect(createReviewArtifacts(value).files['pull-request.md']).toContain(
    "`npx tsc --noEmit` failed on the migrated code with exit code 2. The patch introduced 1 type error, the first: “app/api/create-checkout-session/route.ts(39,9): error TS2322: Type '\\{ trial\\_from\\_plan: true; \\}' is not assignable to type 'SubscriptionData'.”",
  );
});

it('says an empty patch changes nothing instead of claiming a migration', async () => {
  const value = await report();
  if (!('diff' in value.patch)) throw new Error('Expected fixture patch');
  // As Sanjdcool/ApanStack-Newsletter's unsupported patch reached a failed baseline.
  value.patch.diff = '';
  value.validation.patchHash = digest('');
  value.validation.status = value.patch.validation = 'baseline-failed';
  value.validation.baseline = { status: 'failed', exitCode: 1, stdout: '', stderr: '' };
  value.validation.patched = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain(
    'No Refit rule changes the 1 confirmed usage in 1 file, so this patch changes no files.',
  );
  expect(body).not.toContain('migrates');
});

it('lists breaking contract changes the reach gate let through, with their paths', async () => {
  const value = await report();
  value.specificationDiff = {
    engine: 'oasdiff',
    version: 'oasdiff 1.33.0',
    coverage: 'Full oasdiff changelog.',
    changes: [
      {
        id: 'request-property-removed',
        level: 3,
        operation: 'POST',
        path: '/v1/checkout/sessions',
        text: 'removed the request property `line_items/items/dynamic_tax_rates`',
        reach: 'unused',
        reachReason:
          'No traced `checkout.sessions.create` call sends `line_items/items/dynamic_tax_rates`.',
      },
      {
        id: 'request-property-removed',
        level: 3,
        operation: 'POST',
        path: '/v1/checkout/sessions',
        text: 'removed the request property `payment_method_types`',
        reach: 'reached',
        reachReason: 'The `checkout.sessions.create` call in app/api/stripe/route.ts sends it.',
      },
      {
        id: 'response-property-enum-value-added',
        level: 1,
        operation: 'GET',
        path: '/v1/charges',
        text: 'added the new `x` enum value to the `status` response property',
        reach: 'unused',
        reachReason: 'No code reads `charge.status`.',
      },
    ],
  };
  const body = createReviewArtifacts(value).files['pull-request.md'];
  expect(body).toContain('## Changed, Not Used By Traced Code');
  expect(body).toContain(
    '- `POST /v1/checkout/sessions` removed the request property \\`line\\_items/items/dynamic\\_tax\\_rates\\`: No traced \\`checkout.sessions.create\\` call sends \\`line\\_items/items/dynamic\\_tax\\_rates\\`.',
  );
  // A reached change blocks instead, and a non-breaking change is not listed.
  expect(body).not.toContain('payment\\_method\\_types\\`: The');
  expect(body).not.toContain('/v1/charges');
});

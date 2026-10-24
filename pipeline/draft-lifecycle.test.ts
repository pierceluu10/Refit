import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import {
  findExistingMigration,
  publicationConfiguration,
  publishDraft,
  publishFiles,
} from './publication.ts';
import { INTEGRATION_MARKER, MIGRATION_MARKER, REFIT_VERSION } from './migration-identity.ts';
import { digest } from './specifications.ts';
import { runWorkflow } from './workflow.ts';

// Each draft's whole life against simulated GitHub: real Git objects, branches and pull requests,
// with the App's installation token. No Docker check runs; the evidence is the fixture's.
const execute = promisify(execFile);
const APP_ID = 321;
const REPOSITORY = 'example/application';
const BOT = 'refit-acceptance[bot]';
const isolated = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
let github: FakeGitHub;
let root: string;
let checkout: string;

const git = (directory: string, args: string[]) =>
  execute(
    'git',
    [
      '-C',
      directory,
      '-c',
      'user.name=Customer',
      '-c',
      'user.email=customer@example.test',
      ...args,
    ],
    { env: isolated },
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refit-draft-lifecycle-'));
  github = await startFakeGitHub({ appId: APP_ID, webhookSecret: 'unused-webhook-secret' });
  vi.stubGlobal('fetch', github.fetch);
  checkout = join(root, 'customer');
  await cp(resolve('pipeline/fixtures/repository'), checkout, { recursive: true });
  await git(checkout, ['init', '--quiet', '--initial-branch=main']);
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '--quiet', '-m', 'feat: charge history']);
  await github.publish(REPOSITORY, checkout);
  github.installations.set(654, {
    id: 654,
    login: 'example',
    repositories: [REPOSITORY],
    suspended: false,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await github.close();
  await rm(root, { recursive: true, force: true });
});

const options = (integration?: string) => ({
  ...publicationConfiguration(REPOSITORY, 'main', undefined, github.app),
  ...(integration ? { integration } : {}),
});
async function branchTip(name: string) {
  const tip = await github.branch(REPOSITORY, name);
  if (!tip) throw new Error(`The fake repository has no ${name} branch.`);
  return tip;
}
const main = () => branchTip('main');

// The customer pushes a commit to main, such as the committed .refit.json that preceded the
// full-stack-starter-kit duplicate.
async function pushToMain(file: string, content: string) {
  await writeFile(join(checkout, file), content);
  await git(checkout, ['add', file]);
  await git(checkout, ['commit', '--quiet', '-m', `chore: add ${file}`]);
  return github.publish(REPOSITORY, checkout);
}

async function candidate(comment = '') {
  const report = await validatedReport(await main());
  if (comment)
    report.publicationFiles = report.publicationFiles.map((file) => ({
      ...file,
      content: `// ${comment}\n${file.content}`,
    }));
  return report;
}

const commit = async (sha: string) => {
  const { stdout } = await execute(
    'git',
    ['-C', github.remote(REPOSITORY), 'log', '-1', '--format=%P%n%ae', sha],
    { env: isolated },
  );
  const [parents, author] = stdout.trim().split('\n');
  return { parents: parents.split(' '), author };
};

it('keeps one draft per integration and target version across a rerun, a push to main and a retry', async () => {
  const first = await publishDraft(await candidate(), options());
  expect(first).toMatchObject({ status: 'created', number: 1, draft: true });
  const tip = await branchTip(first.branch);
  expect(await commit(tip)).toEqual({
    parents: [await main()],
    author: `7000+${BOT}@users.noreply.github.com`,
  });

  // A rerun of the same candidate changes nothing.
  expect(await publishDraft(await candidate(), options())).toMatchObject({
    status: 'existing',
    number: 1,
    head: tip,
  });
  expect(await branchTip(first.branch)).toBe(tip);

  // The full-stack-starter-kit duplicate: a config-only commit on main and a patch with different
  // bytes used to open a second draft. Now Refit moves its own commit onto the new base.
  const base = await pushToMain('.refit.json', '{"version":1}\n');
  const moved = await candidate('regenerated');
  moved.validation.command = moved.validation.baselineCommand = ['npm', 'run', 'check'];
  // The committed file changes the repository hash, and with it the run id.
  moved.runId = digest(`${moved.runId}:.refit.json`);
  const second = await publishDraft(moved, options());
  expect(second).toMatchObject({ status: 'updated', number: 1, branch: first.branch });
  const updated = await branchTip(first.branch);
  expect(updated).not.toBe(tip);
  expect((await commit(updated)).parents).toEqual([base]);
  const [pull] = github.pulls(REPOSITORY);
  expect(github.pulls(REPOSITORY)).toHaveLength(1);
  expect(pull).toMatchObject({ state: 'open', draft: true, headSha: updated, baseSha: base });
  expect(pull.body).toContain('`npm run check` passed on the original and migrated code');
  expect(pull.body).not.toContain('`npm test`');

  // A retry after the update is quiet too.
  expect(await publishDraft(moved, options())).toMatchObject({ status: 'existing', number: 1 });
  expect(github.pulls(REPOSITORY)).toHaveLength(1);
  expect(github.comments(REPOSITORY)).toEqual([]);
});

it('keeps drafts on different base branches apart, as the benchmark fork and the hosted worker publish', async () => {
  await github.pushBranch(REPOSITORY, 'refit-base', checkout);
  await pushToMain('.refit.json', '{"version":1}\n');
  const hosted = await publishDraft(await candidate(), options());
  const tip = await branchTip(hosted.branch);
  const benchmark = await publishDraft(await validatedReport(await branchTip('refit-base')), {
    ...options(),
    base: 'refit-base',
  });
  expect(benchmark).toMatchObject({ status: 'created', number: 2 });
  expect(benchmark.branch).not.toBe(hosted.branch);
  expect(await branchTip(hosted.branch)).toBe(tip);
  expect(await publishDraft(await candidate(), options())).toMatchObject({
    status: 'existing',
    number: 1,
  });
  expect(github.comments(REPOSITORY)).toEqual([]);
});

it('finds its own open draft before generation so a rerun spends no validation', async () => {
  const report = await candidate();
  await publishDraft(report, options());
  expect(await findExistingMigration(report, await main(), options())).toMatchObject({
    status: 'existing',
    number: 1,
    validation: 'not-rerun',
  });
});

// As the release before this one would have left the draft's evidence marker.
const writtenEarlier = (body: string) =>
  body.replace(`"refit": "${REFIT_VERSION}"`, '"refit": "0.0.1"');

it('generates a [Needs review] draft an earlier Refit release wrote again and updates it in place', async () => {
  const earlier = await candidate();
  earlier.patch.unresolvedFindings = 1;
  await publishDraft(earlier, { ...options(), allowUnresolved: true });
  const [draft] = github.pulls(REPOSITORY);
  expect(draft.title).toMatch(/^\[Needs review\] /);
  // Written by this release, it is found before generation like any current draft.
  expect(await findExistingMigration(earlier, await main(), options())).toMatchObject({
    status: 'existing',
    number: 1,
  });
  draft.body = writtenEarlier(draft.body);
  expect(await findExistingMigration(earlier, await main(), options())).toBeUndefined();
  // This release migrates what the earlier one left: the same draft, no longer for review.
  const current = await candidate('migrates the usage the earlier release left');
  expect(await publishDraft(current, options())).toMatchObject({ status: 'updated', number: 1 });
  expect(github.pulls(REPOSITORY)).toHaveLength(1);
  expect(github.pulls(REPOSITORY)[0].title).not.toMatch(/Needs review/);
  expect(github.pulls(REPOSITORY)[0].body).toContain(`"refit": "${REFIT_VERSION}"`);
});

it('still finds a draft an earlier release wrote when nothing in it needs review', async () => {
  const report = await candidate();
  await publishDraft(report, options());
  const [draft] = github.pulls(REPOSITORY);
  draft.body = writtenEarlier(draft.body);
  expect(await findExistingMigration(report, await main(), options())).toMatchObject({
    status: 'existing',
    number: 1,
    validation: 'not-rerun',
  });
});

it('leaves a draft branch with commits a person added as it is, even after main moves', async () => {
  const draft = await publishDraft(await candidate(), options());
  const branch = join(root, 'branch');
  await execute(
    'git',
    ['clone', '--quiet', '--branch', draft.branch, github.remote(REPOSITORY), branch],
    {
      env: isolated,
    },
  );
  await writeFile(join(branch, 'billing.ts'), '// reviewed by the customer\n');
  await git(branch, ['commit', '--quiet', '-am', 'fix: keep the reviewed charge history']);
  await github.pushBranch(REPOSITORY, draft.branch, branch);
  const edited = await branchTip(draft.branch);
  const body = github.pulls(REPOSITORY)[0].body;

  await pushToMain('README.md', 'moved\n');
  const report = await candidate('regenerated');
  const expected = {
    status: 'existing',
    number: 1,
    leftUnchanged: 'The draft branch has commits Refit did not write, so Refit left it as it is.',
  };
  expect(await findExistingMigration(report, await main(), options())).toMatchObject({
    ...expected,
    validation: 'not-rerun',
  });
  expect(await publishDraft(report, options())).toMatchObject(expected);
  expect(await branchTip(draft.branch)).toBe(edited);
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'open', body }]);
});

it('never reopens or replaces a draft a person closed, and stays quiet once one is merged', async () => {
  const declined = await publishDraft(await candidate(), options());
  const tip = await branchTip(declined.branch);
  github.closePull(REPOSITORY, declined.number);
  await pushToMain('README.md', 'moved\n');
  const report = await candidate('regenerated');
  expect(await findExistingMigration(report, await main(), options())).toMatchObject({
    status: 'closed',
    number: 1,
    validation: 'not-rerun',
  });
  expect(await publishDraft(report, options())).toMatchObject({ status: 'closed', number: 1 });
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'closed' }]);
  expect(await branchTip(declined.branch)).toBe(tip);

  // Another integration's draft has its own identity; once merged, it stays merged.
  const accepted = await publishDraft(await candidate(), options('billing-stripe'));
  expect(accepted).toMatchObject({ status: 'created', number: 2 });
  await github.merge(REPOSITORY, accepted.number, 'squash');
  const merged = await candidate('after the merge');
  expect(await publishDraft(merged, options('billing-stripe'))).toMatchObject({
    status: 'merged',
    number: 2,
  });
  expect(github.pulls(REPOSITORY)).toHaveLength(2);
  expect(github.comments(REPOSITORY)).toEqual([]);
});

it('closes the older drafts this one replaces with a link, but not other integrations or edited drafts', async () => {
  const revision = await main();
  const report = await candidate();
  const legacy = (key: string, integration?: string) =>
    publishFiles(options(integration), {
      revision,
      key,
      files: report.publicationFiles,
      title: 'fix(stripe): an earlier Refit draft',
      body: `Earlier draft.\n${MIGRATION_MARKER}${key} -->${integration ? `\n${INTEGRATION_MARKER}${integration} -->` : ''}`,
      message: 'fix(stripe): an earlier Refit draft',
    });
  const older = await legacy('legacy-run');
  const edited = await legacy('legacy-edited');
  const other = await legacy('legacy-other', 'billing-stripe');
  const branch = join(root, 'branch');
  await execute(
    'git',
    ['clone', '--quiet', '--branch', edited.branch, github.remote(REPOSITORY), branch],
    {
      env: isolated,
    },
  );
  await writeFile(join(branch, 'NOTES.md'), 'keep\n');
  await git(branch, ['add', 'NOTES.md']);
  await git(branch, ['commit', '--quiet', '-m', 'docs: notes']);
  await github.pushBranch(REPOSITORY, edited.branch, branch);

  const current = await publishDraft(report, options());
  expect(current).toMatchObject({ status: 'created', number: 4, superseded: [older.number] });
  expect(github.pulls(REPOSITORY).map(({ number, state }) => [number, state])).toEqual([
    [1, 'closed'],
    [2, 'open'],
    [3, 'open'],
    [4, 'open'],
  ]);
  expect(github.comments(REPOSITORY)).toEqual([
    {
      issue: 1,
      user: BOT,
      body: `Superseded by #4. Refit keeps one draft per integration and updates it in place; that draft migrates this code to ${report.apiVersion.after} on the current \`main\`.`,
    },
  ]);
  // Publishing again supersedes nothing more.
  expect(await publishDraft(report, options())).toMatchObject({ status: 'existing', number: 4 });
  expect(github.comments(REPOSITORY)).toHaveLength(1);
  expect(await branchTip(other.branch)).toBeTruthy();
});

// The customer migrates billing.ts by hand and pushes it to main, optionally moving the pin too.
async function migrateByHand(pin?: string, extra = '') {
  await writeFile(
    join(checkout, 'billing.ts'),
    `import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!${pin ? `, { apiVersion: '${pin}' }` : ''});

export async function chargeHistory(paymentIntentId: string) {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return (await stripe.charges.list({ payment_intent: intent.id })).data;
}
${extra}`,
  );
  await git(checkout, ['commit', '--quiet', '-am', 'fix: migrate charge history']);
  return github.publish(REPOSITORY, checkout);
}

let runs = 0;
// The workflow as the watcher runs it, on the customer's clean checkout of main. Each run here
// stops before validation, so no Docker check runs.
const workflow = () =>
  runWorkflow({
    repository: checkout,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    output: join(root, `run-${++runs}`),
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    publication: options(),
  });

it('closes its draft once with a note when the customer migrates to the target themselves', async () => {
  const report = await candidate();
  const draft = await publishDraft(report, options());
  const base = await migrateByHand(report.apiVersion.after!);

  const first = await workflow();
  expect(first.manifest).toMatchObject({
    status: 'up-to-date',
    reason: `The code already sends 2022-11-15 and uses none of what it breaks. Refit closed its draft ${draft.url}.`,
  });
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'closed', merged: false }]);
  expect(github.comments(REPOSITORY)).toEqual([
    {
      issue: 1,
      user: BOT,
      body: `Refit is closing this draft. On \`main\` at ${base.slice(0, 12)}, the code already sends 2022-11-15 and uses none of what it breaks, so this migration no longer applies. If you reopen it, Refit leaves it open.\n\n<!-- refit-resolved -->`,
    },
  ]);

  // The customer wants it after all: Refit leaves the reopened draft alone.
  github.reopenPull(REPOSITORY, 1);
  expect((await workflow()).manifest).toMatchObject({
    status: 'up-to-date',
    reason: 'The code already sends 2022-11-15 and uses none of what it breaks.',
  });
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'open' }]);
  expect(github.comments(REPOSITORY)).toHaveLength(1);
});

it('closes its draft when the customer migrates the reads without moving the pin', async () => {
  const draft = await publishDraft(await candidate(), options());
  await migrateByHand();
  expect((await workflow()).manifest).toMatchObject({
    status: 'draft-closed',
    reason: `Refit no longer finds the usages ${draft.url} migrated, so it closed that draft.`,
  });
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'closed' }]);
  expect(github.comments(REPOSITORY)[0].body).toContain(
    'Refit no longer finds the usages this draft migrated',
  );
});

it('stays quiet when the code already sends the target and Refit has no draft', async () => {
  await migrateByHand('2022-11-15');
  expect((await workflow()).manifest).toMatchObject({ status: 'up-to-date' });
  expect(github.pulls(REPOSITORY)).toEqual([]);
  expect(github.comments(REPOSITORY)).toEqual([]);
});

it('keeps its draft open while a read Refit cannot trace remains', async () => {
  const report = await candidate();
  await publishDraft(report, options());
  await migrateByHand(
    report.apiVersion.after!,
    'export const cached = (intent: { charges: { data: unknown[] } }) => intent.charges.data;\n',
  );
  const result = await workflow();
  console.log('untraced read:', result.manifest.status, result.manifest.reason);
  expect(result.manifest.status).toBe('needs-review');
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'open' }]);
  expect(github.comments(REPOSITORY)).toEqual([]);
});

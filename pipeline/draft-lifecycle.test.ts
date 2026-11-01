import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import {
  AI_PATCH_STOP,
  draftKey,
  findExistingMigration,
  publicationConfiguration,
  publishDraft,
} from './publication.ts';
import { REFIT_VERSION } from './migration-identity.ts';
import { runWorkflow } from './workflow.ts';

// Each draft's whole life against simulated GitHub: real Git objects, branches and pull requests,
// with the App's installation token. No Docker check runs; the evidence is the fixture's.
const execute = promisify(execFile);
const APP_ID = 321;
const REPOSITORY = 'example/application';
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

async function candidate(comment = '') {
  const report = await validatedReport(await main());
  if (comment)
    report.publicationFiles = report.publicationFiles.map((file) => ({
      ...file,
      content: `// ${comment}\n${file.content}`,
    }));
  return report;
}

// A person clones a draft branch, commits a note and pushes it.
async function addPersonCommit(name: string) {
  const branch = await mkdtemp(join(root, 'branch-'));
  await execute('git', ['clone', '--quiet', '--branch', name, github.remote(REPOSITORY), branch], {
    env: isolated,
  });
  await writeFile(join(branch, 'NOTES.md'), 'keep\n');
  await git(branch, ['add', 'NOTES.md']);
  await git(branch, ['commit', '--quiet', '-m', 'docs: notes']);
  await github.pushBranch(REPOSITORY, name, branch);
  return branchTip(name);
}

// As the release before this one would have left the draft's evidence marker.
const writtenEarlier = (body: string) =>
  body.replace(`"refit": "${REFIT_VERSION}"`, '"refit": "0.0.1"');

it('generates a rules-only [Needs review] draft again once for a run with AI', async () => {
  const report = await candidate();
  report.patch.unresolvedFindings = 1;
  await publishDraft(report, { ...options(), allowUnresolved: true });
  const [draft] = github.pulls(REPOSITORY);
  // Written by this release, so only the AI refresh generates it again.
  expect(await findExistingMigration(report, await main(), options(), 'release')).toMatchObject({
    status: 'existing',
    number: 1,
  });
  expect(await findExistingMigration(report, await main(), options(), 'ai')).toBeUndefined();
  // Once an AI model worked on it, the draft lists the AI review item and is reported as it is.
  draft.body = `${draft.body}\n${AI_PATCH_STOP}`;
  expect(await findExistingMigration(report, await main(), options(), 'ai')).toMatchObject({
    status: 'existing',
    number: 1,
  });
});

it('reports a [Needs review] draft an earlier release left on another branch as it is', async () => {
  const earlier = await candidate();
  earlier.patch.unresolvedFindings = 1;
  const { branch } = await publishDraft(earlier, { ...options(), allowUnresolved: true });
  // As a release that named draft branches differently left it.
  const [draft] = github.pulls(REPOSITORY);
  draft.body = writtenEarlier(draft.body);
  draft.head = 'refit/legacy';
  const bare = github.remote(REPOSITORY);
  await execute('git', ['-C', bare, 'update-ref', 'refs/heads/refit/legacy', draft.headSha], {
    env: isolated,
  });
  await execute('git', ['-C', bare, 'update-ref', '-d', `refs/heads/${branch}`], {
    env: isolated,
  });
  // Generating it again would publish a second draft on the current branch.
  expect(await findExistingMigration(earlier, await main(), options(), 'release')).toMatchObject({
    status: 'existing',
    number: 1,
    branch: 'refit/legacy',
  });
});

it('names a draft by its target version, or by its breaking changes when the version stays the same', async () => {
  const report = await candidate();
  const named = (
    before: string | null,
    target: string | null,
    changes: typeof report.changes = report.changes,
  ) =>
    draftKey({ ...report, changes, apiVersion: { ...report.apiVersion, before, after: target } });
  expect(named('2024-06-20', '2025-03-31.basil')).toBe(`draft:${report.provider}:2025-03-31.basil`);
  const same = named('1.0.0', '1.0.0');
  expect(same).toMatch(`draft:${report.provider}:changes:`);
  expect(named(null, null)).toBe(same);
  // An upstream edit that leaves the breaking changes alone keeps the draft; another one does not.
  expect(report.changes.length).toBeGreaterThan(0);
  expect(named('1.0.0', '1.0.0', [...report.changes].reverse())).toBe(same);
  expect(
    named('1.0.0', '1.0.0', [...report.changes, { ...report.changes[0], id: 'another' }]),
  ).not.toBe(same);
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

it('stays quiet when the code already sends the target and Refit has no draft', async () => {
  await migrateByHand('2022-11-15');
  expect((await workflow()).manifest).toMatchObject({ status: 'up-to-date' });
  // main moves on GitHub while the checkout is scanned: with no draft to close, that is no error.
  await addPersonCommit('main');
  expect((await workflow()).manifest).toMatchObject({ status: 'up-to-date' });
  expect(github.pulls(REPOSITORY)).toEqual([]);
  expect(github.comments(REPOSITORY)).toEqual([]);
});

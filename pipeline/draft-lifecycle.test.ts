import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import {
  draftKey,
  findExistingMigration,
  publicationConfiguration,
  publishDraft,
  publishFiles,
} from './publication.ts';
import { INTEGRATION_MARKER, MIGRATION_MARKER } from './migration-identity.ts';
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

const short = (sha: string) => sha.slice(0, 7);

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
  // The branch moved under a lease on the commit Refit pushed, which the draft records.
  expect(pull.body).toContain(`<!-- refit-pushed: ${updated} -->`);
  expect(github.requests.filter((request) => request.path === '/graphql')).toMatchObject([
    {
      status: 200,
      body: {
        variables: {
          refUpdates: [
            { name: `refs/heads/${first.branch}`, beforeOid: tip, afterOid: updated, force: true },
          ],
        },
      },
    },
  ]);
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

it('leaves a draft branch with commits a person added as it is, and says once that main moved', async () => {
  const draft = await publishDraft(await candidate(), options());
  const edited = await addPersonCommit(draft.branch);
  const body = github.pulls(REPOSITORY)[0].body;
  const expected = {
    status: 'existing',
    number: 1,
    leftUnchanged: 'The draft branch has commits Refit did not write, so Refit left it as it is.',
  };
  // While main has not moved, the person's commits are all there is to say.
  expect(await publishDraft(await candidate('regenerated'), options())).toMatchObject(expected);
  expect(github.comments(REPOSITORY)).toEqual([]);

  const base = await pushToMain('README.md', 'moved\n');
  const report = await candidate('regenerated');
  expect(await findExistingMigration(report, base, options())).toMatchObject({
    ...expected,
    validation: 'not-rerun',
  });
  expect(await publishDraft(report, options())).toMatchObject(expected);
  expect(await branchTip(draft.branch)).toBe(edited);
  expect(github.pulls(REPOSITORY)).toMatchObject([{ number: 1, state: 'open', body }]);
  expect(github.comments(REPOSITORY)).toEqual([
    {
      issue: 1,
      user: BOT,
      body: `\`main\` has moved to \`${short(base)}\` since this draft was last updated, and the draft branch has commits Refit did not write. Refit force-pushes only over its own last commit, so it left the branch as it is. On \`main\` at \`${short(base)}\`, the usages this draft migrates are in \`billing.ts\`. To update the draft, merge \`main\` into this branch and resolve any conflicts; the check results in the description ran on the earlier base.\n\n<!-- refit-base-moved: ${base} -->`,
    },
  ]);

  // Main moves again: the same comment is edited, not repeated.
  const later = await pushToMain('CHANGELOG.md', 'later\n');
  await publishDraft(await candidate('regenerated'), options());
  expect(github.comments(REPOSITORY)).toHaveLength(1);
  expect(github.comments(REPOSITORY)[0].body).toContain(
    `\`main\` has moved to \`${short(later)}\``,
  );
  expect(github.comments(REPOSITORY)[0].body).toContain(
    `Refit's patch for \`main\` at \`${short(later)}\` changes \`billing.ts\`.`,
  );
  expect(await branchTip(draft.branch)).toBe(edited);
});

it('never forces over a commit a person pushes while Refit is updating its draft', async () => {
  const draft = await publishDraft(await candidate(), options());
  const tip = await branchTip(draft.branch);
  const base = await pushToMain('README.md', 'moved\n');
  let pushed = '';
  github.beforeNext('POST', '/graphql', async () => {
    pushed = await addPersonCommit(draft.branch);
  });
  expect(await publishDraft(await candidate('regenerated'), options())).toMatchObject({
    status: 'existing',
    number: 1,
    leftUnchanged: 'The draft branch has commits Refit did not write, so Refit left it as it is.',
  });
  expect(pushed).not.toBe('');
  expect((await commit(pushed)).parents).toEqual([tip]);
  expect(await branchTip(draft.branch)).toBe(pushed);
  expect(github.requests.filter((request) => request.path === '/graphql')).toMatchObject([
    { body: { variables: { refUpdates: [{ beforeOid: tip }] } } },
  ]);
  expect(github.comments(REPOSITORY)).toMatchObject([
    { issue: 1, body: expect.stringContaining(`<!-- refit-base-moved: ${base} -->`) },
  ]);
});

it('tells reviewers when it replaces the commit they reviewed', async () => {
  const draft = await publishDraft(await candidate(), options());
  const tip = await branchTip(draft.branch);
  github.review(REPOSITORY, draft.number);
  const base = await pushToMain('README.md', 'moved\n');
  expect(await publishDraft(await candidate(), options())).toMatchObject({ status: 'updated' });
  const moved = await branchTip(draft.branch);
  // A later patch on the same base, such as a new Refit release's.
  expect(await publishDraft(await candidate('a later release'), options())).toMatchObject({
    status: 'updated',
  });
  const changed = await branchTip(draft.branch);
  expect(github.comments(REPOSITORY)).toEqual([
    {
      issue: 1,
      user: BOT,
      body: `Refit replaced commit \`${short(tip)}\` with \`${short(moved)}\` because \`main\` moved to \`${short(base)}\`. Reviews before this comment refer to \`${short(tip)}\`; the description now shows the checks for \`${short(moved)}\`.`,
    },
    {
      issue: 1,
      user: BOT,
      body: `Refit replaced commit \`${short(moved)}\` with \`${short(changed)}\` because the migration changed. Reviews before this comment refer to \`${short(moved)}\`; the description now shows the checks for \`${short(changed)}\`.`,
    },
  ]);
});

it('leaves a pull request someone else opened from the Refit branch to them', async () => {
  const draft = await publishDraft(await candidate(), options());
  const tip = await branchTip(draft.branch);
  github.closePull(REPOSITORY, draft.number);
  const theirs = await github.openPull(REPOSITORY, draft.branch, 'main');
  await pushToMain('README.md', 'moved\n');
  expect(await publishDraft(await candidate('regenerated'), options())).toMatchObject({
    status: 'existing',
    number: theirs,
    leftUnchanged:
      'Someone else opened this pull request from the Refit branch, so Refit left it as it is.',
  });
  expect(await branchTip(draft.branch)).toBe(tip);
  expect(github.comments(REPOSITORY)).toEqual([]);
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

// Drafts an earlier release of Refit opened for the same base, each with its own key.
function earlierDraft(
  report: Awaited<ReturnType<typeof candidate>>,
  revision: string,
  key: string,
  markers: string[],
  integration?: string,
) {
  return publishFiles(options(integration), {
    revision,
    key,
    files: report.publicationFiles,
    title: 'fix(stripe): an earlier Refit draft',
    body: ['Earlier draft.', `${MIGRATION_MARKER}${key} -->`, ...markers].join('\n'),
    message: 'fix(stripe): an earlier Refit draft',
  });
}

const providerMarker = (provider: string) => `<!-- refit-provider: ${provider} -->`;

it('closes older drafts only when asked, and only for the same provider and integration', async () => {
  const revision = await main();
  const report = await candidate();
  const same = providerMarker(report.provider);
  const older = await earlierDraft(report, revision, 'older', [same]);
  await earlierDraft(report, revision, 'legacy', []);
  await earlierDraft(report, revision, 'shopify', [providerMarker('shopify')]);
  const other = await earlierDraft(
    report,
    revision,
    'other',
    [same, `${INTEGRATION_MARKER}billing-stripe -->`],
    'billing-stripe',
  );
  const edited = await earlierDraft(report, revision, 'edited', [same]);
  await addPersonCommit(edited.branch);
  const states = () => github.pulls(REPOSITORY).map(({ number, state }) => [number, state]);

  // Off by default.
  const current = await publishDraft(report, options());
  expect(current).toMatchObject({ status: 'created', number: 6 });
  expect(current).not.toHaveProperty('superseded');
  expect(github.pulls(REPOSITORY).find(({ number }) => number === 6)?.body).toContain(same);
  expect(states().every(([, state]) => state === 'open')).toBe(true);

  const asked = { ...options(), supersedeDrafts: true };
  expect(await publishDraft(report, asked)).toMatchObject({
    status: 'existing',
    number: 6,
    superseded: [older.number],
  });
  expect(states()).toEqual([
    [1, 'closed'],
    [2, 'open'],
    [3, 'open'],
    [4, 'open'],
    [5, 'open'],
    [6, 'open'],
  ]);
  expect(github.comments(REPOSITORY)).toEqual([
    {
      issue: 1,
      user: BOT,
      body: `Superseded by #6. Refit keeps one draft per integration and updates it in place; that draft migrates this code to ${report.apiVersion.after} on the current \`main\`.\n\n<!-- refit-superseded -->`,
    },
  ]);
  expect(await branchTip(other.branch)).toBeTruthy();

  // A person reopens the closed draft: Refit leaves it open.
  github.reopenPull(REPOSITORY, older.number);
  const again = await publishDraft(report, asked);
  expect(again).toMatchObject({ status: 'existing', number: 6 });
  expect(again).not.toHaveProperty('superseded');
  expect(states()[0]).toEqual([1, 'open']);
  expect(github.comments(REPOSITORY)).toHaveLength(1);
});

it('opens a new draft for a target whose draft Refit closed itself, unlike one a person closed', async () => {
  const revision = await main();
  const report = await candidate();
  const older = await earlierDraft(report, revision, 'older', [providerMarker(report.provider)]);
  await publishDraft(report, { ...options(), supersedeDrafts: true });
  expect(github.pulls(REPOSITORY)[0]).toMatchObject({ number: 1, state: 'closed' });

  const reopened = await earlierDraft(report, revision, 'older', [providerMarker(report.provider)]);
  expect(reopened).toMatchObject({ status: 'created', number: 3, branch: older.branch });
});

it('names a draft by its target version, or by its contract when the version stays the same', async () => {
  const report = await candidate();
  const { after } = report.snapshots;
  const named = (before: string | null, target: string | null) =>
    draftKey({ ...report, apiVersion: { ...report.apiVersion, before, after: target } });
  expect(named('2024-06-20', '2025-03-31.basil')).toBe(`draft:${report.provider}:2025-03-31.basil`);
  expect(named('1.0.0', '1.0.0')).toBe(`draft:${report.provider}:${after}`);
  expect(named(null, null)).toBe(`draft:${report.provider}:${after}`);
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

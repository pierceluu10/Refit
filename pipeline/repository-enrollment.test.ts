import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  loadApprovedRepository,
  readRepositoryApproval,
  RepositoryApprovalError,
} from './repository-enrollment.ts';
import { readServiceConfiguration } from './service-configuration.ts';
import {
  linkStaysInside,
  readCommittedFile,
  readCommittedRepository,
} from './committed-repository.ts';
import { approvedCheckout, commit, enrollmentFixture } from './test/enrollment-fixture.ts';

// Multiple integrations in one profile: repository-enrollment-integrations.test.ts.
const execute = promisify(execFile);
const roots: string[] = [];
const bin = resolve('bin/refit.mjs');
const APP = { appId: '123', privateKeyFile: 'unused-test-key' };
const setup = enrollmentFixture(approvedCheckout);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshSetup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-enrollment-'));
  roots.push(root);
  return approvedCheckout(root);
}

it('reviews only committed inputs, requires the exact fingerprint and writes a private receipt outside Git', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Enrollment must not contact a provider');
    }),
  );
  const sample = await freshSetup();
  expect(sample.enrollment.repository).toBe('example/application');
  expect(sample.enrollment.files.map((file) => file.role)).toEqual([
    'workflow',
    'baseline',
    'adapter',
  ]);
  expect(sample.approval.reviewedRevision).toMatch(/^[a-f0-9]{40}$/);
  expect((await stat(sample.output)).mode & 0o777).toBe(0o600);
  expect(await readRepositoryApproval(sample.output)).toEqual(sample.approval);
  expect(await readFile(sample.output, 'utf8')).not.toContain('private-value');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expect(readFile(join(sample.repository, 'application-executed'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    approveRepositoryEnrollment({
      enrollment: sample.enrollment,
      fingerprint: '0'.repeat(64),
      output: join(sample.root, 'wrong.json'),
    }),
  ).rejects.toBeInstanceOf(RepositoryApprovalError);
  await expect(readFile(join(sample.root, 'wrong.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    approveRepositoryEnrollment({
      enrollment: sample.enrollment,
      fingerprint: sample.enrollment.fingerprint,
      output: join(sample.repository, 'approval.json'),
    }),
  ).rejects.toThrow('outside');
  await expect(
    approveRepositoryEnrollment({
      enrollment: sample.enrollment,
      fingerprint: sample.enrollment.fingerprint,
      output: sample.output,
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
});

it('rechecks source-verified API versions after application changes without relying on the approval fingerprint', async () => {
  const sample = await setup();
  const providerPath = join(sample.repository, 'provider.json');
  const provider = JSON.parse(await readFile(providerPath, 'utf8'));
  provider.apiVersion = { constructorArgument: 0, property: 'apiVersion', requestArguments: [] };
  await writeFile(providerPath, JSON.stringify(provider));
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, apiVersionPolicy: 'source-verified' }),
  );
  const clientPath = join(sample.repository, 'src/client.ts');
  await writeFile(
    clientPath,
    "import { Catalog } from '@example/catalog'; export const catalog = new Catalog({ apiVersion: '1' });",
  );
  await commit(sample.repository);
  const enrollment = await inspectRepositoryEnrollment(sample.input);
  expect(enrollment.apiVersion!.source.status).toBe('verified');
  const output = join(sample.root, 'strict-approval.json');
  await approveRepositoryEnrollment({ enrollment, fingerprint: enrollment.fingerprint, output });
  await writeFile(
    clientPath,
    "import { Catalog } from '@example/catalog'; export const catalog = new Catalog({ apiVersion: '2' });",
  );
  await commit(sample.repository);
  await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow(
    /conflicts with the application pin/,
  );
  await expect(
    loadApprovedRepository({
      repository: sample.repository,
      approval: await readRepositoryApproval(output),
      stateDirectory: join(sample.root, 'strict-cache'),
    }),
  ).rejects.toThrow(/conflicts with the application pin/);
});

it('retains approval across application and current source changes while snapshotting reviewed inputs', async () => {
  const sample = await setup();
  const stateDirectory = join(sample.root, 'state');
  const initial = await loadApprovedRepository({
    repository: sample.repository,
    approval: sample.approval,
    stateDirectory,
  });
  await writeFile(join(sample.repository, 'src/items.ts'), 'export const applicationRevision = 2;');
  const after = JSON.parse(await readFile(join(sample.repository, 'after.json'), 'utf8'));
  after.info.version = '3';
  await writeFile(join(sample.repository, 'after.json'), JSON.stringify(after));
  await commit(sample.repository);
  const current = await inspectRepositoryEnrollment(sample.input);
  expect(current.fingerprint).toBe(sample.enrollment.fingerprint);
  expect(current.reviewedRevision).not.toBe(sample.enrollment.reviewedRevision);
  const refreshed = await loadApprovedRepository({
    repository: sample.repository,
    approval: sample.approval,
    stateDirectory,
  });
  expect(refreshed.workflow.before).toBe(initial.workflow.before);
  expect(refreshed.workflow.before).not.toBe(join(sample.repository, 'before.json'));
  expect(await readFile(refreshed.workflow.before, 'utf8')).toBe(
    await readFile(join(sample.repository, 'before.json'), 'utf8'),
  );
  expect(refreshed.source).toEqual({
    kind: 'file',
    path: await realpath(join(sample.repository, 'after.json')),
  });
  expect((await execute('git', ['-C', sample.repository, 'status', '--porcelain'])).stdout).toBe(
    '',
  );
});

it.each(['workflow', 'baseline', 'adapter'] as const)(
  'requires fresh review when the approved %s changes',
  async (role) => {
    const sample = await setup();
    const name =
      role === 'workflow' ? '.refit.json' : role === 'baseline' ? 'before.json' : 'provider.json';
    const path = join(sample.repository, name);
    await writeFile(path, (await readFile(path, 'utf8')) + '\n');
    await commit(sample.repository);
    await expect(
      loadApprovedRepository({
        repository: sample.repository,
        approval: sample.approval,
        stateDirectory: join(sample.root, 'state'),
      }),
    ).rejects.toThrow('Approved repository inputs changed');
    await expect(stat(join(sample.root, 'state/approved-inputs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it.each(['../private.json', '/tmp/private.json', '.git/config'] as const)(
  'rejects a profile input outside committed repository files: %s',
  async (before) => {
    const sample = await setup();
    await writeFile(
      join(sample.repository, '.refit.json'),
      JSON.stringify({ ...sample.configuration, before }),
    );
    await commit(sample.repository);
    await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow(
      'relative committed paths',
    );
  },
);

it('rejects repository switching, dirty snapshots, missing files and tracked symlinks', async () => {
  const sample = await setup();
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, repository: '../another' }),
  );
  await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow(
    'clean committed repository',
  );
  await commit(sample.repository);
  await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow(
    'must not select another repository',
  );
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({ ...sample.configuration, before: 'missing.json' }),
  );
  await commit(sample.repository);
  await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow(
    'not a committed regular file',
  );
  await writeFile(join(sample.repository, '.refit.json'), JSON.stringify(sample.configuration));
  await symlink(join(sample.repository, 'before.json'), join(sample.repository, 'linked.json'));
  await commit(sample.repository);
  await expect(inspectRepositoryEnrollment(sample.input)).rejects.toThrow('symbolic links');
});

it('bounds immutable Git blob reads and rejects unsupported text before parser use', async () => {
  const sample = await setup();
  const snapshot = await readCommittedRepository(sample.repository);
  await expect(readCommittedFile(snapshot, '.refit.json', 1)).rejects.toThrow('read limit');
  await writeFile(join(sample.repository, 'binary.dat'), Buffer.from([0xff]));
  await commit(sample.repository);
  await expect(
    readCommittedFile(await readCommittedRepository(sample.repository), 'binary.dat', 100),
  ).rejects.toThrow('supported UTF-8');
});

it('accepts tracked symbolic links only when they resolve inside the repository', async () => {
  const sample = await setup();
  await mkdir(join(sample.repository, 'public', 'icons'), { recursive: true });
  await symlink('../before.json', join(sample.repository, 'public', 'contract.json'));
  await symlink('icons', join(sample.repository, 'public', 'images'));
  await symlink('missing.png', join(sample.repository, 'public', 'icons', 'logo.png'));
  await commit(sample.repository);
  const snapshot = await readCommittedRepository(sample.repository);
  await expect(readCommittedFile(snapshot, 'public/contract.json', 1000)).rejects.toThrow(
    'not a committed regular file',
  );
  await symlink('../../..', join(sample.repository, 'public', 'icons', 'up'));
  await commit(sample.repository);
  await expect(readCommittedRepository(sample.repository)).rejects.toThrow(
    'public/icons/up does not',
  );
});

it('resolves chained links before deciding whether a link escapes', () => {
  const links = new Map([
    ['app/root', '..'],
    ['app/escape', 'root/..'],
    ['app/inside', 'root/app'],
    ['absolute', '/etc/passwd'],
    ['loop', 'loop'],
  ]);
  expect(linkStaysInside('app/root', links)).toBe(true);
  // Read as text, root/.. is app; through the link it is the repository's parent.
  expect(linkStaysInside('app/escape', links)).toBe(false);
  expect(linkStaysInside('app/inside', links)).toBe(true);
  expect(linkStaysInside('absolute', links)).toBe(false);
  expect(linkStaysInside('loop', links)).toBe(false);
});

it('refuses changed, linked, extra or incomplete cached input files without overwriting them', async () => {
  const sample = await setup();
  const stateDirectory = join(sample.root, 'state');
  const profile = await loadApprovedRepository({
    repository: sample.repository,
    approval: sample.approval,
    stateDirectory,
  });
  await writeFile(profile.workflow.before, 'changed baseline must survive');
  await expect(
    loadApprovedRepository({
      repository: sample.repository,
      approval: sample.approval,
      stateDirectory,
    }),
  ).rejects.toThrow('cache changed');
  expect(await readFile(profile.workflow.before, 'utf8')).toBe('changed baseline must survive');
  await rm(profile.workflow.before);
  await symlink(join(sample.repository, 'before.json'), profile.workflow.before);
  await expect(
    loadApprovedRepository({
      repository: sample.repository,
      approval: sample.approval,
      stateDirectory,
    }),
  ).rejects.toThrow('regular files');
  await rm(profile.workflow.before);
  await expect(
    loadApprovedRepository({
      repository: sample.repository,
      approval: sample.approval,
      stateDirectory,
    }),
  ).rejects.toThrow('cache is incomplete');
  await writeFile(profile.workflow.before, await readFile(join(sample.repository, 'before.json')));
  const extra = join(profile.workflow.before, '..', 'extra.json');
  await writeFile(extra, 'unexpected cache input');
  await expect(
    loadApprovedRepository({
      repository: sample.repository,
      approval: sample.approval,
      stateDirectory,
    }),
  ).rejects.toThrow('unexpected files');
  expect(await readFile(extra, 'utf8')).toBe('unexpected cache input');
  // Reloads the approved repository five times; loaded runners can exceed the default 5s timeout.
}, 30_000);

it('rejects tampered receipt identity/evidence and mismatched service repositories or branches', async () => {
  const sample = await setup();
  const text = await readFile(sample.output, 'utf8');
  await writeFile(
    sample.output,
    JSON.stringify({
      ...sample.approval,
      files: sample.approval.files.map((file) => ({ ...file, sha256: '1'.repeat(64) })),
    }),
  );
  await expect(readRepositoryApproval(sample.output)).rejects.toThrow('fingerprint');
  await writeFile(sample.output, text);
  const path = join(sample.root, 'service.json');
  const target = {
    id: 'demo',
    repository: 'example/application',
    base: 'main',
    approval: './approval.json',
  };
  await writeFile(path, JSON.stringify({ formatVersion: 1, targets: [target] }));
  expect((await readServiceConfiguration(path, APP))[0].approval).toEqual(sample.approval);
  for (const override of [
    { repository: 'another/application' },
    { base: 'other' },
    { workflow: './workflow.json' },
  ]) {
    await writeFile(
      path,
      JSON.stringify({ formatVersion: 1, targets: [{ ...target, ...override }] }),
    );
    await expect(readServiceConfiguration(path, APP)).rejects.toThrow(/another GitHub|exactly one/);
  }
});

it('names the enroll options a command leaves out', async () => {
  const sample = await setup();
  // Before: the whole usage text on one line.
  await expect(
    execute(
      process.execPath,
      [bin, 'enroll', '--github', 'example/application', '--base', 'main'],
      {
        cwd: sample.repository,
      },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: 'refit enroll: --repository is required. Run refit enroll --help for its options.\n',
  });
  await expect(
    execute(
      process.execPath,
      [bin, 'enroll', '--repository', sample.repository, '--approve', '0'.repeat(64)],
      { cwd: sample.repository },
    ),
  ).rejects.toMatchObject({
    stderr:
      'refit enroll: --github and --base are required. Run refit enroll --help for its options.\n',
  });
});

it('provides a read-only CLI review and creates a receipt only with the displayed fingerprint', async () => {
  const sample = await setup();
  const argumentsList = [
    bin,
    'enroll',
    '--repository',
    sample.repository,
    '--github',
    'example/application',
    '--base',
    'main',
  ];
  const review = JSON.parse(
    (await execute(process.execPath, [...argumentsList, '--json'], { cwd: sample.root })).stdout,
  );
  expect(review.fingerprint).toBe(sample.enrollment.fingerprint);
  expect(review.settings.command).toEqual(sample.configuration.command);
  const output = join(sample.root, 'cli-approved.json');
  await expect(
    execute(process.execPath, [...argumentsList, '--approve', '0'.repeat(64), '--output', output], {
      cwd: sample.root,
    }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  const approved = await execute(
    process.execPath,
    [...argumentsList, '--approve', review.fingerprint, '--output', output],
    { cwd: sample.root },
  );
  expect(approved.stdout).toContain('Repository configuration approved');
  expect((await readRepositoryApproval(output)).fingerprint).toBe(review.fingerprint);
  await expect(
    execute(process.execPath, [...argumentsList, '--ai-patch'], { cwd: sample.root }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown option') });
  // Starts the CLI four times; shared CI runners can exceed the default 5s timeout.
}, 30_000);

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareDependencies } from './dependency-preparation.ts';
import { runWorkflow } from './workflow.ts';
import { inspectRepositoryReadiness } from './readiness.ts';
import { verifyArtifacts } from './verification.ts';
import { digest } from './specifications.ts';
import { readEvidence } from './state-files.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/npm-workspaces/repository');
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const PNPM_VERSIONS = ['9.15.4', '10.17.1', '11.28.5', '12.4.2'];
const PNPM_FIXTURE = resolve('pipeline/fixtures/pnpm-workspaces');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scenario(pnpmVersion?: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-npm-workspaces-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(FIXTURE, repository, { recursive: true });
  if (pnpmVersion) {
    const root = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    delete root.workspaces;
    root.packageManager = `pnpm@${pnpmVersion}`;
    await writeFile(join(repository, 'package.json'), JSON.stringify(root, null, 2) + '\n');
    const billingFile = join(repository, 'packages/billing/package.json');
    const billing = JSON.parse(await readFile(billingFile, 'utf8'));
    billing.dependencies.stripe = 'catalog:legacy';
    billing.dependencies['@refit-fixture/ids'] = 'workspace:*';
    billing.devDependencies.typescript = 'catalog:';
    await writeFile(billingFile, JSON.stringify(billing, null, 2) + '\n');
    await rm(join(repository, 'package-lock.json'));
    await cp(
      join(
        PNPM_FIXTURE,
        `pnpm-v${Number(pnpmVersion.split('.')[0]) >= 11 ? pnpmVersion.split('.')[0] : '9'}.yaml`,
      ),
      join(repository, 'pnpm-lock.yaml'),
    );
    await cp(join(PNPM_FIXTURE, 'pnpm-workspace.yaml'), join(repository, 'pnpm-workspace.yaml'));
  }
  await cp(
    resolve('pipeline/fixtures/stripe-sdk/contract.mjs'),
    join(repository, 'simulator/stripe-contract.mjs'),
  );
  await writeFile(join(repository, '.npmrc'), 'registry=http://127.0.0.1:1\n');
  await writeFile(join(repository, 'packages/billing/.npmrc'), 'registry=http://127.0.0.1:1\n');
  await writeFile(join(repository, '.env'), 'PRIVATE_SOURCE_FIXTURE=must-not-reach-preparation\n');
  const git = (args: string[]) =>
    execute('git', ['-C', repository, '-c', 'commit.gpgsign=false', ...args]);
  const commit = async () => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'test: seed workspace application',
    ]);
  };
  await git(['init', '-b', 'main']);
  const check = (mode: string) => [
    'sh',
    '-c',
    pnpmVersion
      ? `pnpm --filter @refit-fixture/billing exec node --experimental-strip-types ../../simulator/check.mjs ${mode} && pnpm --filter @refit-fixture/billing exec node --experimental-strip-types ../../simulator/check.mjs ${mode} empty && pnpm --filter @refit-fixture/billing run typecheck`
      : `npm test --workspace @refit-fixture/billing -- ${mode} && npm test --workspace @refit-fixture/billing -- ${mode} empty && npm run typecheck --workspace @refit-fixture/billing`,
  ];
  if (pnpmVersion)
    await writeFile(
      join(repository, '.refit.json'),
      JSON.stringify({
        formatVersion: 1,
        before: resolve('pipeline/fixtures/before.json'),
        after: resolve('pipeline/fixtures/after.json'),
        apiVersion: '2022-08-01',
        apiVersionPolicy: 'source-verified',
        image: IMAGE,
        prepareDependencies: true,
        fullDiff: false,
        baselineCommand: check('before'),
        command: ['sh', '-c', `${check('before')[2]} && ${check('after')[2]}`],
      }),
    );
  await commit();
  return {
    root,
    repository,
    git,
    commit,
    options: {
      repository,
      image: IMAGE!,
      prepareDependencies: true,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      apiVersionPolicy: 'source-verified' as const,
      baselineCommand: check('before'),
      command: pnpmVersion
        ? ['sh', '-c', `${check('before')[2]} && ${check('after')[2]}`]
        : check('after'),
      output: join(root, 'run'),
    },
  };
}

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE).each(PNPM_VERSIONS)(
  'prepares pinned pnpm %s with catalogs, links and both Stripe versions, then validates offline without install scripts',
  async (version) => {
    const sample = await scenario(version);
    const options = {
      repository: sample.repository,
      image: IMAGE!,
      cacheDirectory: join(sample.root, 'cache'),
    };
    const readiness = await inspectRepositoryReadiness({ repository: sample.repository });
    expect(readiness.status).toBe('ready-for-validation');
    expect(readiness.checks.find((check) => check.id === 'dependencies')?.status).toBe('passed');
    const prepared = await prepareDependencies(options);
    expect(prepared.environment).toMatchObject({
      kind: 'refit-pnpm-environment',
      manager: 'pnpm',
      pnpmVersion: version,
    });
    expect(prepared.environment.pnpmIntegrity).toMatch(/^sha512-/);
    expect((await verifyArtifacts(prepared.directory)).status).toBe('integrity-verified');
    expect((await prepareDependencies(options)).reused).toBe(true);
    const entries = (await execute('tar', ['-tf', prepared.archive])).stdout.split('\n');
    expect(
      entries.some((path) => path.startsWith('node_modules/.refit-tools/node_modules/pnpm/')),
    ).toBe(true);
    expect(
      entries.some(
        (path) =>
          path.endsWith('/root-script-ran') ||
          path.endsWith('/workspace-script-ran') ||
          path.endsWith('/.env') ||
          path.endsWith('/.npmrc') ||
          path.endsWith('/src/history.ts'),
      ),
    ).toBe(false);
    if (version === '12.4.2') {
      const failed = await runWorkflow({
        ...sample.options,
        baselineCommand: sample.options.command,
        output: join(sample.root, 'original-after'),
      });
      expect(failed.manifest.status).toBe('validation-failed');
      const failure = JSON.parse((await readEvidence(failed.directory, 'report.json'))!);
      expect(failure.validation.baseline.stderr).toContain('Missing history');
    }
    const result = await runWorkflow(sample.options);
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse((await readEvidence(result.directory, 'report.json'))!);
    expect(
      report.repository.dependencies
        .map((dependency: { lock: { version: string } }) => dependency.lock.version)
        .sort(),
    ).toEqual(['10.17.0', '19.1.0']);
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
      environment: { manager: 'pnpm', pnpmVersion: version },
    });
    expect(report.validation.patched.stdout).toContain('starting_after=ch_first');
    expect(report.validation.patched.stdout).toContain('"chargeIds":[]');
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
    if (version === '12.4.2') {
      const environmentFile = join(prepared.directory, 'environment.json');
      const environment = JSON.parse(await readFile(environmentFile, 'utf8'));
      environment.pnpmVersion = '0.0.0';
      const bytes = JSON.stringify(environment);
      await writeFile(environmentFile, bytes);
      const manifestFile = join(prepared.directory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      Object.assign(
        manifest.files.find((file: { path: string }) => file.path === 'environment.json'),
        { sha256: digest(bytes), bytes: Buffer.byteLength(bytes) },
      );
      await writeFile(manifestFile, JSON.stringify(manifest));
      expect((await verifyArtifacts(prepared.directory)).status).toBe('integrity-verified');
      await expect(prepareDependencies(options)).rejects.toThrow(
        'does not match its committed inputs',
      );
    }
  },
  180_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE).each(['relative', 'alias'])(
  'validates a TypeScript billing workspace using %s imports, linked local source and two actual Stripe versions in offline Docker',
  async (imports) => {
    const sample = await scenario();
    if (imports === 'alias') {
      const directory = join(sample.repository, 'packages/billing');
      const manifestPath = join(directory, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.imports = { '#billing/*': './src/*' };
      await writeFile(manifestPath, JSON.stringify(manifest));
      const configurationPath = join(directory, 'tsconfig.json');
      const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
      configuration.compilerOptions.paths = { '#billing/*': ['./src/*'] };
      await writeFile(configurationPath, JSON.stringify(configuration));
      const historyPath = join(directory, 'src/history.ts');
      await writeFile(
        historyPath,
        (await readFile(historyPath, 'utf8')).replace('./client.ts', '#billing/client.ts'),
      );
      await sample.commit();
    }
    const prepared = await prepareDependencies({
      repository: sample.repository,
      image: IMAGE!,
      cacheDirectory: join(sample.root, 'cache'),
    });
    expect(prepared.environment.workspaceHashes).toHaveProperty('packages/billing');
    expect(prepared.environment.workspaceHashes).toHaveProperty('packages/ids');
    const entries = (await execute('tar', ['-tf', prepared.archive])).stdout.trim().split('\n');
    expect(entries.some((name) => name.startsWith('packages/billing/node_modules/stripe/'))).toBe(
      true,
    );
    expect(
      entries.every(
        (name) =>
          name.startsWith('node_modules/') || name.startsWith('packages/billing/node_modules/'),
      ),
    ).toBe(true);
    expect(entries).not.toContain('packages/billing/src/history.ts');
    expect(entries).not.toContain('.env');
    expect(entries).not.toContain('.npmrc');
    expect(
      entries.some(
        (name) => name.endsWith('/root-script-ran') || name.endsWith('/workspace-script-ran'),
      ),
    ).toBe(false);
    const incompatible = await runWorkflow({
      ...sample.options,
      baselineCommand: sample.options.command,
      output: join(sample.root, 'original-after'),
    });
    expect(incompatible.manifest.status).toBe('validation-failed');
    const failure = JSON.parse((await readEvidence(incompatible.directory, 'report.json'))!);
    expect(failure.validation.baseline.stderr).toContain('Missing history');
    expect(failure.validation.patched.status).toBe('not-run');
    const result = await runWorkflow(sample.options);
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse((await readEvidence(result.directory, 'report.json'))!);
    expect(report.repository.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'package.json',
          lock: expect.objectContaining({ version: '19.1.0', packagePath: 'node_modules/stripe' }),
        }),
        expect.objectContaining({
          file: 'packages/billing/package.json',
          lock: expect.objectContaining({
            version: '10.17.0',
            packagePath: 'packages/billing/node_modules/stripe',
          }),
        }),
      ]),
    );
    expect(report.apiVersion.source.status).toBe('verified');
    expect(report.findings).toMatchObject([
      { confidence: 'confirmed' },
      { confidence: 'confirmed' },
    ]);
    expect(report.repository.configurations).toMatchObject([
      { path: 'packages/billing/tsconfig.json' },
    ]);
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
    });
    expect(report.validation.patched.stdout).toContain('starting_after=ch_first');
    expect(report.validation.patched.stdout).toContain('"chargeIds":[]');
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      'packages/billing/src/history.ts',
    ]);
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
    expect(
      (
        await prepareDependencies({
          repository: sample.repository,
          image: IMAGE!,
          cacheDirectory: join(sample.root, 'cache'),
        })
      ).reused,
    ).toBe(true);
  },
  120_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'invalidates prepared metadata for a workspace-only manifest change and refuses a stale graph during setup',
  async () => {
    const sample = await scenario();
    const options = {
      repository: sample.repository,
      image: IMAGE!,
      cacheDirectory: join(sample.root, 'cache'),
    };
    const first = await prepareDependencies(options);
    const path = join(sample.repository, 'packages/billing/package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.scripts.test += ' ';
    await writeFile(path, JSON.stringify(manifest));
    await sample.commit();
    const second = await prepareDependencies(options);
    expect(second.reused).toBe(false);
    expect(second.directory).not.toBe(first.directory);
    manifest.dependencies.stripe = '11.0.0';
    await writeFile(path, JSON.stringify(manifest));
    await sample.commit();
    await expect(prepareDependencies(options)).rejects.toThrow(
      'stripe is "11.0.0" in packages/billing/package.json but "10.17.0" in the lockfile',
    );
    await writeFile(
      join(sample.repository, '.refit.json'),
      JSON.stringify({
        formatVersion: 1,
        before: sample.options.before,
        after: sample.options.after,
        apiVersion: '2022-08-01',
        image: IMAGE,
        prepareDependencies: true,
        command: sample.options.command,
      }),
    );
    await sample.commit();
    const diagnosis = await inspectRepositoryReadiness({ repository: sample.repository });
    expect(diagnosis.checks.find((check) => check.id === 'dependencies')).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('differ from the committed package-lock.json'),
    });
  },
  120_000,
);

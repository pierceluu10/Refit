import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readCommittedFile, readCommittedRepository } from './committed-repository.ts';
import { prepareDependencies } from './dependency-preparation.ts';
import {
  dockerSandboxArguments,
  removeDockerContainer,
  SANDBOX_EXPIRY_LABEL,
} from './docker-sandbox.ts';
import { packageSnapshot, sdkPackageDirectory } from './preparation-packages.ts';
import { packageDiff } from './stripe-package-upgrade.ts';
import { validateMigration } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const FAKE_IMAGE = `sha256:${'d'.repeat(64)}`;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The parts of a scan report and a committed tree that decide the package, as paths.
function decide(layout: {
  declares: string[];
  committed: string[];
  findings: string[];
  declarations?: string[];
}) {
  return sdkPackageDirectory(
    {
      repository: { dependencies: layout.declares.map((file) => ({ file })) },
      findings: layout.findings.map((file) => ({ file })),
      apiVersion: {
        source: { declarations: (layout.declarations ?? []).map((file) => ({ file })) },
      },
    },
    (path) => layout.committed.includes(path),
  );
}

it('prepares and checks the nested package that declares stripe and commits its own lockfile', () => {
  // different-ai/embedbase at fb0afda5e8c2ad0212ea8c0dfa495be9865221d5: no root package.json; the
  // dashboard is its own npm project beside other projects with their own lockfiles.
  expect(
    decide({
      declares: ['dashboard/package.json'],
      committed: [
        'dashboard/package.json',
        'dashboard/package-lock.json',
        'sdk/embedbase-js/package.json',
        'sdk/embedbase-js/package-lock.json',
      ],
      findings: [
        'dashboard/pages/api/create-checkout-session.ts',
        'dashboard/utils/supabase-admin.ts',
      ],
      declarations: ['dashboard/utils/stripe.ts'],
    }),
  ).toBe('dashboard');
  // starmanv4/react-typescript-docker at 109c4528fba9c6c0efe67a250704ece82441bad9: one service of
  // eight, each with its own package-lock.json.
  expect(
    decide({
      declares: ['payments/package.json'],
      committed: [
        'auth/package.json',
        'auth/package-lock.json',
        'payments/package.json',
        'payments/package-lock.json',
      ],
      findings: ['payments/src/routes/new.ts'],
      declarations: ['payments/src/stripe.ts'],
    }),
  ).toBe('payments');
});

it('keeps the repository root whenever the files do not sit in one nested package with a lockfile', () => {
  // App-4-Dat-LLC/LandLORDER-rp at f360e1139c847dbba4a846a32eb513a81f2766ab: landlorder/ is
  // its own npm project, but a root file pins the API version too, so the patch edits root code.
  expect(
    decide({
      declares: ['package.json', 'landlorder/package.json'],
      committed: [
        'package.json',
        'package-lock.json',
        'landlorder/package.json',
        'landlorder/package-lock.json',
      ],
      findings: [],
      declarations: [
        'landlorder/services/stripe.js',
        'landlorder/routes/billing.js',
        'stripe-service.js',
      ],
    }),
  ).toBeUndefined();
  // cyberdreadx/cyberpunk-grok-api at its pinned commit: api/package.json does not declare stripe,
  // so the root's lockfile installs it, as before.
  expect(
    decide({
      declares: ['package.json'],
      committed: ['package.json', 'package-lock.json', 'api/package.json'],
      findings: ['api/checkout.ts', 'src/components/EarningsPanel.tsx'],
    }),
  ).toBeUndefined();
  // benlamiro/ShipGenAI at 10037d3d3fcf: Stripe code in many separate projects.
  expect(
    decide({
      declares: [
        'ecommerce/pet-product-studio/package.json',
        'writing_content/mail-wise/package.json',
      ],
      committed: [
        'ecommerce/pet-product-studio/package.json',
        'ecommerce/pet-product-studio/package-lock.json',
        'writing_content/mail-wise/package.json',
        'writing_content/mail-wise/package-lock.json',
      ],
      findings: [
        'ecommerce/pet-product-studio/app/api/checkout/route.ts',
        'writing_content/mail-wise/app/api/checkout/route.ts',
      ],
    }),
  ).toBeUndefined();
  // pretzelai/lumen at c689c56b3241: a Bun workspace; api/ declares no stripe and ui/ commits no
  // lockfile Refit installs.
  const lumen = {
    declares: ['ui/package.json'],
    committed: ['package.json', 'bun.lock', 'api/package.json', 'ui/package.json'],
  };
  expect(
    decide({
      ...lumen,
      findings: ['api/src/routes/billing.ts', 'ui/src/components/ui/pricing-table.tsx'],
    }),
  ).toBeUndefined();
  expect(
    decide({ ...lumen, findings: ['ui/src/components/ui/pricing-table.tsx'] }),
  ).toBeUndefined();
  expect(decide({ declares: [], committed: [], findings: [] })).toBeUndefined();
});

async function commit(repository: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '--force', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: seed nested packages',
  ]);
}

const manifest = (name: string) => JSON.stringify({ name, version: '1.0.0', dependencies: {} });
const lockfile = (name: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': JSON.parse(manifest(name)) } });

it('reads one committed directory as its own repository root', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'refit-package-snapshot-'));
  roots.push(repository);
  await commit(repository, {
    'dashboard/package.json': manifest('nextjs'),
    'dashboard/package-lock.json': lockfile('nextjs'),
    'dashboard/utils/stripe.ts': 'export {};\n',
    'sdk/embedbase-js/package.json': manifest('embedbase-js'),
  });
  const snapshot = await readCommittedRepository(repository);
  const dashboard = await packageSnapshot(snapshot, 'dashboard');
  expect(dashboard.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1))).toEqual([
    'package-lock.json',
    'package.json',
    'utils/stripe.ts',
  ]);
  expect(await readCommittedFile(dashboard, 'package.json', 1024)).toBe(manifest('nextjs'));
  for (const directory of ['dashboard/package.json', 'missing'])
    await expect(packageSnapshot(snapshot, directory)).rejects.toThrow(
      `${directory} is not a committed directory.`,
    );
});

// A docker stand-in: preparation (the bridge network) prints version evidence and an empty
// node_modules archive; checks exit 0. Every call records its input files and arguments.
async function fakeDocker(root: string) {
  const log = join(root, 'docker.jsonl');
  const archive = join(root, 'archive');
  await mkdir(join(archive, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin', 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? '${FAKE_IMAGE}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const input = args.find((arg) => arg.includes(',dst=/input,')).slice('type=bind,src='.length).split(',dst=')[0];
const files = (prefix = '') => fs.readdirSync(input + '/' + prefix, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(prefix + entry.name + '/') : [prefix + entry.name]);
const label = args[args.indexOf('--label') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  network: args[args.indexOf('--network') + 1],
  remainingMs: Number(label.slice(label.indexOf('=') + 1)) - Date.now(),
  inputFiles: files().sort(),
  script: args[args.indexOf('-c') + 1],
  tail: args.slice(args.indexOf('refit-check')),
}) + '\\n');
if (args[args.indexOf('--network') + 1] === 'bridge') {
  process.stderr.write('REFIT_NODE_VERSION=v22.23.3\\nREFIT_NPM_VERSION=10.9.9\\n');
  process.stdout.write(execFileSync('tar', ['-cf', '-', 'node_modules'], { cwd: ${JSON.stringify(archive)} }));
}
`,
  );
  await chmod(join(root, 'bin', 'docker'), 0o755);
  vi.stubEnv('PATH', join(root, 'bin') + delimiter + process.env.PATH);
  return async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            network: string;
            remainingMs: number;
            inputFiles: string[];
            script: string;
            tail: string[];
          },
      );
}

it('installs a nested package from its own manifest and lockfile only, and still refuses tracked node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-package-install-'));
  roots.push(root);
  const calls = await fakeDocker(root);
  const repository = join(root, 'repository');
  // Shaped like starmanv4/react-typescript-docker at 109c4528fba9c6c0efe67a250704ece82441bad9.
  await commit(repository, {
    'auth/package.json': manifest('auth'),
    'auth/package-lock.json': lockfile('auth'),
    'payments/package.json': manifest('payments'),
    'payments/package-lock.json': lockfile('payments'),
    'payments/src/stripe.ts': 'export {};\n',
    'skaffold.yaml': 'apiVersion: skaffold/v2alpha3\n',
  });
  const prepared = await prepareDependencies({
    repository,
    image: 'local-node:test',
    cacheDirectory: join(root, 'cache'),
    packageDirectory: 'payments',
  });
  expect(prepared.reused).toBe(false);
  expect(await calls()).toMatchObject([
    { network: 'bridge', inputFiles: ['package-lock.json', 'package.json'] },
  ]);
  const tracked = join(root, 'tracked');
  await commit(tracked, {
    'auth/node_modules/left-pad/index.js': 'module.exports = 0;\n',
    'payments/package.json': manifest('payments'),
    'payments/package-lock.json': lockfile('payments'),
  });
  await expect(
    prepareDependencies({
      repository: tracked,
      image: 'local-node:test',
      cacheDirectory: join(root, 'cache'),
      packageDirectory: 'payments',
    }),
  ).rejects.toThrow('The repository tracks auth/node_modules;');
});

it('runs a nested package check in its directory with its own dependencies', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  const args = dockerSandboxArguments({
    name: 'refit-check',
    directory: '/tmp/candidate',
    image: 'sha256:image',
    command: ['npm', 'test'],
    network: 'none',
    timeoutMs: 600_000,
    dependencies: '/tmp/dependencies.tar',
    packageDirectory: 'dashboard',
  });
  expect(args).toContain(`${SANDBOX_EXPIRY_LABEL}=660000`);
  expect(args.slice(args.indexOf('-c') + 1)).toEqual([
    'cp -R /input/. /workspace/ && cd "./$1" && shift && tar -xf /dependencies.tar && export PATH="$PWD/node_modules/.refit-tools/node_modules/.bin:$PWD/node_modules/.bin:$PATH" && exec "$@"',
    'refit-check',
    'dashboard',
    'npm',
    'test',
  ]);
  for (const packageDirectory of ['', '../outside', 'dashboard/./x', 'dashboard//x'])
    expect(() =>
      dockerSandboxArguments({
        name: 'refit-check',
        directory: '/tmp/candidate',
        image: 'sha256:image',
        command: ['npm', 'test'],
        network: 'none',
        timeoutMs: 1000,
        packageDirectory,
      }),
    ).toThrow('A package directory must be a relative path inside the repository.');
});

it('finds the dependency part of a patch in the nested package it prepares', () => {
  const diff =
    'diff --git "a/dashboard/package.json" "b/dashboard/package.json"\n--- a\n+++ b\n' +
    'diff --git "a/dashboard/utils/stripe.ts" "b/dashboard/utils/stripe.ts"\n--- a\n+++ b\n';
  expect(packageDiff(diff)).toBe('');
  expect(packageDiff(diff, 'dashboard')).toBe(
    'diff --git "a/dashboard/package.json" "b/dashboard/package.json"\n--- a\n+++ b\n',
  );
});

it('validates Stripe code in a nested package there, under the configured check time limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-package-validation-'));
  roots.push(root);
  const calls = await fakeDocker(root);
  vi.stubEnv('REFIT_DEPENDENCY_CACHE_DIRECTORY', join(root, 'cache'));
  const repository = join(root, 'repository');
  // Shaped like different-ai/embedbase at fb0afda5e8c2ad0212ea8c0dfa495be9865221d5: no root
  // package.json, and a dashboard project with its own lockfile.
  const dashboard = { name: 'nextjs', private: true, dependencies: { stripe: '^10.0.0' } };
  await commit(repository, {
    'dashboard/package.json': JSON.stringify(dashboard),
    'dashboard/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': dashboard,
        'node_modules/stripe': {
          version: '10.17.0',
          resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        },
      },
    }),
    'dashboard/billing.ts': await readFile(
      resolve('pipeline/fixtures/repository/billing.ts'),
      'utf8',
    ),
    'docs/package.json': manifest('docs'),
    'docs/package-lock.json': lockfile('docs'),
  });
  const validate = (checkTimeoutSeconds?: number) =>
    validateMigration({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      prepareDependencies: true,
      checkTimeoutSeconds,
    });
  const report = await validate();
  expect(report.validation).toMatchObject({
    status: 'passed',
    packageDirectory: 'dashboard',
    limits: { timeoutMs: 600_000 },
  });
  expect(report.publicationFiles.map((file) => file.path)).toEqual(['dashboard/billing.ts']);
  const [preparation, ...checks] = await calls();
  expect(preparation).toMatchObject({
    network: 'bridge',
    inputFiles: ['package-lock.json', 'package.json'],
  });
  expect(checks).toHaveLength(2);
  for (const check of checks) {
    expect(check.network).toBe('none');
    expect(check.script).toContain('cd "./$1" && shift && tar -xf /dependencies.tar');
    expect(check.tail).toEqual(['refit-check', 'dashboard', 'npm', 'test']);
    // The sandbox label expires a minute after the check's own deadline.
    expect(check.remainingMs).toBeGreaterThan(600_000 + 60_000 - 30_000);
    expect(check.remainingMs).toBeLessThanOrEqual(600_000 + 60_000);
  }
  const limited = await validate(45);
  expect(limited.validation.limits.timeoutMs).toBe(45_000);
  for (const check of (await calls()).slice(-2))
    expect(check.remainingMs).toBeLessThanOrEqual(45_000 + 60_000);
  await expect(validate(29)).rejects.toThrow(
    'checkTimeoutSeconds must be a whole number from 30 to 1800.',
  );
  // refit run reads the limit from its configuration file, whose schema .refit.json shares.
  const configuration = join(root, 'run.json');
  await writeFile(
    configuration,
    JSON.stringify({
      formatVersion: 1,
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      prepareDependencies: true,
      checkTimeoutSeconds: 75,
    }),
  );
  const output = join(root, 'run');
  // A run whose findings stay unresolved exits 2; the report is what this test reads.
  await execute(process.execPath, [
    resolve('bin/refit.mjs'),
    'run',
    '--config',
    configuration,
    '--output',
    output,
    '--quiet',
    '--json',
  ]).catch((error: unknown) => error);
  const run = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  expect(run.validation).toMatchObject({
    status: 'passed',
    packageDirectory: 'dashboard',
    limits: { timeoutMs: 75_000 },
  });
  for (const check of (await calls()).slice(-2))
    expect(check.remainingMs).toBeLessThanOrEqual(75_000 + 60_000);
});

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'prepares a nested npm workspace in real Docker and runs its check in it, offline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-package-docker-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await cp(resolve('pipeline/fixtures/npm-workspaces/repository'), join(repository, 'service'), {
      recursive: true,
    });
    await commit(repository, { 'README.md': 'Several services.\n' });
    const prepared = await prepareDependencies({
      repository,
      image: IMAGE!,
      cacheDirectory: join(root, 'cache'),
      packageDirectory: 'service',
    });
    const name = `refit-package-check-${randomUUID()}`;
    try {
      const { stdout } = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: repository,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          timeoutMs: 120_000,
          packageDirectory: 'service',
          command: [
            'node',
            '-e',
            "const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(process.cwd(),'/workspace/service');assert.equal(typeof require('stripe'),'function');assert.equal(fs.realpathSync('node_modules/@refit-fixture/billing'),'/workspace/service/packages/billing');assert.equal(fs.existsSync('node_modules/root-script-ran'),false);assert.equal(fs.existsSync('/workspace/node_modules'),false);assert.equal(fs.readFileSync('../README.md','utf8'),'Several services.\\n');console.log('nested package checked');",
          ],
        }),
      );
      expect(stdout).toContain('nested package checked');
    } finally {
      await removeDockerContainer(name);
    }
  },
  180_000,
);

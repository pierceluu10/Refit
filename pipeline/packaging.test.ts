import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
const bin = resolve('bin/refit.mjs');
const packager = resolve('scripts/package-cli.mjs');

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-install-test-'));
  roots.push(root);
  return root;
}

async function pack(root: string) {
  const { stdout } = await execute(
    process.execPath,
    [packager, '--output', join(root, 'archives')],
    { timeout: 60_000 },
  );
  return JSON.parse(stdout) as {
    archive: string;
    version: string;
    files: string[];
    dependencies: Record<string, string>;
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('routes replay from an unrelated directory without reading its TypeScript configuration', async () => {
  const root = await directory();
  await writeFile(join(root, 'tsconfig.json'), 'not valid json');
  const result = await execute(process.execPath, [bin, 'replay', '--propose-patch'], { cwd: root });
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe('affected');
  expect(report.patch.status).toBe('proposed');
  expect(report.findings[0].file).toBe('billing.ts');
  await expect(
    execute(process.execPath, [bin, 'not-a-command'], { cwd: root }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown command') });
});

it('packs only CLI runtime sources, fixtures, docs and exact runtime dependencies', async () => {
  const root = await directory();
  const result = await pack(root);
  expect(result.files).toContain('bin/refit.mjs');
  expect(result.files).toContain('LICENSE');
  expect(result.files).toContain('pipeline/class-clients.ts');
  expect(result.files).toContain('docs/CLASS-CLIENTS.md');
  expect(result.files).toContain('pipeline/workflow.ts');
  expect(result.files).toContain('pipeline/github-app.ts');
  expect(result.files).toContain('public/refit-agent-avatar.png');
  expect(result.files).toContain('docs/GITHUB-APP.md');
  expect(result.files).toContain('docs/AUTOMATION.md');
  expect(result.files).toContain('pipeline/watch-cli.ts');
  expect(result.files).toContain('pipeline/service-cli.ts');
  expect(result.files).toContain('docs/LOCAL-SERVICE.md');
  expect(result.files).toContain('docs/DEPENDENCIES.md');
  expect(result.files).toContain('docs/ENDPOINT-MIGRATIONS.md');
  expect(result.files).toContain('docs/REPOSITORY-SETUP.md');
  expect(result.files).toContain('docs/APP-ONBOARDING.md');
  expect(result.files).toContain('docs/VENDOR_NOTES.md');
  expect(result.files).toContain('docs/API-VERSIONS.md');
  expect(result.files).toContain('docs/MULTIPLE-INTEGRATIONS.md');
  expect(result.files).toContain('docs/REQUEST-MIGRATIONS.md');
  expect(result.files).toContain('docs/CLIENT-MODULES.md');
  expect(result.files).toContain('docs/NPM-WORKSPACES.md');
  expect(result.files).toContain('docs/SOURCE-ALIASES.md');
  expect(result.files).toContain('pipeline/source-configurations.ts');
  expect(result.files).toContain('pipeline/fixtures/npm-workspaces/repository/package-lock.json');
  expect(result.files).toContain('pipeline/source-modules.ts');
  expect(result.files).toContain('docs/STRIPE-SUBSCRIPTION-PERIODS.md');
  expect(result.files).toContain('pipeline/stripe-sdk-metadata.json');
  expect(result.files).toContain('pipeline/fixtures/stripe-webhooks/provider-price-policy.json');
  expect(result.files).toContain('pipeline/sdk-constructors.ts');
  expect(result.files).toContain('pipeline/openapi-contracts.ts');
  expect(result.files).toContain('pipeline/provider-request-renames.ts');
  expect(result.files).toContain('pipeline/fixtures/request-renames/provider.json');
  expect(result.files).toContain('pipeline/fixtures/multiple-integrations/repository/.refit.json');
  expect(result.files).toContain(
    'pipeline/fixtures/multiple-integrations/repository/package-lock.json',
  );
  expect(result.files).toContain('pipeline/enrollment-cli.ts');
  expect(result.files).toContain('pipeline/repository-enrollment.ts');
  expect(result.files).toContain('pipeline/fixtures/endpoint-replacement/provider.json');
  expect(result.files).toContain('pipeline/provider-operation-replacements.ts');
  expect(result.files).toContain('pipeline/dependency-preparation.ts');
  expect(result.files).toContain('pipeline/readiness-cli.ts');
  expect(result.files).toContain('pipeline/dependency-inputs.ts');
  expect(result.files).toContain('pipeline/pnpm-inputs.ts');
  expect(result.files).toContain('pipeline/pnpm-install.ts');
  expect(result.files).toContain('examples/billing-demo.npm.refit.json');
  expect(result.files).toContain('examples/local-service.npm.refit.json');
  expect(result.files).toContain('pipeline/fixtures/repository/billing.ts');
  expect(
    result.files.some(
      (file) =>
        file.includes('.test.') || file.startsWith('src/') || file.startsWith('node_modules/'),
    ),
  ).toBe(false);
  expect(Object.keys(result.dependencies).sort()).toEqual([
    'diff',
    'fast-xml-parser',
    'parse5',
    'tsx',
    'typescript-compiler',
    'yaml',
  ]);
  expect(result.dependencies.tsx).toMatch(/^\d+\.\d+\.\d+/);
  expect(result.dependencies['typescript-compiler']).toMatch(/^npm:typescript@\d+\.\d+\.\d+/);
  const extracted = await execute('tar', ['-xOf', result.archive, 'package/package.json']);
  const metadata = JSON.parse(extracted.stdout);
  expect(metadata.bin.refit).toBe('bin/refit.mjs');
  expect(metadata.private).toBe(true);
  expect(metadata.scripts).toBeUndefined();
  const readme = await execute('tar', ['-xOf', result.archive, 'package/README.md']);
  expect(readme.stdout).toBe(await readFile(resolve('README.md'), 'utf8'));
  await expect(pack(root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('EEXIST'),
  });
}, 60_000);

it.skipIf(!process.env.REFIT_PACKAGE_INSTALL)(
  'installs the archive independently and runs its executable and bundled replay',
  async () => {
    const root = await directory();
    const result = await pack(root);
    const prefix = join(root, 'installed');
    await execute(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        result.archive,
      ],
      { cwd: root, timeout: 120_000 },
    );
    const installed = join(prefix, 'node_modules/.bin/refit');
    expect((await execute(installed, ['--version'], { cwd: root })).stdout.trim()).toBe(
      result.version,
    );
    const replay = JSON.parse(
      (await execute(installed, ['replay', '--propose-patch'], { cwd: root })).stdout,
    );
    expect(replay.status).toBe('affected');
    expect(replay.patch.status).toBe('proposed');
    const fixture = join(
      prefix,
      'node_modules/refit/pipeline/fixtures/multiple-integrations/repository',
    );
    const output = join(root, 'selected-stripe');
    await expect(
      execute(
        installed,
        [
          'run',
          '--repository',
          fixture,
          '--config',
          join(fixture, '.refit.json'),
          '--integration',
          'stripe',
          '--output',
          output,
          '--json',
        ],
        { cwd: root },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"integration": "stripe"'),
    });
    await expect(
      execute(
        installed,
        [
          'run',
          '--repository',
          fixture,
          '--config',
          join(fixture, '.refit.json'),
          '--output',
          join(root, 'ambiguous-run'),
        ],
        { cwd: root },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--integration'),
    });
    for (const command of [
      'scan',
      'run',
      'validate',
      'stripe-snapshot',
      'source-snapshot',
      'adapter-suggest',
      'stripe-check',
      'demo',
      'verify',
      'watch',
      'serve',
      'prepare',
      'doctor',
      'enroll',
    ]) {
      expect((await execute(installed, [command, '--help'], { cwd: root })).stdout).toContain(
        'Usage:',
      );
    }
  },
  180_000,
);

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { readPackageManifests } from './package-manifests.ts';
import {
  exclusionReason,
  globMatcher,
  placeFinding,
  readWorkspaceLayout,
} from './workspace-attribution.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-workspaces-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const manifest = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, ...extra });

describe('workspace layouts', () => {
  it('reads npm workspaces, including negated globs', async () => {
    const root = await repository({
      'package.json': manifest('root', {
        workspaces: ['apps/*', 'packages/**', '!packages/legacy'],
      }),
      'apps/web/package.json': manifest('@acme/web'),
      'packages/ui/button/package.json': manifest('@acme/button'),
      'packages/legacy/package.json': manifest('@acme/legacy'),
      'tools/script/package.json': manifest('script'),
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.tools).toEqual(['npm']);
    expect(layout.packages.map((item) => [item.path, item.name, item.member])).toEqual([
      ['.', 'root', true],
      ['apps/web', '@acme/web', true],
      ['packages/legacy', '@acme/legacy', false],
      ['packages/ui/button', '@acme/button', true],
      ['tools/script', 'script', false],
    ]);
  });

  it("reads Yarn's { packages } form and marks Yarn by its lockfile", async () => {
    const root = await repository({
      'package.json': manifest('shop', { workspaces: { packages: ['extensions/*'] } }),
      'yarn.lock': '',
      'extensions/discount/package.json': manifest('discount'),
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.tools).toEqual(['yarn']);
    expect(layout.packages.find((item) => item.path === 'extensions/discount')?.member).toBe(true);
  });

  it('reads pnpm-workspace.yaml, Lerna, Rush, Nx project.json and Turborepo', async () => {
    const root = await repository({
      'package.json': manifest('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'lerna.json': JSON.stringify({ packages: ['libs/*'] }),
      'rush.json':
        '// rush config\n{ "projects": [{ "packageName": "svc", "projectFolder": "services/svc" }] }',
      'nx.json': '{}',
      'turbo.json': '{}',
      'apps/api/package.json': manifest('api'),
      'libs/core/package.json': manifest('core'),
      'services/svc/package.json': manifest('svc'),
      'apps/admin/project.json': JSON.stringify({ name: 'admin' }),
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.tools).toEqual(['lerna', 'nx', 'pnpm', 'rush', 'turborepo']);
    expect(layout.packages.map((item) => [item.path, item.name, item.member])).toEqual([
      ['.', 'root', true],
      ['apps/admin', 'admin', true],
      ['apps/api', 'api', true],
      ['libs/core', 'core', true],
      ['services/svc', 'svc', true],
    ]);
  });

  it('treats nested package.json files without workspaces as packages that are not members', async () => {
    const root = await repository({
      'backend/package.json': manifest('backend'),
      'frontend/package.json': manifest('frontend'),
      'frontend/src/pay.ts': "export const host = 'https://api.stripe.com';\n",
      'scripts/seed.ts': "export const host = 'https://api.stripe.com';\n",
      'api/pyproject.toml': '[project]\nname = "api"\n',
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.tools).toEqual([]);
    expect(layout.packages.map((item) => [item.path, item.name, item.member])).toEqual([
      ['api', 'api', false],
      ['backend', 'backend', false],
      ['frontend', 'frontend', false],
    ]);
    expect(placeFinding(layout, 'frontend/src/pay.ts')).toEqual({
      workspace: { path: 'frontend', name: 'frontend' },
      excluded: null,
    });
    // A file outside every package belongs to none.
    expect(placeFinding(layout, 'scripts/seed.ts')).toEqual({ workspace: null, excluded: null });
  });

  it('matches workspace globs as npm does', () => {
    const member = globMatcher(['./apps/*/', 'packages/**', '!packages/old']);
    expect(['apps/web', 'apps/web/nested', 'packages/a/b', 'packages/old'].map(member)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});

describe('exclusions', () => {
  it.each([
    ['node_modules/stripe/index.js', 'node-modules'],
    ['vendor/acme/client.js', 'vendored'],
    ['packages/web/third_party/sdk.js', 'vendored'],
    ['apps/web/out/server.js', 'build-output'],
    ['apps/web/.next/server/page.js', 'build-output'],
    ['public/assets/app.min.js', 'build-output'],
    ['examples/checkout/index.ts', 'example'],
    ['packages/sdk/samples/basic.ts', 'example'],
    ['apps/demo/server.ts', 'example'],
    ['apps/docs/pages/api.mdx.ts', 'docs-site'],
    ['website/src/stripe.ts', 'docs-site'],
    ['src/__fixtures__/stripe.ts', 'test-fixture'],
    ['test/fixtures/project/index.ts', 'test-fixture'],
    ['src/lib/stripe.ts', null],
    // Only directories count: a file named after a reason is product code.
    ['src/examples.ts', null],
  ])('%s is %s', (file, reason) => {
    expect(exclusionReason(file)).toBe(reason);
  });
});

describe('attribution in detectProviders and scanDeadlines', () => {
  it('attributes detections to their package, flags excluded paths and reads nested lockfiles', async () => {
    const root = await repository({
      'package.json': manifest('root', { workspaces: ['apps/*'] }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', workspaces: ['apps/*'] },
          'apps/web': { name: 'web', dependencies: { stripe: '^17.0.0' } },
          'node_modules/stripe': { version: '17.7.0' },
        },
      }),
      'apps/web/package.json': manifest('web', { dependencies: { stripe: '^17.0.0' } }),
      // A nested app outside the workspaces, with its own lockfile.
      'tools/billing/package.json': manifest('billing', { dependencies: { stripe: '^14.0.0' } }),
      'tools/billing/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'billing', dependencies: { stripe: '^14.0.0' } },
          'node_modules/stripe': { version: '14.25.0' },
        },
      }),
      'examples/checkout/package.json': manifest('checkout-example', {
        dependencies: { stripe: '^12.0.0' },
      }),
      'examples/checkout/index.ts': "fetch('https://api.stripe.com/v1/charges');\n",
    });
    const [stripe] = await detectProviders(root);
    expect(
      stripe.packages.map((item) => [item.file, item.locked, item.workspace?.name, item.excluded]),
    ).toEqual([
      ['apps/web/package.json', '17.7.0', 'web', null],
      ['examples/checkout/package.json', null, 'checkout-example', 'example'],
      ['tools/billing/package.json', '14.25.0', 'billing', null],
    ]);
    expect(stripe.hostnames).toEqual([
      {
        file: 'examples/checkout/index.ts',
        line: 1,
        hostname: 'api.stripe.com',
        workspace: { path: 'examples/checkout', name: 'checkout-example' },
        excluded: 'example',
      },
    ]);
  });

  it('keeps an excluded deadline match out of live evidence, with its reason and package', async () => {
    const root = await repository({
      'package.json': manifest('root', { workspaces: ['apps/*'] }),
      'apps/api/package.json': manifest('api'),
      'apps/api/src/chat.ts': "client.chat.completions.create({ model: 'gpt-4.5-preview' });\n",
      'docs/snippets/chat.ts': "client.chat.completions.create({ model: 'gpt-4.5-preview' });\n",
    });
    const registry = await loadDeadlineRegistry();
    const scan = await scanDeadlines(root, registry, new Date('2026-10-22T00:00:00Z'));
    const exposure = [...scan.exposures, ...scan.mentions].find((item) =>
      item.deadline.versions.includes('gpt-4.5-preview'),
    )!;
    expect(exposure.evidence.map((item) => [item.file, item.use, item.workspace?.name])).toEqual([
      ['apps/api/src/chat.ts', 'live', 'api'],
    ]);
    expect(
      exposure.nonLive.map((item) => [item.file, item.use, item.excluded, item.workspace]),
    ).toEqual([['docs/snippets/chat.ts', 'excluded', 'docs-site', { path: '.', name: 'root' }]]);
    expect(exposure.nonLiveCounts).toEqual({ excluded: 1 });
  });
});

describe('Python, Rust and Go monorepos', () => {
  // A real uv workspace (fixture header names its commit): one uv.lock at the root locks both
  // members' dependencies.
  const UV_WORKSPACE = join(import.meta.dirname, 'fixtures', 'workspace-attribution', 'uv-backai');

  it('reads uv workspace members and locks member dependencies from the root uv.lock', async () => {
    const layout = await readWorkspaceLayout(UV_WORKSPACE);
    expect(layout.tools).toEqual(['uv']);
    expect(layout.packages.map((item) => [item.path, item.name, item.member])).toEqual([
      ['.', 'af-stack-workspace', true],
      ['apps/backend', 'af-stack-backend', true],
      ['packages/sdk-py', 'af-stack', true],
    ]);
    const inventory = await readPackageManifests(UV_WORKSPACE);
    expect(
      inventory.dependencies
        .filter(
          (item) =>
            item.file === 'packages/sdk-py/pyproject.toml' &&
            ['httpx', 'pydantic', 'anyio'].includes(item.name),
        )
        .map((item) => [item.name, item.locked, placeFinding(layout, item.file).workspace?.name]),
    ).toEqual([
      ['httpx', '0.28.1', 'af-stack'],
      ['pydantic', '2.13.4', 'af-stack'],
      ['anyio', '4.13.0', 'af-stack'],
    ]);
  });

  it('attributes provider SDKs in several pyproject.toml files to their own package', async () => {
    const root = await repository({
      'pyproject.toml':
        '[project]\nname = "suite"\n[tool.uv.workspace]\nmembers = ["services/*"]\nexclude = ["services/old"]\n',
      'services/chat/pyproject.toml': '[project]\nname = "chat"\ndependencies = ["openai>=1.40"]\n',
      'services/billing/pyproject.toml':
        '[project]\nname = "billing"\ndependencies = ["stripe==12.0.0"]\n',
      'services/old/pyproject.toml': '[project]\nname = "old"\ndependencies = ["anthropic"]\n',
      'examples/bot/pyproject.toml': '[project]\nname = "bot"\ndependencies = ["anthropic"]\n',
      'uv.lock': '[[package]]\nname = "openai"\nversion = "1.52.0"\n',
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.packages.filter((item) => item.member).map((item) => item.path)).toEqual([
      '.',
      'services/billing',
      'services/chat',
    ]);
    expect(
      (await detectProviders(root)).map((detection) => [
        detection.agent.id,
        detection.packages.map(
          (item) =>
            `${item.workspace?.name}:${item.locked ?? (item.version || '-')}${item.excluded ? ` (${item.excluded})` : ''}`,
        ),
      ]),
    ).toEqual([
      ['stripe', ['billing:==12.0.0']],
      ['openai', ['chat:1.52.0']],
      ['anthropic', ['bot:- (example)', 'old:-']],
    ]);
  });

  it('reads Cargo workspace members and go.work modules', async () => {
    const root = await repository({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/scratch"]\n',
      'crates/api/Cargo.toml': '[package]\nname = "api"\n',
      'crates/scratch/Cargo.toml': '[package]\nname = "scratch"\n',
      'go.work': 'go 1.23\n\nuse (\n\t./svc/payments\n\t./svc/mail\n)\nuse ./tools\n',
      'svc/payments/go.mod': 'module example.com/payments\n',
      'svc/mail/go.mod': 'module example.com/mail\n',
      'tools/go.mod': 'module example.com/tools\n',
      'legacy/go.mod': 'module example.com/legacy\n',
    });
    const layout = await readWorkspaceLayout(root);
    expect(layout.tools).toEqual(['cargo', 'go']);
    expect(layout.packages.map((item) => [item.path, item.name, item.member])).toEqual([
      ['.', null, true],
      ['crates/api', 'api', true],
      ['crates/scratch', 'scratch', false],
      ['legacy', 'example.com/legacy', false],
      ['svc/mail', 'example.com/mail', true],
      ['svc/payments', 'example.com/payments', true],
      ['tools', 'example.com/tools', true],
    ]);
  });
});

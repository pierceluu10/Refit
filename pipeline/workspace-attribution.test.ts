import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { readPackageManifests } from './package-manifests.ts';
import {
  exclusionReason,
  globMatcher,
  IGNORE_PATHS_FILE,
  placeFinding,
  readIgnoredPaths,
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
  it('does not read a nested lockfile through a symlink', async () => {
    const outside = await repository({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/stripe': { version: '14.25.0' } },
      }),
    });
    const root = await repository({
      'package.json': manifest('root'),
      'tools/billing/package.json': manifest('billing', { dependencies: { stripe: '^14.0.0' } }),
    });
    await symlink(
      join(outside, 'package-lock.json'),
      join(root, 'tools/billing/package-lock.json'),
    );
    const [stripe] = await detectProviders(root);
    expect(stripe.packages.map((item) => [item.file, item.locked])).toEqual([
      ['tools/billing/package.json', null],
    ]);
  });

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

  const CALL = "client.chat.completions.create({ model: 'gpt-4.5-preview' });\n";
  const scanFor = async (root: string) => {
    const scan = await scanDeadlines(
      root,
      await loadDeadlineRegistry(),
      new Date('2026-10-22T00:00:00Z'),
    );
    const find = (list: typeof scan.exposures) =>
      list.find((item) => item.deadline.versions.includes('gpt-4.5-preview'));
    return { exposure: find(scan.exposures), mention: find(scan.mentions) };
  };

  // Owner decision 22: a match outside application code still counts everywhere, labelled.
  it('counts matches in application code and outside it, labelling the latter', async () => {
    const root = await repository({
      'package.json': manifest('root', { workspaces: ['apps/*'] }),
      'apps/api/package.json': manifest('api'),
      'apps/api/src/chat.ts': CALL,
      'docs/snippets/chat.ts': CALL,
      'demo/chat.ts': CALL,
      'mocks/chat.ts': CALL,
      'out/chat.js': CALL,
      'examples/chat.ts': CALL,
    });
    const { exposure, mention } = await scanFor(root);
    expect(mention).toBeUndefined();
    expect(
      exposure!.evidence.map((item) => [item.file, item.use, item.excluded, item.workspace?.name]),
    ).toEqual([
      ['apps/api/src/chat.ts', 'live', null, 'api'],
      ['demo/chat.ts', 'live', 'example', 'root'],
      ['docs/snippets/chat.ts', 'live', 'docs-site', 'root'],
      ['mocks/chat.ts', 'live', 'test-fixture', 'root'],
      ['out/chat.js', 'live', 'build-output', 'root'],
    ]);
    // examples/ was a test path before workspace attribution, so it stays a labelled test match.
    expect(exposure!.nonLive.map((item) => [item.file, item.use, item.excluded])).toEqual([
      ['examples/chat.ts', 'test', 'example'],
    ]);
    expect(exposure!.ignoredPaths).toEqual([]);
  });

  // embedbase's docs/ is a deployed Next.js site whose API route calls OpenAI live.
  it('counts a deployed docs site that calls a provider live', async () => {
    const root = await repository({
      'package.json': manifest('root'),
      'docs/package.json': manifest('docs'),
      'docs/pages/api/qa.ts': [
        "import OpenAI from 'openai';",
        'const openai = new OpenAI();',
        'export default async function handler() {',
        "  return openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
        '}',
        '',
      ].join('\n'),
    });
    const scan = await scanDeadlines(
      root,
      await loadDeadlineRegistry(),
      new Date('2026-10-22T00:00:00Z'),
    );
    const exposure = scan.exposures.find((item) => item.deadline.id === 'openai-2026-10-23-gpt-4');
    expect(exposure!.evidence.map((item) => [item.file, item.line, item.excluded])).toEqual([
      ['docs/pages/api/qa.ts', 4, 'docs-site'],
    ]);
  });

  it('lists a path the repository opts out, with its reason, without counting it', async () => {
    const root = await repository({
      'package.json': manifest('root'),
      [IGNORE_PATHS_FILE]: JSON.stringify({
        formatVersion: 1,
        paths: [{ path: 'website', reason: 'static marketing site, never deployed with keys' }],
      }),
      'website/pages/chat.ts': CALL,
      'docs/chat.ts': CALL,
    });
    const { exposure } = await scanFor(root);
    expect(exposure!.evidence.map((item) => item.file)).toEqual(['docs/chat.ts']);
    expect(exposure!.ignoredPaths!.map((item) => [item.file, item.ignoreReason])).toEqual([
      ['website/pages/chat.ts', 'static marketing site, never deployed with keys'],
    ]);
  });

  it('makes a deadline matched only on ignored paths a mention', async () => {
    const root = await repository({
      'package.json': manifest('root'),
      [IGNORE_PATHS_FILE]: JSON.stringify({
        formatVersion: 1,
        paths: [{ path: 'apps/*/demo/**', reason: 'demo builds use a mock server' }],
      }),
      'apps/shop/demo/chat.ts': CALL,
    });
    const { exposure, mention } = await scanFor(root);
    expect(exposure).toBeUndefined();
    expect(mention!.ignoredPaths!.map((item) => [item.file, item.ignoreReason])).toEqual([
      ['apps/shop/demo/chat.ts', 'demo builds use a mock server'],
    ]);
  });

  it('prints the label and the ignored path in refit deadlines, and fails --fail-within on docs alone', async () => {
    const root = await repository({
      'package.json': manifest('root'),
      [IGNORE_PATHS_FILE]: JSON.stringify({
        formatVersion: 1,
        paths: [{ path: 'website', reason: 'static marketing site' }],
      }),
      'docs/pages/api/chat.ts': CALL,
      'website/chat.ts': CALL,
    });
    const run = promisify(execFile)(process.execPath, [
      resolve('bin/refit.mjs'),
      'deadlines',
      '--repository',
      root,
      '--fail-within',
      '3650',
    ]);
    const failed = await run.then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    );
    expect(failed?.code).toBe(2);
    expect(failed?.stdout).toContain(
      'docs/pages/api/chat.ts:1  ' +
        CALL.trim() +
        '  (counted; outside application code: docs-site)',
    );
    expect(failed?.stdout).toMatch(
      /Ignored by repository config \(\.refit-ignore-paths\.json, not counted\):\n\s+website\/chat\.ts:1 {2}static marketing site/,
    );
  });

  it.each([
    ['no reason', { formatVersion: 1, paths: [{ path: 'docs' }] }],
    ['an empty reason', { formatVersion: 1, paths: [{ path: 'docs', reason: ' ' }] }],
    ['a bare string', { formatVersion: 1, paths: ['docs'] }],
    ['a parent path', { formatVersion: 1, paths: [{ path: '../app', reason: 'x' }] }],
    ['an absolute path', { formatVersion: 1, paths: [{ path: '/srv/app', reason: 'x' }] }],
    ['an unknown key', { formatVersion: 1, paths: [{ path: 'docs', reason: 'x', all: true }] }],
    ['no paths list', { formatVersion: 1 }],
    ['another format version', { formatVersion: 2, paths: [] }],
  ])('refuses an ignore paths file with %s', async (_name, content) => {
    const root = await repository({
      'package.json': manifest('root'),
      [IGNORE_PATHS_FILE]: JSON.stringify(content),
    });
    await expect(readIgnoredPaths(root)).rejects.toThrow(IGNORE_PATHS_FILE);
    await expect(scanFor(root)).rejects.toThrow(IGNORE_PATHS_FILE);
  });

  it('refuses an ignore paths file that is not JSON', async () => {
    const root = await repository({ 'package.json': manifest('root'), [IGNORE_PATHS_FILE]: '{' });
    await expect(readIgnoredPaths(root)).rejects.toThrow(IGNORE_PATHS_FILE);
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

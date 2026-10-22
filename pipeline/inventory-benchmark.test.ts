import { describe, expect, it } from 'vitest';
import {
  applicationReason,
  dependencyDeclarations,
  excludedName,
  importSpecifiers,
  isProduction,
  missCategory,
  scoreInventory,
  sourceFileCount,
  urlHosts,
  validateLabels,
  wilson,
  type CatalogEntry,
  type Label,
  type LabelsFile,
  type ResultsFile,
} from '../scripts/inventory-benchmark-helpers.mjs';

const SHA = 'a'.repeat(40);
const CATALOG: CatalogEntry[] = [
  { id: 'stripe', packages: ['stripe'], hostnames: ['api.stripe.com'] },
  { id: 'openai', packages: ['openai'], hostnames: ['api.openai.com'] },
  { id: 'shopify', packages: ['@shopify/shopify-api'], hostnames: ['myshopify.com/admin/api'] },
];

function label(provider: string, fields: Partial<Label> = {}): Label {
  return {
    provider,
    via: 'sdk',
    package: provider,
    host: null,
    language: 'typescript',
    file: 'src/index.ts',
    line: 1,
    monorepo: false,
    ...fields,
  };
}

describe('sampling', () => {
  it('excludes tutorials, libraries and templates by name or topic, never by owner', () => {
    expect(excludedName('acme/nextjs-starter')).toBe(true);
    expect(excludedName('acme/shop', ['tutorial'])).toBe(true);
    expect(excludedName('example-org/shop')).toBe(false);
    expect(excludedName('acme/invoice-app')).toBe(false);
  });

  it('counts source files per language outside vendored and generated directories', () => {
    const paths = [
      'src/a.ts',
      'src/b.tsx',
      'src/types.d.ts',
      'node_modules/x/index.js',
      'public/app.min.js',
      'main.go',
      'main_test.go',
      'vendor/github.com/x/y.go',
      'app.py',
      '.venv/lib/site.py',
    ];
    expect(sourceFileCount('js-ts', paths)).toBe(2);
    expect(sourceFileCount('go', paths)).toBe(1);
    expect(sourceFileCount('python', paths)).toBe(1);
  });

  it('classes applications per language and rejects libraries', () => {
    // A single package needs an app marker; a package.json that only configures tooling is not one.
    expect(
      applicationReason('js-ts', ['package.json', 'src/app/page.tsx'], {
        'package.json': { private: true },
      }),
    ).toBe('private, marker:src/app/');
    expect(
      applicationReason('js-ts', ['package.json', 'index.js'], {
        'package.json': { dependencies: { express: '5' } },
      }),
    ).toBe('unpublished, dependency:express');
    expect(
      applicationReason('js-ts', ['package.json'], { 'package.json': { private: true } }),
    ).toBe(null);
    // A private workspace root counts only through a workspace with an app marker.
    const workspace = ['package.json', 'pnpm-workspace.yaml', 'packages/core/package.json'];
    const libraries = {
      'package.json': { private: true },
      'packages/core/package.json': { private: true, main: 'dist/index.js' },
    };
    expect(applicationReason('js-ts', workspace, libraries)).toBe(null);
    expect(
      applicationReason(
        'js-ts',
        [...workspace, 'apps/web/package.json', 'apps/web/next.config.mjs'],
        {
          ...libraries,
          'apps/web/package.json': { private: true },
        },
      ),
    ).toBe('apps/web: marker:next.config.mjs');
    expect(
      applicationReason('js-ts', ['package.json', 'server/package.json'], {
        'package.json': { private: true, workspaces: ['server'] },
        'server/package.json': { dependencies: { fastify: '5' } },
      }),
    ).toBe('server: dependency:fastify');
    expect(applicationReason('js-ts', ['package.json'], { 'package.json': { main: 'x.js' } })).toBe(
      null,
    );
    expect(applicationReason('python', ['requirements.txt', 'src/app.py'])).toBe(
      'requirements.txt + src/app.py',
    );
    expect(applicationReason('python', ['pyproject.toml', 'pkg/core/lib.py'])).toBe(null);
    expect(applicationReason('go', ['go.mod', 'cmd/server/main.go'])).toBe(
      'go.mod + cmd/server/main.go',
    );
    expect(applicationReason('go', ['go.mod', 'client.go'])).toBe(null);
  });
});

describe('candidate search', () => {
  it('separates production code from tests, scripts, examples and config', () => {
    expect(isProduction('src/server/billing.ts')).toBe(true);
    expect(isProduction('src/billing.test.ts')).toBe(false);
    expect(isProduction('scripts/seed.ts')).toBe(false);
    expect(isProduction('examples/basic/index.js')).toBe(false);
    expect(isProduction('app/tests/test_views.py')).toBe(false);
    expect(isProduction('internal/pay/pay_test.go')).toBe(false);
    expect(isProduction('vite.config.ts')).toBe(false);
  });

  it('finds bare imports in JS, Python and Go, with lines', () => {
    expect(
      importSpecifiers(
        'a.ts',
        "import S3 from '@aws-sdk/client-s3/dist';\nconst stripe = require('stripe');\nimport '@/lib/x';\nimport x from './y';",
      ),
    ).toEqual([
      { specifier: '@aws-sdk/client-s3', line: 1, language: 'js' },
      { specifier: 'stripe', line: 2, language: 'js' },
    ]);
    expect(
      importSpecifiers('a.py', 'import os, boto3\nfrom openai.types import X\nfrom . import y'),
    ).toEqual([
      { specifier: 'os', line: 1, language: 'python' },
      { specifier: 'boto3', line: 1, language: 'python' },
      { specifier: 'openai', line: 2, language: 'python' },
    ]);
    expect(
      importSpecifiers(
        'a.go',
        'import (\n\t"fmt"\n\tstripe "github.com/stripe/stripe-go/v82"\n)\nimport "net/http"',
      ),
    ).toEqual([
      { specifier: 'fmt', line: 2, language: 'go' },
      { specifier: 'github.com/stripe/stripe-go/v82', line: 3, language: 'go' },
      { specifier: 'net/http', line: 5, language: 'go' },
    ]);
  });

  it('lists URL hosts and skips placeholders', () => {
    expect(
      urlHosts(
        'fetch("https://api.Stripe.com/v1")\n// see http://localhost:3000 and https://example.com',
      ),
    ).toEqual([{ host: 'api.stripe.com', line: 1 }]);
  });

  it('reads dependency declarations from each manifest format', () => {
    expect(
      dependencyDeclarations(
        'package.json',
        '{"dependencies":{"stripe":"1"},"devDependencies":{"vitest":"1"}}',
      ),
    ).toEqual([
      { name: 'stripe', dev: false, file: 'package.json' },
      { name: 'vitest', dev: true, file: 'package.json' },
    ]);
    expect(
      dependencyDeclarations('requirements.txt', 'Django==5.0  # web\n-r base.txt\nboto3>=1'),
    ).toEqual([
      { name: 'django', dev: false, file: 'requirements.txt' },
      { name: 'boto3', dev: false, file: 'requirements.txt' },
    ]);
    expect(
      dependencyDeclarations(
        'pyproject.toml',
        '[project]\nname = "app"\ndependencies = ["requests[socks]>=2.0", "openai"]\nrequires-python = ">=3.11"\n[project.optional-dependencies]\ndev = [\n  "pytest>=8",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nstripe = "^9"\n',
      ).map((d) => `${d.name}${d.dev ? ' (dev)' : ''}`),
    ).toEqual(['requests', 'openai', 'pytest (dev)', 'stripe']);
    expect(
      dependencyDeclarations(
        'go.mod',
        'module x\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/stripe/stripe-go/v82 v82.1.0\n\tgolang.org/x/sys v0.1.0 // indirect\n)',
      ).map((d) => `${d.name}${d.dev ? ' (indirect)' : ''}`),
    ).toEqual(['github.com/a/b', 'github.com/stripe/stripe-go/v82', 'golang.org/x/sys (indirect)']);
  });
});

describe('labels', () => {
  const list = {
    repos: [
      { repo: 'a/one', commit: SHA },
      { repo: 'a/two', commit: SHA },
    ],
  };

  it('accepts a complete labels file', () => {
    const labels: LabelsFile = {
      repos: [
        { repo: 'a/one', commit: SHA, none: false, labels: [label('stripe')] },
        { repo: 'a/two', commit: SHA, none: true, labels: [] },
      ],
    };
    expect(validateLabels(list, labels)).toEqual([]);
  });

  it('reports a missing repository, a wrong commit, bad fields and duplicates', () => {
    const labels: LabelsFile = {
      repos: [
        {
          repo: 'a/one',
          commit: 'b'.repeat(40),
          none: true,
          labels: [
            label('Stripe'),
            label('openai', { via: 'http', host: null, line: 0 }),
            label('aws', { file: '../x' }),
            label('aws', { file: '../x' }),
          ],
        },
      ],
    };
    expect(validateLabels(list, labels)).toEqual([
      { repo: 'a/one', problem: 'commit differs from the frozen list' },
      { repo: 'a/one', problem: 'none must be true exactly when labels is empty' },
      { repo: 'a/one', problem: 'provider id Stripe' },
      { repo: 'a/one', problem: 'openai: http label without host' },
      { repo: 'a/one', problem: 'openai: line' },
      { repo: 'a/one', problem: 'aws: file' },
      { repo: 'a/one', problem: 'aws: file' },
      { repo: 'a/one', problem: 'duplicate label aws|sdk|aws' },
      { repo: 'a/two', problem: 'not labelled' },
    ]);
  });
});

describe('scoring', () => {
  it('categorises misses by the first matching rule', () => {
    expect(
      missCategory([label('stripe', { language: 'python', package: 'stripe' })], CATALOG).category,
    ).toBe('language not supported');
    expect(
      missCategory([label('supabase', { package: '@supabase/supabase-js' })], CATALOG),
    ).toEqual({
      category: 'provider not in catalog',
      detail: 'supabase',
    });
    expect(
      missCategory(
        [label('openai', { via: 'http', package: null, host: 'openai.azure.com' })],
        CATALOG,
      ).category,
    ).toBe('raw HTTP');
    expect(
      missCategory(
        [label('shopify', { via: 'http', package: null, host: 'x.myshopify.com' })],
        CATALOG,
      ).category,
    ).toBe('other');
    expect(
      missCategory([label('stripe', { monorepo: true, file: 'apps/web/pay.ts' })], CATALOG),
    ).toEqual({
      category: 'monorepo',
      detail: 'apps/web/pay.ts',
    });
    expect(missCategory([label('stripe', { package: '@stripe/stripe-js' })], CATALOG)).toEqual({
      category: 'other',
      detail: 'package not in catalog: @stripe/stripe-js',
    });
  });

  it('scores a tiny synthetic run per provider, per group and overall', () => {
    const labels: LabelsFile = {
      repos: [
        {
          repo: 'a/shop',
          commit: SHA,
          none: false,
          labels: [
            label('stripe'),
            label('stripe', { package: '@stripe/stripe-js', file: 'src/checkout.tsx', line: 4 }),
            label('supabase', { package: '@supabase/supabase-js', file: 'src/db.ts', line: 2 }),
          ],
        },
        { repo: 'a/quiet', commit: SHA, none: true, labels: [] },
        {
          repo: 'a/bot',
          commit: SHA,
          none: false,
          labels: [label('openai', { language: 'python', file: 'bot.py', line: 7 })],
        },
        { repo: 'a/broken', commit: SHA, none: false, labels: [label('stripe')] },
      ],
    };
    const results: ResultsFile = {
      catalog: CATALOG,
      repos: [
        {
          repo: 'a/shop',
          group: 'js-ts',
          detections: [
            { provider: 'stripe', detector: 'agents', files: ['package.json'] },
            { provider: 'openai', detector: 'agents', files: ['package.json'] },
          ],
        },
        {
          repo: 'a/quiet',
          group: 'js-ts',
          detections: [{ provider: 'openai', detector: 'deadlines', files: ['docs/x.ts:3'] }],
        },
        { repo: 'a/bot', group: 'python', detections: [] },
        { repo: 'a/broken', group: 'js-ts', error: 'checkout failed', detections: [] },
      ],
    };
    const score = scoreInventory(labels, results);
    // The errored repository reported nothing, so its Stripe label is a miss.
    expect(score.repositories).toBe(4);
    expect(score.errored).toEqual([{ repo: 'a/broken', error: 'checkout failed' }]);
    expect(score.catalogProviders).toMatchObject({
      truePositives: 1,
      falsePositives: 2,
      falseNegatives: 2,
    });
    expect(score.allProviders).toMatchObject({
      truePositives: 1,
      falsePositives: 2,
      falseNegatives: 3,
    });
    expect(score.perProvider.stripe).toMatchObject({
      inCatalog: true,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
    });
    expect(score.perProvider.openai).toMatchObject({
      truePositives: 0,
      falsePositives: 2,
      falseNegatives: 1,
    });
    expect(score.perProvider.supabase).toMatchObject({ inCatalog: false, falseNegatives: 1 });
    expect(score.byGroup.python.allProviders).toMatchObject({
      truePositives: 0,
      falseNegatives: 1,
    });
    expect(score.missesByCategory).toEqual({
      'language not supported': 1,
      'provider not in catalog': 1,
      'raw HTTP': 0,
      monorepo: 0,
      other: 1,
    });
    expect(
      score.falsePositives.map((item) => `${item.repo}:${item.provider}:${item.files.join(',')}`),
    ).toEqual(['a/shop:openai:package.json', 'a/quiet:openai:docs/x.ts:3']);
    expect(
      score.falseNegatives.map((item) => `${item.repo}:${item.provider}:${item.files.join(',')}`),
    ).toEqual([
      'a/shop:supabase:src/db.ts:2',
      'a/bot:openai:bot.py:7',
      'a/broken:stripe:src/index.ts:1',
    ]);
    expect(score.falseNegatives.at(-1)).toMatchObject({
      category: 'other',
      detail: 'Refit scan failed: checkout failed',
    });
  });

  it('computes Wilson intervals as percentages', () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
    expect(wilson(8, 10)).toEqual({ k: 8, n: 10, rate: 80, low: 49, high: 94.3 });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TYPE_CHECK_STARTED } from './check-selection.ts';
import {
  archivedShopifyTypes,
  archivedStripeTypes,
  errorSources,
  namedTypes,
  typeDeclarations,
  withoutBaselineErrors,
} from './repair-context.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const old = "src/old.ts(3,1): error TS2304: Cannot find name 'legacy'.";
const added =
  'src/pay.ts(9,5): error TS2322: Type \'"2026-02-25.clover"\' is not assignable to type \'"2026-09-30.endive"\'.';

it('leaves out the type errors the original code already had, with their continuation lines', () => {
  const baseline = { stdout: `${old}\n`, stderr: '' };
  const patched = [
    'test output mentioning src/old.ts(3,1): error TS2304',
    TYPE_CHECK_STARTED,
    old,
    '  The original error goes on here.',
    added,
    '  And the new one here.',
    'Found 2 errors.',
  ].join('\n');
  expect(withoutBaselineErrors(baseline, patched)).toBe(
    [
      'test output mentioning src/old.ts(3,1): error TS2304',
      TYPE_CHECK_STARTED,
      added,
      '  And the new one here.',
      'Found 2 errors.',
    ].join('\n'),
  );
  expect(withoutBaselineErrors({ stdout: '', stderr: '' }, patched)).toBe(patched);
});

it('gives each introduced error the source around it and names the stripe-node types it quotes', () => {
  const errors = [
    {
      file: 'src/pay.ts',
      line: 3,
      column: 5,
      code: 'TS2561',
      message:
        "Object literal may only specify known properties, but 'payment_method_types' does not exist in type 'Stripe.PaymentIntentCreateParams'.",
    },
    { file: 'src/pay.ts', line: 1, column: 1, code: 'TS2322', message: added },
  ];
  const content = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
  const [first] = errorSources(errors, [{ path: 'src/pay.ts', content }]);
  expect(first.source).toBe('1  a\n2  b\n3> c\n4  d\n5  e\n6  f\n7  g');
  expect(namedTypes(errors)).toEqual(['PaymentIntentCreateParams', 'LatestApiVersion']);
});

it('cuts each named declaration from the stripe-node type files at its closing brace', () => {
  const files = [
    {
      path: 'types/lib.d.ts',
      content:
        "declare module 'stripe' {\n  namespace Stripe {\n    export type LatestApiVersion = '2026-09-30.endive';\n  }\n}",
    },
    {
      path: 'types/PaymentIntentsResource.d.ts',
      content:
        'interface PaymentIntentCreateParams {\n  amount: number;\n  metadata?: { [key: string]: string };\n}\ninterface Other {}',
    },
  ];
  expect(
    typeDeclarations(['PaymentIntentCreateParams', 'LatestApiVersion', 'Missing'], files),
  ).toEqual([
    {
      file: 'types/PaymentIntentsResource.d.ts',
      name: 'PaymentIntentCreateParams',
      declaration:
        'interface PaymentIntentCreateParams {\n  amount: number;\n  metadata?: { [key: string]: string };\n}',
    },
    {
      file: 'types/lib.d.ts',
      name: 'LatestApiVersion',
      declaration: "    export type LatestApiVersion = '2026-09-30.endive';",
    },
  ]);
});

it('reads the checked package’s stripe-node types from a dependency archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-repair-context-'));
  directories.push(root);
  for (const [path, content] of [
    ['node_modules/stripe/types/lib.d.ts', 'type Root = 1;'],
    ['app/node_modules/stripe/types/lib.d.ts', 'type Package = 1;'],
    ['node_modules/stripe/cjs/index.js', ''],
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const archive = join(root, 'dependencies.tar');
  execFileSync('tar', ['-cf', archive, '-C', root, 'node_modules', 'app']);
  expect(await archivedStripeTypes(archive)).toEqual([
    { path: 'types/lib.d.ts', content: 'type Root = 1;' },
  ]);
  expect(await archivedStripeTypes(archive, 'app')).toEqual([
    { path: 'types/lib.d.ts', content: 'type Package = 1;' },
  ]);
});

it('reads the checked package’s @shopify declarations, named from the package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-repair-context-'));
  directories.push(root);
  for (const [path, content] of [
    ['node_modules/@shopify/shopify-api/dist/ts/lib/index.d.ts', 'type Root = 1;'],
    ['node_modules/@shopify/shopify-api/node_modules/@shopify/x/index.d.ts', 'type Nested = 1;'],
    ['node_modules/@shopify/shopify-api/dist/esm/index.mjs', ''],
    ['web/node_modules/@shopify/shopify-app-express/dist/index.d.ts', 'type Package = 1;'],
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const archive = join(root, 'dependencies.tar');
  execFileSync('tar', ['-cf', archive, '-C', root, 'node_modules', 'web']);
  expect(await archivedShopifyTypes(archive)).toEqual([
    { path: '@shopify/shopify-api/dist/ts/lib/index.d.ts', content: 'type Root = 1;' },
  ]);
  expect(await archivedShopifyTypes(archive, 'web')).toEqual([
    { path: '@shopify/shopify-app-express/dist/index.d.ts', content: 'type Package = 1;' },
  ]);
  // A package with no @shopify install of its own reads the root's.
  expect(await archivedShopifyTypes(archive, 'other')).toHaveLength(1);
});

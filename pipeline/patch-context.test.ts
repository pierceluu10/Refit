import { expect, it } from 'vitest';
import { buildPatchContext } from './patch-context.ts';
import type { Repository } from './types.ts';

function repository(files: Record<string, string>): Repository {
  return {
    root: '/virtual',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

it('supplies wrapper and client context transitively while excluding unrelated sources and cycles', () => {
  const input = repository({
    'billing/history.ts': "import {retrieve} from './payments.ts'; import Stripe from 'stripe';",
    'billing/payments.ts': "import {stripe} from '../client.ts';",
    'client.ts': "import {retrieve} from './billing/payments.ts'; export const stripe = {}",
    'unrelated.ts': 'export const unrelated = true;',
  });
  expect(
    buildPatchContext(input, new Set(['billing/history.ts'])).map((file) => file.path),
  ).toEqual(['billing/payments.ts', 'client.ts']);
});

it('resolves output extensions and declines ambiguous source/output pairs', () => {
  const files = {
    'history.ts': "import {client} from './client.js';",
    'client.ts': 'export const client = {};',
  };
  expect(buildPatchContext(repository(files), new Set(['history.ts']))).toHaveLength(1);
  expect(
    buildPatchContext(
      repository({ ...files, 'client.js': files['client.ts'] }),
      new Set(['history.ts']),
    ),
  ).toEqual([]);
});

it('keeps multiple editable files out of read-only context', () => {
  const input = repository({
    'one.ts': "import {two} from './two.ts';",
    'two.ts': 'export const two = true;',
  });
  expect(buildPatchContext(input, new Set(['one.ts', 'two.ts']))).toEqual([]);
});

it('rejects excessive import context instead of silently truncating essential evidence', () => {
  const files: Record<string, string> = {};
  const CONTEXT_CHAIN_LENGTH = 26;
  for (let index = 0; index < CONTEXT_CHAIN_LENGTH; index++)
    files[`${index}.ts`] =
      index + 1 < CONTEXT_CHAIN_LENGTH ? `import './${index + 1}.ts';` : 'export {};';
  expect(() => buildPatchContext(repository(files), new Set(['0.ts']))).toThrow(/context exceeds/);
  // A coverage request keeps the nearest 24 instead.
  expect(
    buildPatchContext(repository(files), new Set(['0.ts']), true).map((file) => file.path),
  ).toEqual(Array.from({ length: 24 }, (_, index) => `${index + 1}.ts`));
});

it('includes static CommonJS and import-equals dependencies transitively without following dynamic calls', () => {
  const input = repository({
    'history.cts': "const {retrieve} = require('./payments.cjs'); require(dynamicPath);",
    'payments.cts': "import client = require('./client.cjs');",
    'client.cts': "const Stripe = require('stripe'); module.exports = Stripe('test');",
    'unrelated.ts': 'export const secret = true;',
  });
  expect(buildPatchContext(input, new Set(['history.cts'])).map((file) => file.path)).toEqual([
    'payments.cts',
    'client.cts',
  ]);
});

it('adds the files that import an editable file to a coverage request, after its imports', () => {
  const files = {
    'billing.ts': "import { stripe } from './client.ts'; export const plan = (p) => p.price;",
    'client.ts': 'export const stripe = {};',
    'route.ts': "import { plan } from './billing.ts'; plan(PLANS.pro);",
    'unrelated.ts': 'export const unrelated = true;',
  };
  expect(
    buildPatchContext(repository(files), new Set(['billing.ts']), true).map((file) => file.path),
  ).toEqual(['client.ts', 'route.ts']);
  // The first patch keeps its imports only.
  expect(
    buildPatchContext(repository(files), new Set(['billing.ts'])).map((file) => file.path),
  ).toEqual(['client.ts']);
});

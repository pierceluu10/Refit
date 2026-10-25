import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stripeOnlyImports, stripeOnlyProject } from './dependency-stripe-only.ts';
import { validateNpmLock } from './npm-lock.ts';
import { readRepository } from './repository.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-stripe-only-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return readRepository(root, 'stripe');
}

// palashb01/DocuChat at 4f222d3a5131129ebeb7f4239c96bdd6392e38da (dev-30): package-lock.json's
// stripe 14.1.0 and the eleven records it needs, as committed, beside one record it does not.
const DOCUCHAT = {
  'node_modules/@types/node': {
    version: '20.8.2',
    resolved: 'https://registry.npmjs.org/@types/node/-/node-20.8.2.tgz',
    integrity:
      'sha512-Vvycsc9FQdwhxE3y3DzeIxuEJbWGDsnrxvMADzTDF/lcdR9/K+AQIeAghTQsHtotg/q0j3WEOYS/jQgSdWue3w==',
  },
  'node_modules/call-bind': {
    version: '1.0.2',
    resolved: 'https://registry.npmjs.org/call-bind/-/call-bind-1.0.2.tgz',
    integrity:
      'sha512-7O+FbCihrB5WGbFYesctwmTKae6rOiIzmz1icreWJ+0aA7LJfuqhEso2T9ncpcFtzMQtzXf2QGGueWJGTYsqrA==',
    dependencies: { 'function-bind': '^1.1.1', 'get-intrinsic': '^1.0.2' },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/function-bind': {
    version: '1.1.1',
    resolved: 'https://registry.npmjs.org/function-bind/-/function-bind-1.1.1.tgz',
    integrity:
      'sha512-yIovAzMX49sF8Yl58fSCWJ5svSLuaibPxXQJFLmBObTuCr0Mf1KiPopGM9NiFjiYBCbfaa2Fh6breQ6ANVTI0A==',
  },
  'node_modules/get-intrinsic': {
    version: '1.2.1',
    resolved: 'https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.2.1.tgz',
    integrity:
      'sha512-2DcsyfABl+gVHEfCOaTrWgyt+tb6MSEGmKq+kI5HwLbIYgjgmMcV8KQ41uaKz1xxUcn9tJtgFbQUEVcEbd0FYw==',
    dependencies: {
      'function-bind': '^1.1.1',
      has: '^1.0.3',
      'has-proto': '^1.0.1',
      'has-symbols': '^1.0.3',
    },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/has': {
    version: '1.0.4',
    resolved: 'https://registry.npmjs.org/has/-/has-1.0.4.tgz',
    integrity:
      'sha512-qdSAmqLF6209RFj4VVItywPMbm3vWylknmB3nvNiUIs72xAimcM8nVYxYr7ncvZq5qzk9MKIZR8ijqD/1QuYjQ==',
    engines: { node: '>= 0.4.0' },
  },
  'node_modules/has-proto': {
    version: '1.0.1',
    resolved: 'https://registry.npmjs.org/has-proto/-/has-proto-1.0.1.tgz',
    integrity:
      'sha512-7qE+iP+O+bgF9clE5+UoBFzE65mlBiVj3tKCrlNQ0Ogwm0BjpT/gK4SlLYDMybDh5I3TCTKnPPa0oMG7JDYrhg==',
    engines: { node: '>= 0.4' },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/has-symbols': {
    version: '1.0.3',
    resolved: 'https://registry.npmjs.org/has-symbols/-/has-symbols-1.0.3.tgz',
    integrity:
      'sha512-l3LCuF6MgDNwTDKkdYGEihYjt5pRPbEg46rtlmnSPlUbgmB8LOIrKJbYYFBSbnPaJexMKtiPO8hmeRjRz2Td+A==',
    engines: { node: '>= 0.4' },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/object-inspect': {
    version: '1.12.3',
    resolved: 'https://registry.npmjs.org/object-inspect/-/object-inspect-1.12.3.tgz',
    integrity:
      'sha512-geUvdk7c+eizMNUDkRpW1wJwgfOiOeHbxBR/hLXK1aT6zmVSO0jsQcs7fj6MGw89jC/cjGfLcNOrtMYtGqm81g==',
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/qs': {
    version: '6.11.2',
    resolved: 'https://registry.npmjs.org/qs/-/qs-6.11.2.tgz',
    integrity:
      'sha512-tDNIz22aBzCDxLtVH++VnTfzxlfeK5CbqohpSqpJgj1Wg/cQbStNAz3NuqCs5vV+pjBsK4x4pN9HlVh7rcYRiA==',
    dependencies: { 'side-channel': '^1.0.4' },
    engines: { node: '>=0.6' },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/side-channel': {
    version: '1.0.4',
    resolved: 'https://registry.npmjs.org/side-channel/-/side-channel-1.0.4.tgz',
    integrity:
      'sha512-q5XPytqFEIKHkGdiMIrY10mvLRvnQh42/+GoBlFW3b2LXLE2xxJpZFdm94we0BaoV3RwJyGqg5wS7epxTv0Zvw==',
    dependencies: {
      'call-bind': '^1.0.0',
      'get-intrinsic': '^1.0.2',
      'object-inspect': '^1.9.0',
    },
    funding: { url: 'https://github.com/sponsors/ljharb' },
  },
  'node_modules/stripe': {
    version: '14.1.0',
    resolved: 'https://registry.npmjs.org/stripe/-/stripe-14.1.0.tgz',
    integrity:
      'sha512-hpI8OT7jbaVTGOm9bqeCbdVGwM/55Hetn+WpPGFSq7FmlnqLPB7CSZy2eNYU6ko+4tdur6ZMrDKS6wh1CCx8bw==',
    dependencies: { '@types/node': '>=8.1.0', qs: '^6.11.0' },
    engines: { node: '>=12.*' },
  },
};
const NEXT = {
  version: '13.5.4',
  resolved: 'https://registry.npmjs.org/next/-/next-13.5.4.tgz',
  integrity:
    'sha512-+93un5S779gho8y9ASQhb/bTkQF17FNQOtXLKAj3lsNgltEcF0C5PMLLncDmH+8X1EnJH1kbqAERa29nRXqhjA==',
};
const lock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  JSON.stringify({
    name: 'docuchat',
    lockfileVersion,
    requires: true,
    packages: {
      '': { name: 'docuchat', dependencies: { next: '13.5.4', stripe: '^14.1.0' } },
      ...packages,
    },
  });

it('takes stripe and only the records it needs from an npm lockfile, with their tarballs and integrity (palashb01/DocuChat at 4f222d3)', () => {
  const project = stripeOnlyProject(
    lock({
      ...DOCUCHAT,
      'node_modules/next': NEXT,
      // Flags describe the repository's tree, not the stripe-only project.
      'node_modules/qs': { ...DOCUCHAT['node_modules/qs'], dev: true, peer: true },
    }),
  );
  expect(project).toMatchObject({
    version: '14.1.0',
    integrity: DOCUCHAT['node_modules/stripe'].integrity,
    manifest: { private: true, dependencies: { stripe: '14.1.0' } },
  });
  if (!('lockfile' in project)) throw new Error('expected a project');
  const { '': rootEntry, ...records } = project.lockfile.packages;
  expect(rootEntry).toEqual({
    name: 'refit-stripe-only',
    version: '0.0.0',
    dependencies: { stripe: '14.1.0' },
  });
  expect(records).toEqual(DOCUCHAT);
  // Preparation's own lockfile checks accept the project it installs.
  expect(() =>
    validateNpmLock(JSON.stringify(project.manifest), JSON.stringify(project.lockfile)),
  ).not.toThrow();
});

// samiamjidkhan/dota2-helper at 91e32cce572510c11c7aa82388abac3cc163ce96 (dev-30): stripe 22.0.0
// declares @types/node as an optional peer, which the lockfile does not install.
it('installs stripe alone when its only peer is optional and absent (samiamjidkhan/dota2-helper at 91e32cc)', () => {
  const stripe = {
    version: '22.0.0',
    resolved: 'https://registry.npmjs.org/stripe/-/stripe-22.0.0.tgz',
    integrity:
      'sha512-q1UgXXpSfZCmkyzZEh3vFEWT7+ajuaFGqaP9Tsi2NMtwlkigIWNr+KBIUQqtNeNEsreDKgdn+BP5HRW9JDj22Q==',
    license: 'MIT',
    engines: { node: '>=18' },
    peerDependencies: { '@types/node': '>=18' },
    peerDependenciesMeta: { '@types/node': { optional: true } },
  };
  const project = stripeOnlyProject(lock({ 'node_modules/stripe': stripe }));
  if (!('lockfile' in project)) throw new Error('expected a project');
  expect(Object.keys(project.lockfile.packages)).toEqual(['', 'node_modules/stripe']);
  expect(project.version).toBe('22.0.0');
});

it.each([
  ['lockfile version 1', lock(DOCUCHAT, 1), 'Only npm lockfiles of version 2 or 3'],
  [
    'stripe nested under another package',
    lock({ 'node_modules/next/node_modules/stripe': DOCUCHAT['node_modules/stripe'] }),
    'does not install stripe at node_modules/stripe',
  ],
  [
    'a dependency the lockfile lacks',
    lock({ ...DOCUCHAT, 'node_modules/qs': undefined }),
    'does not install qs, which node_modules/stripe needs',
  ],
  [
    'a record without integrity',
    lock({
      ...DOCUCHAT,
      'node_modules/has': { ...DOCUCHAT['node_modules/has'], integrity: 'sha1-abc' },
    }),
    'node_modules/has without a strong integrity',
  ],
  [
    'a Git dependency',
    lock({
      ...DOCUCHAT,
      'node_modules/has': { version: '1.0.4', resolved: 'git+ssh://git@github.com/x/has.git#abc' },
    }),
    'Package tarballs must use public registry.npmjs.org HTTPS URLs',
  ],
  [
    'a linked package',
    lock({ ...DOCUCHAT, 'node_modules/qs': { link: true, resolved: 'packages/qs' } }),
    'node_modules/qs without a registry tarball',
  ],
  ['invalid JSON', '{', 'not valid JSON'],
])('refuses %s', (_name, content, reason) => {
  expect(stripeOnlyProject(content)).toEqual({ reason: expect.stringContaining(reason) });
});

// alanagoyal/branded at cf8f84cc8bfc4b6fc35ae462deea9369ff7afc27 (dev-30): lib/billing-state.ts
// imports only types from stripe. Miguel07Alm/text2question at ce789503da89a1a7cc488c96e0717727b5abb4ec
// (dev-30): its checkout route imports next/server and an aliased auth module.
it('loads modules that import only stripe, node builtins and repository files, and names every other import', async () => {
  const branded = await repository({
    'lib/billing-state.ts': `import type Stripe from "stripe";

export type BillingSnapshot = { subscription_id: string | null; current_period_end: string | null };

export function billingSnapshot(subscriptions: Stripe.Subscription[]): BillingSnapshot {
  const subscription = [...subscriptions].sort((a, b) => b.created - a.created)[0];
  return {
    subscription_id: subscription?.id ?? null,
    current_period_end: subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
  };
}
`,
  });
  expect(stripeOnlyImports(branded, ['lib/billing-state.ts'])).toEqual([]);
  const text2question = await repository({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'src/lib/stripe.ts': `import Stripe from "stripe";
import { readFileSync } from "node:fs";
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
`,
    'src/auth.ts': `import NextAuth from "next-auth";
export const { auth } = NextAuth({});
`,
    'src/app/api/stripe/checkout-session/route.ts': `import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
  const session = await auth();
  const checkoutSession = await stripe.checkout.sessions.create({ payment_method_types: ["card"], mode: "payment" });
  return NextResponse.json({ url: checkoutSession.url, user: session?.user });
}
`,
  });
  expect(stripeOnlyImports(text2question, ['src/lib/stripe.ts'])).toEqual([]);
  expect(
    stripeOnlyImports(text2question, ['src/app/api/stripe/checkout-session/route.ts']),
  ).toEqual([
    "src/app/api/stripe/checkout-session/route.ts imports 'next/server', which needs the repository dependencies.",
    "src/auth.ts imports 'next-auth', which needs the repository dependencies.",
  ]);
  const computed = await repository({
    'lib/load.js':
      "export const load = (name) => import(name);\nexport const missing = () => import('./gone.js');\n",
  });
  expect(stripeOnlyImports(computed, ['lib/load.js'])).toEqual([
    'lib/load.js loads a module whose name is computed at runtime.',
    "lib/load.js imports './gone.js', which is not a repository source file.",
  ]);
});

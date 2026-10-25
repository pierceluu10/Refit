import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkKinds, gradeEvidence, selectCheck, TYPE_CHECK } from './check-selection.ts';
import { readRepository } from './repository.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-check-selection-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return readRepository(root);
}

const manifest = (scripts: Record<string, string>, devDependencies = { typescript: '^5.9.3' }) =>
  JSON.stringify({ scripts, dependencies: { stripe: '^17.7.0' }, devDependencies });

// gr8monk3ys/link-flame at 742dfb7: Vitest unit tests import Stripe helpers through `@/`.
const LINK_FLAME_TSCONFIG = JSON.stringify({
  compilerOptions: {
    allowJs: true,
    strict: true,
    noEmit: true,
    baseUrl: '.',
    paths: { '@/*': ['./*'] },
  },
  include: ['**/*.ts', '**/*.tsx'],
  exclude: ['node_modules'],
});
const WEBHOOK_VALIDATION = `import type Stripe from 'stripe'

export function extractGiftOptions(metadata: Stripe.Metadata | null) {
  if (!metadata) return { isGift: false }
  return { isGift: metadata.isGift === 'true' }
}
`;
const WEBHOOK_TEST = `import { describe, it, expect } from 'vitest'
import { extractGiftOptions } from '@/lib/validations/webhook'

describe('extractGiftOptions', () => {
  it('reads gift flags', () => expect(extractGiftOptions(null).isGift).toBe(false))
})
`;
const SECRET = `export function resolveWebhookSecret(dedicatedName: string): string {
  return process.env[dedicatedName] ?? process.env.STRIPE_WEBHOOK_SECRET ?? ''
}
`;
const SECRET_TEST = `import { it, expect } from 'vitest'
import { resolveWebhookSecret } from '@/lib/stripe-webhook-secret'

it('prefers the route\\'s own secret', () => expect(resolveWebhookSecret('X')).toBe(''))
`;
const ROUTE = `import Stripe from 'stripe'
import { extractGiftOptions } from '@/lib/validations/webhook'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST(request: Request) {
  const session = await stripe.checkout.sessions.retrieve('cs_123')
  return Response.json(extractGiftOptions(session.metadata))
}
`;

it('prefers tests that import Stripe code, through tsconfig path aliases', async () => {
  const selection = await selectCheck(
    await repository({
      'package.json': manifest({ test: 'vitest run' }),
      'package-lock.json': '{}',
      'tsconfig.json': LINK_FLAME_TSCONFIG,
      'lib/validations/webhook.ts': WEBHOOK_VALIDATION,
      'app/api/webhook/route.ts': ROUTE,
      'tests/unit/webhook.test.ts': WEBHOOK_TEST,
    }),
  );
  expect(selection).toMatchObject({
    kind: 'tests',
    command: ['npm', 'test'],
    stripeFiles: ['app/api/webhook/route.ts', 'lib/validations/webhook.ts'],
    testedStripeFiles: ['lib/validations/webhook.ts'],
    typeCheckedStripeFiles: ['app/api/webhook/route.ts', 'lib/validations/webhook.ts'],
    reason: 'Tests import Stripe code in lib/validations/webhook.ts.',
  });
  expect(selection.compareTypeErrors).toBeUndefined();
});

it('type-checks when the tests reach no Stripe code, and uses the lockfile manager otherwise', async () => {
  const files = {
    'package.json': manifest({ test: 'vitest run' }),
    'tsconfig.json': LINK_FLAME_TSCONFIG,
    'lib/stripe-webhook-secret.ts': SECRET,
    'app/api/webhook/route.ts': ROUTE.replace(/^import \{ extractGiftOptions.*\n/m, ''),
    'tests/unit/stripe-webhook-secret.test.ts': SECRET_TEST,
  };
  expect(
    await selectCheck(await repository({ ...files, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })),
  ).toMatchObject({
    kind: 'typecheck',
    command: TYPE_CHECK,
    compareTypeErrors: true,
    testedStripeFiles: [],
    reason:
      'No test imports Stripe code; tsc over tsconfig.json checks the Stripe code in app/api/webhook/route.ts.',
  });
  const { 'tsconfig.json': _, ...withoutTypeScript } = files;
  expect(
    await selectCheck(
      await repository({ ...withoutTypeScript, 'yarn.lock': '# yarn lockfile v1\n' }),
    ),
  ).toMatchObject({
    kind: 'tests',
    command: ['yarn', 'test'],
    reason:
      'No test imports Stripe code; the tests show only that the rest of the code still works.',
  });
});

it('counts nothing as type-checked under a solution-style tsconfig, which tsc -p . leaves empty', async () => {
  // get-convex/convex-saas at 2bb768c: the root tsconfig only references the app and node configs.
  const selection = await selectCheck(
    await repository({
      'package.json': manifest({ build: 'tsc -b && vite build' }),
      'package-lock.json': '{}',
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      }),
      'tsconfig.app.json': JSON.stringify({ include: ['src'] }),
      'convex/stripe.ts': "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
    }),
  );
  expect(selection).toMatchObject({
    kind: 'typecheck',
    typeCheckedStripeFiles: [],
    reason: 'There is no test script, and tsc over tsconfig.json checks none of the Stripe code.',
  });
});

it('never selects a no-op, and type-checks JavaScript only with checkJs', async () => {
  const javascript = {
    'package.json': manifest({
      start: 'node server.js',
      test: 'echo "Error: no test specified" && exit 1',
    }),
    'package-lock.json': '{}',
    'server.js': "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);\n",
  };
  expect(await selectCheck(await repository(javascript))).toMatchObject({
    kind: null,
    command: null,
    stripeFiles: ['server.js'],
    reason: 'There is no test script and no TypeScript type check.',
  });
  const checked = (options: Record<string, boolean>) =>
    repository({
      ...javascript,
      'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true, ...options } }),
    }).then(selectCheck);
  expect((await checked({})).typeCheckedStripeFiles).toEqual([]);
  expect((await checked({ checkJs: true })).typeCheckedStripeFiles).toEqual(['server.js']);
});

it('reads what a configured command runs from its package script', () => {
  const scripts = { check: 'tsc --noEmit && vitest run', lint: 'eslint .', test: 'node --test' };
  expect([...checkKinds(['npm', 'run', 'check'], scripts)].sort()).toEqual(['tests', 'typecheck']);
  expect([...checkKinds(['pnpm', 'test'], scripts)]).toEqual(['tests']);
  expect([...checkKinds(TYPE_CHECK, scripts)]).toEqual(['typecheck']);
  expect([...checkKinds(['npm', 'run', 'lint'], scripts)]).toEqual([]);
  expect([...checkKinds(['node', '-e', '0'], scripts)]).toEqual([]);
});

it('grades what the passing checks proved about the changed files, strongest first', async () => {
  const candidate = await repository({
    'package.json': manifest({ test: 'vitest run' }),
    'package-lock.json': '{}',
    'tsconfig.json': LINK_FLAME_TSCONFIG,
    'lib/validations/webhook.ts': WEBHOOK_VALIDATION,
    'app/api/webhook/route.ts': ROUTE,
    'tests/unit/webhook.test.ts': WEBHOOK_TEST,
    'server.js': "const stripe = require('stripe')('sk');\n",
  });
  const grade = (command: string[], changedFiles: string[], generated?: number) =>
    gradeEvidence({
      repository: candidate,
      command,
      changedFiles,
      ...(generated === undefined
        ? {}
        : {
            generated: { status: generated ? 'passed' : 'not-runnable', ran: generated },
          }),
    });
  expect(await grade(['npm', 'test'], ['lib/validations/webhook.ts', 'package.json'])).toEqual({
    level: 'stripe-tests',
    reason: 'npm test runs tests that import the changed lib/validations/webhook.ts.',
  });
  expect(await grade(['npm', 'test'], ['app/api/webhook/route.ts'])).toEqual({
    level: 'none',
    reason: 'npm test reaches none of the changed code, and no generated check ran it.',
  });
  expect(await grade(TYPE_CHECK, ['app/api/webhook/route.ts', 'package-lock.json'])).toEqual({
    level: 'type-check',
    reason: `${TYPE_CHECK.join(' ')} type-checks every changed file (app/api/webhook/route.ts); no changed code ran.`,
  });
  // server.js is outside the program (no checkJs), so the type check does not cover the patch.
  expect((await grade(TYPE_CHECK, ['app/api/webhook/route.ts', 'server.js'], 1)).level).toBe(
    'generated-check',
  );
  expect(await grade(TYPE_CHECK, ['server.js'], 0)).toEqual({
    level: 'none',
    reason: `${TYPE_CHECK.join(' ')} reaches none of the changed code, and no generated check ran it.`,
  });
  expect((await grade(['node', '-e', '0'], ['server.js'])).reason).toBe(
    'node -e 0 is neither a test script nor a type check, and no generated check ran it.',
  );
});

it('grades A only from behaviour tests that ran every changed Stripe line, and otherwise says why not', async () => {
  const repository = { root: '/nonexistent', files: [] } as never;
  const behaviour = {
    tests: [{ path: 'refit-behaviour/payments.test.mjs' }],
    coverage: {
      changedLines: {
        original: { 'controller/payment/payment.js': [29] },
        patched: { 'controller/payment/payment.js': [29], 'lib/stripe.ts': [3] },
      },
    },
  };
  expect(
    await gradeEvidence({
      repository,
      command: ['node', '-e', '0'],
      changedFiles: ['controller/payment/payment.js'],
      behaviour: { ...behaviour, grade: 'A', missing: [] },
    }),
  ).toEqual({
    level: 'behaviour-tests',
    reason:
      'Behaviour tests (refit-behaviour/payments.test.mjs) passed on the original code against the before-version stripe-mock and on the patched code against the after-version stripe-mock, and ran every changed Stripe line on both sides (1 original, 2 patched).',
  });
  expect(
    await gradeEvidence({
      repository,
      command: ['node', '-e', '0'],
      changedFiles: ['controller/payment/payment.js'],
      behaviour: {
        ...behaviour,
        grade: null,
        missing: [
          'lib/stripe.ts line 3 did not run on the patched code against the after-version stripe-mock.',
        ],
      },
    }),
  ).toEqual({
    level: 'none',
    reason:
      'node -e 0 is neither a test script nor a type check, and no generated check ran it. Behaviour tests did not give grade A: lib/stripe.ts line 3 did not run on the patched code against the after-version stripe-mock.',
  });
});

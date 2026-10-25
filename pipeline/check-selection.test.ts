import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  checkKinds,
  failingPart,
  gradeEvidence,
  REFIT_TSC,
  SCOPED_TSCONFIG,
  selectCheck,
  TESTS_FAILED,
  TYPE_CHECK,
  TYPE_CHECK_STARTED,
} from './check-selection.ts';
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
const chain = (tests: string, typeCheck: string) =>
  `${tests} || { echo '${TESTS_FAILED}'; exit 1; }; echo '${TYPE_CHECK_STARTED}'; ${typeCheck}`;
const scopedScript = (compiler: string) =>
  `printf '%s' "$1" > ${SCOPED_TSCONFIG} && ${compiler} --noEmit --pretty false -p ${SCOPED_TSCONFIG}`;
const scopedConfiguration = (command: string[] | null) => JSON.parse(command!.at(-1)!);
const JAVASCRIPT_CHECK = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  skipLibCheck: true,
  composite: false,
};

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
const LINK_FLAME = {
  'package.json': manifest({ test: 'vitest run' }),
  'package-lock.json': '{}',
  'tsconfig.json': LINK_FLAME_TSCONFIG,
  'lib/validations/webhook.ts': WEBHOOK_VALIDATION,
  'app/api/webhook/route.ts': ROUTE,
  'tests/unit/webhook.test.ts': WEBHOOK_TEST,
};

// Deepanshu0211/Rocart at 15ce8d8: a Vite solution-style tsconfig whose app project includes
// `api`, where the Stripe handlers are JavaScript, so `tsc -p .` checks nothing.
const ROCART = {
  'package.json': JSON.stringify({
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { express: '^4.21.2', stripe: '^17.4.0' },
    devDependencies: { typescript: '~5.6.2', vite: '^6.0.5' },
  }),
  'package-lock.json': '{}',
  'tsconfig.json': JSON.stringify({
    files: [],
    references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
  }),
  'tsconfig.app.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
    },
    include: ['src', 'api'],
  }),
  'tsconfig.node.json': JSON.stringify({ include: ['vite.config.ts'] }),
  'src/main.tsx': "export const root = document.getElementById('root');\n",
  'api/create-payment-intent.js': `import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-09-30.acacia' });

export default async function createCheckoutSessionHandler(req, res) {
  const session = await stripe.checkout.sessions.create({ payment_method_types: ["card"], mode: "payment" });
  return res.status(200).json({ id: session.id });
}
`,
  'api/server.js': `import express from "express";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-09-30.acacia' });
export const app = express();
`,
};

// emman-tt/tilios-backend at b554dcb: an ES module Express server with no tests, no tsconfig and no
// TypeScript; the client module is imported by the server, a controller and, through it, a route.
const TILIOS = {
  'package.json': JSON.stringify({
    type: 'module',
    scripts: { test: 'echo "Error: no test specified" && exit 1', start: 'nodemon server.js' },
    dependencies: { express: '^4.19.2', stripe: '^16.2.0' },
  }),
  'package-lock.json': '{}',
  'services/stripe.js':
    "import Stripe from 'stripe'\nexport const stripe = new Stripe(process.env.STRIPE_SECRET)\n",
  'server.js': "import { stripe } from './services/stripe.js'\nexport default stripe\n",
  'controller/payment/payment.js':
    "import { Order } from '../../database/orders.js'\nimport { stripe } from '../../services/stripe.js'\nexport async function handlePayments () { return stripe && Order }\n",
  'routes/route.js':
    "import { handlePayments } from '../controller/payment/payment.js'\nexport const routes = [handlePayments]\n",
  'database/orders.js': 'export const Order = {}\n',
};

it('runs the tests, then tsc when its program holds every Stripe file; both must pass', async () => {
  const selection = await selectCheck(await repository(LINK_FLAME));
  expect(selection).toEqual({
    kind: 'tests',
    command: ['sh', '-c', chain('npm test', TYPE_CHECK.join(' '))],
    compareTypeErrors: true,
    typeCheck: 'project',
    stripeFiles: ['app/api/webhook/route.ts', 'lib/validations/webhook.ts'],
    testedStripeFiles: ['lib/validations/webhook.ts'],
    typeCheckedStripeFiles: ['app/api/webhook/route.ts', 'lib/validations/webhook.ts'],
    reason:
      'The tests import Stripe code in lib/validations/webhook.ts. The type check (tsc over tsconfig.json) covers the Stripe code in app/api/webhook/route.ts, lib/validations/webhook.ts. Both must pass.',
  });
});

it('keeps tests that reach no Stripe code, and runs only the tests without TypeScript', async () => {
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
    kind: 'tests',
    command: ['sh', '-c', chain('pnpm test', TYPE_CHECK.join(' '))],
    compareTypeErrors: true,
    testedStripeFiles: [],
    reason:
      'No test imports Stripe code, so the tests show only that the rest of the code still works. The type check (tsc over tsconfig.json) covers the Stripe code in app/api/webhook/route.ts. Both must pass.',
  });
  // brunobola-portfolio/GitHub-Repo-Manager at 982052f: Vitest loads the Stripe module with a
  // dynamic import, and the repository installs no TypeScript.
  const selection = await selectCheck(
    await repository({
      'package.json': JSON.stringify({
        type: 'module',
        scripts: { test: 'vitest' },
        dependencies: { stripe: '^20.3.1' },
        devDependencies: { vitest: '^3.2.4' },
      }),
      'package-lock.json': '{}',
      'server/lib/stripe.js':
        "import Stripe from 'stripe';\nexport function isStripeEnabled() { return Boolean(Stripe); }\n",
      'server/__tests__/stripe-enablement.test.js':
        "import { it } from 'vitest';\nconst { isStripeEnabled } = await import('../lib/stripe.js');\nit('reads the flag', () => isStripeEnabled());\n",
    }),
  );
  expect(selection).toEqual({
    kind: 'tests',
    command: ['npm', 'test'],
    stripeFiles: ['server/lib/stripe.js'],
    testedStripeFiles: ['server/lib/stripe.js'],
    typeCheckedStripeFiles: [],
    reason:
      'The tests import Stripe code in server/lib/stripe.js. TypeScript is not installed, so no type check runs with them.',
  });
});

it('scopes the type check to the Stripe code when the root program leaves it out', async () => {
  const rocart = await selectCheck(await repository(ROCART));
  expect(rocart).toMatchObject({
    kind: 'typecheck',
    typeCheck: 'scoped',
    compareTypeErrors: true,
    typeCheckedStripeFiles: ['api/create-payment-intent.js', 'api/server.js'],
    reason:
      'There is no test script. A generated tsconfig extending tsconfig.app.json type-checks the Stripe code (api/create-payment-intent.js, api/server.js) and every file importing it, because tsc -p . checks no file (tsconfig.json only references other projects).',
  });
  expect(rocart.command!.slice(0, 4)).toEqual([
    'sh',
    '-c',
    scopedScript('npx --no-install tsc'),
    'refit-check',
  ]);
  // The app project sets its own target, module and jsx, so nothing else is added.
  expect(scopedConfiguration(rocart.command)).toEqual({
    extends: './tsconfig.app.json',
    compilerOptions: JAVASCRIPT_CHECK,
    files: ['api/create-payment-intent.js', 'api/server.js'],
    include: [],
  });
  // get-convex/convex-saas at 2bb768c: the solution-style root references the app project, which
  // includes `convex`.
  const convex = await selectCheck(
    await repository({
      'package.json': manifest({ build: 'tsc -b && vite build' }),
      'package-lock.json': '{}',
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { composite: true, target: 'ES2020', module: 'ESNext', jsx: 'react-jsx' },
        include: ['src', 'convex'],
      }),
      'convex/stripe.ts': "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
      'convex/http.ts': "import { stripe } from './stripe';\nexport default stripe;\n",
    }),
  );
  expect(scopedConfiguration(convex.command)).toEqual({
    extends: './tsconfig.app.json',
    compilerOptions: JAVASCRIPT_CHECK,
    files: ['convex/http.ts', 'convex/stripe.ts'],
    include: [],
  });
});

it("type-checks a JavaScript repository that installs no TypeScript with Refit's compiler", async () => {
  const tilios = await selectCheck(await repository(TILIOS));
  expect(tilios).toMatchObject({
    kind: 'typecheck',
    typeCheck: 'scoped',
    stripeFiles: ['services/stripe.js'],
    reason:
      "There is no test script. A generated tsconfig type-checks the Stripe code (services/stripe.js) and every file importing it, because there is no tsconfig.json, with Refit's own TypeScript because the repository installs none.",
  });
  expect(tilios.command!.slice(0, 3)).toEqual(['sh', '-c', scopedScript(`node ${REFIT_TSC}`)]);
  // Without a configuration to extend, a modern target keeps Stripe's Promise types declared.
  expect(scopedConfiguration(tilios.command)).toEqual({
    compilerOptions: {
      ...JAVASCRIPT_CHECK,
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      jsx: 'preserve',
    },
    files: ['controller/payment/payment.js', 'routes/route.js', 'server.js', 'services/stripe.js'],
    include: [],
  });
  // MeldinRadoncic/TriboAI at 48d5b9a: a Next.js JavaScript app whose jsconfig.json maps `@/`.
  const tribo = await selectCheck(
    await repository({
      'package.json': JSON.stringify({
        scripts: { dev: 'next dev', build: 'next build' },
        dependencies: { next: '14.2.3', stripe: '^15.8.0' },
      }),
      'package-lock.json': '{}',
      'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
      'lib/stripe.js': "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
      'app/api/webhook/route.js':
        'import { stripe } from "@/lib/stripe";\nexport async function POST() { return stripe; }\n',
    }),
  );
  expect(scopedConfiguration(tribo.command)).toMatchObject({
    extends: './jsconfig.json',
    files: ['app/api/webhook/route.js', 'lib/stripe.js'],
  });
});

it('never selects a no-op', async () => {
  // Stripe.js loaded from a script tag: no file imports stripe, so no type check can cover it.
  expect(
    await selectCheck(
      await repository({
        'package.json': JSON.stringify({
          scripts: { start: 'node server.js', test: 'echo "Error: no test specified" && exit 1' },
          dependencies: { stripe: '^14.0.0' },
        }),
        'package-lock.json': '{}',
        'server.js': "const express = require('express');\nmodule.exports = express();\n",
      }),
    ),
  ).toEqual({
    kind: null,
    command: null,
    stripeFiles: [],
    testedStripeFiles: [],
    typeCheckedStripeFiles: [],
    reason:
      'There is no test script. No file imports stripe, so no type check can cover the Stripe code.',
  });
  // dalemoncayo/express-stripe at a18c6d3: `require('stripe')(key)` is untyped to TypeScript, so a
  // type check would pass without checking a single Stripe call.
  expect(
    await selectCheck(
      await repository({
        'package.json': JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
          dependencies: { cors: '^2.8.5', express: '^4.18.2', stripe: '^14.5.0' },
        }),
        'package-lock.json': '{}',
        'app.js':
          "const express = require('express');\nconst stripe = require('stripe')('YOUR_STRIPE_SECRET_KEY');\nmodule.exports = express();\n",
      }),
    ),
  ).toMatchObject({
    kind: null,
    command: null,
    stripeFiles: ['app.js'],
    reason:
      'There is no test script. Stripe is loaded with require() (app.js), which TypeScript leaves untyped, so no type check can cover the Stripe code.',
  });
});

it('reads what a configured command runs, including each part of a sh -c chain', () => {
  const scripts = { check: 'tsc --noEmit && vitest run', lint: 'eslint .', test: 'node --test' };
  expect([...checkKinds(['npm', 'run', 'check'], scripts)].sort()).toEqual(['tests', 'typecheck']);
  expect([...checkKinds(['pnpm', 'test'], scripts)]).toEqual(['tests']);
  expect([...checkKinds(TYPE_CHECK, scripts)]).toEqual(['typecheck']);
  expect([...checkKinds(['npm', 'run', 'lint'], scripts)]).toEqual([]);
  expect([...checkKinds(['node', '-e', '0'], scripts)]).toEqual([]);
  expect(
    [...checkKinds(['sh', '-c', chain('npm test', TYPE_CHECK.join(' '))], scripts)].sort(),
  ).toEqual(['tests', 'typecheck']);
  expect([
    ...checkKinds(['sh', '-c', scopedScript(`node ${REFIT_TSC}`), 'refit-check', '{}'], scripts),
  ]).toEqual(['typecheck']);
  expect([...checkKinds(['sh', '-c', 'npm test && npm run lint'], scripts)]).toEqual(['tests']);
});

it('names the part of a tests-then-type-check chain that failed', () => {
  const command = ['sh', '-c', chain('yarn test', TYPE_CHECK.join(' '))];
  expect(failingPart(command, `FAIL src/a.test.ts\n${TESTS_FAILED}\n`)).toEqual({
    part: 'tests',
    command: 'yarn test',
  });
  expect(failingPart(command, `PASS src/a.test.ts\n${TYPE_CHECK_STARTED}\nerror`)).toEqual({
    part: 'type check',
    command: TYPE_CHECK.join(' '),
  });
  // A run stopped before either line was still in its tests.
  expect(failingPart(command, 'RUNS src/a.test.ts')).toEqual({
    part: 'tests',
    command: 'yarn test',
  });
  expect(failingPart(['npm', 'test'], TESTS_FAILED)).toBeUndefined();
});

it('grades each changed file by the strongest check that reached it', async () => {
  const candidate = await repository({
    ...LINK_FLAME,
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
  const both = ['sh', '-c', chain('npm test', TYPE_CHECK.join(' '))];
  expect(await grade(both, ['lib/validations/webhook.ts', 'package.json'])).toEqual({
    letter: 'B',
    level: 'stripe-tests',
    reason: "The repository's tests reach every changed file (lib/validations/webhook.ts).",
  });
  expect(await grade(both, ['lib/validations/webhook.ts', 'app/api/webhook/route.ts'])).toEqual({
    letter: 'C',
    level: 'type-check',
    reason:
      'The tests reach lib/validations/webhook.ts but not app/api/webhook/route.ts. tsc type-checks app/api/webhook/route.ts; no test ran that code.',
  });
  expect(await grade(['npm', 'test'], ['app/api/webhook/route.ts'])).toEqual({
    letter: 'D',
    level: 'none',
    reason: 'No test reaches app/api/webhook/route.ts, and no generated check ran it.',
  });
  // server.js is outside the program (no checkJs), so the type check does not cover the patch.
  expect(await grade(both, ['app/api/webhook/route.ts', 'server.js'], 1)).toEqual({
    letter: 'D',
    level: 'generated-check',
    reason:
      'Neither the tests nor the type check reach server.js; only the generated stripe-mock checks ran changed code (1 exported function).',
  });
  expect((await grade(TYPE_CHECK, ['server.js'], 0)).reason).toBe(
    'The type check does not cover server.js, and no generated check ran it.',
  );
  expect((await grade(['node', '-e', '0'], ['server.js'])).reason).toBe(
    'node -e 0 is neither a test script nor a type check, and no generated check ran it.',
  );
  // Grade A comes only from the behaviour-test harness.
  expect(
    await gradeEvidence({
      repository: candidate,
      command: ['npm', 'test'],
      changedFiles: ['server.js'],
      behaviour: { passed: true, coversEveryChangedLine: true, reason: 'Ran every changed line.' },
    }),
  ).toEqual({ letter: 'A', level: 'behaviour-tests', reason: 'Ran every changed line.' });
});

it('grades a scoped type check by the files its generated configuration covers', async () => {
  const candidate = await repository(ROCART);
  const { command } = await selectCheck(candidate);
  expect(
    await gradeEvidence({
      repository: candidate,
      command: command!,
      changedFiles: ['api/server.js'],
    }),
  ).toEqual({
    letter: 'C',
    level: 'type-check',
    reason: 'tsc type-checks api/server.js; no test ran that code.',
  });
  expect(
    (
      await gradeEvidence({
        repository: candidate,
        command: command!,
        changedFiles: ['src/main.tsx'],
      })
    ).letter,
  ).toBe('D');
});

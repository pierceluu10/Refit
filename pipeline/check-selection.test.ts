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
  advisoryTypeError,
  selectCheck,
  TESTS_FAILED,
  TYPE_CHECK,
  TYPE_CHECK_STARTED,
  testsFoundNone,
  typeCheckCommand,
  unavailableTypeCheck,
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
  `${tests} || echo '${TESTS_FAILED}'; echo '${TYPE_CHECK_STARTED}'; ${typeCheck}`;
const scopedScript = (compiler: string) =>
  `printf '%s' "$1" > ${SCOPED_TSCONFIG} && ${compiler} --noEmit --pretty false -p ${SCOPED_TSCONFIG}`;
const scopedConfiguration = (command: string[] | null) => JSON.parse(command!.at(-1)!);
const JAVASCRIPT_CHECK = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  skipLibCheck: true,
  composite: false,
  rootDir: '.',
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
      tsBuildInfoFile: './node_modules/.tmp/tsconfig.app.tsbuildinfo',
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
    command: ['sh', '-c', chain('npm test', TYPE_CHECK.join(' ')), 'refit-check'],
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
    command: ['sh', '-c', chain('pnpm test', TYPE_CHECK.join(' ')), 'refit-check'],
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
      'server/lib/logger.js': 'export const logger = console;\n',
      'server/__tests__/logger.test.js':
        "import { it } from 'vitest';\nimport { logger } from '../lib/logger.js';\nit('logs', () => logger.log('x'));\n",
    }),
  );
  // 3 of its 821 test files reach Stripe code; the whole suite does not finish in 120 seconds.
  expect(selection).toEqual({
    kind: 'tests',
    command: ['npm', 'test', '--', 'server/__tests__/stripe-enablement.test.js'],
    stripeFiles: ['server/lib/stripe.js'],
    testedStripeFiles: ['server/lib/stripe.js'],
    typeCheckedStripeFiles: [],
    reason:
      'The tests import Stripe code in server/lib/stripe.js, and only the 1 test file that reach it run (server/__tests__/stripe-enablement.test.js); no other test reaches a file the patch can change. TypeScript is not installed, so no type check runs with them.',
  });
});

it('runs only the test files that reach Stripe code when the runner takes file arguments', async () => {
  // beindigital-products/wedillybird at 4efeeed: `vitest run` over 222 test files outlasts the
  // 120-second limit; 15 of them reach lib/payments/drivers/stripe.ts, the file its patch changes.
  const files = {
    'package.json': JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: { stripe: '^22.1.0' },
      devDependencies: { typescript: '^5', vitest: '^4.0.0' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'tsconfig.json': JSON.stringify({
      compilerOptions: { noEmit: true, paths: { '@/*': ['./*'] } },
      include: ['**/*.ts'],
    }),
    'lib/payments/drivers/stripe.ts':
      "import Stripe from 'stripe';\nexport const stripeDriver = new Stripe('sk');\n",
    'lib/payments/coupon-name.ts': 'export const STRIPE_COUPON_NAME_MAX_LENGTH = 40;\n',
    'tests/unit/lib/payments-stripe-driver.test.ts':
      "import { it } from 'vitest';\nimport { STRIPE_COUPON_NAME_MAX_LENGTH } from '@/lib/payments/coupon-name';\nit('loads', async () => { await import('@/lib/payments/drivers/stripe'); return STRIPE_COUPON_NAME_MAX_LENGTH; });\n",
    'tests/unit/lib/coupon-name.test.ts':
      "import { it } from 'vitest';\nimport { STRIPE_COUPON_NAME_MAX_LENGTH } from '@/lib/payments/coupon-name';\nit('caps', () => STRIPE_COUPON_NAME_MAX_LENGTH);\n",
  };
  const wedillybird = await selectCheck(await repository(files));
  expect(wedillybird.command).toEqual([
    'sh',
    '-c',
    chain('pnpm test "$@"', TYPE_CHECK.join(' ')),
    'refit-check',
    'tests/unit/lib/payments-stripe-driver.test.ts',
  ]);
  // Jest takes exact paths; a script that chains commands keeps the whole suite.
  const jest = await selectCheck(
    await repository({
      ...files,
      'package.json': files['package.json'].replace('vitest run', 'jest'),
    }),
  );
  expect(jest.command!.slice(2)).toEqual([
    chain('pnpm test --runTestsByPath "$@"', TYPE_CHECK.join(' ')),
    'refit-check',
    'tests/unit/lib/payments-stripe-driver.test.ts',
  ]);
  const chained = await selectCheck(
    await repository({
      ...files,
      'package.json': files['package.json'].replace('vitest run', 'vitest run && playwright test'),
    }),
  );
  expect(chained.command).toEqual([
    'sh',
    '-c',
    chain('pnpm test', TYPE_CHECK.join(' ')),
    'refit-check',
  ]);
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
    compilerOptions: { ...JAVASCRIPT_CHECK, incremental: true },
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
        compilerOptions: {
          composite: true,
          tsBuildInfoFile: './node_modules/.tmp/tsconfig.app.tsbuildinfo',
          target: 'ES2020',
          module: 'ESNext',
          jsx: 'react-jsx',
        },
        include: ['src', 'convex'],
      }),
      'convex/stripe.ts': "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
      'convex/http.ts': "import { stripe } from './stripe';\nexport default stripe;\n",
    }),
  );
  // refit-bench run 40180681405: without incremental, tsc rejected the inherited tsBuildInfoFile (TS5069).
  expect(scopedConfiguration(convex.command)).toEqual({
    extends: './tsconfig.app.json',
    compilerOptions: { ...JAVASCRIPT_CHECK, incremental: true },
    files: ['convex/http.ts', 'convex/stripe.ts'],
    include: [],
  });
});

it('lists importers outside the base configuration rootDir, which only governs emit', async () => {
  // cyberdreadx/cyberpunk-grok-api at b1dc85c: api/tsconfig.json sets "rootDir": "." and a backfill
  // script under scripts/ imports the Stripe code; refit-bench run 40155034890 failed its type
  // check with TS6059 until the generated tsconfig reset rootDir.
  const selection = await selectCheck(
    await repository({
      'package.json': manifest({ test: 'vitest run' }),
      'package-lock.json': '{}',
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ include: ['src'] }),
      'api/tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'commonjs', rootDir: '.', outDir: './dist' },
        include: ['./**/*.ts'],
      }),
      'api/_lib/stripe-finance.ts':
        "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
      'scripts/backfill-legacy-sub-credits.ts':
        "import { stripe } from '../api/_lib/stripe-finance';\nexport default stripe;\n",
      'src/lib/createMode.test.ts': "it('creates', () => 1);\n",
    }),
  );
  expect(scopedConfiguration(selection.command)).toMatchObject({
    extends: './api/tsconfig.json',
    compilerOptions: { rootDir: '.' },
    files: ['api/_lib/stripe-finance.ts', 'scripts/backfill-legacy-sub-credits.ts'],
  });
});

// different-ai/embedbase at fb0afda5e8c2ad0212ea8c0dfa495be9865221d5: no root package.json; the
// dashboard is its own npm project, which validation prepares and checks (preparation-packages.ts).
const EMBEDBASE_DASHBOARD = {
  scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
  dependencies: { next: '^13.4.4', stripe: '^11.13.0' },
  devDependencies: { typescript: '4.9.5' },
};
const EMBEDBASE = {
  'dashboard/package.json': JSON.stringify(EMBEDBASE_DASHBOARD),
  'dashboard/package-lock.json': '{}',
  'dashboard/tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'es5',
      allowJs: true,
      noEmit: true,
      incremental: true,
      module: 'esnext',
      moduleResolution: 'node',
      jsx: 'preserve',
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules', 'supabase'],
  }),
  'dashboard/utils/stripe.ts':
    "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2022-11-15' });\n",
  'dashboard/utils/supabase-admin.ts':
    "import Stripe from 'stripe'\nimport { stripe } from './stripe'\nexport const customer = (id: string) => stripe.customers.retrieve(id) as Promise<Stripe.Customer>\n",
  'dashboard/pages/api/webhooks.ts':
    "import Stripe from 'stripe';\nimport { customer } from '../../utils/supabase-admin';\nexport default async function handler(event: Stripe.Event) { return customer(event.id); }\n",
  'sdk/embedbase-js/package.json': JSON.stringify({
    scripts: { test: 'jest' },
    devDependencies: { typescript: '^4.9.5' },
  }),
  'sdk/embedbase-js/package-lock.json': '{}',
  'sdk/embedbase-js/src/index.test.ts': "it('splits', () => 1);\n",
};
// starmanv4/react-typescript-docker at 109c4528fba9c6c0efe67a250704ece82441bad9: payments is one
// of eight services with their own package-lock.json, and there is no root package.json.
const STARMAN = {
  'payments/package.json': JSON.stringify({
    scripts: { start: 'ts-node-dev src/index.ts', test: 'jest --watchAll --no-cache' },
    dependencies: { stripe: '^11.17.0', typescript: '^4.7.4' },
    devDependencies: { jest: '^28.1.1', 'ts-jest': '^28.0.5' },
  }),
  'payments/package-lock.json': '{}',
  'payments/tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'es2016', module: 'commonjs', esModuleInterop: true, strict: true },
  }),
  'payments/src/stripe.ts':
    'import Stripe from "stripe";\nexport const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: "2022-11-15" });\n',
  'payments/src/routes/new.ts':
    'import { stripe } from "../stripe";\nexport const charge = (source: string) => stripe.charges.create({ currency: "usd", amount: 100, source });\n',
  'payments/src/app.ts': 'import { charge } from "./routes/new";\nexport const app = { charge };\n',
  'payments/src/routes/__test__/new.test.ts':
    'import { app } from "../../app";\nimport { stripe } from "../../stripe";\nit("charges", () => expect(app && stripe).toBeTruthy());\n',
  'payments/src/events/listeners/__test__/order-created-listener.test.ts':
    'it("listens", () => 1);\n',
  'auth/package.json': JSON.stringify({ scripts: { test: 'jest --watchAll --no-cache' } }),
  'auth/package-lock.json': '{}',
  'auth/src/routes/__test__/signup.test.ts': 'it("signs up", () => 1);\n',
};

it('selects and grades the check of the nested package it runs in, with paths from there', async () => {
  // Run 40236299492 selected both from the repository root but ran them in the package, so the
  // generated tsconfig extended /workspace/dashboard/dashboard/tsconfig.json (TS5083).
  const embedbase = await repository(EMBEDBASE);
  const dashboard = await selectCheck(embedbase, 'dashboard');
  const stripeFiles = [
    'dashboard/pages/api/webhooks.ts',
    'dashboard/utils/stripe.ts',
    'dashboard/utils/supabase-admin.ts',
  ];
  expect(dashboard).toEqual({
    kind: 'typecheck',
    command: TYPE_CHECK,
    compareTypeErrors: true,
    typeCheck: 'project',
    stripeFiles,
    testedStripeFiles: [],
    typeCheckedStripeFiles: stripeFiles,
    reason:
      'There is no test script. The type check (tsc over tsconfig.json) covers the Stripe code in dashboard/pages/api/webhooks.ts, dashboard/utils/stripe.ts, dashboard/utils/supabase-admin.ts.',
  });
  const changed = ['dashboard/pages/api/webhooks.ts', 'dashboard/utils/stripe.ts'];
  await expect(
    gradeEvidence({
      repository: embedbase,
      command: dashboard.command!,
      changedFiles: changed,
      packageDirectory: 'dashboard',
    }),
  ).resolves.toEqual({
    letter: 'C',
    level: 'type-check',
    reason:
      'tsc type-checks dashboard/pages/api/webhooks.ts, dashboard/utils/stripe.ts; no test ran that code.',
  });
  // Without TypeScript of its own, the generated tsconfig is written in the package and names
  // every path from it.
  const untyped = await repository({
    ...EMBEDBASE,
    'dashboard/package.json': JSON.stringify({ ...EMBEDBASE_DASHBOARD, devDependencies: {} }),
  });
  const scoped = await selectCheck(untyped, 'dashboard');
  expect(scoped.command!.slice(0, 3)).toEqual(['sh', '-c', scopedScript(`node ${REFIT_TSC}`)]);
  expect(scopedConfiguration(scoped.command)).toEqual({
    extends: './tsconfig.json',
    compilerOptions: JAVASCRIPT_CHECK,
    files: ['pages/api/webhooks.ts', 'utils/stripe.ts', 'utils/supabase-admin.ts'],
    include: [],
  });
  await expect(
    gradeEvidence({
      repository: untyped,
      command: scoped.command!,
      changedFiles: changed,
      packageDirectory: 'dashboard',
    }),
  ).resolves.toMatchObject({ letter: 'C' });

  // The service's own test script runs, with the test files that reach Stripe code named from it.
  const starman = await repository(STARMAN);
  const payments = await selectCheck(starman, 'payments');
  expect(payments).toEqual({
    kind: 'tests',
    command: [
      'sh',
      '-c',
      chain('npm test -- --runTestsByPath "$@"', TYPE_CHECK.join(' ')),
      'refit-check',
      'src/routes/__test__/new.test.ts',
    ],
    compareTypeErrors: true,
    typeCheck: 'project',
    stripeFiles: ['payments/src/stripe.ts'],
    testedStripeFiles: ['payments/src/stripe.ts'],
    typeCheckedStripeFiles: ['payments/src/stripe.ts'],
    reason:
      'The tests import Stripe code in payments/src/stripe.ts, and only the 1 test file that reach it run (payments/src/routes/__test__/new.test.ts); no other test reaches a file the patch can change. The type check (tsc over tsconfig.json) covers the Stripe code in payments/src/stripe.ts. Both must pass.',
  });
  await expect(
    gradeEvidence({
      repository: starman,
      command: payments.command!,
      changedFiles: ['payments/src/stripe.ts'],
      packageDirectory: 'payments',
    }),
  ).resolves.toEqual({
    letter: 'B',
    level: 'stripe-tests',
    reason: "The repository's tests reach every changed file (payments/src/stripe.ts).",
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
  const command = ['sh', '-c', chain('yarn test', TYPE_CHECK.join(' ')), 'refit-check'];
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
  // Listed test files and a scoped configuration are arguments, shown in the command a person reruns.
  const scoped = [
    'sh',
    '-c',
    `config=$1; shift; ${chain('npm test -- "$@"', scopedScript('npx --no-install tsc').replace('"$1"', '"$config"'))}`,
    'refit-check',
    '{"files":["api/pay.ts"],"include":[]}',
    'tests/pay.test.ts',
  ];
  expect(failingPart(scoped, TESTS_FAILED)).toEqual({
    part: 'tests',
    command: 'npm test -- tests/pay.test.ts',
  });
  expect(failingPart(scoped, `${TYPE_CHECK_STARTED}\napi/pay.ts(1,1): error TS2339: x`)).toEqual({
    part: 'type check',
    command: 'npx --no-install tsc --noEmit --pretty false -p .refit-tsconfig.json',
  });
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
  // Grade A comes only from the behaviour-test harness, in a provider's test environment.
  const behaviour = (target: 'test-environment' | 'mock') =>
    gradeEvidence({
      repository: candidate,
      command: ['npm', 'test'],
      changedFiles: ['server.js'],
      behaviour: {
        passed: true,
        coversEveryChangedLine: true,
        target,
        reason: 'Ran every changed line.',
      },
    });
  expect(await behaviour('test-environment')).toEqual({
    letter: 'A',
    level: 'behaviour-tests',
    reason: 'Ran every changed line.',
  });
  expect((await behaviour('mock')).letter).not.toBe('A');
});

it('runs the type check part of a chain alone on a patch whose tests were already broken', () => {
  const configuration = '{"files":["api/pay.ts"],"include":[]}';
  expect(
    typeCheckCommand([
      'sh',
      '-c',
      `config=$1; shift; ${chain('npm test -- "$@"', scopedScript('npx --no-install tsc').replace('"$1"', '"$config"'))}`,
      'refit-check',
      configuration,
      'tests/pay.test.ts',
    ]),
  ).toEqual(['sh', '-c', scopedScript('npx --no-install tsc'), 'refit-check', configuration]);
  expect(
    typeCheckCommand(['sh', '-c', chain('npm test', TYPE_CHECK.join(' ')), 'refit-check']),
  ).toEqual(['sh', '-c', TYPE_CHECK.join(' '), 'refit-check']);
  expect(typeCheckCommand(['npm', 'test'])).toBeUndefined();
});

it('treats JavaScript type errors a generated check finds as advisory, grading from the rest', async () => {
  const rocart = await repository(ROCART);
  const { command } = await selectCheck(rocart);
  const advisory = advisoryTypeError(command!);
  expect([advisory?.('api/server.js'), advisory?.('api/apply-discount.ts')]).toEqual([true, false]);
  expect(advisoryTypeError(TYPE_CHECK)).toBeUndefined();
  // bhaveshchhimwal/PopIn at 90d47d3, refit-bench run 40155034890: stripe-node 23 types an expandable
  // field as string | PaymentIntent, which the JavaScript passes on as a string.
  const popIn = {
    file: 'api/server.js',
    text: "api/server.js(100,11): error TS2322: Type 'string | PaymentIntent' is not assignable to type 'string'.",
  };
  // The file with the advisory error no longer counts as type-checked; the other one still does.
  expect(
    await gradeEvidence({
      repository: rocart,
      command: command!,
      changedFiles: ['api/server.js'],
      advisory: [popIn],
    }),
  ).toEqual({
    letter: 'D',
    level: 'none',
    reason: `The type check does not cover api/server.js, and no generated check ran it. The generated type check reports an advisory type error this patch introduces in JavaScript the repository never type-checks, first ${popIn.text}.`,
  });
  expect(
    (
      await gradeEvidence({
        repository: rocart,
        command: command!,
        changedFiles: ['api/create-payment-intent.js'],
        advisory: [popIn],
      })
    ).letter,
  ).toBe('C');
  // ArkanaDeck/arcana-marketplace at 2c72311: its Stripe tests reach the changed file, so the grade
  // stays B with its advisory errors (api/*.js still pin 2024-06-20 against stripe-node 23).
  const arkana = await repository({
    'package.json': manifest({ test: 'vitest run' }),
    'package-lock.json': '{}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }),
    'api/billing.js':
      "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk', { apiVersion: '2024-06-20' });\n",
    'tests/billing.test.js':
      "import { stripe } from '../api/billing.js';\nit('loads', () => stripe);\n",
  });
  const arkanaCheck = (await selectCheck(arkana)).command!;
  expect(
    (
      await gradeEvidence({
        repository: arkana,
        command: arkanaCheck,
        changedFiles: ['api/billing.js'],
        advisory: [
          {
            file: 'api/billing.js',
            text: `api/billing.js(31,50): error TS2322: Type '"2024-06-20"' is not assignable to type '"2026-09-30.endive"'.`,
          },
        ],
      })
    ).letter,
  ).toBe('B');
});

it('counts a generated type check that fails on configuration as unavailable, never as a failure', () => {
  // cyberdreadx/cyberpunk-grok-api at b1dc85c, refit-bench run 40155034890: the extended base's rootDir
  // rejected listed importers, so tsc checked nothing.
  const command = [
    'sh',
    '-c',
    chain('npm test', scopedScript('npx --no-install tsc')),
    'refit-check',
    '{}',
  ];
  const run = (stdout: string, exitCode = 2) => ({ status: 'failed', exitCode, stdout });
  expect(
    unavailableTypeCheck(
      command,
      run(
        `✓ src/lib/createMode.test.ts\n${TYPE_CHECK_STARTED}\nerror TS6059: File '/workspace/scripts/backfill-legacy-sub-credits.ts' is not under 'rootDir' '/workspace/api'.\n`,
      ),
    ),
  ).toBe(
    "error TS6059: File '/workspace/scripts/backfill-legacy-sub-credits.ts' is not under 'rootDir' '/workspace/api'.",
  );
  expect(unavailableTypeCheck(command, run(`${TYPE_CHECK_STARTED}\nKilled\n`, 137))).toBe(
    'tsc failed without a diagnostic',
  );
  // Type errors in files mean it checked; the repository's own tsc -p . is never Refit-generated.
  expect(
    unavailableTypeCheck(command, run(`${TYPE_CHECK_STARTED}\napi/a.ts(1,1): error TS2322: x\n`)),
  ).toBeUndefined();
  expect(unavailableTypeCheck(TYPE_CHECK, run('error TS6059: x'))).toBeUndefined();
  // get-convex/convex-saas in run 40180681405: an error against the generated config.
  expect(
    unavailableTypeCheck(
      command,
      run(
        `${TYPE_CHECK_STARTED}\n.refit-tsconfig.json(1,34): error TS5069: Option 'tsBuildInfoFile' cannot be specified without specifying option 'incremental' or option 'composite'.\n`,
      ),
    ),
  ).toMatch(/^\.refit-tsconfig\.json\(1,34\): error TS5069/);
  // Deepanshu0211/Rocart in the same run: TS6133, an unused local, is an ordinary diagnostic.
  expect(
    unavailableTypeCheck(
      command,
      run(
        `${TYPE_CHECK_STARTED}\napi/server.js(65,11): error TS6133: 'adjustedLineItems' is declared but its value is never read.\n`,
      ),
    ),
  ).toBeUndefined();
});

// The tests' part of a chain as refit-bench run 40236299492 printed it, before Refit's own lines.
const NO_JEST_TESTS =
  '> jest\n\nNo tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\n';
const NO_MOCHA_TESTS = '\u001b[31mError: No test files found: "test"\u001b[39m\n';
const chained = (tests: string, stderr = '') => ({
  stdout: `${tests}${TESTS_FAILED}\n${TYPE_CHECK_STARTED}\n`,
  stderr,
});

it('counts only the test runner finding no test files as a chain without tests', () => {
  // JensenMPillay/pdfai at 76eee198ded23bf4fafba0e2d431cf01d2f60290 and Panda2Chan/ai-asmr at
  // cbaf6a28512730839a9a0d72a852416e97f0f0dc: `jest`, and the repository has no test file.
  expect(testsFoundNone(chained(NO_JEST_TESTS))).toBe(true);
  // JiantaoFu/insightly at e752d3c311780e3e11ec9738b16a4f6a549cb321: `mocha` reads ./test, which
  // does not exist; Mocha prints its result in red on stderr.
  expect(testsFoundNone(chained('\n> insightly@0.0.0 test\n> mocha\n\n', NO_MOCHA_TESTS))).toBe(
    true,
  );
  // Any other failure of the tests is a failure: a failing test, or a runner that cannot start.
  expect(testsFoundNone(chained('FAIL src/payments.test.ts\n  expected 2 to be 3\n'))).toBe(false);
  expect(testsFoundNone(chained("Error: Cannot find module 'next/jest'\n"))).toBe(false);
  // Tests that passed with none found, and a test script alone, which keeps its baseline stop.
  expect(
    testsFoundNone({
      stdout: `No tests found, exiting with code 0\n${TYPE_CHECK_STARTED}\n`,
      stderr: '',
    }),
  ).toBe(false);
  expect(testsFoundNone({ stdout: NO_JEST_TESTS, stderr: '' })).toBe(false);
  // Only the tests' own output counts, never what follows Refit's lines.
  expect(
    testsFoundNone({
      stdout: `FAIL a.test.ts\n${TESTS_FAILED}\n${TYPE_CHECK_STARTED}\nNo tests found, exiting with code 1\n`,
      stderr: '',
    }),
  ).toBe(false);
});

it('grades a chain whose test script finds no test files by its type check alone', async () => {
  // JensenMPillay/pdfai at 76eee198ded23bf4fafba0e2d431cf01d2f60290.
  const pdfai = await repository({
    'package.json': JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { stripe: '^14.25.0' },
      devDependencies: { jest: '^29.7.0', typescript: '^5.4.5' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '6.0'\n",
    'jest.config.js':
      "const nextJest = require('next/jest');\nmodule.exports = nextJest({ dir: './' })({ testEnvironment: 'jest-environment-jsdom' });\n",
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts', 'jest.config.js'],
      exclude: ['node_modules'],
    }),
    'src/lib/stripe.ts':
      'import Stripe from "stripe";\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" });\n',
    'src/app/api/webhooks/stripe/route.ts':
      'import { stripe } from "@/lib/stripe";\nimport type Stripe from "stripe";\nexport const POST = (event: Stripe.Event) => stripe.subscriptions.retrieve(event.id);\n',
  });
  const selection = await selectCheck(pdfai);
  expect(selection.command).toEqual([
    'sh',
    '-c',
    chain('pnpm test', TYPE_CHECK.join(' ')),
    'refit-check',
  ]);
  const changedFiles = ['src/app/api/webhooks/stripe/route.ts', 'src/lib/stripe.ts'];
  await expect(
    gradeEvidence({ repository: pdfai, command: selection.command!, changedFiles }),
  ).resolves.toMatchObject({ reason: expect.stringMatching(/^The tests pass but reach none/) });
  await expect(
    gradeEvidence({
      repository: pdfai,
      command: selection.command!,
      changedFiles,
      testsFoundNone: true,
    }),
  ).resolves.toEqual({
    letter: 'C',
    level: 'type-check',
    reason:
      'tsc type-checks src/app/api/webhooks/stripe/route.ts, src/lib/stripe.ts; no test ran that code. The test script finds no test files, so only the type check counts.',
  });
  // JiantaoFu/insightly at e752d3c311780e3e11ec9738b16a4f6a549cb321: its own tests (server/tests)
  // are not what `mocha` runs, and the Stripe code is JavaScript only the generated check reads.
  const insightly = await repository({
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'mocha', 'test:server': 'mocha server/tests/sitemap.test.js' },
      dependencies: { stripe: '^18.2.1' },
      devDependencies: { mocha: '^11.1.0', typescript: '^5.5.3' },
    }),
    'package-lock.json': '{}',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
    }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { noEmit: true }, include: ['src'] }),
    'tsconfig.node.json': JSON.stringify({
      compilerOptions: { noEmit: true },
      include: ['vite.config.ts'],
    }),
    'server/index.js':
      "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });\n",
    'server/sitemap.js': 'export const sitemap = () => [];\n',
    'server/tests/sitemap.test.js':
      "import { sitemap } from '../sitemap.js';\nit('maps', () => sitemap());\n",
  });
  const scoped = await selectCheck(insightly);
  expect(scoped).toMatchObject({ kind: 'tests', typeCheck: 'scoped' });
  await expect(
    gradeEvidence({
      repository: insightly,
      command: scoped.command!,
      changedFiles: ['server/index.js'],
      testsFoundNone: true,
      advisory: [
        {
          file: 'server/index.js',
          text: `server/index.js(76,35): error TS2322: Type '"2026-09-30.endive"' is not assignable to type '"2025-05-28.basil"'.`,
        },
      ],
    }),
  ).resolves.toEqual({
    letter: 'D',
    level: 'none',
    reason: `The type check does not cover server/index.js, and no generated check ran it. The test script finds no test files, so only the type check counts. The generated type check reports an advisory type error this patch introduces in JavaScript the repository never type-checks, first server/index.js(76,35): error TS2322: Type '"2026-09-30.endive"' is not assignable to type '"2025-05-28.basil"'..`,
  });
});

it('counts only the listed test files as reaching the changed code', async () => {
  const candidate = await repository({
    ...LINK_FLAME,
    'tests/unit/route.test.ts': "import { POST } from '@/app/api/webhook/route'\nexport { POST }\n",
  });
  const listed = ['npm', 'test', '--', 'tests/unit/webhook.test.ts'];
  expect(
    (
      await gradeEvidence({
        repository: candidate,
        command: listed,
        changedFiles: ['app/api/webhook/route.ts'],
      })
    ).letter,
  ).toBe('D');
  expect(
    (
      await gradeEvidence({
        repository: candidate,
        command: ['npm', 'test'],
        changedFiles: ['app/api/webhook/route.ts'],
      })
    ).letter,
  ).toBe('B');
});

it('grades only the type check when the tests were broken before the patch', async () => {
  // 4NDR3S-01/StyleHub at 8071226: Jest cannot load jest.config.ts on the sandbox's Node, so every
  // run fails before a test starts; its tsconfig covers the Stripe routes.
  const stylehub = await repository({
    'package.json': manifest({ test: 'jest' }),
    'package-lock.json': '{}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true }, include: ['src'] }),
    'src/app/api/stripe/checkout-session.ts':
      "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
    'src/services/checkout.service.ts':
      "import { stripe } from '../app/api/stripe/checkout-session';\nexport const service = stripe;\n",
    'src/__tests__/cart.test.ts': "it('adds', () => 1);\n",
  });
  const { command } = await selectCheck(stylehub);
  const reason =
    'The baseline check npm test fails on the original code, before any change; the first failure: Error: Jest: Failed to parse the TypeScript config file /workspace/jest.config.ts.';
  const changedFiles = ['src/services/checkout.service.ts', 'package.json'];
  expect(
    await gradeEvidence({
      repository: stylehub,
      command: command!,
      changedFiles,
      testsBroken: { reason, typeCheck: { passed: true } },
    }),
  ).toEqual({
    letter: 'C',
    level: 'type-check',
    reason: `${reason} The tests were broken before the patch, so they prove nothing about it; tsc type-checks src/services/checkout.service.ts and passed on both sides.`,
  });
  // JiantaoFu/insightly at e752d3c: mocha's baseline failed in the P2 replay; the scoped type check
  // over server/index.js is what is left, and a type error the patch adds leaves it at grade D.
  const insightly = await repository({
    'package.json': manifest({ test: 'mocha' }),
    'package-lock.json': '{}',
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': JSON.stringify({ include: ['src'] }),
    'server/index.js': "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk');\n",
    'test/app.test.js': "it('serves', () => 1);\n",
  });
  const scoped = await selectCheck(insightly);
  expect(scoped.typeCheck).toBe('scoped');
  expect(
    (
      await gradeEvidence({
        repository: insightly,
        command: scoped.command!,
        changedFiles: ['server/index.js'],
        testsBroken: {
          reason: 'The baseline check npm test fails on the original code, before any change.',
          typeCheck: {
            passed: false,
            detail:
              'the patch introduces a type error, first server/index.js(9,3): error TS2339: x',
          },
        },
      })
    ).reason,
  ).toBe(
    'The baseline check npm test fails on the original code, before any change. The tests were broken before the patch, and the patch introduces a type error, first server/index.js(9,3): error TS2339: x.',
  );
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

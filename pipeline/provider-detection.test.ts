import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { detectProviders, suggestAgents } from './provider-detection.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-detect-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const lock = (stripe: string) =>
  `${JSON.stringify(
    {
      name: 'app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', dependencies: { stripe: '^16.12.0' } },
        'node_modules/stripe': {
          version: stripe,
          resolved: `https://registry.npmjs.org/stripe/-/stripe-${stripe}.tgz`,
          integrity: `sha512-${'A'.repeat(86)}==`,
        },
      },
    },
    null,
    2,
  )}\n`;
const billing = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });
export const ends = async (id: string) => (await stripe.subscriptions.retrieve(id)).status;
`;

it('detects the Stripe server SDK with its locked version and suggests the Stripe agent', async () => {
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { test: 'vitest run' },
      dependencies: { stripe: '^16.12.0', '@stripe/stripe-js': '^4.0.0' },
    }),
    'package-lock.json': lock('16.12.0'),
    'src/billing.ts': billing,
  });
  const detected = await detectProviders(root);
  expect(detected).toEqual([
    {
      id: 'stripe',
      name: 'Stripe',
      server: true,
      agentAvailable: true,
      evidence: [
        {
          kind: 'dependency',
          file: 'package.json',
          package: 'stripe',
          range: '^16.12.0',
          locked: '16.12.0',
        },
        {
          kind: 'client-dependency',
          file: 'package.json',
          package: '@stripe/stripe-js',
          range: '^4.0.0',
        },
      ],
    },
  ]);
  const [suggestion] = await suggestAgents(root, detected);
  expect(suggestion).toEqual({
    provider: 'stripe',
    integration: {
      id: 'stripe',
      latestStripe: true,
      apiVersion: '2024-06-20',
      apiVersionPolicy: 'source-verified',
      image: 'node:22-alpine',
      prepareDependencies: true,
      command: ['npm', 'test'],
    },
    pending: ['before: the Stripe contract for that API version'],
    reasons: [
      '1 Stripe SDK call in 1 file(s)',
      'package.json declares stripe ^16.12.0 (locked 16.12.0)',
    ],
  });
});

it('reports browser-only Stripe without suggesting an agent', async () => {
  const root = await repository({
    'package.json': JSON.stringify({ dependencies: { '@stripe/react-stripe-js': '^2.0.0' } }),
  });
  const detected = await detectProviders(root);
  expect(detected).toMatchObject([{ id: 'stripe', server: false }]);
  expect(await suggestAgents(root, detected)).toEqual([]);
});

it('detects raw API hosts and reports providers without a ready agent', async () => {
  const root = await repository({
    'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
    'src/mail.ts': `export const send = () =>\n  fetch('https://api.resend.com/emails', { method: 'POST' });\n`,
  });
  const detected = await detectProviders(root);
  expect(detected).toEqual([
    {
      id: 'openai',
      name: 'OpenAI',
      server: true,
      agentAvailable: false,
      evidence: [{ kind: 'dependency', file: 'package.json', package: 'openai', range: '^4.0.0' }],
    },
    {
      id: 'resend',
      name: 'Resend',
      server: true,
      agentAvailable: false,
      evidence: [{ kind: 'hostname', file: 'src/mail.ts', line: 2, hostname: 'api.resend.com' }],
    },
  ]);
  expect(await suggestAgents(root, detected)).toEqual([]);
});

it('ignores lookalike hosts, dependencies and generated or hidden directories', async () => {
  const root = await repository({
    'package.json': JSON.stringify({ name: 'app' }),
    'src/a.ts': `const docs = 'https://api.stripe.com.example.org/v1';\nconst other = 'https://myapi.openai.company';\n`,
    'node_modules/stripe/package.json': JSON.stringify({ dependencies: { stripe: '1.0.0' } }),
    '.keystone/config.js': `fetch('https://api-m.paypal.com');`,
    'dist/bundle.js': `fetch('https://api.stripe.com/v1/charges');`,
  });
  expect(await detectProviders(root)).toEqual([]);
});

it('leaves the API version and checks pending when the code does not settle them', async () => {
  const root = await repository({
    'package.json': JSON.stringify({ dependencies: { stripe: '^16.12.0' } }),
    'src/a.ts': billing,
    'src/b.ts': billing.replace("'2024-06-20'", "'2023-10-16'"),
  });
  const [suggestion] = await suggestAgents(root, await detectProviders(root));
  expect(suggestion.integration).toEqual({
    id: 'stripe',
    latestStripe: true,
    apiVersionPolicy: 'operator-pin',
    image: 'node:22-alpine',
  });
  expect(suggestion.pending).toEqual([
    'apiVersion: the code pins 2 different Stripe API versions (2024-06-20, 2023-10-16)',
    'before: the Stripe contract for that API version',
    'command: the repository has no test script; choose its checks',
  ]);
});

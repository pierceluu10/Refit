import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryApiVersionPins, type ApiVersionPin } from './commerce-api-versions.ts';
import { declaredPackageNames, readRepository } from './repository.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError, type Repository } from './types.ts';

const PLACEHOLDER_TEST = /no test specified/;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

// A provider agent is a reviewed adapter for one API provider. `adapter` is the built-in adapter
// ID or a shipped adapter file; null means Refit can detect the provider but has no agent yet.
export interface ProviderAgent {
  id: string;
  name: string;
  packages: string[];
  hostnames: string[];
  adapter: { builtIn: string } | { file: string } | null;
  guide: string | null;
}

// The retired legacy (track 1) Azure SDK packages, generated from Microsoft's release data by
// scripts/azure-sdk-retirements.mjs.
const AZURE_LEGACY_PACKAGES: string[] = JSON.parse(
  readFileSync(new URL('../data/azure-sdk-retirements.json', import.meta.url), 'utf8'),
).packages.map((item: { name: string }) => item.name);

// Source: npm package names and documented API base URLs on each provider's docs, 2026-10-15.
export const AGENT_CATALOG: ProviderAgent[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    packages: ['stripe'],
    hostnames: ['api.stripe.com', 'files.stripe.com', 'connect.stripe.com'],
    adapter: { builtIn: 'stripe' },
    guide: 'docs/STRIPE-PLAN.md',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    packages: ['openai'],
    hostnames: ['api.openai.com'],
    adapter: { file: 'examples/openai.provider.json' },
    guide: 'docs/MULTIPLE-INTEGRATIONS.md',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    packages: ['@anthropic-ai/sdk'],
    hostnames: ['api.anthropic.com'],
    adapter: null,
    guide: null,
  },
  // Both npm packages and the default Gemini Developer API host of each, read from the published
  // @google/genai 2.30.0 and @google/generative-ai 0.24.1 code on 2026-10-21. Vertex AI hosts are
  // left out: Google Cloud sets its own model dates there.
  {
    id: 'gemini',
    name: 'Gemini',
    packages: ['@google/genai', '@google/generative-ai'],
    hostnames: ['generativelanguage.googleapis.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'shopify',
    name: 'Shopify',
    packages: [
      '@shopify/shopify-api',
      '@shopify/admin-api-client',
      '@shopify/shopify-app-remix',
      '@shopify/shopify-app-react-router',
      '@shopify/shopify-app-express',
      'shopify-api-node',
    ],
    hostnames: ['myshopify.com/admin/api'],
    adapter: { builtIn: 'shopify' },
    guide: 'docs/SHOPIFY.md',
  },
  {
    id: 'meta-graph',
    name: 'Meta Graph API',
    packages: ['facebook-nodejs-business-sdk'],
    hostnames: ['graph.facebook.com'],
    adapter: null,
    guide: null,
  },
  // The Octokit packages and @actions/github, each checked on npm on 2026-10-22, and the REST and
  // GraphQL host. Review-only detection lives in `refit github-api`.
  {
    id: 'github',
    name: 'GitHub API',
    packages: [
      'octokit',
      '@octokit/rest',
      '@octokit/core',
      '@octokit/request',
      '@octokit/graphql',
      '@octokit/app',
      '@octokit/action',
      '@actions/github',
    ],
    hostnames: ['api.github.com'],
    adapter: null,
    guide: 'docs/GITHUB-API-DETECTION.md',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    packages: ['twilio'],
    hostnames: ['api.twilio.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    packages: ['@sendgrid/mail', '@sendgrid/client'],
    hostnames: ['api.sendgrid.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'resend',
    name: 'Resend',
    packages: ['resend'],
    hostnames: ['api.resend.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'paypal',
    name: 'PayPal',
    packages: ['@paypal/paypal-server-sdk', '@paypal/checkout-server-sdk'],
    hostnames: ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
    adapter: null,
    guide: null,
  },
  // npm packages checked on the registry on 2026-10-22 (@slack/client is deprecated there in favour
  // of the other four). Hosts from @slack/web-api's default `slackApiUrl` and @slack/webhook's
  // incoming-webhook URLs. `refit slack` lists the methods called (docs/SLACK-DETECTION.md).
  {
    id: 'slack',
    name: 'Slack',
    packages: [
      '@slack/web-api',
      '@slack/bolt',
      '@slack/rtm-api',
      '@slack/webhook',
      '@slack/client',
    ],
    hostnames: ['slack.com/api', 'hooks.slack.com/services'],
    adapter: null,
    guide: 'docs/SLACK-DETECTION.md',
  },
  // The `cloudflare` npm package (checked on the registry on 2026-10-22) and the server of
  // Cloudflare's published OpenAPI document. `refit cloudflare` lists the endpoints called
  // (docs/CLOUDFLARE.md).
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    packages: ['cloudflare'],
    hostnames: ['api.cloudflare.com'],
    adapter: null,
    guide: 'docs/CLOUDFLARE.md',
  },
  // Auth and backend SDKs (docs/AUTH-BACKEND-SDKS.md). Every package was read on the npm registry
  // on 2026-10-22, with its repository in the provider's GitHub organization. The hostnames come
  // from the published SDK code: Auth0 tenant domains (`your-tenant.auth0.com` in auth0 7.6.0),
  // Clerk's Backend API (`API_URL` in @clerk/backend 3.26.1), the Firebase service hosts in
  // firebase-admin 14.5.0 and the @firebase packages, and Supabase project URLs
  // (`xyzcompany.supabase.co` in @supabase/supabase-js 2.118.0).
  {
    id: 'auth0',
    name: 'Auth0',
    packages: [
      'auth0',
      '@auth0/nextjs-auth0',
      '@auth0/auth0-react',
      '@auth0/auth0-spa-js',
      '@auth0/auth0-angular',
      '@auth0/auth0-vue',
      '@auth0/auth0-auth-js',
      '@auth0/auth0-server-js',
      'auth0-js',
      'auth0-lock',
      'express-openid-connect',
      'express-oauth2-jwt-bearer',
    ],
    hostnames: ['.auth0.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'clerk',
    name: 'Clerk',
    packages: [
      '@clerk/nextjs',
      '@clerk/react',
      '@clerk/clerk-react',
      '@clerk/clerk-js',
      '@clerk/backend',
      '@clerk/express',
      '@clerk/clerk-sdk-node',
      '@clerk/expo',
      '@clerk/clerk-expo',
      '@clerk/remix',
      '@clerk/react-router',
      '@clerk/astro',
      '@clerk/vue',
      '@clerk/nuxt',
      '@clerk/fastify',
      '@clerk/chrome-extension',
      '@clerk/tanstack-react-start',
      '@clerk/types',
      '@clerk/elements',
      '@clerk/edge',
    ],
    hostnames: ['api.clerk.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'firebase',
    name: 'Firebase',
    packages: ['firebase', 'firebase-admin'],
    hostnames: [
      'firestore.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebasestorage.googleapis.com',
      'firebaseio.com',
    ],
    adapter: null,
    guide: null,
  },
  {
    id: 'supabase',
    name: 'Supabase',
    packages: [
      '@supabase/supabase-js',
      '@supabase/ssr',
      '@supabase/auth-helpers-nextjs',
      '@supabase/auth-helpers-react',
      '@supabase/auth-helpers-remix',
      '@supabase/auth-helpers-sveltekit',
      '@supabase/auth-helpers-shared',
    ],
    hostnames: ['.supabase.co'],
    adapter: null,
    guide: null,
  },
  // Payments and commerce APIs (docs/COMMERCE-APIS.md). Every package was read on the npm registry
  // on 2026-10-22, with its repository in the provider's GitHub organization (@paddle/paddle-js is
  // published by the paddle.com npm account). The hostnames are the API bases in each provider's
  // published SDK code: plaid-node, square-nodejs-sdk, braintree_node and braintree-web,
  // adyen-node-api-library, paddle-node-sdk, lemonsqueezy.js, shippo-javascript-sdk,
  // easypost-node, lob-node and coinbase-commerce-node.
  {
    id: 'plaid',
    name: 'Plaid',
    packages: ['plaid', 'react-plaid-link'],
    hostnames: ['production.plaid.com', 'sandbox.plaid.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'square',
    name: 'Square',
    packages: ['square', '@square/web-sdk', '@square/web-payments-sdk-types'],
    hostnames: ['connect.squareup.com', 'connect.squareupsandbox.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'braintree',
    name: 'Braintree',
    packages: ['braintree', 'braintree-web', 'braintree-web-drop-in'],
    hostnames: [
      'api.braintreegateway.com',
      'api.sandbox.braintreegateway.com',
      'payments.braintree-api.com',
      'payments.sandbox.braintree-api.com',
    ],
    adapter: null,
    guide: null,
  },
  {
    id: 'adyen',
    name: 'Adyen',
    packages: ['@adyen/api-library', '@adyen/adyen-web'],
    hostnames: [
      'checkout-test.adyen.com',
      'checkout-live.adyenpayments.com',
      'pal-test.adyen.com',
      'pal-live.adyen.com',
      'management-test.adyen.com',
      'management-live.adyen.com',
    ],
    adapter: null,
    guide: null,
  },
  {
    id: 'paddle',
    name: 'Paddle',
    packages: ['@paddle/paddle-node-sdk', '@paddle/paddle-js'],
    hostnames: ['api.paddle.com', 'sandbox-api.paddle.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'lemon-squeezy',
    name: 'Lemon Squeezy',
    packages: ['@lemonsqueezy/lemonsqueezy.js'],
    hostnames: ['api.lemonsqueezy.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'shippo',
    name: 'Shippo',
    packages: ['shippo'],
    hostnames: ['api.goshippo.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'easypost',
    name: 'EasyPost',
    packages: ['@easypost/api'],
    hostnames: ['api.easypost.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'lob',
    name: 'Lob',
    packages: ['lob', '@lob/lob-typescript-sdk'],
    hostnames: ['api.lob.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'coinbase-commerce',
    name: 'Coinbase Commerce',
    packages: ['coinbase-commerce-node'],
    hostnames: ['api.commerce.coinbase.com'],
    adapter: null,
    guide: null,
  },
  // NextAuth.js and Auth.js run inside the application, so they have no API host of their own.
  // Packages read on the npm registry on 2026-10-22, all from nextauthjs/next-auth.
  {
    id: 'nextauth',
    name: 'NextAuth.js',
    packages: [
      'next-auth',
      '@auth/core',
      '@auth/sveltekit',
      '@auth/express',
      '@auth/qwik',
      '@auth/solid-start',
    ],
    hostnames: [],
    adapter: null,
    guide: null,
  },
  // AWS SDK for JavaScript v2, whose support ended on 2025-09-08 (data/deadlines.json). No hostname:
  // amazonaws.com also appears in S3 asset URLs and CSP lists that use no SDK. v3's per-service
  // @aws-sdk/client-* packages are listed by scanCloudSdkClients (pipeline/cloud-sdk-clients.ts)
  // rather than named here one by one.
  {
    id: 'aws',
    name: 'AWS SDK for JavaScript',
    packages: ['aws-sdk'],
    hostnames: [],
    adapter: null,
    guide: null,
  },
  // Only the retired legacy Azure SDK packages: their end of life is the deadline Refit monitors.
  {
    id: 'azure',
    name: 'Azure SDK (legacy)',
    packages: AZURE_LEGACY_PACKAGES,
    hostnames: [],
    adapter: null,
    guide: null,
  },
];

const MAX_HOSTNAME_EVIDENCE = 5;

export interface AgentDetection {
  agent: ProviderAgent;
  packages: { file: string; name: string; version: string; locked: string | null }[];
  hostnames: { file: string; line: number; hostname: string }[];
  // API versions the code pins for providers that version their API by header, option or path.
  apiVersions?: ApiVersionPin[];
}

// A hostname in a line, not as the start of a longer name: `.supabase.co` is in
// `https://abc.supabase.co/rest` but not in `api.supabase.com`.
function hostnameIn(line: string, hostname: string) {
  for (let at = line.indexOf(hostname); at >= 0; at = line.indexOf(hostname, at + 1))
    if (!/[A-Za-z0-9-]/.test(line[at + hostname.length] ?? '')) return true;
  return false;
}

function hostnameEvidence(repository: Repository, agent: ProviderAgent) {
  const evidence: AgentDetection['hostnames'] = [];
  for (const file of repository.files)
    for (const [index, line] of file.content.split('\n').entries())
      for (const hostname of agent.hostnames)
        if (hostnameIn(line, hostname) && evidence.length < MAX_HOSTNAME_EVIDENCE)
          evidence.push({ file: file.path, line: index + 1, hostname });
  return evidence;
}

// Reads each catalog provider's manifest declarations and lock evidence, plus raw API hostnames in
// source, without running repository code or contacting any provider.
export async function detectProviders(directory: string): Promise<AgentDetection[]> {
  const detections: AgentDetection[] = [];
  // Source files are the same whichever package a read resolves, so one read serves every
  // hostname check, and a package is read again only when some manifest declares it.
  const repository: Repository = await readRepository(directory);
  const declared = await declaredPackageNames(directory);
  const pins = repositoryApiVersionPins(repository);
  for (const agent of AGENT_CATALOG) {
    const packages: AgentDetection['packages'] = [];
    for (const name of agent.packages) {
      if (declared && !declared.has(name)) continue;
      for (const dependency of (await readRepository(directory, name)).dependencies)
        packages.push({
          file: dependency.file,
          name,
          version: dependency.version,
          locked: dependency.lock.version,
        });
    }
    const hostnames = hostnameEvidence(repository, agent);
    const apiVersions = pins.filter((pin) => pin.provider === agent.id);
    if (packages.length || hostnames.length || apiVersions.length)
      detections.push({
        agent,
        packages,
        hostnames,
        ...(apiVersions.length ? { apiVersions } : {}),
      });
  }
  return detections;
}

// Chooses a scaffold's check: npm test when package.json has a real test script, and dependency
// preparation when a lockfile is committed.
export async function scaffoldChecks(root: string) {
  const manifest = existsSync(join(root, 'package.json'))
    ? parseObject(await readFile(join(root, 'package.json'), 'utf8'), 'package.json')
    : {};
  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  return {
    testScript: typeof scripts.test === 'string' && !PLACEHOLDER_TEST.test(scripts.test),
    lockfile: LOCKFILES.some((name) => existsSync(join(root, name))),
  };
}

export interface AgentScaffold {
  configuration: Record<string, unknown>;
  adapterFiles: { source: string; target: string }[];
  nextSteps: string[];
}

function configuredIds(configuration: Record<string, unknown> | undefined, v1Id: string) {
  if (!configuration) return [];
  if (configuration.formatVersion === 2 && Array.isArray(configuration.integrations))
    return configuration.integrations.map((entry) => String((entry as { id?: unknown }).id));
  return [v1Id];
}

// The package a built-in integration (no providerConfig) covers. Shopify's built-in integration is
// named `shopify` by `refit agents --add shopify`, and its contracts are Shopify schema snapshots.
export function builtInPackage(integration: Record<string, unknown>) {
  const shopify = [integration.id, integration.before, integration.after].some(
    (value) => typeof value === 'string' && /shopify/i.test(value),
  );
  return shopify ? '@shopify/shopify-api' : 'stripe';
}

// The integration a v1 configuration already describes: its adapter ID or the built-in Stripe agent.
export function v1IntegrationId(adapterId: string | undefined) {
  return adapterId ?? 'stripe';
}

// Adds approved agents to a repository configuration as reviewable integration scaffolds. Contracts
// and checks still need setup, and nothing is enrolled or activated.
export function addAgents(options: {
  configuration: Record<string, unknown> | undefined;
  v1Id: string;
  detections: AgentDetection[];
  ids: string[];
  testScript: boolean;
  lockfile: boolean;
}): AgentScaffold & { added: string[] } {
  const existing = configuredIds(options.configuration, options.v1Id);
  const integrations: Record<string, unknown>[] =
    options.configuration?.formatVersion === 2 && Array.isArray(options.configuration.integrations)
      ? [...(options.configuration.integrations as Record<string, unknown>[])]
      : options.configuration
        ? [
            {
              id: options.v1Id,
              ...Object.fromEntries(
                Object.entries(options.configuration).filter(
                  ([key]) => key !== 'formatVersion' && key !== 'repository',
                ),
              ),
            },
          ]
        : [];
  const added: string[] = [];
  const adapterFiles: AgentScaffold['adapterFiles'] = [];
  const nextSteps: string[] = [];
  for (const id of options.ids) {
    const detection = options.detections.find((entry) => entry.agent.id === id);
    if (!detection)
      throw new PipelineInputError(
        `${id} was not detected in this repository; only detected agents can be added.`,
      );
    if (!detection.agent.adapter)
      throw new PipelineInputError(`Refit has no ${detection.agent.name} agent yet.`);
    if (existing.includes(id) || added.includes(id)) continue;
    const adapter = detection.agent.adapter;
    if ('file' in adapter)
      adapterFiles.push({ source: adapter.file, target: `refit/${id}.provider.json` });
    integrations.push({
      id,
      before: `./refit/${id}-before.json`,
      after: `./refit/${id}-after.json`,
      ...('file' in adapter ? { providerConfig: `./refit/${id}.provider.json` } : {}),
      image: 'node:22-alpine',
      ...(options.lockfile ? { prepareDependencies: true } : {}),
      command: options.testScript ? ['npm', 'test'] : ['npm', 'run', 'build'],
    });
    added.push(id);
    nextSteps.push(
      `Save reviewed ${detection.agent.name} contracts at refit/${id}-before.json and refit/${id}-after.json` +
        (id === 'stripe'
          ? ' (refit stripe-snapshot --revision <sha> --output …).'
          : id === 'shopify'
            ? ' (refit shopify-snapshot --version <pinned version, or 2026-01 if older> --output … and --version <target>).'
            : ' (refit source-snapshot …).'),
    );
  }
  if (added.length)
    nextSteps.push(
      'Review the check command, then run refit doctor. Nothing runs until you approve the configuration with refit enroll.',
    );
  return {
    configuration: { formatVersion: 2, integrations },
    adapterFiles,
    added,
    nextSteps,
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryApiVersionPins, type ApiVersionPin } from './commerce-api-versions.ts';
import {
  matchesPackage,
  readPackageManifests,
  type Ecosystem,
  type PackageInventory,
} from './package-manifests.ts';
import { declaredPackageNames, readRepository } from './repository.ts';
import { parseObject } from './specifications.ts';
import {
  nestedLock,
  placeFinding,
  readWorkspaceLayout,
  type FindingPlace,
} from './workspace-attribution.ts';
import { PipelineInputError, type Repository } from './types.ts';
import { contractCommand } from './contract-commands.ts';
import type { DocumentationSource } from './documentation-sources.ts';
import { readVendorCatalog, type VendorSources } from './vendor-catalog.ts';
import { hostnameIn, scanVendorReferences, type VendorReference } from './vendor-references.ts';

const PLACEHOLDER_TEST = /no test specified/;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

// A provider agent is a reviewed adapter for one API provider. `adapter` is the built-in adapter
// ID or a shipped adapter file; null means Refit can detect the provider but has no agent yet.
export interface ProviderAgent {
  id: string;
  name: string;
  packages: string[];
  // Package names in other ecosystems' registries, each checked on that registry (see
  // docs/benchmarks/2026-10-22-catalog-registry-check.json). `packages` stays npm only.
  ecosystems?: Partial<Record<Ecosystem, string[]>>;
  hostnames: string[];
  adapter: { builtIn: string } | { file: string } | null;
  guide: string | null;
  // From data/vendor-catalog.json: environment variable names specific to the vendor, its published
  // OpenAPI document and its changelog pages, which make it a watch target.
  envVars?: string[];
  specification?: string;
  documentation?: DocumentationSource[];
}

// The retired legacy (track 1) Azure SDK packages, generated from Microsoft's release data by
// scripts/azure-sdk-retirements.mjs.
const AZURE_LEGACY_PACKAGES: string[] = JSON.parse(
  readFileSync(new URL('../data/azure-sdk-retirements.json', import.meta.url), 'utf8'),
).packages.map((item: { name: string }) => item.name);

// Source: npm package names and documented API base URLs on each provider's docs, 2026-10-15.
const PROVIDER_AGENTS: ProviderAgent[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    packages: ['stripe'],
    ecosystems: {
      pypi: ['stripe'],
      go: ['github.com/stripe/stripe-go'],
      rubygems: ['stripe'],
      packagist: ['stripe/stripe-php'],
      maven: [
        'com.stripe:stripe-java',
        'com.stripe:stripe-android',
        'com.stripe:stripeterminal',
        'com.stripe:stripeterminal-core',
        'com.stripe:stripeterminal-localmobile',
      ],
      nuget: ['Stripe.net'],
      cargo: ['async-stripe'],
    },
    hostnames: ['api.stripe.com', 'files.stripe.com', 'connect.stripe.com'],
    adapter: { builtIn: 'stripe' },
    guide: 'docs/STRIPE-PLAN.md',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    packages: ['openai'],
    ecosystems: {
      pypi: ['openai'],
      go: ['github.com/openai/openai-go', 'github.com/sashabaranov/go-openai'],
      rubygems: ['openai', 'ruby-openai'],
      packagist: ['openai-php/client'],
      maven: ['com.openai:openai-java', 'com.theokanning.openai-gpt3-java:service'],
      nuget: ['OpenAI'],
      cargo: ['async-openai'],
    },
    hostnames: ['api.openai.com'],
    adapter: { file: 'examples/openai.provider.json' },
    guide: 'docs/MULTIPLE-INTEGRATIONS.md',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    packages: ['@anthropic-ai/sdk'],
    ecosystems: {
      pypi: ['anthropic'],
      go: ['github.com/anthropics/anthropic-sdk-go'],
      rubygems: ['anthropic'],
      packagist: ['anthropic-ai/sdk'],
      maven: ['com.anthropic:anthropic-java'],
      nuget: ['Anthropic', 'Anthropic.SDK'],
    },
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
    ecosystems: {
      pypi: ['google-genai', 'google-generativeai'],
      go: ['google.golang.org/genai', 'github.com/google/generative-ai-go'],
      rubygems: ['gemini-ai'],
      packagist: ['google-gemini-php/client'],
      maven: ['com.google.genai:google-genai'],
      nuget: ['Google.GenAI', 'Google_GenerativeAI'],
    },
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
    ecosystems: {
      pypi: ['ShopifyAPI'],
      go: ['github.com/bold-commerce/go-shopify'],
      rubygems: ['shopify_api'],
      packagist: ['shopify/shopify-api'],
      nuget: ['ShopifySharp'],
    },
    hostnames: ['myshopify.com/admin/api'],
    adapter: { builtIn: 'shopify' },
    guide: 'docs/SHOPIFY.md',
  },
  {
    id: 'meta-graph',
    name: 'Meta Graph API',
    packages: ['facebook-nodejs-business-sdk'],
    ecosystems: {
      pypi: ['facebook-business'],
      rubygems: ['facebookbusiness'],
      packagist: ['facebook/php-business-sdk'],
      maven: ['com.facebook.business.sdk:facebook-java-business-sdk'],
    },
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
  // Messaging (docs/MESSAGING-APIS.md). Package names were checked on the npm registry and each
  // host read from the SDK's own source on 2026-10-22: twilio 6.2.0 (`lib/rest/*Base.js`),
  // @sendgrid/client 8.1.6, resend 6.34.1, postmark 5.1.0 and mailgun.js 14.1.0 (the EU host from
  // its README). `sendgrid` and `mailgun-js` are the retired packages npm marks deprecated.
  {
    id: 'twilio',
    name: 'Twilio',
    packages: ['twilio'],
    ecosystems: {
      pypi: ['twilio'],
      go: ['github.com/twilio/twilio-go'],
      rubygems: ['twilio-ruby'],
      packagist: ['twilio/sdk'],
      maven: ['com.twilio.sdk:twilio'],
      nuget: ['Twilio', 'Twilio.AspNet.Core', 'Twilio.AspNet.Common', 'Twilio.AspNet.Mvc'],
    },
    hostnames: [
      'accounts.twilio.com',
      'api.twilio.com',
      'bulkexports.twilio.com',
      'chat.twilio.com',
      'content.twilio.com',
      'conversations.twilio.com',
      'events.twilio.com',
      'flex-api.twilio.com',
      'frontline-api.twilio.com',
      'iam.twilio.com',
      'insights.twilio.com',
      'intelligence.twilio.com',
      'ip-messaging.twilio.com',
      'knowledge.twilio.com',
      'lookups.twilio.com',
      'marketplace.twilio.com',
      'memory.twilio.com',
      'messaging.twilio.com',
      'monitor.twilio.com',
      'notify.twilio.com',
      'numbers.twilio.com',
      'oauth.twilio.com',
      'preview-iam.twilio.com',
      'preview.twilio.com',
      'pricing.twilio.com',
      'proxy.twilio.com',
      'routes.twilio.com',
      'serverless.twilio.com',
      'studio.twilio.com',
      'supersim.twilio.com',
      'sync.twilio.com',
      'taskrouter.twilio.com',
      'trunking.twilio.com',
      'trusthub.twilio.com',
      'verify.twilio.com',
      'video.twilio.com',
      'voice.twilio.com',
      'wireless.twilio.com',
    ],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    packages: ['@sendgrid/mail', '@sendgrid/client', 'sendgrid'],
    ecosystems: {
      pypi: ['sendgrid'],
      go: ['github.com/sendgrid/sendgrid-go'],
      rubygems: ['sendgrid-ruby'],
      packagist: ['sendgrid/sendgrid'],
      maven: ['com.sendgrid:sendgrid-java'],
      nuget: ['SendGrid'],
    },
    hostnames: ['api.sendgrid.com', 'api.eu.sendgrid.com'],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'resend',
    name: 'Resend',
    packages: ['resend'],
    ecosystems: {
      pypi: ['resend'],
      // resendlabs/resend-go is the module path before the repository moved to resend/.
      go: ['github.com/resend/resend-go', 'github.com/resendlabs/resend-go'],
      rubygems: ['resend'],
      packagist: ['resend/resend-php'],
      maven: ['com.resend:resend-java'],
      nuget: ['Resend'],
      cargo: ['resend-rs'],
    },
    hostnames: ['api.resend.com'],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    packages: ['postmark'],
    hostnames: ['api.postmarkapp.com'],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'mailgun',
    name: 'Mailgun',
    packages: ['mailgun.js', 'mailgun-js'],
    hostnames: ['api.mailgun.net', 'api.eu.mailgun.net'],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    packages: ['@paypal/paypal-server-sdk', '@paypal/checkout-server-sdk'],
    ecosystems: {
      pypi: ['paypal-server-sdk'],
      rubygems: ['paypal-server-sdk'],
      packagist: ['paypal/paypal-server-sdk'],
      maven: ['com.paypal.sdk:paypal-server-sdk'],
      nuget: ['PayPalServerSDK'],
    },
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
  // Data and productivity APIs (FG3): npm package names read from the npm registry and API hosts
  // from each provider's API reference, 2026-10-22. Detection only; no adapter.
  {
    id: 'google-maps',
    name: 'Google Maps Platform',
    packages: [
      '@googlemaps/google-maps-services-js',
      '@googlemaps/js-api-loader',
      '@react-google-maps/api',
      '@vis.gl/react-google-maps',
    ],
    hostnames: ['maps.googleapis.com', 'places.googleapis.com', 'routes.googleapis.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'mapbox',
    name: 'Mapbox',
    packages: ['mapbox-gl', '@mapbox/mapbox-sdk', '@mapbox/search-js-react'],
    hostnames: ['api.mapbox.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'algolia',
    name: 'Algolia',
    packages: [
      'algoliasearch',
      '@algolia/client-search',
      'instantsearch.js',
      'react-instantsearch',
    ],
    // Subdomains only (`<app>-dsn.algolia.net`): the bare domain names no API request.
    hostnames: ['.algolia.net', '.algolianet.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    packages: ['@hubspot/api-client'],
    hostnames: ['api.hubapi.com', 'api.hubspot.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'intercom',
    name: 'Intercom',
    packages: ['intercom-client'],
    hostnames: ['api.intercom.io'],
    adapter: null,
    guide: null,
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    packages: ['@mailchimp/mailchimp_marketing', '@mailchimp/mailchimp_transactional'],
    hostnames: ['api.mailchimp.com', 'mandrillapp.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'zoom',
    name: 'Zoom',
    packages: ['@zoom/meetingsdk', '@zoom/videosdk', '@zoomus/websdk'],
    hostnames: ['api.zoom.us'],
    adapter: null,
    guide: null,
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    packages: ['dropbox'],
    hostnames: ['api.dropboxapi.com', 'content.dropboxapi.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'notion',
    name: 'Notion',
    packages: ['@notionhq/client'],
    hostnames: ['api.notion.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'airtable',
    name: 'Airtable',
    packages: ['airtable'],
    hostnames: ['api.airtable.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'segment',
    name: 'Segment',
    packages: ['@segment/analytics-node', '@segment/analytics-next', 'analytics-node'],
    hostnames: ['api.segment.io'],
    adapter: null,
    guide: null,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    packages: ['@sentry/node', '@sentry/browser', '@sentry/react', '@sentry/nextjs', 'raven-js'],
    // Sentry's web API is /api/0/; ingest URLs (`o1.ingest.sentry.io/api/<project>/envelope`) are SDK traffic.
    hostnames: ['sentry.io/api/0/'],
    adapter: null,
    guide: null,
  },
  {
    id: 'discord',
    name: 'Discord',
    packages: ['discord.js', 'discord-api-types'],
    hostnames: ['discord.com/api', 'discordapp.com/api'],
    adapter: null,
    guide: null,
  },
  {
    id: 'contentful',
    name: 'Contentful',
    packages: ['contentful', 'contentful-management'],
    hostnames: ['cdn.contentful.com', 'api.contentful.com', 'preview.contentful.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'cloudinary',
    name: 'Cloudinary',
    packages: ['cloudinary', '@cloudinary/url-gen', '@cloudinary/react'],
    hostnames: ['api.cloudinary.com'],
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

export const VENDOR_CATALOG = readVendorCatalog(PROVIDER_AGENTS.map((agent) => agent.id));

function withSources(agent: ProviderAgent, sources: VendorSources = {}): ProviderAgent {
  const ecosystems = { ...agent.ecosystems };
  for (const [ecosystem, names] of Object.entries(sources.ecosystems ?? {}) as [
    Ecosystem,
    string[],
  ][])
    ecosystems[ecosystem] = [...new Set([...(ecosystems[ecosystem] ?? []), ...names])];
  return {
    ...agent,
    ...(Object.keys(ecosystems).length ? { ecosystems } : {}),
    ...(sources.envVars ? { envVars: sources.envVars.flatMap((group) => group.names) } : {}),
    ...(sources.specification ? { specification: sources.specification.url } : {}),
    ...(sources.documentation
      ? { documentation: sources.documentation.map(({ label, url }) => ({ label, url })) }
      : {}),
  };
}

// Reviewed providers first, then the vendors data/vendor-catalog.json adds with no agent.
export const AGENT_CATALOG: ProviderAgent[] = [
  ...PROVIDER_AGENTS.map((agent) => withSources(agent, VENDOR_CATALOG.sources[agent.id])),
  ...VENDOR_CATALOG.vendors.map(({ id, name, packages, hostnames, ...sources }) =>
    withSources(
      {
        id,
        name,
        packages,
        hostnames: hostnames.flatMap((group) => group.names),
        adapter: null,
        guide: null,
      },
      sources,
    ),
  ),
];

const MAX_HOSTNAME_EVIDENCE = 5;

export interface AgentDetection {
  agent: ProviderAgent;
  // `ecosystem` is absent for npm packages, which keep their original shape.
  packages: ({
    file: string;
    name: string;
    version: string;
    locked: string | null;
    ecosystem?: Ecosystem;
    line?: number;
  } & Partial<FindingPlace>)[];
  // `workspace` and `excluded` (pipeline/workspace-attribution.ts) say which package of a monorepo
  // the evidence is in and whether its path is outside the product, such as an example.
  hostnames: ({ file: string; line: number; hostname: string } & Partial<FindingPlace>)[];
  // API versions the code pins for providers that version their API by header, option or path.
  apiVersions?: ApiVersionPin[];
  // Requests the code sends to the provider's hosts through an HTTP client (fetch, axios, got, ky,
  // undici, node:http(s), superagent), from pipeline/api-hosts.ts: tests, docs, assets and
  // allowlists are left out, which `hostnames` does not do.
  requests: { host: string; file: string; line: number; client: string }[];
  // Vendor environment variable names in any source or configuration file, and vendor hostnames
  // outside JavaScript and TypeScript. Report only: they never make an agent addable.
  references: VendorReference[];
}

// Whether the vendor scan stopped at its file limits, which leaves later files unread.
export interface ProviderDetections {
  detections: AgentDetection[];
  vendorScan: { files: number; truncated: boolean };
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

// Direct dependencies in other ecosystems' manifests that are one of the agent's packages.
export function ecosystemPackages(
  agent: ProviderAgent,
  inventory: PackageInventory,
): AgentDetection['packages'] {
  const packages: AgentDetection['packages'] = [];
  for (const dependency of inventory.dependencies) {
    if (!dependency.direct) continue;
    const names = agent.ecosystems?.[dependency.ecosystem] ?? [];
    if (!names.some((name) => matchesPackage(dependency, name))) continue;
    packages.push({
      file: dependency.file,
      name: dependency.name,
      version: dependency.declared ?? '',
      locked: dependency.locked,
      ecosystem: dependency.ecosystem,
      line: dependency.line,
    });
  }
  return packages;
}

// Reads each catalog provider's manifest declarations and lock evidence in every supported
// ecosystem, raw API hostnames in source and configuration files and vendor environment variable
// names, without running repository code or contacting any provider.
export async function detectProviders(directory: string): Promise<AgentDetection[]> {
  return (await scanProviders(directory)).detections;
}

export async function scanProviders(directory: string): Promise<ProviderDetections> {
  const detections: AgentDetection[] = [];
  const inventory = await readPackageManifests(directory);
  const layout = await readWorkspaceLayout(directory);
  // Source files are the same whichever package a read resolves, so one read serves every
  // hostname check, and a package is read again only when some manifest declares it.
  const repository: Repository = await readRepository(directory);
  const declared = await declaredPackageNames(directory);
  const pins = repositoryApiVersionPins(repository);
  // Loaded when needed: api-hosts.ts reads this catalog, and deadline-exposure.ts reads it when
  // loaded, so a static import would be a cycle.
  const { detectApiHosts } = await import('./api-hosts.ts');
  // It throws only where readRepository above already would, or on a malformed shipped host list.
  const apiHosts = await detectApiHosts(directory, { repository });
  const vendorScan = await scanVendorReferences(
    directory,
    AGENT_CATALOG.map(({ id, hostnames, envVars }) => ({ id, hostnames, envVars: envVars ?? [] })),
  );
  for (const agent of AGENT_CATALOG) {
    const packages: AgentDetection['packages'] = [];
    for (const name of agent.packages) {
      if (declared && !declared.has(name)) continue;
      for (const dependency of (await readRepository(directory, name)).dependencies)
        packages.push({
          file: dependency.file,
          name,
          version: dependency.version,
          // A nested package's own lockfile when the root's does not cover it.
          locked: (await nestedLock(repository.root, dependency, name)).version,
        });
    }
    packages.push(...ecosystemPackages(agent, inventory));
    const hostnames = hostnameEvidence(repository, agent);
    const apiVersions = pins.filter((pin) => pin.provider === agent.id);
    const requests = apiHosts.hosts
      .filter((host) => host.provider?.id === agent.id)
      .flatMap((host) =>
        host.calls.map(({ file, line, client }) => ({ host: host.host, file, line, client })),
      );
    const references = vendorScan.references.get(agent.id) ?? [];
    if (
      packages.length ||
      hostnames.length ||
      apiVersions.length ||
      requests.length ||
      references.length
    )
      detections.push({
        agent,
        packages: packages.map((item) => ({ ...item, ...placeFinding(layout, item.file) })),
        hostnames: hostnames.map((item) => ({ ...item, ...placeFinding(layout, item.file) })),
        requests,
        references,
        ...(apiVersions.length ? { apiVersions } : {}),
      });
  }
  return {
    detections,
    vendorScan: { files: vendorScan.files, truncated: vendorScan.truncated },
  };
}

// One label per detected vendor: an integration in .refit.json covers it, Refit ships an agent
// that can be added, Refit has an agent but the evidence is report only (other ecosystems,
// environment names, hostnames outside JS/TS), or Refit has no agent for it yet.
export type VendorStatus = 'configured' | 'agent-available' | 'report-only' | 'no-agent';

export function vendorStatus(detection: AgentDetection, configured: boolean): VendorStatus {
  if (configured) return 'configured';
  if (addable(detection)) return 'agent-available';
  return detection.agent.adapter ? 'report-only' : 'no-agent';
}

// A vendor is watched when its catalog entry names an OpenAPI document or changelog pages; the
// watch reads only those public pages and never touches a repository.
export type VendorWatch =
  | { status: 'watched'; specification: string | null; documentation: DocumentationSource[] }
  | { status: 'unwatched'; reason: string };

export function vendorWatch(agent: ProviderAgent): VendorWatch {
  if (!agent.specification && !agent.documentation?.length)
    return {
      status: 'unwatched',
      reason: 'The vendor catalog has no OpenAPI document or changelog page for this vendor.',
    };
  return {
    status: 'watched',
    specification: agent.specification ?? null,
    documentation: agent.documentation ?? [],
  };
}

// Non-npm manifests are report only (owner decision, 2026-10-22): an agent is addable only with
// npm package, JS/TS hostname or API version evidence.
export function addable(detection: AgentDetection) {
  return Boolean(
    detection.agent.adapter &&
    (detection.packages.some((entry) => !entry.ecosystem) ||
      detection.hostnames.length ||
      detection.apiVersions?.length),
  );
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
    if (!addable(detection))
      throw new PipelineInputError(
        `${detection.agent.name} was detected only in non-npm manifests, which are report only.`,
      );
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
      `Save reviewed ${detection.agent.name} contracts: ${contractCommand(id, 'before', `refit/${id}-before.json`)} and ${contractCommand(id, 'after', `refit/${id}-after.json`)}.`,
    );
  }
  if (added.length)
    nextSteps.push(
      'Review the check command in .refit.json, commit .refit.json and the contracts, then run refit doctor. The GitHub App runs nothing until you approve the configuration with refit enroll.',
    );
  return {
    configuration: { formatVersion: 2, integrations },
    adapterFiles,
    added,
    nextSteps,
  };
}

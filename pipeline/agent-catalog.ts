import { readRepository } from './repository.ts';
import { PipelineInputError, type Repository } from './types.ts';

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
    hostnames: ['algolia.net', 'algolianet.com'],
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
    hostnames: ['api.segment.io', 'cdn.segment.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    packages: ['@sentry/node', '@sentry/browser', '@sentry/react', '@sentry/nextjs', 'raven-js'],
    hostnames: ['sentry.io/api'],
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
];

const MAX_HOSTNAME_EVIDENCE = 5;

export interface AgentDetection {
  agent: ProviderAgent;
  packages: { file: string; name: string; version: string; locked: string | null }[];
  hostnames: { file: string; line: number; hostname: string }[];
  // Requests the code sends to the provider's hosts through an HTTP client (fetch, axios, got, ky,
  // undici, node:http(s), superagent), from pipeline/api-hosts.ts: tests, docs, assets and
  // allowlists are left out, which `hostnames` does not do.
  requests: { host: string; file: string; line: number; client: string }[];
}

function hostnameEvidence(repository: Repository, agent: ProviderAgent) {
  const evidence: AgentDetection['hostnames'] = [];
  for (const file of repository.files)
    for (const [index, line] of file.content.split('\n').entries())
      for (const hostname of agent.hostnames)
        if (line.includes(hostname) && evidence.length < MAX_HOSTNAME_EVIDENCE)
          evidence.push({ file: file.path, line: index + 1, hostname });
  return evidence;
}

// Reads each catalog provider's manifest declarations and lock evidence, plus raw API hostnames in
// source, without running repository code or contacting any provider.
export async function detectProviders(directory: string): Promise<AgentDetection[]> {
  const detections: AgentDetection[] = [];
  // Loaded when needed: api-hosts.ts reads this catalog, and deadline-exposure.ts reads it when
  // loaded, so a static import would be a cycle.
  const { detectApiHosts } = await import('./api-hosts.ts');
  const apiHosts = await detectApiHosts(directory);
  for (const agent of AGENT_CATALOG) {
    const packages: AgentDetection['packages'] = [];
    let repository: Repository | undefined;
    // shortcut: reads the repository once per catalog package; fine for a small catalog, share one
    // read across packages if the catalog grows.
    for (const name of agent.packages) {
      repository = await readRepository(directory, name);
      for (const dependency of repository.dependencies)
        packages.push({
          file: dependency.file,
          name,
          version: dependency.version,
          locked: dependency.lock.version,
        });
    }
    const hostnames = hostnameEvidence(repository!, agent);
    const requests = apiHosts.hosts
      .filter((host) => host.provider?.id === agent.id)
      .flatMap((host) =>
        host.calls.map(({ file, line, client }) => ({ host: host.host, file, line, client })),
      );
    if (packages.length || hostnames.length || requests.length)
      detections.push({ agent, packages, hostnames, requests });
  }
  return detections;
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

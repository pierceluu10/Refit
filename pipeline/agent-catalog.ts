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
  // Messaging (docs/MESSAGING-APIS.md). Package names were checked on the npm registry and each
  // host read from the SDK's own source on 2026-10-22: twilio 6.2.0 (`lib/rest/*Base.js`),
  // @sendgrid/client 8.1.6, resend 6.34.1, postmark 5.1.0 and mailgun.js 14.1.0 (the EU host from
  // its README). `sendgrid` and `mailgun-js` are the retired packages npm marks deprecated.
  {
    id: 'twilio',
    name: 'Twilio',
    packages: ['twilio'],
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
    hostnames: ['api.sendgrid.com', 'api.eu.sendgrid.com'],
    adapter: null,
    guide: 'docs/MESSAGING-APIS.md',
  },
  {
    id: 'resend',
    name: 'Resend',
    packages: ['resend'],
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
    hostnames: ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
    adapter: null,
    guide: null,
  },
];

const MAX_HOSTNAME_EVIDENCE = 5;

export interface AgentDetection {
  agent: ProviderAgent;
  packages: { file: string; name: string; version: string; locked: string | null }[];
  hostnames: { file: string; line: number; hostname: string }[];
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
    if (packages.length || hostnames.length) detections.push({ agent, packages, hostnames });
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

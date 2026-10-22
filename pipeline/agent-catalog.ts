import {
  matchesPackage,
  readPackageManifests,
  type Ecosystem,
  type PackageInventory,
} from './package-manifests.ts';
import { readRepository } from './repository.ts';
import {
  nestedLock,
  placeFinding,
  readWorkspaceLayout,
  type FindingPlace,
} from './workspace-attribution.ts';
import { PipelineInputError, type Repository } from './types.ts';

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
}

// Source: npm package names and documented API base URLs on each provider's docs, 2026-10-15.
export const AGENT_CATALOG: ProviderAgent[] = [
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
    hostnames: ['api.twilio.com'],
    adapter: null,
    guide: null,
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    packages: ['@sendgrid/mail', '@sendgrid/client'],
    ecosystems: {
      pypi: ['sendgrid'],
      go: ['github.com/sendgrid/sendgrid-go'],
      rubygems: ['sendgrid-ruby'],
      packagist: ['sendgrid/sendgrid'],
      maven: ['com.sendgrid:sendgrid-java'],
      nuget: ['SendGrid'],
    },
    hostnames: ['api.sendgrid.com'],
    adapter: null,
    guide: null,
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
    guide: null,
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
// ecosystem, plus raw API hostnames in JS/TS source, without running repository code or
// contacting any provider.
export async function detectProviders(directory: string): Promise<AgentDetection[]> {
  const detections: AgentDetection[] = [];
  const inventory = await readPackageManifests(directory);
  const layout = await readWorkspaceLayout(directory);
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
          // A nested package's own lockfile when the root's does not cover it.
          locked: (await nestedLock(repository.root, dependency, name)).version,
        });
    }
    packages.push(...ecosystemPackages(agent, inventory));
    const hostnames = hostnameEvidence(repository!, agent);
    if (packages.length || hostnames.length)
      detections.push({
        agent,
        packages: packages.map((item) => ({ ...item, ...placeFinding(layout, item.file) })),
        hostnames: hostnames.map((item) => ({ ...item, ...placeFinding(layout, item.file) })),
      });
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

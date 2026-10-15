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

export const AGENT_CATALOG: ProviderAgent[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    packages: ['stripe'],
    hostnames: ['api.stripe.com'],
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
  {
    id: 'shopify',
    name: 'Shopify',
    packages: ['@shopify/shopify-api', '@shopify/admin-api-client', 'shopify-api-node'],
    hostnames: ['myshopify.com/admin/api'],
    adapter: null,
    guide: null,
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

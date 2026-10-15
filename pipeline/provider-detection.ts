import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE } from './providers.ts';
import { readRepository } from './repository.ts';
import { isObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Provider SDKs and API hosts Refit recognizes. `agent` marks providers Refit can maintain today
// (a built-in adapter plus a published contract source); the rest are reported, never suggested.
// Source: npm package names and documented API base URLs on each provider's docs, 2026-10-15.
export const PROVIDER_CATALOG = [
  {
    id: 'stripe',
    name: 'Stripe',
    packages: ['stripe'],
    clientPackages: ['@stripe/stripe-js', '@stripe/react-stripe-js'],
    hostnames: ['api.stripe.com', 'files.stripe.com', 'connect.stripe.com'],
    agent: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    packages: ['openai'],
    clientPackages: [],
    hostnames: ['api.openai.com'],
    agent: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    packages: ['@anthropic-ai/sdk'],
    clientPackages: [],
    hostnames: ['api.anthropic.com'],
    agent: false,
  },
  {
    id: 'twilio',
    name: 'Twilio',
    packages: ['twilio'],
    clientPackages: [],
    hostnames: ['api.twilio.com'],
    agent: false,
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    packages: ['@sendgrid/mail', '@sendgrid/client'],
    clientPackages: [],
    hostnames: ['api.sendgrid.com'],
    agent: false,
  },
  {
    id: 'resend',
    name: 'Resend',
    packages: ['resend'],
    clientPackages: [],
    hostnames: ['api.resend.com'],
    agent: false,
  },
  {
    id: 'paypal',
    name: 'PayPal',
    packages: ['@paypal/paypal-server-sdk', '@paypal/checkout-server-sdk'],
    clientPackages: ['@paypal/react-paypal-js', '@paypal/paypal-js'],
    hostnames: ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
    agent: false,
  },
] as const;

export type ProviderId = (typeof PROVIDER_CATALOG)[number]['id'];

export type ProviderEvidence =
  | { kind: 'dependency'; file: string; package: string; range: string; locked?: string }
  | { kind: 'client-dependency'; file: string; package: string; range: string }
  | { kind: 'hostname'; file: string; line: number; hostname: string };

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  // A server SDK or a raw API host: the code calls the provider's API.
  server: boolean;
  agentAvailable: boolean;
  evidence: ProviderEvidence[];
}

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function walk(root: string) {
  const manifests: string[] = [];
  const sources: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (manifests.length + sources.length >= MAX_FILES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Hidden directories hold tool state and generated output (.keystone, .vercel, .turbo).
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) await visit(path);
      } else if (entry.isFile()) {
        if (entry.name === 'package.json') manifests.push(path);
        else if (SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) sources.push(path);
      }
    }
  };
  await visit(root);
  return { manifests, sources };
}

const hostnamePattern = (hostname: string) =>
  new RegExp(`(?:https?:)?//${hostname.replace(/\./g, '\\.')}(?![\\w.-])`);

// Which provider SDKs and API hosts a repository uses, with the evidence for each. Reads files
// only; no package is installed and no code runs.
export async function detectProviders(root: string): Promise<DetectedProvider[]> {
  const { manifests, sources } = await walk(root);
  const evidence = new Map<ProviderId, ProviderEvidence[]>();
  const add = (id: ProviderId, entry: ProviderEvidence) =>
    evidence.set(id, [...(evidence.get(id) ?? []), entry]);
  const declared = new Set<string>();
  for (const path of manifests) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    if (!isObject(manifest)) continue;
    const file = relative(root, path).split('\\').join('/');
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (!isObject(dependencies)) continue;
      for (const provider of PROVIDER_CATALOG)
        for (const [name, range] of Object.entries(dependencies)) {
          if (typeof range !== 'string') continue;
          if ((provider.packages as readonly string[]).includes(name)) {
            add(provider.id, { kind: 'dependency', file, package: name, range });
            declared.add(name);
          } else if ((provider.clientPackages as readonly string[]).includes(name))
            add(provider.id, { kind: 'client-dependency', file, package: name, range });
        }
    }
  }
  // Locked versions come from the existing npm, pnpm and Yarn lockfile readers.
  for (const name of declared) {
    let repository: Repository;
    try {
      repository = await readRepository(root, name);
    } catch {
      continue;
    }
    for (const declaration of repository.dependencies) {
      const version = declaration.lock?.version;
      if (!version) continue;
      for (const entries of evidence.values())
        for (const entry of entries)
          if (
            entry.kind === 'dependency' &&
            entry.package === name &&
            entry.file === declaration.file
          )
            entry.locked = version;
    }
  }
  for (const path of sources) {
    if ((await stat(path)).size > MAX_FILE_BYTES) continue;
    const content = await readFile(path, 'utf8');
    if (
      !PROVIDER_CATALOG.some((provider) =>
        provider.hostnames.some((host) => content.includes(host)),
      )
    )
      continue;
    const file = relative(root, path).split('\\').join('/');
    const lines = content.split('\n');
    for (const provider of PROVIDER_CATALOG)
      for (const hostname of provider.hostnames) {
        const pattern = hostnamePattern(hostname);
        const line = lines.findIndex((text) => pattern.test(text));
        if (line >= 0) add(provider.id, { kind: 'hostname', file, line: line + 1, hostname });
      }
  }
  return PROVIDER_CATALOG.filter((provider) => evidence.has(provider.id)).map((provider) => {
    const found = evidence.get(provider.id)!;
    return {
      id: provider.id,
      name: provider.name,
      server: found.some((entry) => entry.kind !== 'client-dependency'),
      agentAvailable: provider.agent,
      evidence: found,
    };
  });
}

export interface AgentSuggestion {
  provider: ProviderId;
  // A `.refit.json` (formatVersion 2) integration entry for review; nothing is written here.
  integration: Record<string, unknown>;
  // Inputs the approval step must still supply before the integration can run.
  pending: string[];
  reasons: string[];
}

// Suggests agents only for detected providers that call the provider's API and that Refit can
// maintain. Approval and writing `.refit.json` stay with the enrollment flow.
export async function suggestAgents(
  root: string,
  detected: DetectedProvider[],
): Promise<AgentSuggestion[]> {
  const suggestions: AgentSuggestion[] = [];
  for (const provider of detected) {
    if (!provider.server || !provider.agentAvailable || provider.id !== 'stripe') continue;
    const repository = await readRepository(root, 'stripe');
    const analysis = analyzeRepository(repository, [], STRIPE);
    const literals = [
      ...new Set(
        analysis.apiVersionDeclarations
          .filter((declaration) => declaration.status === 'literal')
          .map((declaration) => declaration.value),
      ),
    ];
    const manifest: unknown = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}'),
    );
    const scripts = isObject(manifest) && isObject(manifest.scripts) ? manifest.scripts : {};
    const test =
      typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)
        ? scripts.test
        : undefined;
    const lockfile = repository.lockfiles.find((entry) => !entry.file.includes('/'))?.file;
    const runner =
      lockfile === 'pnpm-lock.yaml' ? 'pnpm' : lockfile === 'yarn.lock' ? 'yarn' : 'npm';
    const pinned = literals.length === 1 ? literals[0] : undefined;
    suggestions.push({
      provider: 'stripe',
      integration: {
        id: 'stripe',
        latestStripe: true,
        ...(pinned
          ? { apiVersion: pinned, apiVersionPolicy: 'source-verified' }
          : { apiVersionPolicy: 'operator-pin' }),
        image: 'node:22-alpine',
        ...(lockfile ? { prepareDependencies: true } : {}),
        ...(test ? { command: [runner, 'test'] } : {}),
      },
      pending: [
        ...(pinned
          ? []
          : [
              literals.length > 1
                ? `apiVersion: the code pins ${literals.length} different Stripe API versions (${literals.join(', ')})`
                : 'apiVersion: the code does not pin a Stripe API version; confirm the account version',
            ]),
        ...(analysis.sdkCalls.length
          ? []
          : ['calls: no Stripe SDK call was traced; confirm the agent covers this repository']),
        'before: the Stripe contract for that API version',
        ...(test ? [] : ['command: the repository has no test script; choose its checks']),
      ],
      reasons: [
        `${analysis.sdkCalls.length} Stripe SDK call${analysis.sdkCalls.length === 1 ? '' : 's'} in ${new Set(analysis.sdkCalls.map((call) => call.file)).size} file(s)`,
        ...provider.evidence
          .filter((entry) => entry.kind === 'dependency')
          .map(
            (entry) =>
              `${entry.file} declares ${entry.package} ${entry.range}${entry.kind === 'dependency' && entry.locked ? ` (locked ${entry.locked})` : ''}`,
          ),
      ],
    });
  }
  return suggestions;
}

import { AGENT_CATALOG, type ProviderAgent } from './agent-catalog.ts';
import { GitHubRequestError } from './github.ts';
import { isObject, parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const MANIFEST_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
export const SUGGESTION_MARKER = '<!-- refit-agent-suggestion -->';

export type GitHubRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<unknown>;

export interface AgentSuggestion {
  agent: ProviderAgent;
  name: string;
  version: string;
}

function declared(manifest: Record<string, unknown>) {
  const packages = new Map<string, string>();
  for (const section of MANIFEST_SECTIONS) {
    const entries = manifest[section];
    if (isObject(entries))
      for (const [name, version] of Object.entries(entries))
        if (typeof version === 'string') packages.set(name, version);
  }
  return packages;
}

// Provider SDKs the head declares that the base did not, which have an agent and are not already
// covered by a configured adapter.
export function newAgentSuggestions(
  base: Record<string, unknown>,
  head: Record<string, unknown>,
  configuredPackages: ReadonlySet<string>,
) {
  const before = declared(base);
  const suggestions: AgentSuggestion[] = [];
  for (const [name, version] of declared(head)) {
    if (before.has(name) || configuredPackages.has(name)) continue;
    const agent = AGENT_CATALOG.find((entry) => entry.adapter && entry.packages.includes(name));
    if (agent && !agent.packages.some((item) => configuredPackages.has(item)))
      suggestions.push({ agent, name, version });
  }
  return suggestions;
}

export function suggestionComment(suggestions: AgentSuggestion[]) {
  return [
    SUGGESTION_MARKER,
    `This pull request adds ${suggestions.length === 1 ? 'a provider SDK' : 'provider SDKs'} that Refit has an agent for:`,
    '',
    ...suggestions.map(
      (entry) =>
        `- **${entry.agent.name}**: \`${entry.name}@${entry.version}\`. Add it with \`refit agents --add ${entry.agent.id}\`.`,
    ),
    '',
    'Nothing runs until a maintainer commits the configuration and approves it with `refit enroll`.',
  ].join('\n');
}

async function fileAt(request: GitHubRequest, repository: string, path: string, ref: string) {
  try {
    const response = await request(
      'GET',
      `/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
    );
    if (
      !isObject(response) ||
      response.encoding !== 'base64' ||
      typeof response.content !== 'string'
    )
      return undefined;
    return parseObject(Buffer.from(response.content, 'base64').toString('utf8'), path);
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return undefined;
    throw error;
  }
}

// Packages already covered by the base branch's committed Refit integrations.
async function configuredPackages(request: GitHubRequest, repository: string, base: string) {
  const configuration = await fileAt(request, repository, REPOSITORY_CONFIGURATION, base);
  const integrations = (
    configuration?.formatVersion === 2 && Array.isArray(configuration.integrations)
      ? configuration.integrations
      : configuration
        ? [configuration]
        : []
  ) as Record<string, unknown>[];
  const packages = new Set<string>();
  for (const integration of integrations) {
    if (typeof integration.providerConfig !== 'string') {
      packages.add('stripe');
      continue;
    }
    const path = integration.providerConfig.replace(/^\.\//, '');
    const adapter = await fileAt(request, repository, path, base);
    if (typeof adapter?.packageName === 'string') packages.add(adapter.packageName);
  }
  return packages;
}

// shortcut: compares the root package.json only; workspace manifests need the same comparison
// once workspace pull requests matter.
export async function suggestAgentsForPullRequest(options: {
  request: GitHubRequest;
  repository: string;
  number: number;
  base: string;
  head: string;
  alreadySuggested?: readonly string[];
}) {
  const [base, head, configured] = await Promise.all([
    fileAt(options.request, options.repository, 'package.json', options.base),
    fileAt(options.request, options.repository, 'package.json', options.head),
    configuredPackages(options.request, options.repository, options.base),
  ]);
  const suggestions = (head ? newAgentSuggestions(base ?? {}, head, configured) : []).filter(
    (entry) => !options.alreadySuggested?.includes(entry.agent.id),
  );
  if (!suggestions.length) return { status: 'no-new-agents' as const, agents: [] as string[] };
  await options.request('POST', `/repos/${options.repository}/issues/${options.number}/comments`, {
    body: suggestionComment(suggestions),
  });
  return { status: 'commented' as const, agents: suggestions.map((entry) => entry.agent.id) };
}

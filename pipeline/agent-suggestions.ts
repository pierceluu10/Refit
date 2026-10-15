import { AGENT_CATALOG, type ProviderAgent } from './agent-catalog.ts';
import { GitHubRequestError } from './github.ts';
import { isObject, parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const MANIFEST_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const FILES_PER_PAGE = 100;
// shortcut: reads the first 1,000 changed files; GitHub lists at most 3,000, raise this if large
// pull requests miss suggestions.
const MAX_FILE_PAGES = 10;
export const SUGGESTION_MARKER = '<!-- refit-agent-suggestion -->';

export type GitHubRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<unknown>;

export interface AgentSuggestion {
  agent: ProviderAgent;
  file: string;
  // Markdown naming what the pull request adds: `name@version` or a raw API hostname.
  evidence: string;
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
  file: string,
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
      suggestions.push({ agent, file, evidence: `\`${name}@${version}\`` });
  }
  return suggestions;
}

// Raw API hostnames a source file's patch adds, for agents not already configured. A hostname the
// same patch also removes is treated as moved code, not new usage.
export function newHostnameSuggestions(
  file: string,
  patch: string,
  configuredPackages: ReadonlySet<string>,
) {
  const lines = patch.split('\n');
  const added = lines.filter((line) => line.startsWith('+'));
  const removed = lines.filter((line) => line.startsWith('-'));
  const suggestions: AgentSuggestion[] = [];
  for (const agent of AGENT_CATALOG) {
    if (!agent.adapter || agent.packages.some((item) => configuredPackages.has(item))) continue;
    const hostname = agent.hostnames.find(
      (host) =>
        added.some((line) => line.includes(host)) && !removed.some((line) => line.includes(host)),
    );
    if (hostname) suggestions.push({ agent, file, evidence: `calls \`${hostname}\`` });
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
        `- **${entry.agent.name}**: ${entry.evidence} in \`${entry.file}\`. Add it with \`refit agents --add ${entry.agent.id}\`.`,
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

interface ChangedFile {
  filename: string;
  previous: string;
  status: string;
  patch: string | undefined;
}

// The pull request's changed files from GitHub's list-files endpoint, so manifests and sources in
// any workspace are compared without reading the whole tree.
async function changedFiles(request: GitHubRequest, repository: string, number: number) {
  const changed: ChangedFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const response = await request(
      'GET',
      `/repos/${repository}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
    );
    if (!Array.isArray(response)) break;
    for (const entry of response)
      if (isObject(entry) && typeof entry.filename === 'string' && typeof entry.status === 'string')
        changed.push({
          filename: entry.filename,
          previous:
            typeof entry.previous_filename === 'string' ? entry.previous_filename : entry.filename,
          status: entry.status,
          patch: typeof entry.patch === 'string' ? entry.patch : undefined,
        });
    if (response.length < FILES_PER_PAGE) break;
  }
  return changed.filter(
    (file) => file.status !== 'removed' && !file.filename.split('/').includes('node_modules'),
  );
}

export async function suggestAgentsForPullRequest(options: {
  request: GitHubRequest;
  repository: string;
  number: number;
  base: string;
  head: string;
  alreadySuggested?: readonly string[];
}) {
  const [files, configured] = await Promise.all([
    changedFiles(options.request, options.repository, options.number),
    configuredPackages(options.request, options.repository, options.base),
  ]);
  const found: AgentSuggestion[] = [];
  for (const file of files)
    if (file.filename === 'package.json' || file.filename.endsWith('/package.json')) {
      const [base, head] = await Promise.all([
        file.status === 'added'
          ? undefined
          : fileAt(options.request, options.repository, file.previous, options.base),
        fileAt(options.request, options.repository, file.filename, options.head),
      ]);
      if (head) found.push(...newAgentSuggestions(file.filename, base ?? {}, head, configured));
    } else if (SOURCE.test(file.filename) && file.patch)
      found.push(...newHostnameSuggestions(file.filename, file.patch, configured));
  // One line per agent: a manifest declaration comes before a hostname in the same pull request.
  const suggestions = found
    .sort((a, b) => Number(a.evidence.startsWith('calls')) - Number(b.evidence.startsWith('calls')))
    .filter(
      (entry, index, all) =>
        !options.alreadySuggested?.includes(entry.agent.id) &&
        all.findIndex((other) => other.agent.id === entry.agent.id) === index,
    );
  if (!suggestions.length) return { status: 'no-new-agents' as const, agents: [] as string[] };
  await options.request('POST', `/repos/${options.repository}/issues/${options.number}/comments`, {
    body: suggestionComment(suggestions),
  });
  return { status: 'commented' as const, agents: suggestions.map((entry) => entry.agent.id) };
}

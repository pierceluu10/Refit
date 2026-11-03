// loadToolPack(provider): the provider's own tool pack, when providers/<id>/tools.ts exists, plus
// the generic tools and playbooks every provider gets. A provider with no folder gets the generic
// pack, so it is never left without tools. Matching a name to a folder is only a head start.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AgentTool,
  ApiUsage,
  MigrationKind,
  ProviderHints,
  ToolPack,
} from '../../shared/types.ts';
import { createChangelogTool, type KnownSource } from './changelog.ts';
import { isPublicUrl, type NetworkOptions } from './fetch.ts';
import { createGraphqlTools } from './graphql-tools.ts';
import { createOpenApiTools } from './openapi.ts';
import { createPackageLookupTool } from './packages.ts';
import { PageStore } from './pages.ts';
import { loadPlaybooks } from './playbooks.ts';
import { createSearchDocsTool, type SearchDocsOptions } from './searchDocs.ts';

export const PROVIDERS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERIC_PLAYBOOKS_DIR = fileURLToPath(new URL('./playbooks/', import.meta.url));

const NOT_PROVIDERS = new Set(['core', 'toolkit', 'node_modules']);
const ID = /^[a-z0-9][a-z0-9-]*$/;

export type LoadToolPackOptions = NetworkOptions & {
  /** What the inventory found for this provider: packages, API hosts and docs URLs. */
  hints?: ProviderHints;
  /** The providers folder. Tests point it elsewhere. */
  root?: string;
};

export type ProviderFolder = {
  id: string;
  name?: string;
  hasTools: boolean;
  sources: KnownSource[];
  docsUrls: string[];
  packages: string[];
  savedDir?: string;
  playbooksDir?: string;
  /** A spec file provider.json lists (kind "openapi"), used when the agent names none. */
  specUrl?: string;
  /** A schema file provider.json lists (kind "graphql-schema"), used when the agent names none. */
  schemaUrl?: string;
};

export function providerSlug(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function listProviderFolders(root = PROVIDERS_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID.test(entry.name) && !NOT_PROVIDERS.has(entry.name))
    .filter(
      (entry) =>
        existsSync(join(root, entry.name, 'provider.json')) ||
        existsSync(join(root, entry.name, 'tools.ts')),
    )
    .map((entry) => entry.name)
    .sort();
}

/** The provider folder a name refers to: its id, its provider.json name, or "<id>-<product>". */
export function resolveProviderFolder(provider: string, root = PROVIDERS_ROOT): string | undefined {
  const slug = providerSlug(provider);
  if (!slug) return undefined;
  const folders = listProviderFolders(root);
  if (folders.includes(slug)) return slug;
  for (const id of folders) {
    const name = readJson<{ name?: string }>(join(root, id, 'provider.json'))?.name;
    if (name && providerSlug(name) === slug) return id;
  }
  return folders.filter((id) => slug.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
}

type ProviderJson = {
  name?: string;
  sources?: { id: string; kind: string; url: string; note?: string }[];
};
type KnowledgeJson = {
  docs?: { label: string; url: string }[];
  sdks?: { ecosystem: string; package: string }[];
};

export function readProviderFolder(id: string, root = PROVIDERS_ROOT): ProviderFolder {
  const dir = join(root, id);
  const spec = readJson<ProviderJson>(join(dir, 'provider.json'));
  const knowledge = readJson<KnowledgeJson>(join(dir, 'knowledge.json'));
  const sources: KnownSource[] = (spec?.sources ?? []).map((source) => ({
    label: `${source.kind} (${source.id})`,
    url: source.url,
    note: source.note,
  }));
  const docs = knowledge?.docs ?? [];
  for (const doc of docs) {
    if (
      /change|release|deprecat|version|upgrade|migrat|sunset|retire/i.test(
        `${doc.label} ${doc.url}`,
      )
    ) {
      sources.push({ label: doc.label, url: doc.url });
    }
  }
  const saved = join(dir, 'fixtures', 'live');
  const playbooks = join(dir, 'playbooks');
  // Only a link to the spec file itself is a usable default; a changelog of the spec is not.
  const specFile = (kind: string, file: RegExp) =>
    (spec?.sources ?? []).find(
      (source) =>
        source.kind === kind && isPublicUrl(source.url) && file.test(new URL(source.url).pathname),
    )?.url;
  return {
    id,
    name: spec?.name,
    hasTools: existsSync(join(dir, 'tools.ts')),
    sources,
    docsUrls: docs.map((doc) => doc.url),
    packages: (knowledge?.sdks ?? [])
      .filter((sdk) => /^(npm|pypi)$/i.test(sdk.ecosystem))
      .map((sdk) => `${sdk.package} (${sdk.ecosystem.toLowerCase()})`),
    savedDir: existsSync(join(saved, 'manifest.json')) ? saved : undefined,
    playbooksDir: existsSync(playbooks) ? playbooks : undefined,
    specUrl: specFile('openapi', /\.(json|ya?ml)$/i),
    schemaUrl: specFile('graphql-schema', /\.(graphqls?|gql|json)$/i),
  };
}

export type GenericToolOptions = NetworkOptions & {
  store?: PageStore;
  sources?: KnownSource[];
  docsUrls?: string[];
  packages?: string[];
  savedDir?: string;
  specUrl?: string;
  schemaUrl?: string;
  /** Leave out search_docs, for a pack that has its own docs search. */
  withoutSearch?: boolean;
};

/** The tools any provider gets: docs search, changelogs, package registries, OpenAPI and GraphQL. */
export function createGenericTools(
  provider: string,
  options: GenericToolOptions = {},
): AgentTool[] {
  const {
    store = new PageStore(),
    sources,
    docsUrls,
    packages,
    savedDir,
    specUrl,
    schemaUrl,
    withoutSearch,
    ...network
  } = options;
  const tools: AgentTool[] = [];
  if (!withoutSearch) {
    tools.push(
      createSearchDocsTool(provider, {
        ...network,
        name: 'search_docs',
        store,
        docsUrls,
        savedDir,
      }),
    );
  }
  tools.push(
    createChangelogTool({ ...network, provider, store, sources }),
    createPackageLookupTool({ ...network, store, packages }),
    ...createOpenApiTools({ ...network, specUrl }),
    ...createGraphqlTools({ ...network, schemaUrl }),
  );
  return tools;
}

/** The generic playbooks, one per MigrationKind: advice for any provider. */
export function genericPlaybooks(): Partial<Record<MigrationKind, string>> {
  return loadPlaybooks(GENERIC_PLAYBOOKS_DIR);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Every hint the inventory left on a task's usages, merged: what loadToolPack's `hints` takes. */
export function hintsFor(usages: ApiUsage[]): ProviderHints {
  const all = (pick: (hints: ProviderHints) => string[] | undefined) =>
    unique(usages.flatMap((usage) => (usage.hints ? (pick(usage.hints) ?? []) : [])));
  const sdks = usages.flatMap((usage) => (usage.sdk ? [usage.sdk.name] : []));
  return {
    packages: unique([...all((h) => h.packages), ...sdks]),
    hosts: all((h) => h.hosts),
    docsUrls: all((h) => h.docsUrls),
  };
}

type PackModule = {
  createToolPack?: (options?: Record<string, unknown>) => ToolPack;
  toolPack?: ToolPack;
};

export async function loadToolPack(
  provider: string,
  options: LoadToolPackOptions = {},
): Promise<ToolPack> {
  const { hints, root = PROVIDERS_ROOT, ...rest } = options;
  const network: NetworkOptions = {};
  if (rest.fetch !== undefined) network.fetch = rest.fetch;
  if (rest.timeoutMs !== undefined) network.timeoutMs = rest.timeoutMs;
  const id = resolveProviderFolder(provider, root);
  const folder = id ? readProviderFolder(id, root) : undefined;
  const store = new PageStore();
  const docsUrls = unique([...(hints?.docsUrls ?? []), ...(folder?.docsUrls ?? [])]).filter(
    isPublicUrl,
  );
  const hintSources: KnownSource[] = (hints?.docsUrls ?? [])
    .filter(isPublicUrl)
    .map((url) => ({ label: 'docs page from the inventory', url }));
  const packages = unique([...(hints?.packages ?? []), ...(folder?.packages ?? [])]);

  let own: ToolPack | undefined;
  if (id && folder?.hasTools) {
    const searchDocs: SearchDocsOptions = { store, docsUrls, savedDir: folder.savedDir };
    try {
      const mod = (await import(pathToFileURL(join(root, id, 'tools.ts')).href)) as PackModule;
      own = mod.createToolPack ? mod.createToolPack({ ...network, searchDocs }) : mod.toolPack;
    } catch (error) {
      // A pack that fails to load still leaves the provider with the generic tools.
      console.error(
        `toolkit: the ${id} tool pack did not load (${error instanceof Error ? error.message : String(error)}); using the generic tools`,
      );
    }
  }
  const slug = id ?? (providerSlug(provider) || 'unknown');
  const ownNames = new Set((own?.tools ?? []).map((tool) => tool.name));
  const generic = createGenericTools(slug, {
    ...network,
    store,
    sources: [...(folder?.sources ?? []), ...hintSources],
    docsUrls,
    packages,
    savedDir: folder?.savedDir,
    specUrl: folder?.specUrl,
    schemaUrl: folder?.schemaUrl,
    withoutSearch: (own?.tools ?? []).some((tool) => tool.name.endsWith('_search_docs')),
  });
  const folderPlaybooks = !own && folder?.playbooksDir ? loadPlaybooks(folder.playbooksDir) : {};
  return {
    provider: own?.provider ?? slug,
    tools: [...(own?.tools ?? []), ...generic.filter((tool) => !ownNames.has(tool.name))],
    // The provider's own playbook wins for its kind; the generic one fills every other kind.
    playbooks: { ...genericPlaybooks(), ...folderPlaybooks, ...(own?.playbooks ?? {}) },
  };
}

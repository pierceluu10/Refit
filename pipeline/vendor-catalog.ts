import { readFileSync } from 'node:fs';
import { normalizeDocumentationSource, type DocumentationSource } from './documentation-sources.ts';
import { ECOSYSTEMS, type Ecosystem } from './package-manifests.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Vendor knowledge kept as data, each fact with the page it was read from and the day it was
// checked: the environment variables a vendor's SDK or docs name, its published OpenAPI document,
// its changelog pages, and whole catalog entries for vendors without a reviewed agent.
// `node scripts/vendor-catalog-check.mjs` re-reads every source.
export const VENDOR_CATALOG_PATH = new URL('../data/vendor-catalog.json', import.meta.url);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VENDOR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A vendor-specific variable name: a generic one such as API_KEY or NEXT_PUBLIC_API_URL would
// match every repository, so at least one part must be outside GENERIC_ENV_PARTS.
const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const GENERIC_ENV_PARTS = new Set(
  (
    'API KEY KEYS SECRET SECRETS TOKEN ACCESS AUTH URL URI ID CLIENT PUBLIC PRIVATE NEXT VITE REACT ' +
    'EXPO APP BASE ENDPOINT HOST PORT PASSWORD USER USERNAME WEBHOOK ACCOUNT PROJECT ORG REGION ENV ' +
    'SERVER SERVICE DATABASE DB BUCKET'
  ).split(' '),
);
const vendorSpecific = (name: string) =>
  ENV_NAME.test(name) && name.split('_').some((part) => part && !GENERIC_ENV_PARTS.has(part));
const HOSTNAME = /^\.?[a-z0-9.-]+\.[a-z]{2,}(?:\/[A-Za-z0-9/_.-]*)?$/;

// Names read on one page: each must appear in the text of `source`.
export interface SourcedNames {
  names: string[];
  source: string;
  checkedAt: string;
}

export interface VendorSources {
  // Packages in other ecosystems' registries, checked there by scripts/catalog-registry-check.mjs.
  ecosystems?: Partial<Record<Ecosystem, string[]>>;
  envVars?: SourcedNames[];
  specification?: { url: string; checkedAt: string };
  documentation?: (DocumentationSource & { checkedAt: string })[];
}

// A catalog entry for a vendor Refit has no reviewed agent for (adapter null). Its npm packages are
// checked on the registry on `checkedAt`.
export interface VendorEntry extends VendorSources {
  id: string;
  name: string;
  packages: string[];
  hostnames: SourcedNames[];
  checkedAt: string;
}

export interface VendorCatalog {
  // Sources for vendors the agent catalog already lists, by its ID.
  sources: Record<string, VendorSources>;
  vendors: VendorEntry[];
}

function fail(message: string): never {
  throw new PipelineInputError(`Vendor catalog: ${message}`);
}

function httpsUrl(value: unknown, where: string) {
  if (typeof value !== 'string') fail(`${where} needs an https URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${where} is not a URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    fail(`${where} must be a public https URL without credentials, query or fragment.`);
  return url.href;
}

function checkedAt(value: unknown, where: string) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) fail(`${where} needs checkedAt.`);
  return value;
}

function strings(value: unknown, where: string, valid?: (name: string) => boolean) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    fail(`${where} must be a list of names.`);
  if (valid) for (const item of value) if (!valid(item)) fail(`${where}: ${item}.`);
  return value as string[];
}

function sourcedNames(
  value: unknown,
  where: string,
  valid: (name: string) => boolean,
): SourcedNames[] {
  if (!Array.isArray(value) || !value.length) fail(`${where} must be a non-empty list.`);
  return value.map((group, index) => {
    if (!isObject(group)) fail(`${where}[${index}] must be an object.`);
    return {
      names: strings(group.names, `${where}[${index}].names`, valid),
      source: httpsUrl(group.source, `${where}[${index}].source`),
      checkedAt: checkedAt(group.checkedAt, `${where}[${index}]`),
    };
  });
}

function parseSources(value: Record<string, unknown>, where: string): VendorSources {
  const sources: VendorSources = {};
  if (value.ecosystems !== undefined) {
    if (!isObject(value.ecosystems)) fail(`${where}.ecosystems must be an object.`);
    const ecosystems: Partial<Record<Ecosystem, string[]>> = {};
    for (const [ecosystem, names] of Object.entries(value.ecosystems)) {
      if (!ECOSYSTEMS.includes(ecosystem as Ecosystem))
        fail(`${where}.ecosystems: unknown ecosystem ${ecosystem}.`);
      ecosystems[ecosystem as Ecosystem] = strings(names, `${where}.ecosystems.${ecosystem}`);
    }
    sources.ecosystems = ecosystems;
  }
  if (value.envVars !== undefined)
    sources.envVars = sourcedNames(value.envVars, `${where}.envVars`, vendorSpecific);
  if (value.specification !== undefined) {
    const specification = value.specification;
    if (!isObject(specification)) fail(`${where}.specification must be an object.`);
    sources.specification = {
      url: httpsUrl(specification.url, `${where}.specification.url`),
      checkedAt: checkedAt(specification.checkedAt, `${where}.specification`),
    };
  }
  if (value.documentation !== undefined) {
    if (!Array.isArray(value.documentation)) fail(`${where}.documentation must be a list.`);
    sources.documentation = value.documentation.map((page, index) => {
      if (!isObject(page)) fail(`${where}.documentation[${index}] must be an object.`);
      return {
        ...normalizeDocumentationSource({ label: page.label, url: page.url }),
        checkedAt: checkedAt(page.checkedAt, `${where}.documentation[${index}]`),
      };
    });
  }
  return sources;
}

// Rejects the whole file on any error, as the deadline registry does.
export function parseVendorCatalog(value: unknown, knownIds: readonly string[]): VendorCatalog {
  if (!isObject(value) || value.formatVersion !== 1 || !isObject(value.vendors))
    fail('expected formatVersion 1 and a vendors object.');
  const catalog: VendorCatalog = { sources: {}, vendors: [] };
  for (const [id, entry] of Object.entries(value.vendors)) {
    if (!VENDOR_ID.test(id) || !isObject(entry)) fail(`invalid vendor ${id}.`);
    const sources = parseSources(entry, id);
    if (knownIds.includes(id)) {
      if (entry.name !== undefined) fail(`${id} is already in the agent catalog.`);
      catalog.sources[id] = sources;
      continue;
    }
    if (typeof entry.name !== 'string' || !entry.name) fail(`${id} needs a name.`);
    catalog.vendors.push({
      id,
      name: entry.name,
      packages: strings(entry.packages, `${id}.packages`),
      hostnames: sourcedNames(entry.hostnames, `${id}.hostnames`, (name) => HOSTNAME.test(name)),
      checkedAt: checkedAt(entry.checkedAt, id),
      ...sources,
    });
  }
  return catalog;
}

export function readVendorCatalog(knownIds: readonly string[]) {
  return parseVendorCatalog(JSON.parse(readFileSync(VENDOR_CATALOG_PATH, 'utf8')), knownIds);
}

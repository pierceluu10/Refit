import { readFile } from 'node:fs/promises';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// A reviewed list of what each Meta Graph API version removes or changes, taken from Meta's
// changelogs. Meta publishes prose changelogs, not a machine-readable contract, so every entry names
// the page it came from, the day someone read it and the passage that states it; `refit rules
// check` finds each quote in the saved page (docs/benchmarks/meta-graph-changelog/pages).

export const DEFAULT_META_GRAPH_CHANGES = new URL(
  '../data/meta-graph/changes.json',
  import.meta.url,
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^v\d+\.\d+$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,119}$/;
// Changes may only cite Meta's developer documentation.
const SOURCE = /^https:\/\/developers\.facebook\.com\/[^\s]*$/;
const TOP_KEYS = ['formatVersion', 'provider', 'versions', 'changes'];
const VERSION_KEYS = ['version', 'released', 'status', 'source', 'checkedAt', 'note'];
const CHANGE_KEYS = [
  'id',
  'version',
  'kind',
  'node',
  'edge',
  'path',
  'name',
  'replacement',
  'appliesToAll',
  'summary',
  'quote',
  'source',
  'checkedAt',
];
export const CHANGE_KINDS = [
  'endpoint-removed',
  'endpoint-changed',
  'product-removed',
  'edge-removed',
  'edge-changed',
  'field-removed',
  'field-changed',
  'metric-removed',
  'metric-changed',
  'parameter-removed',
  'parameter-changed',
  'parameter-required',
  'breakdown-removed',
  'webhook-field-removed',
  'webhook-field-changed',
  'error-changed',
  'permission-changed',
] as const;
const STATUSES = ['reviewed', 'unread'] as const;

// One Graph API version's changelog page and whether it has been read. `reviewed` means every
// removal and change on the page that names an edge, field, metric, parameter or endpoint is in
// `changes`. `unread` means nobody could read the page; a version move across it must stop.
export interface MetaGraphVersion {
  version: string;
  // The day Meta released the version, as its changelog page prints it ("Released October 8,
  // 2025"): when its changes start, the date an alert-only change gives when it has no other.
  released: string;
  status: (typeof STATUSES)[number];
  source: string;
  checkedAt: string;
  note: string | null;
}

// One removal or change a version introduces. It applies to requests pinned to that version and
// later ones, and to every version from `appliesToAll` when Meta gives that date; an out-of-cycle
// or platform change with no version applies to every version from that date, so no version move
// crosses it. `node` is the node type as the changelog names it (`Page`, `IG Media`); `edge` is the
// edge name in `/{id}/<edge>`; `path` is a root endpoint such as `/instagram_oembed`; `name` is the
// field, metric, breakdown, parameter, webhook field, error code or permission. `replacement` is
// what the changelog says to use instead, or null when it names nothing.
export interface MetaGraphChange {
  id: string;
  version: string | null;
  kind: (typeof CHANGE_KINDS)[number];
  node: string | null;
  edge: string | null;
  path: string | null;
  name: string | null;
  replacement: string | null;
  appliesToAll: string | null;
  summary: string;
  quote: string;
  source: string;
  checkedAt: string;
}

export interface MetaGraphChanges {
  formatVersion: 1;
  provider: 'meta-graph';
  versions: MetaGraphVersion[];
  changes: MetaGraphChange[];
}

export interface MetaGraphChangesCheck {
  errors: string[];
  // Versions whose changelog was not read; moves across them stop for review.
  unread: string[];
  // Versions the deadline registry lists that have no record here.
  missing: string[];
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

// `v9.0` < `v13.0` < `v13.1`.
export function compareVersions(a: string, b: string) {
  const [majorA, minorA] = a.slice(1).split('.').map(Number);
  const [majorB, minorB] = b.slice(1).split('.').map(Number);
  return majorA - majorB || minorA - minorB;
}

function optionalText(value: unknown) {
  return value === null || (typeof value === 'string' && value.trim() !== '');
}

// Shape errors make the list unusable. `registryVersions` are the Meta versions in the deadline
// registry; one with no record here is reported, since a move to or across it cannot be checked.
export function checkMetaGraphChanges(
  value: unknown,
  now: Date,
  registryVersions: string[] = [],
): MetaGraphChangesCheck {
  const errors: string[] = [];
  const unread: string[] = [];
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    value.provider !== 'meta-graph' ||
    !Array.isArray(value.versions) ||
    !Array.isArray(value.changes)
  )
    return {
      errors: [
        'The change list requires formatVersion: 1, provider: "meta-graph", and versions and changes arrays.',
      ],
      unread,
      missing: [],
    };
  const unknownTop = Object.keys(value).filter((key) => !TOP_KEYS.includes(key));
  if (unknownTop.length) errors.push(`unknown top-level fields ${unknownTop.join(', ')}.`);
  const today = now.toISOString().slice(0, 10);
  const checkDate = (label: string, date: unknown) => {
    if (!validDate(date)) errors.push(`${label}: checkedAt must be a real YYYY-MM-DD date.`);
    else if (date > today) errors.push(`${label}: checkedAt ${date} is in the future.`);
  };
  const statuses = new Map<string, string>();
  for (const [index, entry] of value.versions.entries()) {
    const label =
      isObject(entry) && typeof entry.version === 'string' ? entry.version : `version ${index}`;
    if (!isObject(entry)) {
      errors.push(`${label}: must be an object.`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !VERSION_KEYS.includes(key));
    if (unknown.length) errors.push(`${label}: unknown fields ${unknown.join(', ')}.`);
    if (typeof entry.version !== 'string' || !VERSION.test(entry.version))
      errors.push(`${label}: version must look like v19.0.`);
    else if (statuses.has(entry.version)) errors.push(`${label}: listed twice.`);
    if (!STATUSES.includes(entry.status as never))
      errors.push(`${label}: status must be reviewed or unread.`);
    if (typeof entry.source !== 'string' || !SOURCE.test(entry.source))
      errors.push(`${label}: source must be a developers.facebook.com https URL.`);
    checkDate(label, entry.checkedAt);
    if (!validDate(entry.released))
      errors.push(`${label}: released must be a real YYYY-MM-DD date.`);
    if (!optionalText(entry.note)) errors.push(`${label}: note must be text or null.`);
    if (entry.status === 'unread' && !entry.note)
      errors.push(`${label}: an unread version needs a note saying why.`);
    if (typeof entry.version === 'string') {
      statuses.set(entry.version, String(entry.status));
      if (entry.status === 'unread') unread.push(entry.version);
    }
  }
  const ids = new Set<string>();
  for (const [index, entry] of value.changes.entries()) {
    const label = isObject(entry) && typeof entry.id === 'string' ? entry.id : `change ${index}`;
    if (!isObject(entry)) {
      errors.push(`${label}: must be an object.`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !CHANGE_KEYS.includes(key));
    if (unknown.length) errors.push(`${label}: unknown fields ${unknown.join(', ')}.`);
    const missingKeys = CHANGE_KEYS.filter((key) => !(key in entry));
    if (missingKeys.length) errors.push(`${label}: missing fields ${missingKeys.join(', ')}.`);
    if (typeof entry.id !== 'string' || !ENTRY_ID.test(entry.id))
      errors.push(`${label}: id must be lowercase letters, digits and hyphens.`);
    else if (ids.has(entry.id)) errors.push(`${label}: duplicate id.`);
    else ids.add(entry.id);
    if (entry.version === null) {
      if (!validDate(entry.appliesToAll))
        errors.push(`${label}: a change with no version needs the appliesToAll date.`);
    } else if (typeof entry.version !== 'string' || !VERSION.test(entry.version))
      errors.push(`${label}: version must look like v19.0 or be null.`);
    else if (!statuses.has(entry.version))
      errors.push(`${label}: ${entry.version} has no record in versions.`);
    // A change can only come from a page someone read.
    else if (statuses.get(entry.version) !== 'reviewed')
      errors.push(`${label}: ${entry.version} is not reviewed, so it cannot list changes.`);
    if (!CHANGE_KINDS.includes(entry.kind as never))
      errors.push(`${label}: kind must be one of ${CHANGE_KINDS.join(', ')}.`);
    if (entry.appliesToAll !== null && !validDate(entry.appliesToAll))
      errors.push(`${label}: appliesToAll must be a real YYYY-MM-DD date or null.`);
    for (const key of ['node', 'edge', 'path', 'name', 'replacement'])
      if (key in entry && !optionalText(entry[key]))
        errors.push(`${label}: ${key} must be text or null.`);
    if (typeof entry.path === 'string' && !/^\/[\w/{}.-]+$/.test(entry.path))
      errors.push(`${label}: path must start with / and hold only path characters.`);
    const kind = String(entry.kind);
    if (/^(field|metric|parameter|breakdown|webhook|error|permission)-/.test(kind) && !entry.name)
      errors.push(`${label}: a ${kind} change needs the ${kind.split('-')[0]} name.`);
    if (kind.startsWith('edge-') && !entry.edge)
      errors.push(`${label}: an edge change needs edge.`);
    if (kind.startsWith('endpoint-') && !entry.path && !entry.edge)
      errors.push(`${label}: an endpoint change needs a path or an edge.`);
    if (kind === 'product-removed' && !entry.name)
      errors.push(`${label}: a product removal needs the product name.`);
    if (typeof entry.summary !== 'string' || !entry.summary.trim())
      errors.push(`${label}: summary is required.`);
    if (typeof entry.quote !== 'string' || !entry.quote.trim())
      errors.push(`${label}: quote is required.`);
    if (typeof entry.source !== 'string' || !SOURCE.test(entry.source))
      errors.push(`${label}: source must be a developers.facebook.com https URL.`);
    checkDate(label, entry.checkedAt);
  }
  const missing = [...new Set(registryVersions)]
    .filter((version) => !statuses.has(version))
    .sort(compareVersions);
  return { errors, unread: unread.sort(compareVersions), missing };
}

// Loads the change list for matching. Any shape error rejects the whole file: a misread removal
// list must never make a version move look safe.
export async function loadMetaGraphChanges(
  path: string | URL = DEFAULT_META_GRAPH_CHANGES,
  now = new Date(),
): Promise<MetaGraphChanges> {
  const value = parseObject(await readFile(path, 'utf8'), 'Meta Graph API change list');
  const { errors } = checkMetaGraphChanges(value, now);
  if (errors.length)
    throw new PipelineInputError(
      `Meta Graph API change list is invalid: ${errors.slice(0, 5).join(' ')}`,
    );
  return value as unknown as MetaGraphChanges;
}

import { readFileSync } from 'node:fs';
import type { AgentTool, ToolPack } from '../../shared/types.ts';
import {
  assembleToolPack,
  bool,
  closest,
  defineTool,
  fetchText,
  htmlToText,
  rank,
  resolveFetch,
  str,
  type NetworkOptions,
  type ToolPackOptions,
} from '../toolkit/index.ts';

// Meta (Facebook / Instagram Graph API, Marketing API, WhatsApp Cloud API) tools.
// Each tool reads a dated snapshot in tools-data/ and, when online, may glance at the live changelog.
// They report what they find; they never decide whether a repo or change matters.

export type MetaChange = {
  version: string;
  date: string;
  api: string;
  node: string;
  field?: string;
  edge?: string;
  endpoint?: string;
  permission?: string;
  metric?: string;
  parameter?: string;
  behaviour?: string;
  product?: string;
  change: string;
  replacement?: string;
  allVersions?: string;
  note: string;
  source: string;
  confidence?: string;
};

export type MetaChanges = {
  source: string[];
  retrieved: string;
  note?: string;
  entries: MetaChange[];
};

export type MetaVersion = {
  version: string;
  released: string;
  expires: string | null;
  note?: string;
  confidence?: string;
  source?: string;
};

export type MetaVersions = {
  source: string[];
  retrieved: string;
  latest: { graph: string; marketing: string };
  policy: {
    graph: string;
    marketing: string;
    policySource: { graph: string; marketing: string };
  };
  graph: MetaVersion[];
  marketing: MetaVersion[];
  sdks: { name: string; pin: string; source: string; confidence?: string }[];
};

export type MetaToolPackOptions = ToolPackOptions & {
  /** Clock override for tests. */
  now?: Date | string;
  changes?: MetaChanges;
  versions?: MetaVersions;
};

const CHANGELOG = 'https://developers.facebook.com/docs/graph-api/changelog';
const MARKETING_CHANGELOG =
  'https://developers.facebook.com/docs/marketing-api/marketing-api-changelog';
const NAME_KEYS = [
  'field',
  'edge',
  'endpoint',
  'permission',
  'metric',
  'parameter',
  'behaviour',
  'product',
] as const;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./tools-data/${file}`, import.meta.url), 'utf8')) as T;
}

let cachedChanges: MetaChanges | undefined;
let cachedVersions: MetaVersions | undefined;
export function loadChanges(): MetaChanges {
  cachedChanges ??= readJson<MetaChanges>('changes.json');
  return cachedChanges;
}
export function loadVersions(): MetaVersions {
  cachedVersions ??= readJson<MetaVersions>('versions.json');
  return cachedVersions;
}

/** "v17.0", "17", "17.0", "v17" -> 17. Returns undefined for anything else. */
export function parseVersion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^v?(\d{1,2})(?:\.(\d))?$/i.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) + Number(match[2] ?? 0) / 10;
}

function fmtVersion(n: number): string {
  return `v${n.toFixed(1)}`;
}

function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value);
  return new Date();
}

function daysBetween(from: Date, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - from.getTime()) / 86_400_000);
}

export function changeName(entry: MetaChange): { key: string; name: string } {
  for (const key of NAME_KEYS) {
    const value = entry[key];
    if (value) return { key, name: value };
  }
  return { key: 'item', name: entry.node };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/graph\.(facebook|instagram)\.com/, '')
    .replace(/^\/?v\d+\.\d\//, '/')
    .replace(/\{[^}]*\}/g, '')
    .replace(/act_\d+/g, '')
    .replace(/^[/\s]+|[/\s]+$/g, '')
    .trim();
}

/** Find snapshot entries for a node/edge/field/permission/metric name. Exact, then substring, then ranked. */
export function findChanges(
  query: string,
  entries: MetaChange[],
): { matches: MetaChange[]; how: 'exact' | 'partial' | 'ranked' | 'none'; suggestions: string[] } {
  const q = normalize(query);
  const parts = q.split(/[.\s]+/).filter(Boolean);
  const leaf = normalize(query.split(/[.]/).pop() ?? query);
  const names = entries.map((e) => normalize(changeName(e).name));

  const exact = entries.filter((_, i) => names[i] === q || (leaf.length > 2 && names[i] === leaf));
  if (exact.length) return { matches: exact, how: 'exact', suggestions: [] };

  const partial = entries.filter((_, i) => {
    const name = names[i];
    if (!name) return false;
    if (leaf.length >= 4 && name.includes(leaf)) return true;
    if (name.length >= 5 && q.includes(name)) return true;
    return false;
  });
  if (partial.length) return { matches: partial.slice(0, 25), how: 'partial', suggestions: [] };

  const ranked = rank(
    parts.join(' '),
    entries,
    (e) => `${e.node} ${changeName(e).name} ${e.replacement ?? ''} ${e.note}`,
  );
  const suggestions = closest(leaf || q, new Set(entries.map((e) => changeName(e).name)), 5);
  if (ranked.length) {
    return { matches: ranked.slice(0, 8).map((r) => r.item), how: 'ranked', suggestions };
  }
  return { matches: [], how: 'none', suggestions };
}

function describeWindow(
  entry: MetaChange,
  from: number | undefined,
  to: number | undefined,
  now: Date,
): string {
  const notes: string[] = [];
  const ev = parseVersion(entry.version);
  if (ev === undefined) {
    notes.push('out-of-cycle change: applies to every version regardless of the pinned one');
  } else if (from !== undefined || to !== undefined) {
    const lower = from ?? 0;
    const upper = to ?? Infinity;
    if (ev > lower && ev <= upper) {
      notes.push(
        `IN WINDOW: introduced in ${entry.version}, which is between ${from !== undefined ? fmtVersion(from) : 'your version'} and ${to !== undefined ? fmtVersion(to) : 'latest'}`,
      );
    } else if (ev <= lower) {
      notes.push(
        `already in effect at ${fmtVersion(lower)} (introduced in ${entry.version}) - code on that version should already see it`,
      );
    } else {
      notes.push(`after the target version (introduced in ${entry.version})`);
    }
  }
  if (entry.allVersions) {
    const days = daysBetween(now, entry.allVersions);
    notes.push(
      days <= 0
        ? `applies to ALL versions since ${entry.allVersions}, so the version pin does not shield older code`
        : `will apply to ALL versions on ${entry.allVersions} (in ${days} days)`,
    );
  }
  return notes.join('; ');
}

function formatChange(
  entry: MetaChange,
  from: number | undefined,
  to: number | undefined,
  now: Date,
): string {
  const { key, name } = changeName(entry);
  const lines = [
    `- ${entry.version} (${entry.date}) [${entry.api}] ${entry.node} ${key} \`${name}\`: ${entry.change}${entry.replacement ? ` -> ${entry.replacement}` : ''}`,
  ];
  if (entry.note) lines.push(`  note: ${entry.note}`);
  const window = describeWindow(entry, from, to, now);
  if (window) lines.push(`  window: ${window}`);
  if (entry.confidence)
    lines.push(`  confidence: ${entry.confidence} - confirm on the source page`);
  lines.push(`  source: ${entry.source}`);
  return lines.join('\n');
}

async function liveChangelogMentions(
  name: string,
  version: number | undefined,
  network: NetworkOptions,
): Promise<string | undefined> {
  if (version === undefined || resolveFetch(network) === null) return undefined;
  const url = `${CHANGELOG}/version${version.toFixed(1)}`;
  const result = await fetchText(url, network);
  if (!result.ok) return `Live check of ${url} failed (${result.error}).`;
  const text = /<\w+[^>]*>/.test(result.text) ? htmlToText(result.text) : result.text;
  const needle = name.toLowerCase();
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return `Live check: "${name}" does not appear on ${url}.`;
  const snippet = text
    .slice(Math.max(0, at - 200), at + 300)
    .replace(/\s+/g, ' ')
    .trim();
  return `Live check: "${name}" appears on ${url}: ...${snippet}...`;
}

function lookupFieldTool(options: MetaToolPackOptions): AgentTool {
  return defineTool({
    name: 'meta_lookup_field',
    description:
      'Look up recorded Meta Graph/Marketing/Instagram API changes to a node, edge, field, permission, metric or endpoint (e.g. "instagram_actor_id", "Page.page_fans", "/{ig-user-id}/insights", "impressions"). Optionally pass the version the code uses and a target version to see which changes fall in that upgrade window, and which out-of-cycle changes hit every version. Snapshot of v19.0-v26.0 changelogs; fuzzy matching.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Node, edge, field, permission, metric, parameter or endpoint name. "Node.field" is fine.',
        },
        from_version: { type: 'string', description: 'Version the code pins today, e.g. v17.0.' },
        to_version: {
          type: 'string',
          description: 'Version you plan to move to (default: latest in snapshot).',
        },
        live: {
          type: 'boolean',
          description: 'Also search the live target-version changelog page (default true).',
        },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = str(input, 'name') ?? str(input, 'query') ?? str(input, 'field');
      if (!name)
        return 'Pass "name": a node, edge, field, permission, metric or endpoint to look up.';
      const data = options.changes ?? loadChanges();
      const versions = options.versions ?? loadVersions();
      const now = toDate(options.now);
      const fromRaw = str(input, 'from_version');
      const toRaw = str(input, 'to_version');
      const from = parseVersion(fromRaw);
      const to = parseVersion(toRaw) ?? parseVersion(versions.latest.graph);
      const header: string[] = [];
      if (fromRaw && from === undefined) {
        header.push(`Could not read from_version "${fromRaw}"; expected something like v17.0.`);
      }
      if (toRaw && parseVersion(toRaw) === undefined) {
        header.push(`Could not read to_version "${toRaw}"; using ${versions.latest.graph}.`);
      }
      const { matches, how, suggestions } = findChanges(name, data.entries);
      const out: string[] = [...header];
      if (matches.length === 0) {
        out.push(
          `"${name}" is not in the Meta change snapshot (${data.retrieved}, v19.0-v26.0 plus out-of-cycle items, not exhaustive). That does not mean it is unchanged.`,
        );
        if (suggestions.length)
          out.push(`Similar names in the snapshot: ${suggestions.join(', ')}.`);
      } else {
        const label =
          how === 'exact'
            ? 'Exact matches'
            : how === 'partial'
              ? 'Partial name matches'
              : 'Closest related entries (no direct name match; judge relevance yourself)';
        const window =
          from !== undefined && to !== undefined
            ? ` (window ${fmtVersion(from)} -> ${fmtVersion(to)})`
            : '';
        out.push(`${label} for "${name}"${window}:`);
        const sorted = [...matches].sort(
          (a, b) => (parseVersion(b.version) ?? 99) - (parseVersion(a.version) ?? 99),
        );
        out.push(...sorted.map((entry) => formatChange(entry, from, to, now)));
        if (how === 'ranked' && suggestions.length) {
          out.push(`Similar names: ${suggestions.join(', ')}.`);
        }
      }
      if (bool(input, 'live') !== false) {
        const live = await liveChangelogMentions(
          normalize(name.split('.').pop() ?? name),
          to,
          options,
        );
        if (live) out.push(live);
      }
      out.push(
        `Snapshot taken ${data.retrieved}. Next: read the per-version pages between your versions (${CHANGELOG}/version<NN>.0), the Marketing API changelog (${MARKETING_CHANGELOG}) and out-of-cycle changes (${CHANGELOG}/out-of-cycle-changes); meta_search_docs can search them. For metrics also check the Page/IG insights metric reference.`,
      );
      return out.join('\n');
    },
  });
}

function versionStatus(
  row: MetaVersion,
  table: MetaVersion[],
  api: 'graph' | 'marketing',
  latest: string,
  now: Date,
): string {
  const parts = [
    `${api === 'graph' ? 'Graph API' : 'Marketing API'} ${row.version}: released ${row.released}`,
  ];
  if (row.version === latest) parts.push('(latest)');
  if (!row.expires) {
    parts.push('- end date not set in snapshot (TBD), so currently supported');
  } else {
    const days = daysBetween(now, row.expires);
    if (days > 0) {
      parts.push(
        `- supported until ${row.expires} (${days} days from ${now.toISOString().slice(0, 10)})`,
      );
      if (days <= 120) parts.push('- expiry is close; plan the upgrade');
    } else {
      const usable = table
        .filter((r) => !r.expires || daysBetween(now, r.expires) > 0)
        .sort((a, b) => (parseVersion(a.version) ?? 0) - (parseVersion(b.version) ?? 0));
      const oldest = usable[0]?.version;
      parts.push(`- EXPIRED on ${row.expires} (${-days} days ago).`);
      parts.push(
        api === 'graph'
          ? `Calls pinned to it are defaulted to the next oldest usable version${oldest ? ` (${oldest} by this snapshot)` : ''}, so they still run but with newer behaviour.`
          : `Calls may fail or be upgraded to the next available version${oldest ? ` (${oldest})` : ''}; only endpoints that did not change auto-upgrade.`,
      );
    }
  }
  if (row.note) parts.push(`Note: ${row.note}`);
  if (row.confidence) parts.push(`[${row.confidence}]`);
  return parts.join(' ');
}

async function liveLatest(network: NetworkOptions): Promise<number | undefined> {
  if (resolveFetch(network) === null) return undefined;
  const result = await fetchText(CHANGELOG, network);
  if (!result.ok) return undefined;
  const found = [...result.text.matchAll(/\bv(\d{2})\.0\b/g)].map((m) => Number(m[1]));
  return found.length ? Math.max(...found) : undefined;
}

const PIN_HINTS = [
  'How to find the pinned version in code:',
  '- URL paths: grep for "graph.facebook.com/v", "graph.instagram.com/v", "graph-video.facebook.com/v", "facebook.com/v..../dialog/oauth". No version in the path means an unversioned call: Graph uses the app default from App Dashboard > Settings > Advanced; Marketing API rejects it.',
  '- Config/env: names like GRAPH_API_VERSION, FB_API_VERSION, META_API_VERSION, WHATSAPP_API_VERSION.',
  '- JS SDK: FB.init({ version: "vXX.X" }).',
  '- Python business SDK (facebook-business): FacebookAdsApi.init(..., api_version="vXX.X"), otherwise facebook_business/apiconfig.py API_VERSION of the installed SDK.',
  '- Node business SDK (facebook-nodejs-business-sdk): no init override; FacebookAdsApi.VERSION comes from the installed package, so the package version IS the API version.',
  '- PHP business SDK: ApiConfig::APIVersion of the installed package. Mobile SDKs: version tracks the SDK release, overridable.',
  '- WhatsApp Cloud API: graph.facebook.com/vXX.X/{phone-number-id}/messages follows Graph versioning.',
];

function apiVersionsTool(options: MetaToolPackOptions): AgentTool {
  return defineTool({
    name: 'meta_api_versions',
    description:
      'Meta Graph API and Marketing API versions with release and expiry dates, days to expiry (computed now), what happens to calls on an expired version, SDK-to-API version mapping and where to find the pinned version in code. Pass a version (e.g. v17.0) for its status.',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Optional version, e.g. v17.0 or 17.' },
        api: {
          type: 'string',
          description: '"graph", "marketing" or omit for both.',
        },
        live: {
          type: 'boolean',
          description: 'Check the live changelog for a newer version (default true).',
        },
      },
    },
    run: async (input) => {
      const data = options.versions ?? loadVersions();
      const now = toDate(options.now);
      const today = now.toISOString().slice(0, 10);
      const apiInput = str(input, 'api')?.toLowerCase();
      const apis: ('graph' | 'marketing')[] =
        apiInput === 'graph'
          ? ['graph']
          : apiInput?.startsWith('market')
            ? ['marketing']
            : ['graph', 'marketing'];
      const raw = str(input, 'version') ?? str(input, 'query');
      const version = parseVersion(raw);
      const out: string[] = [];

      if (raw && version === undefined) {
        out.push(
          `Could not read version "${raw}"; expected something like v21.0. Showing all versions.`,
        );
      }

      for (const api of apis) {
        const table = data[api];
        const latest = data.latest[api];
        if (version !== undefined) {
          const row = table.find((r) => parseVersion(r.version) === version);
          if (row) {
            out.push(versionStatus(row, table, api, latest, now));
          } else if (api === 'graph') {
            out.push(
              version > (parseVersion(latest) ?? 0)
                ? `Graph API ${fmtVersion(version)} is newer than the snapshot's latest (${latest}). It may have shipped after ${data.retrieved}; check ${CHANGELOG}.`
                : `Graph API ${fmtVersion(version)} is not in the snapshot table. Older than ${table.at(-1)?.version}, so it expired long ago; calls are defaulted to the oldest usable version. Check ${CHANGELOG}.`,
            );
          } else {
            out.push(
              `Marketing API ${fmtVersion(version)}: not in the snapshot table (not confirmed). Marketing versions last ~90+ days after their successor; see ${MARKETING_CHANGELOG}.`,
            );
          }
        } else {
          out.push(
            `${api === 'graph' ? 'Graph API' : 'Marketing API'} versions (latest ${latest}, as of ${today}):`,
          );
          for (const row of table) out.push(`  ${versionStatus(row, table, api, latest, now)}`);
        }
        out.push(`Policy: ${data.policy[api]} (${data.policy.policySource[api]})`);
      }

      if (bool(input, 'live') !== false) {
        const live = await liveLatest(options);
        const snap = parseVersion(data.latest.graph) ?? 0;
        if (live !== undefined && live > snap) {
          out.push(
            `Live changelog mentions v${live}.0, newer than the snapshot latest ${data.latest.graph}. Re-check dates at ${CHANGELOG}.`,
          );
        } else if (live !== undefined) {
          out.push(
            `Live changelog check: newest version mentioned is v${live}.0 (snapshot agrees).`,
          );
        }
      }

      out.push(...PIN_HINTS);
      out.push('SDKs:');
      for (const sdk of data.sdks) {
        out.push(
          `- ${sdk.name}: ${sdk.pin}${sdk.confidence ? ` [${sdk.confidence}]` : ''} (${sdk.source})`,
        );
      }
      out.push(
        `Snapshot ${data.retrieved}; days computed against ${today}. Next: meta_lookup_field with from_version/to_version for changes in the window.`,
      );
      return out.join('\n');
    },
  });
}

const PERMISSION_NOTES = [
  'Facebook Login for Business uses a configuration (config_id) instead of a scope list and can issue system-user or user tokens: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business',
  'Instagram API with Instagram Login uses instagram_business_* scopes; Instagram API with Facebook Login uses instagram_basic plus pages_* scopes: https://developers.facebook.com/docs/instagram-platform',
  'Advanced Access to most permissions needs App Review: https://developers.facebook.com/docs/permissions',
];

function permissionInfoTool(options: MetaToolPackOptions): AgentTool {
  return defineTool({
    name: 'meta_permission_info',
    description:
      'Recorded renames, removals and shutdowns of Meta permissions/scopes and whole products (e.g. business_basic -> instagram_business_basic, publish_to_groups, Instagram Basic Display API, WhatsApp On-Premises API). Omit "name" to list them all.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Permission, scope or product name (optional).' },
      },
    },
    run: async (input) => {
      const data = options.changes ?? loadChanges();
      const now = toDate(options.now);
      const pool = data.entries.filter((e) => e.permission || e.product);
      const name =
        str(input, 'name') ??
        str(input, 'query') ??
        str(input, 'permission') ??
        str(input, 'product');
      const out: string[] = [];
      if (!name) {
        out.push(`Permission and product changes in the snapshot (${data.retrieved}):`);
        out.push(...pool.map((e) => formatChange(e, undefined, undefined, now)));
      } else {
        const { matches, how, suggestions } = findChanges(name, pool);
        if (matches.length && how !== 'ranked') {
          out.push(`Permission/product changes matching "${name}":`);
          out.push(...matches.map((e) => formatChange(e, undefined, undefined, now)));
        } else {
          out.push(
            `"${name}" has no recorded permission or product change in the snapshot. It may still be current; check https://developers.facebook.com/docs/permissions and the changelog.`,
          );
          if (matches.length) {
            out.push(
              'Possibly related:',
              ...matches.map((e) => formatChange(e, undefined, undefined, now)),
            );
          }
          if (suggestions.length) out.push(`Similar names: ${suggestions.join(', ')}.`);
          const fields = findChanges(name, data.entries);
          if (fields.how === 'exact' || fields.how === 'partial') {
            out.push('It does match field/metric entries; see meta_lookup_field.');
          }
        }
      }
      out.push(...PERMISSION_NOTES);
      return out.join('\n');
    },
  });
}

export function createToolPack(options: MetaToolPackOptions = {}): ToolPack {
  const tools = [lookupFieldTool(options), apiVersionsTool(options), permissionInfoTool(options)];
  return assembleToolPack({
    provider: 'meta',
    tools,
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options,
  });
}

export const toolPack: ToolPack = createToolPack();

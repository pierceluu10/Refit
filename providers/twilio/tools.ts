// Twilio ToolPack: endpoint/version lookup, helper-library version notes and docs search.
// Tools are helpers the agent may call to check itself. They return information and never block.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, ToolPack } from '../../shared/types.ts';
import {
  assembleToolPack,
  bool,
  closest,
  defineTool,
  fetchText,
  resolveFetch,
  str,
  type NetworkOptions,
  type ToolPackOptions,
} from '../toolkit/index.ts';

// ---------- snapshot types ----------

export type EndpointVersion = {
  version: string;
  pathPrefix: string;
  oaiFile?: string;
  oaiUrl?: string;
  title?: string;
  sdkAccessor?: { node?: string; python?: string };
  operations?: number;
  /** "GET,POST /v2/Services/{Sid}" */
  paths: string[];
};

export type EndpointProduct = {
  id: string;
  name: string;
  hosts: string[];
  versions: EndpointVersion[];
  sdk: { node?: string; python?: string };
  docs: string[];
  status: string;
  note: string;
  sources: string[];
  latestVersion?: string;
  versionStatus?: Record<string, string>;
  eolDate?: string;
  migrationTarget?: string;
  confidence?: string;
};

export type EndpointsSnapshot = {
  provider: string;
  retrieved: string;
  source: string[];
  oaiRelease: string;
  note: string;
  shortcuts: Record<string, string>;
  products: EndpointProduct[];
};

export type SdkMajor = { major: number; date: string; breaking: string[]; confidence?: string };

export type SdkLibrary = {
  id: string;
  aliases: string[];
  package: string;
  repo: string;
  changes: string;
  upgrade: string;
  latest: string;
  latestDate: string;
  currentMajor: number;
  majors: SdkMajor[];
  notes?: string[];
};

export type ClientSdkNote = { id: string; aliases: string[]; note: string; sources: string[] };

export type SdkSnapshot = {
  provider: string;
  retrieved: string;
  source: string[];
  note: string;
  libraries: SdkLibrary[];
  clientSdks?: ClientSdkNote[];
};

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./tools-data/${name}`, import.meta.url), 'utf8')) as T;
}

let endpointsCache: EndpointsSnapshot | undefined;
let sdkCache: SdkSnapshot | undefined;

export function loadEndpoints(): EndpointsSnapshot {
  endpointsCache ??= readJson<EndpointsSnapshot>('endpoints.json');
  return endpointsCache;
}

export function loadSdkVersions(): SdkSnapshot {
  sdkCache ??= readJson<SdkSnapshot>('sdk-versions.json');
  return sdkCache;
}

const OAI_DIR = 'https://github.com/twilio/twilio-oai/tree/main/spec/json';
const CHANGELOG = 'https://www.twilio.com/en-us/changelog';

// ---------- input parsing ----------

export type ParsedTarget = {
  kind: 'url' | 'sdk' | 'unknown';
  host?: string;
  path?: string;
  /** For SDK calls: domain accessor, version and resource tokens. */
  domain?: string;
  version?: string;
  resources?: string[];
  method?: string;
  shortcut?: string;
};

const SDK_METHODS: Record<string, string> = {
  create: 'POST',
  update: 'POST',
  fetch: 'GET',
  list: 'GET',
  each: 'GET',
  stream: 'GET',
  page: 'GET',
  read: 'GET',
  get: 'GET',
  remove: 'DELETE',
  delete: 'DELETE',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseTarget(raw: string): ParsedTarget {
  const input = raw.trim().replace(/^['"`]|['"`]$/g, '');
  const hostMatch =
    /(?:https?:\/\/)?((?:[a-z0-9-]+\.)*(?:twilio|authy)\.com)(\/[^\s?#'"`]*)?/i.exec(input);
  if (hostMatch) {
    return { kind: 'url', host: hostMatch[1].toLowerCase(), path: cleanPath(hostMatch[2] ?? '') };
  }
  if (/^\/?(2010-04-01|2008-08-01)\b/.test(input)) {
    return { kind: 'url', host: 'api.twilio.com', path: cleanPath(`/${input.replace(/^\//, '')}`) };
  }
  if (/^\/v\d+\//.test(input)) return { kind: 'url', path: cleanPath(input) };

  // SDK-style: client.verify.v2.services('VA..').verifications.create  /  $twilio->messages->create
  const code = input
    .replace(/\([^()]*\)/g, '()')
    .replace(/\([^()]*\)/g, '()')
    .replace(/->|::/g, '.')
    .replace(/\$/g, '');
  const tokens = code
    .split('.')
    .map((t) => t.replace(/\(\)/g, '').trim())
    .filter(Boolean);
  const start = tokens.findIndex((t) =>
    /^(client|twilio|twilioclient|@client|this\.client)$/i.test(t),
  );
  const rest = (start >= 0 ? tokens.slice(start + 1) : tokens).filter(
    (t) => !/^(rest|client)$/i.test(t),
  );
  if (rest.length === 0) return { kind: 'unknown' };
  const parsed: ParsedTarget = { kind: 'sdk', resources: [] };
  const last = rest[rest.length - 1];
  if (SDK_METHODS[last.toLowerCase()] && rest.length > 1) {
    parsed.method = SDK_METHODS[last.toLowerCase()];
    rest.pop();
  }
  if (!/^[A-Za-z_]\w*$/.test(rest[0])) return { kind: 'unknown' };
  parsed.domain = rest[0];
  let i = 1;
  if (rest[i] && /^v\d+$/i.test(rest[i])) {
    parsed.version = rest[i].toLowerCase();
    i++;
  }
  parsed.resources = rest.slice(i);
  return parsed;
}

function cleanPath(path: string): string {
  return path.replace(/[)'"`,;]+$/, '').replace(/\/+$/, '');
}

// ---------- matching ----------

function templateRegex(template: string): RegExp {
  const body = template
    .replace(/\.json$/, '')
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}(?:\\.json)?$`, 'i');
}

function splitPathEntry(entry: string): { methods: string[]; path: string } {
  const space = entry.indexOf(' ');
  return { methods: entry.slice(0, space).split(','), path: entry.slice(space + 1) };
}

export function findProductByHost(
  snapshot: EndpointsSnapshot,
  host: string,
  path = '',
): EndpointProduct | undefined {
  const onHost = snapshot.products.filter((p) => p.hosts.some((h) => h.toLowerCase() === host));
  const first = /^\/([^/]+)/.exec(path)?.[1];
  return (
    (first && onHost.find((p) => p.versions.some((v) => v.pathPrefix === `/${first}`))) || onHost[0]
  );
}

function versionFromPath(product: EndpointProduct, path: string): EndpointVersion | undefined {
  const first = /^\/([^/]+)/.exec(path)?.[1] ?? '';
  return (
    product.versions.find((v) => v.pathPrefix && v.pathPrefix === `/${first}`) ??
    product.versions.find((v) => !v.pathPrefix)
  );
}

export function matchPath(
  version: EndpointVersion,
  path: string,
): { methods: string[]; path: string }[] {
  const clean = path.replace(/\?.*$/, '');
  return version.paths.map(splitPathEntry).filter((e) => templateRegex(e.path).test(clean));
}

function productByDomain(snapshot: EndpointsSnapshot, domain: string): EndpointProduct | undefined {
  const d = norm(domain);
  if (!d) return undefined;
  return snapshot.products.find(
    (p) =>
      norm(p.id) === d ||
      norm(p.sdk.node?.replace(/^client\./, '') ?? '') === d ||
      norm(p.sdk.python?.replace(/^client\./, '') ?? '') === d,
  );
}

/** Rank paths of a version by how well SDK resource tokens line up with path segments. */
function rankSdkPaths(version: EndpointVersion, resources: string[], method?: string) {
  const want = resources.map(norm).filter(Boolean);
  const scored = version.paths.map((entry) => {
    const { methods, path } = splitPathEntry(entry);
    const segs = path
      .replace(/\.json$/, '')
      .split('/')
      .filter((s) => s && !s.startsWith('{'))
      .map(norm);
    let score = 0;
    let cursor = 0;
    for (const token of want) {
      const idx = segs.findIndex(
        (s, k) => k >= cursor && (s === token || s === `${token}s` || `${s}s` === token),
      );
      if (idx >= 0) {
        score += 2;
        cursor = idx + 1;
      }
    }
    // Prefer paths with no extra literal segments, and a matching method.
    score -= Math.max(0, segs.length - (version.pathPrefix ? 1 : 0) - want.length) * 0.5;
    if (method && methods.includes(method)) score += 0.5;
    // Instance paths end in a placeholder; prefer them for fetch/update/remove on the last token.
    return { methods, path, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

// ---------- live OAI check ----------

export type LiveOptions = NetworkOptions & { cacheDir?: string; cacheMaxAgeMs?: number };

export async function fetchOaiPaths(
  version: EndpointVersion,
  options: LiveOptions,
): Promise<
  { ok: true; paths: Record<string, string[]>; from: string } | { ok: false; error: string }
> {
  if (!version.oaiUrl || !version.oaiFile)
    return { ok: false, error: 'no OAI file for this version' };
  if (!resolveFetch(options)) return { ok: false, error: 'offline' };
  const dir = options.cacheDir ?? join(tmpdir(), 'aptitude-twilio-oai');
  const file = join(dir, version.oaiFile);
  const maxAge = options.cacheMaxAgeMs ?? 24 * 3600 * 1000;
  let text: string | undefined;
  let from = version.oaiUrl;
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAge) {
      text = readFileSync(file, 'utf8');
      from = `${version.oaiUrl} (cached ${file})`;
    }
  } catch {
    text = undefined;
  }
  if (!text) {
    // Pass only network settings: callers may carry an HTTP method meant for the path check.
    const result = await fetchText(version.oaiUrl, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    if (!result.ok) return { ok: false, error: result.error };
    text = result.text;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    } catch {
      // Cache is best effort.
    }
  }
  const spec = JSON.parse(text) as { paths?: Record<string, Record<string, unknown>> };
  const paths: Record<string, string[]> = {};
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    paths[p] = ['get', 'post', 'put', 'patch', 'delete']
      .filter((m) => m in ops)
      .map((m) => m.toUpperCase());
  }
  return { ok: true, paths, from };
}

// ---------- endpoint lookup ----------

function statusLine(product: EndpointProduct, version?: string): string {
  const vs = version ? product.versionStatus?.[version] : undefined;
  const parts = [
    `Product status: ${product.status}${product.eolDate ? ` (EOL date ${product.eolDate})` : ''}.`,
  ];
  if (vs) parts.push(`Version ${version} status: ${vs}.`);
  if (product.migrationTarget) parts.push(`Migration target: ${product.migrationTarget}.`);
  if (product.confidence) parts.push(`Confidence: ${product.confidence}.`);
  return parts.join(' ');
}

function describeProduct(
  product: EndpointProduct,
  snapshot: EndpointsSnapshot,
  version?: EndpointVersion,
): string[] {
  const lines: string[] = [];
  lines.push(`Product: ${product.name} [${product.id}]`);
  lines.push(`Host(s): ${product.hosts.join(', ') || '(unknown)'}`);
  const versions = product.versions.map((v) => v.version);
  if (versions.length) {
    lines.push(
      `Versions in snapshot: ${versions.join(', ')}${product.latestVersion ? ` (highest: ${product.latestVersion})` : ''}`,
    );
  }
  if (version) {
    const newer =
      product.status !== 'end-of-life' &&
      product.latestVersion &&
      product.latestVersion !== version.version &&
      /^v\d+$/.test(version.version)
        ? ` A higher version (${product.latestVersion}) exists; it is not necessarily a drop-in upgrade, so compare paths before switching.`
        : '';
    lines.push(
      `Version used: ${version.version} (path prefix ${version.pathPrefix || '(none)'}).${newer}`,
    );
  }
  lines.push(statusLine(product, version?.version));
  lines.push(`Note: ${product.note}`);
  const accessor = version?.sdkAccessor ?? product.sdk;
  if (accessor && (accessor.node || accessor.python)) {
    lines.push(
      `SDK accessor: node ${accessor.node ?? '?'} | python ${accessor.python ?? '?'} (other SDKs use the same domain/version naming)`,
    );
  }
  const links = [...new Set([...product.docs, ...product.sources])];
  if (links.length) lines.push(`Docs / sources:\n${links.map((l) => `- ${l}`).join('\n')}`);
  lines.push(
    `Snapshot: twilio-oai ${snapshot.oaiRelease}, statuses checked ${snapshot.retrieved}.`,
  );
  return lines;
}

export async function endpointLookup(
  query: string,
  opts: { method?: string; live?: boolean } & LiveOptions = {},
): Promise<string> {
  const snapshot = loadEndpoints();
  const target = parseTarget(query);
  const out: string[] = [];
  let product: EndpointProduct | undefined;
  let version: EndpointVersion | undefined;
  let candidatePath: string | undefined;
  const method = opts.method?.toUpperCase() ?? target.method;

  if (target.kind === 'url') {
    if (target.host) product = findProductByHost(snapshot, target.host, target.path);
    if (!product && target.path && target.host === undefined) {
      // Bare /vN/... path: guess by matching every product.
      const hits = snapshot.products.flatMap((p) =>
        p.versions.flatMap((v) => (matchPath(v, target.path!).length ? [{ p, v }] : [])),
      );
      if (hits.length === 1) {
        product = hits[0].p;
        version = hits[0].v;
      } else if (hits.length > 1) {
        out.push(
          `The path ${target.path} exists in several products: ${hits.map((h) => `${h.p.id} ${h.v.version} (${h.p.hosts[0]})`).join(', ')}. Pass the full URL with host to narrow it down.`,
        );
      }
    }
    if (!product) {
      out.push(
        `Host ${target.host ?? '(none)'} is not in the Twilio snapshot. It may be a new product, a regional/edge host (e.g. api.dublin.ie1.twilio.com routes to the same API), or a non-REST host (media, SDK, status). Check ${OAI_DIR} for a twilio_<product>_<version>.json file, and ${CHANGELOG}.`,
      );
      const near = target.host
        ? closest(
            target.host.split('.')[0],
            snapshot.products.flatMap((p) => p.hosts.map((h) => h.split('.')[0])),
          )
        : [];
      if (near.length) out.push(`Similar hosts: ${near.map((n) => `${n}.twilio.com`).join(', ')}`);
      return out.join('\n');
    }
    if (!version && target.path !== undefined)
      version = versionFromPath(product, target.path || '/');
    if (target.path && target.path !== '' && target.path !== version?.pathPrefix)
      candidatePath = target.path;
    if (!version && target.path) {
      const first = /^\/([^/]+)/.exec(target.path)?.[1];
      if (first) {
        out.push(
          `Version "${first}" of ${product.name} is not in the snapshot (known: ${product.versions.map((v) => v.version).join(', ') || 'none'}). It may be retired, unreleased, or a typo.`,
        );
      }
    }
  } else if (target.kind === 'sdk' && target.domain) {
    const shortcut = snapshot.shortcuts[target.domain];
    if (shortcut && !target.version) {
      product = snapshot.products.find((p) => p.id === 'api');
      version = product?.versions.find((v) => v.version === 'v2010');
      out.push(
        `"client.${target.domain}" is a shortcut for client.api.v2010.accounts(<AccountSid>).${target.domain} on api.twilio.com/2010-04-01/Accounts/{AccountSid}/${shortcut}.json.`,
      );
      target.resources = ['Accounts', shortcut.split('/').pop()!, ...(target.resources ?? [])];
    } else {
      product = productByDomain(snapshot, target.domain);
      if (product && target.version) {
        version = product.versions.find((v) => v.version === target.version);
        if (!version) {
          out.push(
            `${product.name} has no ${target.version} in the snapshot (known: ${product.versions.map((v) => v.version).join(', ') || 'none'}). Old SDK code may reference a retired version.`,
          );
        }
      } else if (product && product.versions.length === 1) {
        version = product.versions[0];
      } else if (product && !target.version && product.versions.length > 1) {
        out.push(
          `No version in the call; the SDK's default for ${product.id} is usually the latest stable version, but check which one this SDK major maps it to.`,
        );
      }
    }
    if (!product) {
      const names = snapshot.products.map((p) => p.sdk.node?.replace(/^client\./, '') ?? p.id);
      const near = closest(target.domain, [...names, ...Object.keys(snapshot.shortcuts)]);
      return [
        `"${target.domain}" is not a Twilio SDK domain or shortcut in the snapshot.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`,
        `Known domains: ${names.join(', ')}.`,
        `If it is a removed product (fax, autopilot, authy), see twilio_search_docs; otherwise check ${OAI_DIR}.`,
      ].join('\n');
    }
  } else {
    return `Could not read "${query}" as a Twilio URL, path or SDK call. Try a URL like https://verify.twilio.com/v2/Services/{Sid}/Verifications or a call like client.verify.v2.services(sid).verifications.create. Product list: ${OAI_DIR}`;
  }

  out.push(...describeProduct(product, snapshot, version));

  // Path matching
  if (version && version.paths.length) {
    if (candidatePath) {
      const hits = matchPath(version, candidatePath);
      if (hits.length) {
        for (const hit of hits) {
          const ok = method
            ? hit.methods.includes(method)
              ? `${method} is listed`
              : `${method} is NOT listed (has ${hit.methods.join(', ')})`
            : `methods ${hit.methods.join(', ')}`;
          out.push(`Path match: ${hit.path} — ${ok}.`);
        }
      } else {
        const near = closest(
          candidatePath.replace(/\.json$/, ''),
          version.paths.map((e) => splitPathEntry(e).path.replace(/\.json$/, '')),
          3,
        );
        out.push(
          `Path ${candidatePath} did not match any ${version.version} path template in the snapshot.${near.length ? ` Closest: ${near.join(' | ')}` : ''} It may be removed, renamed, misspelled, or newer than the snapshot.`,
        );
      }
    } else if (target.kind === 'sdk' && target.resources && target.resources.length) {
      const ranked = rankSdkPaths(version, target.resources, method).slice(0, 4);
      if (ranked.length) {
        out.push(
          `Likely REST paths for this SDK call (best guess from resource names${method ? `, method ${method}` : ''}):\n${ranked.map((r) => `- ${r.methods.join(',')} ${r.path}`).join('\n')}`,
        );
      } else {
        out.push(
          `No ${version.version} path matched the resource names ${target.resources.join('.')}; they may be renamed or removed.`,
        );
      }
    } else if (version.paths.length <= 12) {
      out.push(`Paths in ${version.version}:\n${version.paths.map((p) => `- ${p}`).join('\n')}`);
    } else {
      out.push(
        `${version.paths.length} path templates in ${version.version}; pass a full path to check one.`,
      );
    }
  }

  // Optional live check against the current OAI file
  const wantLive =
    opts.live !== false && version?.oaiUrl && (candidatePath || target.kind === 'sdk');
  if (wantLive && version) {
    const live = await fetchOaiPaths(version, opts);
    if (live.ok) {
      const livePaths = Object.entries(live.paths);
      if (candidatePath) {
        const hit = livePaths.find(([p]) =>
          templateRegex(p).test(candidatePath!.replace(/\?.*$/, '')),
        );
        out.push(
          hit
            ? `Live OAI check (${live.from}): ${hit[0]} exists with ${hit[1].join(', ')}${method ? (hit[1].includes(method) ? `; ${method} present` : `; ${method} NOT present`) : ''}.`
            : `Live OAI check (${live.from}): path not found in the current spec.`,
        );
      } else {
        out.push(
          `Live OAI check (${live.from}): current spec has ${livePaths.length} paths for ${version.version} (snapshot had ${version.paths.length}).`,
        );
      }
    } else if (live.error !== 'offline') {
      out.push(`Live OAI check skipped (${live.error}); the snapshot above still applies.`);
    }
  }

  out.push(
    'Next: confirm status on the product docs/changelog link above; use twilio_search_docs for migration guides, and twilio_sdk_versions if the call goes through a helper library.',
  );
  return out.join('\n');
}

// ---------- SDK versions ----------

export function parseMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const m = /(\d+)(?:\.\d+)*/.exec(version.replace(/^[\^~>=<v\s]+/, ''));
  return m ? Number(m[1]) : undefined;
}

export function findLibrary(snapshot: SdkSnapshot, name: string): SdkLibrary | undefined {
  const n = norm(name);
  return snapshot.libraries.find(
    (lib) =>
      norm(lib.id) === n ||
      lib.aliases.some((a) => norm(a) === n || norm(a.replace(/^\w+:/, '')) === n),
  );
}

export async function sdkVersions(
  pkg: string | undefined,
  version: string | undefined,
  options: NetworkOptions & { live?: boolean } = {},
): Promise<string> {
  const snapshot = loadSdkVersions();
  if (!pkg) {
    return [
      'Twilio server-side helper libraries (snapshot ' + snapshot.retrieved + '):',
      ...snapshot.libraries.map(
        (l) =>
          `- ${l.id} (${l.package}): latest ${l.latest} (${l.latestDate}), current major ${l.currentMajor}. Upgrade notes: ${l.upgrade}`,
      ),
      snapshot.note,
      'Pass "package" (and optionally "version") for what changed since a given version.',
    ].join('\n');
  }
  const lib = findLibrary(snapshot, pkg);
  if (!lib) {
    const client = snapshot.clientSdks?.find(
      (c) => c.aliases.some((a) => norm(a) === norm(pkg)) || norm(c.id) === norm(pkg),
    );
    if (client) {
      return `${client.id}: ${client.note}\nSources:\n${client.sources.map((s) => `- ${s}`).join('\n')}\n(snapshot ${snapshot.retrieved})`;
    }
    const near = closest(
      pkg,
      snapshot.libraries.flatMap((l) => [l.id, ...l.aliases]),
    );
    return [
      `"${pkg}" is not one of the Twilio helper libraries in the snapshot.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}`,
      `Known: ${snapshot.libraries.map((l) => `${l.id} (${l.package})`).join(', ')}.`,
      'Client-side SDKs (Voice, Video, Conversations, Sync) version separately; see https://www.twilio.com/docs/libraries and https://www.twilio.com/docs/conversations/versioning-and-support-lifecycle.',
    ].join('\n');
  }

  const out: string[] = [];
  out.push(`${lib.id} (${lib.package}) — repo ${lib.repo}`);
  out.push(
    `Latest in snapshot: ${lib.latest} (${lib.latestDate}); current major ${lib.currentMajor}.`,
  );

  if (options.live !== false && resolveFetch(options)) {
    const result = await fetchText(
      `https://api.github.com/repos/twilio/${lib.id}/releases/latest`,
      options,
    );
    if (result.ok) {
      try {
        const release = JSON.parse(result.text) as { tag_name?: string; published_at?: string };
        if (release.tag_name) {
          out.push(
            `Live: latest GitHub release is ${release.tag_name}${release.published_at ? ` (${release.published_at.slice(0, 10)})` : ''}.`,
          );
        }
      } catch {
        // Ignore malformed live data.
      }
    }
  }

  const major = parseMajor(version);
  if (version && major === undefined)
    out.push(`Could not read a major version from "${version}"; showing all majors.`);
  const relevant = lib.majors
    .filter((m) => major === undefined || m.major > major)
    .sort((a, b) => a.major - b.major);
  if (major !== undefined) {
    if (major > lib.currentMajor) {
      out.push(
        `Version ${version} is newer than the snapshot's current major (${lib.currentMajor}); check ${lib.changes}.`,
      );
    } else if (major === lib.currentMajor) {
      out.push(
        `${version} is on the current major. Minor releases since then add API surface (see ${lib.changes}); breaking changes are not expected within a major.`,
      );
    } else {
      out.push(
        `${version} is ${lib.currentMajor - major} major version(s) behind. Breaking changes to review, oldest first:`,
      );
    }
    const own = lib.majors.find((m) => m.major === major);
    if (!own && major < lib.currentMajor && !lib.majors.some((m) => m.major <= major)) {
      out.push(
        `(Major ${major} predates the notes in this snapshot; read the full ${lib.upgrade}.)`,
      );
    }
  }
  for (const m of relevant) {
    out.push(`\n${m.major}.0.0 (${m.date})${m.confidence ? ` [${m.confidence}]` : ''}:`);
    for (const b of m.breaking) out.push(`- ${b}`);
  }
  for (const n of lib.notes ?? []) out.push(`Note: ${n}`);
  out.push(`\nUpgrade guide: ${lib.upgrade}\nChangelog: ${lib.changes}`);
  out.push(`${snapshot.note}`);
  out.push(
    'Next: grep the repo for the renamed classes/methods above, check the runtime version in CI and engines/python_requires, then run the tests. Use twilio_endpoint_lookup for any product/version the code calls.',
  );
  return out.join('\n');
}

// ---------- tools ----------

export type TwilioToolPackOptions = ToolPackOptions & { cacheDir?: string };

export function createTools(options: TwilioToolPackOptions = {}): AgentTool[] {
  const network: LiveOptions = {};
  if (options.fetch !== undefined) network.fetch = options.fetch;
  if (options.timeoutMs !== undefined) network.timeoutMs = options.timeoutMs;
  if (options.cacheDir !== undefined) network.cacheDir = options.cacheDir;

  const endpointTool = defineTool({
    name: 'twilio_endpoint_lookup',
    description:
      'Look up a Twilio endpoint from a URL/path or SDK call (e.g. https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json, chat.twilio.com/v2, client.verify.v2.services(sid).verifications.create, client.messages.create). Returns the product, host, API versions, whether the product/version is current, deprecated or end-of-life (with EOL date and migration target), the SDK accessor, matching path templates and docs links. Optionally checks the live twilio-oai spec.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'URL, path or SDK call as it appears in code.' },
        method: {
          type: 'string',
          description: 'Optional HTTP method to check (GET, POST, DELETE).',
        },
        live: {
          type: 'boolean',
          description: 'Also check the current twilio-oai spec (default true when online).',
        },
      },
      required: ['query'],
    },
    run: async (input) => {
      const query =
        str(input, 'query') ??
        str(input, 'url') ??
        str(input, 'path') ??
        str(input, 'endpoint') ??
        str(input, 'call');
      if (!query)
        return 'Pass "query": a Twilio URL, path or SDK call, e.g. client.messages.create or https://verify.twilio.com/v2/Services.';
      return endpointLookup(query, {
        ...network,
        method: str(input, 'method'),
        live: bool(input, 'live'),
      });
    },
  });

  const sdkTool = defineTool({
    name: 'twilio_sdk_versions',
    description:
      'Twilio helper library versions (twilio-node, twilio-python, twilio-ruby, twilio-php, twilio-java, twilio-csharp, twilio-go): current major, and the breaking changes in each major since the version you pass, with upgrade-guide links. Also notes for client SDKs (Chat, Conversations, Video, Authy).',
    inputSchema: {
      type: 'object',
      properties: {
        package: {
          type: 'string',
          description:
            'Package or library, e.g. twilio (npm), twilio-python, com.twilio.sdk, Twilio (NuGet).',
        },
        version: { type: 'string', description: 'Version in use, e.g. "^3.84.1" or "7.16.0".' },
        live: {
          type: 'boolean',
          description: 'Check the latest GitHub release too (default true when online).',
        },
      },
    },
    run: async (input) =>
      sdkVersions(str(input, 'package') ?? str(input, 'query'), str(input, 'version'), {
        ...network,
        live: bool(input, 'live'),
      }),
  });

  return [endpointTool, sdkTool];
}

export function createToolPack(options?: TwilioToolPackOptions): ToolPack {
  return assembleToolPack({
    provider: 'twilio',
    tools: createTools(options),
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options,
  });
}

export const toolPack: ToolPack = createToolPack();

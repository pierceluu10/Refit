// The version gate: which version the code runs at, in order, an API version set in code and then the
// SDK's own default. A pin never makes something safe alone: it's compared to the removal.
import path from 'node:path';
import { escapeRegex } from '../dead-apis/match.ts';
import type { DeadApiEntry } from '../shared/types.ts';
import { lineIndexAt, spanAt, type FileMode, type Source } from './dead-scan-lex.ts';
import { closeOf, enclosing } from './dead-scan-place.ts';
import { lockedVersions, type Manifest } from './scanners.ts';

type Pin = {
  provider?: string; // who a provider-specific header or setting belongs to
  owner?: string; // the call, key or prefix a generic apiVersion sits under
  file: string;
  line: number;
  version?: string; // undefined: set in code to something this can't read, such as an env var
  fileOnly?: boolean; // a header on one request says nothing about the rest of the package
};
type Locked = { lockfile: string; version: string };

export type VersionFacts = {
  pins: Pin[];
  unpinned: { provider: string; file: string }[]; // a client made with no API version, on the SDK's own
  manifests: Manifest[];
  locked: Map<string, Locked[]>;
  codeOf: Map<string, string>;
};

type Read =
  | { state: 'at-or-after' | 'below'; version: string; reason: string }
  | { state: 'unknown'; reason: string };

export type Gate = { state: 'none' } | Read;

const DATED_VERSION = /^\d{4}-\d{2}(?:-\d{2})?/;
const GENERIC_PINS = [
  /\b()apiVersion\b["']?\s*[:=]\s*([^,\n})]+)/g,
  /\b([A-Za-z_][\w.]*?[._])?api_version\b["']?\s*[:=]\s*([^,\n)]+)/gi,
  /\b()setApiVersion\(\s*([^,\n)]+)/g,
];
// Headers set per request, so they only speak for their own file.
const HEADER_PINS: { pattern: RegExp; provider: string }[] = [
  { pattern: /\bStripe-Version["']?\s*[:,=]\s*["'`]([^"'`\s]+)/gi, provider: 'stripe' },
  { pattern: /\banthropic-version["']?\s*[:,=]\s*["'`]([^"'`\s]+)/gi, provider: 'anthropic' },
  { pattern: /\bX-GitHub-Api-Version["']?\s*[:,=]\s*["'`]([^"'`\s]+)/gi, provider: 'github' },
];
const NAMED_PINS: { pattern: RegExp; provider: string }[] = [
  { pattern: /\bstripe_version\b["']?\s*[:=]\s*["'`]([^"'`\s]+)/gi, provider: 'stripe' },
];
const QUOTED = /["'`]([^"'`\s]+)["'`]/g;
const NO_VERSION = /^\s*(?:undefined|null|None|nil)?\s*$/;
const BARE_DATE = /^\s*(\d{4}-\d{2}(?:-\d{2})?[\w.]*)/;
const IDENTIFIER = /^\s*([A-Za-z_$][\w$]*)\s*$/;
const OWNER_LOOK_BACK_CHARS = 80;
const NAME_BEFORE_BRACKET = /([\w$.]+)\s*(:|\()?\s*$/;
const MAX_OWNER_LEVELS = 3;
// A prefix that says where a setting lives, and not whose it is.
const NEUTRAL_PREFIX = /^(?:self|this|config|settings|options|opts|cfg|params|args|client)[._]$/i;
// The tail takes a prerelease or build tag whole: the 1 in 17.0.0-beta.1 or 17.0.0rc1 isn't a version.
const COMPARATOR =
  /(\^|~>|~=|~|>=|<=|>|<|===?|!=)?\s*v?(\d+(?:\.(?:\d+|[xX*]))*)(?:[-+.]?[A-Za-z0-9][\w.+-]*)?/g;
const RANGE_START = /^\s*(?:[\^~<>=!]|v?\d)/;
const HYPHEN_RANGE = /^\s*v?(\d[\w.]*)\s+-\s+v?(\d[\w.]*)\s*$/;
const WILDCARD = /[xX*]/;
const NPM_LOCKS = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
]);
const PYTHON_LOCKS = new Set(['poetry.lock', 'uv.lock', 'Pipfile.lock']);
const NO_LOWER_BOUND = '0.0.0';
const NAMES_A_VERSION = /version/i;
// Options held elsewhere may set the version: new Stripe(key, options), new Stripe(key, { ...options }).
const OPTIONS_ELSEWHERE = /,\s*[A-Za-z_$][\w$.]*(?:\(.*\))?\s*,?\s*$|\.\.\.|\*\*/s;
// Each of these languages has its own SDK and its own version, which no npm or PyPI spec speaks for.
const OWN_SDK_MODES: ReadonlySet<FileMode> = new Set(['clike', 'php', 'ruby']);
const NPM_MODES: ReadonlySet<FileMode> = new Set(['js', 'html']);
const PYTHON_MODES: ReadonlySet<FileMode> = new Set(['python', 'notebook']);

const lockEcosystem = (lockfile: string) => {
  const name = path.posix.basename(lockfile);
  return NPM_LOCKS.has(name) ? 'npm' : PYTHON_LOCKS.has(name) ? 'python' : 'other';
};

const lockKey = (name: string, ecosystem: string) => `${ecosystem}|${name}`;

/** Negative, zero or positive, comparing numeric parts: 1.2 is 1.2.0, and a prerelease tag is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number(part) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** What a range can install. No `top` means it's open: an install gets whatever is newest. */
export type RangeBounds = { floor: string; top?: string; topExcluded?: boolean };

const bumped = (parts: string[], index: number) =>
  parts
    .slice(0, index + 1)
    .map((part, at) => (at === index ? String(Number(part) + 1) : part))
    .join('.');

function comparatorBounds(operator: string | undefined, raw: string): RangeBounds {
  const wild = raw.split('.').findIndex((part) => WILDCARD.test(part));
  const parts = wild === -1 ? raw.split('.') : raw.split('.').slice(0, wild);
  const floor = raw.replace(/[xX*]/g, '0');
  const upTo = (index: number): RangeBounds => ({
    floor,
    top: bumped(parts, Math.max(0, Math.min(index, parts.length - 1))),
    topExcluded: true,
  });
  switch (operator) {
    case '^': {
      const first = parts.findIndex((part) => Number(part) !== 0);
      return upTo(first === -1 ? parts.length - 1 : first);
    }
    case '~':
      return upTo(1);
    case '~=':
    case '~>':
      return upTo(parts.length - 2);
    case '>=':
    case '>':
      return { floor };
    case '<':
      return { floor: NO_LOWER_BOUND, top: floor, topExcluded: true };
    case '<=':
      return { floor: NO_LOWER_BOUND, top: floor };
    default:
      // 1.x and a bare 1.2 are ranges, and three parts are one version.
      return wild !== -1 || parts.length < 3 ? upTo(parts.length - 1) : { floor, top: floor };
  }
}

function partBounds(part: string): RangeBounds | undefined {
  const hyphen = HYPHEN_RANGE.exec(part);
  if (hyphen) return { floor: hyphen[1], top: hyphen[2] };
  if (!RANGE_START.test(part)) return undefined;
  const comparators = [...part.matchAll(COMPARATOR)].filter((match) => match[1] !== '!=');
  if (comparators.length === 0) return undefined;
  return comparators
    .map((match) => comparatorBounds(match[1], match[2]))
    .reduce((all, one) => {
      const floor = compareVersions(one.floor, all.floor) > 0 ? one.floor : all.floor;
      const tight =
        all.top === undefined || (one.top !== undefined && compareVersions(one.top, all.top) < 0);
      return tight ? { floor, top: one.top, topExcluded: one.topExcluded } : { ...all, floor };
    });
}

/** The versions a range could install, or undefined when a range doesn't say (*, latest, git). */
export function rangeBounds(range: string): RangeBounds | undefined {
  const parts = range.split('||').map(partBounds);
  if (parts.length === 0 || parts.some((part) => part === undefined)) return undefined;
  return (parts as RangeBounds[]).reduce((all, one) => {
    const floor = compareVersions(one.floor, all.floor) < 0 ? one.floor : all.floor;
    if (all.top === undefined || one.top === undefined) return { floor };
    return compareVersions(one.top, all.top) > 0
      ? { floor, top: one.top, topExcluded: one.topExcluded }
      : { ...all, floor };
  });
}

export const lowestVersion = (range: string) => rangeBounds(range)?.floor;

const fits = (bounds: RangeBounds, version: string) => {
  if (compareVersions(version, bounds.floor) < 0) return false;
  if (bounds.top === undefined) return true;
  const above = compareVersions(version, bounds.top);
  return bounds.topExcluded ? above < 0 : above <= 0;
};

// What a value in code says: a dated version, nothing, or something only known when it runs.
function readPinValue(source: Source, value: string): string | null | undefined {
  if (NO_VERSION.test(value)) return null;
  const dated = [...value.matchAll(QUOTED)].map((match) => match[1]);
  const literal = dated.find((one) => DATED_VERSION.test(one));
  if (literal) return literal;
  const bare = BARE_DATE.exec(value)?.[1];
  if (bare) return bare;
  const name = IDENTIFIER.exec(value)?.[1];
  if (name) {
    const assigned = new RegExp(
      `(?<![\\w$.])${escapeRegex(name)}\\s*(?::[^=\\n]*)?=\\s*["'\`]([^"'\`\\s]+)`,
    ).exec(source.text)?.[1];
    if (assigned && DATED_VERSION.test(assigned)) return assigned;
  }
  return undefined;
}

// The call or key a generic apiVersion sits under: new Stripe(k, { apiVersion }) or azure: { apiVersion }.
function ownerOf(source: Source, offset: number): string | undefined {
  let at = offset;
  for (let level = 0; level < MAX_OWNER_LEVELS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    const ahead = source.code.slice(Math.max(0, open.open - OWNER_LOOK_BACK_CHARS), open.open);
    const found = NAME_BEFORE_BRACKET.exec(ahead);
    // A variable holding the options says nothing, so the file has to speak for it.
    if (found && (found[2] || open.char === '(')) return found[1];
    at = open.open;
  }
  return undefined;
}

function pinsIn(source: Source): Pin[] {
  const pins: Pin[] = [];
  const lineOf = (offset: number) => lineIndexAt(source, offset) + 1;
  const inComment = (offset: number) => spanAt(source.spans, offset)?.kind === 'comment';
  for (const pattern of GENERIC_PINS) {
    for (const match of source.text.matchAll(pattern)) {
      if (inComment(match.index)) continue;
      const version = readPinValue(source, match[2]);
      if (version === null) continue;
      const prefix = match[1] && !NEUTRAL_PREFIX.test(match[1]) ? match[1] : undefined;
      const owner = prefix ?? ownerOf(source, match.index);
      // An unreadable value with no owner is usually another tool's, such as Kubernetes' apiVersion.
      if (version === undefined && !owner) continue;
      const line = lineOf(match.index);
      pins.push({ owner, file: source.file, line, version });
    }
  }
  for (const { pattern, provider } of HEADER_PINS) {
    for (const match of source.text.matchAll(pattern)) {
      if (inComment(match.index) || !DATED_VERSION.test(match[1])) continue;
      const line = lineOf(match.index);
      pins.push({ provider, file: source.file, line, version: match[1], fileOnly: true });
    }
  }
  for (const { pattern, provider } of NAMED_PINS) {
    for (const match of source.text.matchAll(pattern)) {
      if (inComment(match.index) || !DATED_VERSION.test(match[1])) continue;
      pins.push({ provider, file: source.file, line: lineOf(match.index), version: match[1] });
    }
  }
  return pins;
}

// new Stripe('k') or StripeClient('k'): a client that runs at its SDK's default, whatever other clients pin.
function hasUnpinnedClient(source: Source, provider: string): boolean {
  const name = escapeRegex(provider);
  const client = new RegExp(
    `(?:\\bnew\\s+(?:[\\w$]+\\.)*${name}(?:client)?|\\b${name}client)\\s*\\(`,
    'gi',
  );
  return [...source.code.matchAll(client)].some((match) => {
    const open = match.index + match[0].length - 1;
    const close = closeOf(source.code, open);
    // The code has its strings blanked, so a key like 'sk_test_...' doesn't read as a spread.
    return (
      !NAMES_A_VERSION.test(source.text.slice(open + 1, close)) &&
      !OPTIONS_ELSEWHERE.test(source.code.slice(open + 1, close))
    );
  });
}

export async function loadVersionFacts(
  repoDir: string,
  sources: Source[],
  manifests: Manifest[],
  entries: DeadApiEntry[],
  ignored: (file: string) => boolean,
): Promise<VersionFacts> {
  const own = sources.filter((source) => !ignored(source.file));
  const pins = own.flatMap(pinsIn);
  const versioned = new Set(
    entries.filter((entry) => entry.appliesTo?.apiVersionSince).map((entry) => entry.provider),
  );
  const unpinned = [...versioned].flatMap((provider) =>
    own
      .filter((source) => hasUnpinnedClient(source, provider))
      .map((source) => ({ provider, file: source.file })),
  );
  const wanted = new Set(
    entries.flatMap((entry) =>
      [...(entry.appliesTo?.sdkSince ?? []), ...(entry.appliesTo?.sdkUntil ?? [])].map(
        (one) => one.package,
      ),
    ),
  );
  const present = new Set(
    manifests.flatMap((manifest) => manifest.dependencies.map((one) => one.name)),
  );
  const locked = new Map<string, Locked[]>();
  for (const name of [...wanted].filter((one) => present.has(one))) {
    for (const found of await lockedVersions(repoDir, name)) {
      if (ignored(found.lockfile)) continue;
      const key = lockKey(name, lockEcosystem(found.lockfile));
      locked.set(key, [...(locked.get(key) ?? []), found]);
    }
  }
  const codeOf = new Map(sources.map((source) => [source.file, source.code]));
  return { pins, unpinned, manifests, locked, codeOf };
}

const isAncestor = (directory: string, file: string) =>
  directory === '.' || file.startsWith(`${directory}/`);

// The deepest of some files' folders above `file`, or nothing when none is above it.
function nearest<T>(items: T[], folderOf: (item: T) => string, file: string): T[] {
  const above = items.filter((item) => isAncestor(folderOf(item), file));
  if (above.length === 0) return [];
  const deepest = Math.max(...above.map((item) => folderOf(item).length));
  return above.filter((item) => folderOf(item).length === deepest);
}

const manifestFolder = (manifest: Manifest) => path.posix.dirname(manifest.file);

type Installed =
  { version: string; via: string; bounds?: RangeBounds } | { conflict: string[]; via: string };

function declaredRange(
  facts: VersionFacts,
  name: string,
  ecosystem: string,
  file: string,
): { range: string; manifest: string } | { conflict: string[] } | undefined {
  const declaring = facts.manifests.filter(
    (manifest) =>
      manifest.ecosystem === ecosystem && manifest.dependencies.some((one) => one.name === name),
  );
  if (declaring.length === 0) return undefined;
  const near = nearest(declaring, manifestFolder, file);
  const rangeOf = (manifest: Manifest) =>
    manifest.dependencies.find((one) => one.name === name)?.version ?? '';
  // Outside every package that declares it, a repo with one answer still has that answer.
  const candidates = near.length > 0 ? near : declaring;
  const ranges = [...new Set(candidates.map(rangeOf))];
  if (ranges.length > 1) return { conflict: ranges };
  return { range: ranges[0], manifest: candidates[0].file };
}

function installedVersion(
  facts: VersionFacts,
  name: string,
  ecosystem: string,
  file: string,
): Installed | undefined {
  const declared = declaredRange(facts, name, ecosystem, file);
  const range = declared && 'range' in declared ? rangeBounds(declared.range) : undefined;
  const locked = nearest(
    facts.locked.get(lockKey(name, ecosystem)) ?? [],
    (one) => path.posix.dirname(one.lockfile),
    file,
  );
  if (locked.length > 0) {
    // A copy outside the app's own range is a dependency's, nested in the lock: it doesn't speak for the app.
    const own = range ? locked.filter((one) => fits(range, one.version)) : [];
    const chosen = own.length > 0 ? own : locked;
    const versions = [...new Set(chosen.map((one) => one.version))];
    const via = `locked in ${chosen[0].lockfile}`;
    return versions.length > 1 ? { conflict: versions, via } : { version: versions[0], via };
  }
  if (!declared) return undefined;
  if ('conflict' in declared) return { conflict: declared.conflict, via: "the repo's manifests" };
  if (!range) return undefined;
  return {
    version: range.floor,
    via: `"${declared.range}" in ${declared.manifest}`,
    bounds: range,
  };
}

/** The version in a Deno or edge function's own import: npm:stripe@18.5.0 or esm.sh/stripe@18.5.0. */
function importedVersion(source: Source, name: string): string | undefined {
  const pattern = new RegExp(`(?:npm:|/)${escapeRegex(name)}@(\\d[\\w.-]*)`);
  return pattern.exec(source.text)?.[1];
}

type PinChoice = { version?: string; conflict?: string[]; unread?: string; where?: string };

function belongsTo(facts: VersionFacts, pin: Pin, provider: string): boolean {
  if (pin.provider) return pin.provider === provider;
  if (pin.owner) return pin.owner.toLowerCase().includes(provider);
  // No call or key says whose it is, so the file's own code has to name the provider as a word.
  const word = new RegExp(`\\b${escapeRegex(provider)}\\b`, 'i');
  return word.test(facts.codeOf.get(pin.file) ?? '');
}

function choosePin(pins: Pin[]): PinChoice {
  if (pins.length === 0) return {};
  const unread = pins.find((pin) => pin.version === undefined);
  if (unread) return { unread: `${unread.file}:${unread.line}` };
  const versions = [...new Set(pins.map((pin) => pin.version as string))];
  if (versions.length > 1) return { conflict: versions };
  return { version: versions[0], where: `${pins[0].file}:${pins[0].line}` };
}

// shortcut: same file, then the package, then the repo, stands in for "the client this read comes from";
// two clients in one package with different pins, or a pinned one beside an unpinned one, read as unclear
// unless the SDK agrees. Upgrade by following imports if P5 sees it.
function pinFor(
  facts: VersionFacts,
  provider: string,
  source: Source,
): PinChoice & { fromRepo?: boolean; mixed?: boolean } {
  const loose = facts.unpinned.filter((one) => one.provider === provider);
  const ownClient = loose.some((one) => one.file === source.file);
  const mine = facts.pins.filter((pin) => belongsTo(facts, pin, provider));
  const same = mine.filter((pin) => pin.file === source.file);
  if (same.length > 0) return { ...choosePin(same), mixed: ownClient };
  // A file with its own unpinned client runs at the SDK's default, so another file's pin isn't its.
  if (ownClient) return {};
  const shared = mine.filter((pin) => !pin.fileOnly);
  const folder = nearest(facts.manifests, manifestFolder, source.file).map(manifestFolder)[0];
  const local = folder ? shared.filter((pin) => isAncestor(folder, pin.file)) : [];
  if (local.length > 0) {
    const mixed = loose.some((one) => isAncestor(folder, one.file));
    return { ...choosePin(local), mixed };
  }
  return { ...choosePin(shared), fromRepo: true };
}

const dateOf = (version: string) => DATED_VERSION.exec(version)?.[0] ?? version;

// The SDK specs that speak for this file. A config or text file could belong to either SDK.
function specsFor(entry: DeadApiEntry, source: Source) {
  const specs = [
    ...(entry.appliesTo?.sdkSince ?? []),
    ...(entry.appliesTo?.sdkUntil ?? []).map((one) => ({ ...one, until: true })),
  ];
  if (OWN_SDK_MODES.has(source.mode)) return [];
  if (NPM_MODES.has(source.mode)) return specs.filter((one) => (one.ecosystem ?? 'npm') === 'npm');
  if (PYTHON_MODES.has(source.mode)) return specs.filter((one) => one.ecosystem === 'python');
  return specs;
}

function sdkGate(entry: DeadApiEntry, source: Source, facts: VersionFacts): Read | undefined {
  const gates = specsFor(entry, source).flatMap((spec): Read[] => {
    const imported = importedVersion(source, spec.package);
    const installed = imported
      ? { version: imported, via: 'its import' }
      : installedVersion(facts, spec.package, spec.ecosystem ?? 'npm', source.file);
    if (!installed) return [];
    if ('conflict' in installed) {
      return [
        {
          state: 'unknown',
          reason: `${spec.package} has more than one version here, in ${installed.via}: ${installed.conflict.join(', ')}`,
        },
      ];
    }
    const until = 'until' in spec;
    const compared = `${spec.package} ${installed.version} (${installed.via}), ${until ? 'moved off it' : 'removal'} at ${spec.version}`;
    const dead: Read = {
      state: 'at-or-after',
      version: installed.version,
      reason: `SDK default: ${compared}`,
    };
    const safe: Read = {
      state: 'below',
      version: installed.version,
      reason: `below the gate, SDK default: ${compared}`,
    };
    if (compareVersions(installed.version, spec.version) >= 0) return [until ? safe : dead];
    const { bounds } = installed;
    const above = bounds?.top === undefined ? 1 : compareVersions(bounds.top, spec.version);
    const reaches = bounds !== undefined && (bounds.topExcluded ? above > 0 : above >= 0);
    if (reaches) {
      return [
        {
          state: 'unknown',
          reason: `the range can install either side of the removal: ${compared}${
            bounds?.top === undefined
              ? `; it has no top, so a fresh install takes the newest, past ${spec.version}`
              : ''
          }`,
        },
      ];
    }
    return [until ? dead : safe];
  });
  return (
    gates.find((gate) => gate.state === 'at-or-after') ??
    gates.find((gate) => gate.state === 'unknown') ??
    gates[0]
  );
}

function pinGate(pin: PinChoice, since: string): Read | undefined {
  // Pins that differ but all predate the removal agree on the only thing that matters here.
  const newest = pin.conflict?.reduce((a, b) => (dateOf(a) > dateOf(b) ? a : b));
  if (newest && dateOf(newest) < dateOf(since)) {
    return {
      state: 'below',
      version: newest,
      reason: `every pin predates the removal: ${(pin.conflict ?? []).join(', ')}, removal at ${since}`,
    };
  }
  if (pin.conflict) {
    return {
      state: 'unknown',
      reason: `the code pins conflicting versions: ${pin.conflict.join(', ')}`,
    };
  }
  if (pin.unread) {
    return {
      state: 'unknown',
      reason: `the API version is set in code to a value only known when it runs (${pin.unread})`,
    };
  }
  if (!pin.version) return undefined;
  const compared = `${pin.version} (${pin.where}), removal at ${since}`;
  return dateOf(pin.version) >= dateOf(since)
    ? {
        state: 'at-or-after',
        version: pin.version,
        reason: `pinned at or after the removal: ${compared}`,
      }
    : {
        state: 'below',
        version: pin.version,
        reason: `pinned before the removal: ${compared}`,
      };
}

export function gateFor(entry: DeadApiEntry, source: Source, facts: VersionFacts): Gate {
  const since = entry.appliesTo?.apiVersionSince;
  const hasSdk = Boolean(entry.appliesTo?.sdkSince?.length || entry.appliesTo?.sdkUntil?.length);
  if (!since && !hasSdk) return { state: 'none' };
  const sdk = hasSdk ? sdkGate(entry, source, facts) : undefined;
  if (since) {
    const pin = pinFor(facts, entry.provider, source);
    // Another package's pin only answers for a package with no SDK of its own.
    if (pin.fromRepo && sdk) return sdk;
    const pinned = pinGate(pin, since);
    if (pinned && (!pin.mixed || sdk?.state === pinned.state)) return pinned;
    if (pinned) {
      return {
        state: 'unknown',
        reason: `a pinned client and an unpinned one sit together, and this read could be either's: ${pinned.reason}; ${sdk?.reason ?? 'no installed SDK version found'}`,
      };
    }
  }
  const unversioned = specsFor(entry, source).find((spec) => {
    if ('until' in spec) return false;
    const declared = declaredRange(facts, spec.package, spec.ecosystem ?? 'npm', source.file);
    return declared !== undefined && 'range' in declared;
  });
  return (
    sdk ?? {
      state: 'unknown',
      reason: unversioned
        ? `no installed SDK version found: ${unversioned.package} is declared with no version, so a fresh install takes the newest, past the removal at ${unversioned.version}, and an environment built earlier may still work`
        : 'no API version set in code and no installed SDK version found',
    }
  );
}

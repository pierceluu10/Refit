import { satisfies } from './shopify-sdk-upgrade.ts';
import { isObject, parseJson } from './specifications.ts';

// An SDK upgrade's package-lock.json, scoped to the SDK: the committed lockfile with only the
// moved packages' own dependency trees replaced by the ones npm's re-resolution locked. npm
// re-resolving a whole tree also re-hoists shared packages the old SDK pulled up, adds other
// platforms' optional binaries the committed lockfile left out and repairs unrelated drift; none
// of that is the upgrade, so every entry outside the moved packages' trees stays as committed.
// The result is kept only when each dependency in the grafted trees resolves, as Node resolves
// it, to a locked release its range accepts.

type Packages = Record<string, Record<string, unknown>>;
export type ScopedLock = { lockfile: string } | { reason: string };

const SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const ROOT_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
// Flags npm derives from how the root reaches an entry; a shared entry the new trees now use
// takes the re-resolved lockfile's.
const FLAGS = ['dev', 'optional', 'devOptional', 'peer'] as const;

// The package name an npm lockfile key installs (`node_modules/a/node_modules/@b/c` is `@b/c`).
const nameOf = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 13);
const parent = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf('/node_modules/')));
const record = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

// The key Node loads `name` from when required by the package at `from`, or undefined.
function locate(packages: Packages, from: string, name: string) {
  for (let base = from; ; base = parent(base)) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
  }
}

function dependencyNames(entry: Record<string, unknown>, root: boolean) {
  return (root ? ROOT_SECTIONS : SECTIONS).flatMap((section) =>
    Object.keys(record(entry[section])),
  );
}

// Keys reached from `starts`, never entering a key `stop` rejects.
function reach(packages: Packages, starts: string[], stop: (key: string) => boolean) {
  const seen = new Set<string>();
  const pending = starts.filter((key) => packages[key] && !stop(key));
  for (const key of pending) seen.add(key);
  while (pending.length) {
    const key = pending.pop()!;
    for (const name of dependencyNames(packages[key], key === '')) {
      const found = locate(packages, key, name);
      if (found && !seen.has(found) && !stop(found)) {
        seen.add(found);
        pending.push(found);
      }
    }
  }
  return seen;
}

// The moved packages' own tree: what the root reaches through them and through nothing else.
function ownTree(packages: Packages, names: Set<string>) {
  const shared = reach(packages, [''], (key) => key !== '' && names.has(nameOf(key)));
  const roots = Object.keys(packages).filter((key) => names.has(nameOf(key)));
  return reach(packages, roots, (key) => shared.has(key));
}

export function scopedNpmLock(options: {
  committed: string;
  resolved: string;
  // The moved packages: the SDK, a package it replaces and any moved with it.
  names: string[];
}): ScopedLock {
  const committed = parseJson(options.committed);
  const resolved = parseJson(options.resolved);
  if (!isObject(committed) || !isObject(committed.packages))
    return { reason: 'package-lock.json has no packages map.' };
  if (!isObject(resolved) || !isObject(resolved.packages))
    return { reason: "npm's re-resolved package-lock.json has no packages map." };
  if (committed.dependencies !== undefined)
    return {
      reason:
        'package-lock.json is lockfile version 2, whose npm 6 dependency tree Refit does not graft.',
    };
  const names = new Set(options.names);
  const old = committed.packages as Packages;
  const now = resolved.packages as Packages;
  if (!isObject(now['']) || !isObject(old['']))
    return { reason: 'package-lock.json has no root record.' };
  const grafted: Packages = {};
  for (const [key, entry] of Object.entries(old))
    if (key === '' || !ownTree(old, names).has(key)) grafted[key] = entry;
  // The root keeps its record; only the moved packages' declarations come from the new one.
  const root = { ...old[''] };
  for (const section of ROOT_SECTIONS) {
    const declared = record(now[''][section]);
    // Committed order, with each moved declaration replaced in place or dropped.
    const merged = Object.fromEntries([
      ...Object.entries(record(root[section])).flatMap(([name, spec]) =>
        !names.has(name) ? [[name, spec]] : name in declared ? [[name, declared[name]]] : [],
      ),
      ...Object.entries(declared).filter(
        ([name]) => names.has(name) && !(name in record(root[section])),
      ),
    ]);
    if (Object.keys(merged).length) root[section] = merged;
    else delete root[section];
  }
  grafted[''] = root;
  // Each placed key, with the key of the re-resolved lockfile it was copied from.
  const placed = new Map<string, string>();
  const pending: [string, string][] = [];
  const place = (target: string, source: string) => {
    grafted[target] = now[source];
    placed.set(target, source);
    pending.push([target, source]);
  };
  // The moved packages where npm put them, below the root or below a package kept as committed.
  for (const key of Object.keys(now))
    if (names.has(nameOf(key)) && (parent(key) === '' || grafted[parent(key)])) {
      if (grafted[key] && !placed.has(key))
        return { reason: `package-lock.json keeps another ${nameOf(key)} at ${key}.` };
      place(key, key);
    }
  while (pending.length) {
    const [target, source] = pending.pop()!;
    const entry = now[source];
    for (const section of SECTIONS)
      for (const [name, range] of Object.entries(record(entry[section]))) {
        const found = locate(grafted, target, name);
        // A release the project already locks where Node looks is kept when the range takes it.
        if (
          found &&
          (placed.get(found) !== undefined ||
            satisfies(String(grafted[found].version), String(range)) === true)
        )
          continue;
        const from = locate(now, source, name);
        if (!from) continue;
        // Peers resolve to the dependent's own copy and are never nested; unmetRanges names them.
        if (section === 'peerDependencies') {
          if (!found && !grafted[`node_modules/${name}`] && !isOptionalPeer(entry, name))
            place(`node_modules/${name}`, from);
          continue;
        }
        const top = `node_modules/${name}`;
        const nested = `${target}/node_modules/${name}`;
        const spot = !found && !grafted[top] ? top : !grafted[nested] ? nested : undefined;
        if (!spot)
          return {
            reason: `npm locks ${name} ${String(now[from].version)} for ${nameOf(target)} where the committed lockfile keeps ${name} ${String(grafted[nested].version)}; the upgrade would change it.`,
          };
        place(spot, from);
        // What npm nested below that package moves with it.
        for (const key of Object.keys(now))
          if (key.startsWith(`${from}/node_modules/`)) {
            const moved = spot + key.slice(from.length);
            if (!grafted[moved]) place(moved, key);
          }
      }
  }
  // Shared entries the new trees use take the flags npm derived for them.
  for (const key of reach(grafted, [...placed.keys()], () => false))
    if (!placed.has(key) && now[key] && now[key].version === grafted[key].version) {
      const entry = { ...grafted[key] };
      for (const flag of FLAGS)
        if (now[key][flag] === undefined) delete entry[flag];
        else entry[flag] = now[key][flag];
      grafted[key] = entry;
    }
  const problem = unmetRanges(grafted, [...placed.keys()], names);
  if (problem) return { reason: problem };
  const indent = /^\{\r?\n([ \t]+)"/.exec(options.committed)?.[1] ?? '  ';
  const eol = options.committed.includes('\r\n') ? '\r\n' : '\n';
  // Keys keep the committed order; added ones follow in npm's sorted order.
  const order = [
    ...Object.keys(old).filter((key) => grafted[key]),
    ...Object.keys(grafted)
      .filter((key) => !(key in old))
      .sort((left, right) => left.localeCompare(right, 'en')),
  ];
  const packages = Object.fromEntries(order.map((key) => [key, grafted[key]]));
  return {
    lockfile:
      JSON.stringify({ ...committed, packages }, null, indent).replace(/\n/g, eol) +
      (options.committed.endsWith('\n') ? eol : ''),
  };
}

const isOptionalPeer = (entry: Record<string, unknown>, name: string) =>
  record(record(entry.peerDependenciesMeta)[name]).optional === true;

// The first dependency of the grafted trees, or of the root's moved declarations, that Node
// would not resolve to a release its range accepts.
function unmetRanges(packages: Packages, keys: string[], names: Set<string>) {
  const checks: [string, string, string, boolean][] = [];
  for (const key of keys) {
    const entry = packages[key];
    for (const section of SECTIONS)
      for (const [name, range] of Object.entries(record(entry[section])))
        checks.push([
          key,
          name,
          String(range),
          section === 'optionalDependencies' ||
            (section === 'peerDependencies' && isOptionalPeer(entry, name)),
        ]);
  }
  for (const section of ROOT_SECTIONS)
    for (const [name, range] of Object.entries(record(packages[''][section])))
      if (names.has(name)) checks.push(['', name, String(range), false]);
  for (const [from, name, range, optional] of checks) {
    const found = locate(packages, from, name);
    const who = from ? `${nameOf(from)} ${String(packages[from].version)}` : 'package.json';
    if (!found) {
      if (optional) continue;
      return `${who} needs ${name} ${range}, which the upgraded package-lock.json does not lock where Node finds it.`;
    }
    const version = String(packages[found].version);
    if (/^(?:npm:|file:|link:|git|https?:)/.test(range)) continue;
    const ok = satisfies(version, range);
    if (ok === undefined)
      return `Refit cannot check ${who}'s range ${range} for ${name}, so it cannot verify the upgraded package-lock.json.`;
    if (!ok)
      return `${who} declares ${name} ${range}${
        optional ? ' (an optional peer, but installed)' : ''
      }; the project locks ${name} ${version}, and moving it would change a package outside the upgrade.`;
  }
  return undefined;
}

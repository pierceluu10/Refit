import { npmLockFromBun } from './bun-lock.ts';
import { changesOutside, type ResolutionManager } from './lockfile-resolution.ts';
import { parsePnpmLock } from './pnpm-lock.ts';
import { isObject, parseDocumentObject, parseJson } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// A lockfile with the package.json files it covers, by directory ('.' is the root).
export interface LockedProject {
  lockfile: string;
  manifests: Record<string, Record<string, unknown>>;
}

interface Node {
  name: string;
  version: string;
  // What the install fetches: the resolved version with its integrity or resolution.
  identity: string;
  dependencies: Record<string, string>;
}

// pnpm and Yarn lockfiles as one graph: each importer's declarations point at nodes, and each node
// at the nodes its dependencies resolve to. `settings` is everything else the lockfile records.
interface Graph {
  settings: string;
  importers: Record<string, Record<string, { spec: string; node?: string }>>;
  nodes: Record<string, Node>;
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
// `name@range` or `name@version`, with a scoped name's own `@`.
const DESCRIPTOR = /^(@?[^@]+)@(.*)$/;

const record = (value: unknown) => (isObject(value) ? value : {});

function pnpmGraph(text: string): Graph {
  const { document } = parsePnpmLock(text);
  const { importers, packages, snapshots, ...settings } = document;
  // A pnpm version names a snapshot: `1.2.3(peer@4)`, or `real-name@1.2.3` for an alias. Links and
  // local sources name no registry node.
  const key = (name: string, version: unknown) =>
    typeof version !== 'string' || /^(?:link|file|workspace):/.test(version)
      ? undefined
      : /^\d/.test(version)
        ? `${name}@${version}`
        : version;
  const nodes: Record<string, Node> = {};
  for (const [snapshot, value] of Object.entries(record(snapshots))) {
    const base = snapshot.split('(')[0];
    const match = DESCRIPTOR.exec(base);
    if (!match) throw new PipelineInputError(`pnpm-lock.yaml records the snapshot ${snapshot}.`);
    const dependencies: Record<string, string> = {};
    for (const section of ['dependencies', 'optionalDependencies'])
      for (const [name, version] of Object.entries(record(record(value)[section]))) {
        const target = key(name, version);
        if (target) dependencies[name] = target;
      }
    nodes[snapshot] = {
      name: match[1],
      version: match[2],
      identity: `${base} ${JSON.stringify(record(record(packages)[base]).resolution ?? null)}`,
      dependencies,
    };
  }
  const graphImporters: Graph['importers'] = {};
  for (const [path, importer] of Object.entries(record(importers))) {
    const entries: Graph['importers'][string] = {};
    for (const section of SECTIONS)
      for (const [name, value] of Object.entries(record(record(importer)[section]))) {
        const entry = record(value);
        const node = key(name, entry.version);
        entries[name] = {
          spec: `${section} ${String(entry.specifier)} ${node ? '' : String(entry.version)}`,
          ...(node ? { node } : {}),
        };
      }
    graphImporters[path] = entries;
  }
  return { settings: JSON.stringify(settings), importers: graphImporters, nodes };
}

// Yarn 1's own format: unindented descriptor lines, two-space fields and four-space dependencies.
function yarnClassicGraph(text: string, manifests: LockedProject['manifests']): Graph {
  const entries: Record<string, string> = {};
  const nodes: Record<string, Node> = {};
  const fields: Record<string, Record<string, string>> = {};
  let current: string | undefined;
  let block: string | undefined;
  const unquote = (value: string) => value.replace(/^"|"$/g, '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      if (!line.endsWith(':'))
        throw new PipelineInputError('yarn.lock contains an unsupported entry line.');
      const descriptors = line.slice(0, -1).split(/,\s*/).map(unquote);
      current = descriptors[0];
      for (const descriptor of descriptors) entries[descriptor] = current;
      fields[current] = {};
      nodes[current] = { name: '', version: '', identity: '', dependencies: {} };
      block = undefined;
      continue;
    }
    const field = /^ {2}(\S+?):?(?: (.*))?$/.exec(line);
    const dependency = /^ {4}("?[^"\s]+"?) (.+)$/.exec(line);
    if (current && field && !line.startsWith('    ')) {
      if (field[2] === undefined) block = field[1];
      else fields[current][field[1]] = unquote(field[2]);
    } else if (
      current &&
      dependency &&
      (block === 'dependencies' || block === 'optionalDependencies')
    )
      nodes[current].dependencies[unquote(dependency[1])] = unquote(dependency[2]);
    else throw new PipelineInputError('yarn.lock contains an unsupported field line.');
  }
  for (const [id, node] of Object.entries(nodes)) {
    const name = DESCRIPTOR.exec(id)?.[1] ?? id;
    const { version = '', resolved = '', integrity = '' } = fields[id];
    node.name = name;
    node.version = version;
    node.identity = `${name}@${version} ${resolved} ${integrity}`;
    node.dependencies = Object.fromEntries(
      Object.entries(node.dependencies).map(([dependency, range]) => [
        dependency,
        entries[`${dependency}@${range}`] ?? `unresolved ${dependency}@${range}`,
      ]),
    );
  }
  const importers: Graph['importers'] = {};
  for (const [path, manifest] of Object.entries(manifests)) {
    const declared: Graph['importers'][string] = {};
    for (const section of SECTIONS)
      for (const [name, range] of Object.entries(record(manifest[section]))) {
        const node = entries[`${name}@${String(range)}`];
        declared[name] = { spec: `${section} ${String(range)}`, ...(node ? { node } : {}) };
      }
    importers[path] = declared;
  }
  return { settings: '', importers, nodes };
}

function yarnBerryGraph(text: string): Graph {
  const document = parseDocumentObject(text, 'yarn.lock');
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(document))
    if (key !== '__metadata' && typeof record(value).resolution === 'string')
      for (const descriptor of key.split(/,\s*/))
        entries[descriptor] = String(record(value).resolution);
  const lookup = (name: string, range: string) =>
    entries[`${name}@${range}`] ?? entries[`${name}@npm:${range}`];
  const nodes: Record<string, Node> = {};
  const importers: Graph['importers'] = {};
  for (const [key, value] of Object.entries(document)) {
    const entry = record(value);
    if (key === '__metadata' || typeof entry.resolution !== 'string') continue;
    const dependencies = Object.entries(record(entry.dependencies));
    const workspace = /@workspace:(.+)$/.exec(entry.resolution);
    if (workspace) {
      importers[workspace[1]] = Object.fromEntries(
        dependencies.map(([name, range]) => {
          const node = lookup(name, String(range));
          return [name, { spec: String(range), ...(node ? { node } : {}) }];
        }),
      );
      continue;
    }
    nodes[entry.resolution] = {
      name: DESCRIPTOR.exec(entry.resolution)?.[1] ?? entry.resolution,
      version: String(entry.version),
      identity: `${entry.resolution} ${String(entry.checksum ?? '')} ${String(entry.conditions ?? '')}`,
      dependencies: Object.fromEntries(
        dependencies.map(([name, range]) => [
          name,
          lookup(name, String(range)) ?? `unresolved ${name}@${String(range)}`,
        ]),
      ),
    };
  }
  return { settings: JSON.stringify(document.__metadata ?? null), importers, nodes };
}

function graph(manager: ResolutionManager, project: LockedProject) {
  return manager === 'pnpm'
    ? pnpmGraph(project.lockfile)
    : manager === 'yarn'
      ? yarnClassicGraph(project.lockfile, project.manifests)
      : yarnBerryGraph(project.lockfile);
}

// npm and Bun lockfiles as npm's v3 packages map (bun-lock.ts translates Bun's).
function npmPackages(manager: 'npm' | 'bun', project: LockedProject) {
  const text =
    manager === 'bun'
      ? npmLockFromBun(JSON.stringify(project.manifests['.'] ?? {}), project.lockfile)
      : project.lockfile;
  const lock = parseJson(text);
  return { text, packages: isObject(lock) && isObject(lock.packages) ? lock.packages : {} };
}

// The nodes the importers reach without passing through `skip`, each with what it fetches and
// what its other dependencies resolve to.
function reached(input: Graph, skip: Set<string>) {
  const signatures = new Set<string>();
  const seen = new Set<string>();
  const pending = Object.values(input.importers).flatMap((entries) =>
    Object.entries(entries).flatMap(([name, entry]) =>
      !skip.has(name) && entry.node ? [entry.node] : [],
    ),
  );
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = input.nodes[id];
    if (!node) {
      signatures.add(`missing ${id}`);
      continue;
    }
    const others = Object.entries(node.dependencies).filter(([name]) => !skip.has(name));
    signatures.add(
      `${node.identity} -> ${others
        .map(([name, target]) => `${name}=${input.nodes[target]?.identity ?? target}`)
        .sort()
        .join(', ')}`,
    );
    pending.push(...others.map(([, target]) => target));
  }
  return signatures;
}

// What changes between two lockfiles of one manager outside `names` and the packages only they
// reach; empty when the change stays inside them. npm and Bun compare npm's packages map
// (changesOutside); pnpm and Yarn compare their graphs, so a package outside `names` must fetch the
// same release and resolve its other dependencies to the same releases, and every importer must
// declare the same packages outside `names`.
export function lockChangesOutside(
  manager: ResolutionManager,
  before: LockedProject,
  after: LockedProject,
  names: string[],
) {
  if (manager === 'npm' || manager === 'bun')
    return changesOutside(
      npmPackages(manager, before).text,
      npmPackages(manager, after).text,
      names,
    );
  const skip = new Set(names);
  const [old, changed] = [graph(manager, before), graph(manager, after)];
  const changes = old.settings === changed.settings ? [] : ['the lockfile settings'];
  const importer = (input: Graph, path: string) =>
    JSON.stringify(
      Object.entries(input.importers[path] ?? {})
        .filter(([name]) => !skip.has(name))
        .map(([name, entry]) => [name, entry.spec, entry.node && input.nodes[entry.node]?.identity])
        .sort(),
    );
  for (const path of new Set([...Object.keys(old.importers), ...Object.keys(changed.importers)]))
    if (importer(old, path) !== importer(changed, path)) changes.push(`importer ${path}`);
  const [was, now] = [reached(old, skip), reached(changed, skip)];
  for (const signature of [...was].filter((entry) => !now.has(entry)))
    changes.push(signature.split(' -> ')[0].split(' ')[0]);
  for (const signature of [...now].filter((entry) => !was.has(entry)))
    changes.push(signature.split(' -> ')[0].split(' ')[0]);
  return [...new Set(changes)];
}

// Every release a lockfile installs, by package name, and the release each root declaration
// installs.
export function lockedReleases(manager: ResolutionManager, project: LockedProject) {
  const all = new Map<string, Set<string>>();
  const root: Record<string, string> = {};
  const add = (name: string, version: string) =>
    all.set(name, (all.get(name) ?? new Set()).add(version));
  if (manager === 'npm' || manager === 'bun') {
    for (const [key, value] of Object.entries(npmPackages(manager, project).packages)) {
      const entry = record(value);
      if (!key || entry.link === true || typeof entry.version !== 'string') continue;
      const name =
        typeof entry.name === 'string'
          ? entry.name
          : key.slice(key.lastIndexOf('node_modules/') + 13);
      add(name, entry.version);
      if (key === `node_modules/${name}`) root[name] = entry.version;
    }
    return { all, root };
  }
  const input = graph(manager, project);
  for (const node of Object.values(input.nodes)) add(node.name, node.version);
  for (const [name, entry] of Object.entries(input.importers['.'] ?? {})) {
    const node = entry.node && input.nodes[entry.node];
    if (node) root[name] = node.version;
  }
  return { all, root };
}

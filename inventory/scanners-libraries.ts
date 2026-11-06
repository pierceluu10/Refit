// Direct dependencies per package root, each resolved against its nearest lockfile. Raw signals for
// the inventory agent: a missing `resolved` means the scanner found nothing, not that none exists.
import path from 'node:path';
import {
  LOCK_READERS,
  indentOf,
  jsonChildVersion,
  listManifests,
  readLines,
  unquote,
  yarnEntries,
} from './scanners.ts';
import type { Dependency, LockedEntry, Manifest } from './scanners.ts';

export type DirectDependency = {
  name: string;
  declared: string;
  dev?: boolean;
  file: string;
  line: number;
  hint?: string;
  resolved?: { version: string; lockfile: string; line: number };
};
export type PackageRoot = {
  dir: string;
  ecosystem: string;
  dependencies: DirectDependency[];
  lockfile?: string;
};

type Ecosystem = Manifest['ecosystem'];
// `directory` is the package's path relative to the lockfile's directory ('' when the same).
type Resolver = (name: string, declared: string, directory: string) => LockedEntry | undefined;

const LOCKFILE_ECOSYSTEMS: Record<string, Ecosystem> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'npm',
  'pnpm-lock.yaml': 'npm',
  'bun.lock': 'npm',
  'poetry.lock': 'python',
  'uv.lock': 'python',
  'Pipfile.lock': 'python',
  'Cargo.lock': 'rust',
  'Gemfile.lock': 'ruby',
  'go.sum': 'go',
  'composer.lock': 'php',
  'gradle.lockfile': 'jvm',
  'packages.lock.json': 'dotnet',
};
const NODE_MODULES = 'node_modules';
const NPM_PACKAGE_KEY = /^\s*"((?:[^"]*\/)?node_modules\/[^"]+)"\s*:\s*\{\s*$/;
const NPM_OBJECT_KEY = /^\s*"([^"]+)"\s*:\s*\{\s*$/;
const PINNED_REQUIREMENT = /^==\s*([\w.+!-]+)\s*\\?$/;
const YAML_KEY = /^(\s*)(?:'([^']*)'|"([^"]*)"|([^:]+)):(?:\s+(.*))?$/;
const PNPM_PEER_SUFFIX = /[(_].*$/;
const PNPM_ROOT_IMPORTER = '.';

function npmResolver(lines: string[]): Resolver {
  // v2 and v3 key every install location by path, so a workspace's own copy is distinguishable.
  const installed = new Map<string, LockedEntry>();
  lines.forEach((line, index) => {
    const key = NPM_PACKAGE_KEY.exec(line);
    const found =
      key && index + 1 < lines.length
        ? jsonChildVersion(lines, index + 1, indentOf(lines[index + 1]), 'version')
        : undefined;
    if (key && found) installed.set(key[1], found);
  });
  return (name, _declared, directory) => {
    const segments = directory === '' ? [] : directory.split('/');
    // Node's lookup order: the package's own node_modules, then each ancestor's.
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      const found = installed.get([...segments.slice(0, depth), NODE_MODULES, name].join('/'));
      if (found) return found;
    }
    return legacyNpmEntry(lines, name);
  };
}

// v1 lockfiles nest a `dependencies` tree instead; the shallowest `"name": {` is the hoisted copy.
function legacyNpmEntry(lines: string[], name: string): LockedEntry | undefined {
  let shallowest: number | undefined;
  lines.forEach((line, index) => {
    if (NPM_OBJECT_KEY.exec(line)?.[1] !== name) return;
    if (shallowest === undefined || indentOf(line) < indentOf(lines[shallowest])) {
      shallowest = index;
    }
  });
  if (shallowest === undefined || shallowest + 1 >= lines.length) return undefined;
  return jsonChildVersion(lines, shallowest + 1, indentOf(lines[shallowest + 1]), 'version');
}

function yarnResolver(lines: string[]): Resolver {
  return (name, declared) => {
    const entries = yarnEntries(lines, name);
    // Berry writes the spec as `name@npm:^14.2.0`.
    const specs = [`${name}@${declared}`, `${name}@npm:${declared}`];
    return entries.find((entry) => entry.specs.some((spec) => specs.includes(spec))) ?? entries[0];
  };
}

type YamlKey = { index: number; indent: number; key: string; inline?: string };

function yamlKeys(lines: string[], from: number, to: number): YamlKey[] {
  const keys: YamlKey[] = [];
  for (let index = from; index < to; index += 1) {
    const match = YAML_KEY.exec(lines[index].trimEnd());
    if (!match) continue;
    const key = match[2] ?? match[3] ?? match[4];
    keys.push({ index, indent: match[1].length, key, inline: match[5] });
  }
  return keys;
}

// The lines nested under the first key called `key` at the shallowest indent of [from, to).
function yamlChildRange(
  lines: string[],
  from: number,
  to: number,
  key: string,
): [number, number] | undefined {
  const keys = yamlKeys(lines, from, to);
  const indent = Math.min(...keys.map((entry) => entry.indent));
  const start = keys.findIndex((entry) => entry.indent === indent && entry.key === key);
  if (start === -1) return undefined;
  const next = keys.slice(start + 1).find((entry) => entry.indent <= keys[start].indent);
  return [keys[start].index + 1, next?.index ?? to];
}

function pnpmResolver(lines: string[]): Resolver {
  const importers = yamlChildRange(lines, 0, lines.length, 'importers');
  const packagesAt = lines.findIndex((line) => line.startsWith('packages:'));
  // Lockfiles of a single project have no `importers:`; its dependencies sit at the top.
  const topLevel: [number, number] = [0, packagesAt === -1 ? lines.length : packagesAt];
  return (name, _declared, directory) => {
    const section = importers
      ? yamlChildRange(lines, ...importers, directory || PNPM_ROOT_IMPORTER)
      : directory === ''
        ? topLevel
        : undefined;
    const keys = section ? yamlKeys(lines, ...section) : [];
    const key = keys.find((entry) => entry.key === name);
    if (!key) return LOCK_READERS['pnpm-lock.yaml'](lines, name)[0];
    // v9 nests `version:` under the name; older lockfiles put the version inline.
    const versionKey = key.inline
      ? key
      : keys.find((entry) => entry.index > key.index && entry.key === 'version');
    if (!versionKey?.inline) return undefined;
    return {
      version: unquote(versionKey.inline).replace(PNPM_PEER_SUFFIX, ''),
      line: versionKey.index + 1,
    };
  };
}

// Falls back to the first entry; the pin in the manifest picks between a package's several copies.
function firstEntryResolver(file: string) {
  return (lines: string[]): Resolver =>
    (name, declared) => {
      const entries = LOCK_READERS[file](lines, name);
      return entries.find((entry) => entry.version === declared) ?? entries[0];
    };
}

const RESOLVERS: Record<string, (lines: string[]) => Resolver> = {
  'package-lock.json': npmResolver,
  'npm-shrinkwrap.json': npmResolver,
  'yarn.lock': yarnResolver,
  'pnpm-lock.yaml': pnpmResolver,
};

function buildResolver(lockfile: string, lines: string[]): Resolver {
  const file = path.posix.basename(lockfile);
  return (RESOLVERS[file] ?? firstEntryResolver(file))(lines);
}

// The closest lockfile of the ecosystem in the package's directory or above it.
function nearestLockfile(
  directory: string,
  ecosystem: Ecosystem,
  lockfiles: string[],
): string | undefined {
  let nearest: string | undefined;
  for (const lockfile of lockfiles) {
    const lockDirectory = path.posix.dirname(lockfile);
    const covers = path.posix.relative(lockDirectory, directory).split('/')[0] !== '..';
    const closer =
      nearest === undefined || lockDirectory.length > path.posix.dirname(nearest).length;
    if (LOCKFILE_ECOSYSTEMS[path.posix.basename(lockfile)] === ecosystem && covers && closer) {
      nearest = lockfile;
    }
  }
  return nearest;
}

function pinnedVersion(manifest: Manifest, entry: Dependency): string | undefined {
  // A compiled requirements file (pip-compile) is its own lock.
  return manifest.file.endsWith('.txt') ? PINNED_REQUIREMENT.exec(entry.version)?.[1] : undefined;
}

export async function findDirectDependencies(
  repoDir: string,
): Promise<{ packages: PackageRoot[]; lockfiles: string[] }> {
  const { manifests, lockfiles } = await listManifests(repoDir);
  const resolvers = new Map<string, Resolver | undefined>();
  const resolverFor = async (lockfile: string) => {
    if (!resolvers.has(lockfile)) {
      const lines = await readLines(repoDir, lockfile);
      resolvers.set(lockfile, lines && buildResolver(lockfile, lines));
    }
    return resolvers.get(lockfile);
  };

  const roots = new Map<string, PackageRoot>();
  for (const manifest of manifests) {
    const dir = path.posix.dirname(manifest.file);
    const key = `${manifest.ecosystem}:${dir}`;
    const lockfile = nearestLockfile(dir, manifest.ecosystem, lockfiles);
    const root = roots.get(key) ?? {
      dir,
      ecosystem: manifest.ecosystem,
      dependencies: [],
      ...(lockfile ? { lockfile } : {}),
    };
    roots.set(key, root);
    const resolver = lockfile ? await resolverFor(lockfile) : undefined;
    for (const entry of manifest.dependencies) {
      const pinned = pinnedVersion(manifest, entry);
      const locked = pinned
        ? { version: pinned, line: entry.line }
        : lockfile && resolver
          ? resolver(
              entry.name,
              entry.version,
              path.posix.relative(path.posix.dirname(lockfile), dir),
            )
          : undefined;
      const source = pinned ? manifest.file : lockfile;
      root.dependencies.push({
        name: entry.name,
        declared: entry.version,
        ...(entry.dev ? { dev: true } : {}),
        file: manifest.file,
        line: entry.line,
        ...(entry.hint ? { hint: entry.hint } : {}),
        ...(locked && source ? { resolved: { ...locked, lockfile: source } } : {}),
      });
    }
  }
  const packages = [...roots.values()].sort(
    (a, b) => a.dir.localeCompare(b.dir) || a.ecosystem.localeCompare(b.ecosystem),
  );
  return { packages, lockfiles };
}

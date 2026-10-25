import {
  DEPENDENCY_SECTIONS,
  EXACT_PACKAGE_VERSION,
  hasStrongIntegrity,
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGES,
  REGISTRY_PACKAGE_NAME,
} from './npm-lock.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const BUN_LOCKFILE = 'bun.lock';
const META_KEYS = new Set([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'optionalPeers',
  'bin',
  'os',
  'cpu',
  'libc',
  'bundled',
]);

const CLOSING = /\s*[}\]]/y;

// bun.lock is JSON with trailing commas; drop each comma that closes an object or array.
function withoutTrailingCommas(text: string) {
  let output = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    CLOSING.lastIndex = index + 1;
    if (quoted) {
      output += character;
      if (character === '\\') output += text[++index] ?? '';
      else if (character === '"') quoted = false;
    } else if (character === ',' && CLOSING.test(text)) {
      continue;
    } else {
      if (character === '"') quoted = true;
      output += character;
    }
  }
  return output;
}

// A bun.lock key names the node_modules path Bun's hoisted linker installs a package at:
// `parent/child` nests child under parent, and a scoped name spans two segments.
function folders(key: string) {
  const parts = key.split('/');
  const names: string[] = [];
  for (let index = 0; index < parts.length; index++)
    names.push(parts[index].startsWith('@') ? `${parts[index]}/${parts[++index]}` : parts[index]);
  return names;
}

const location = (names: string[]) => names.map((name) => `node_modules/${name}`).join('/');
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/node_modules/')));
// `node_modules/a/node_modules/@s/b` reads as `a > @s/b`.
const display = (path: string) =>
  path
    .split('/node_modules/')
    .map((part) => part.replace(/^node_modules\//, ''))
    .join(' > ');
const list = (value: unknown) => (typeof value === 'string' ? [value] : value);
const refuse = (detail: string) =>
  new PipelineInputError(
    `Automatic preparation reads a bun.lock only when every package is a public registry package with integrity, laid out for a single root project. ${detail}`,
  );

// Translates a committed Bun text lockfile into the npm v3 lockfile `npm ci` installs: the same
// packages at the same node_modules paths, each from its registry tarball with Bun's integrity.
export function npmLockFromBun(packageContent: string, bunContent: string) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(bunContent) > MAX_LOCK_BYTES
  )
    throw new PipelineInputError('Bun preparation inputs exceed the manifest or lockfile limit.');
  const manifest = parseObject(packageContent, 'package.json');
  const lock = parseObject(withoutTrailingCommas(bunContent), 'bun.lock');
  if (
    lock.lockfileVersion !== 1 ||
    Object.keys(lock).some(
      (key) => !['lockfileVersion', 'configVersion', 'workspaces', 'packages'].includes(key),
    ) ||
    !isObject(lock.workspaces) ||
    Object.keys(lock.workspaces).join() !== '' ||
    !isObject(lock.workspaces['']) ||
    !isObject(lock.packages) ||
    Object.keys(lock.packages).length > MAX_PACKAGES
  )
    throw refuse(
      'It must be lockfile version 1 with only the root workspace, and no overrides, patches or catalogs.',
    );
  const root = lock.workspaces[''];
  for (const section of DEPENDENCY_SECTIONS) {
    const declared = isObject(manifest[section]) ? manifest[section] : {};
    const recorded = isObject(root[section]) ? root[section] : {};
    const name = [...new Set([...Object.keys(declared), ...Object.keys(recorded)])].find(
      (name) => declared[name] !== recorded[name],
    );
    if (name !== undefined)
      throw new PipelineInputError(
        `package.json ${section} differ from the committed bun.lock: ${name} is ${JSON.stringify(declared[name]) ?? 'missing'} in package.json but ${JSON.stringify(recorded[name]) ?? 'missing'} in bun.lock. Run bun install and commit the updated bun.lock.`,
      );
  }
  const packages: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(lock.packages)) {
    const names = folders(key);
    const [resolution, registry, meta, integrity] = Array.isArray(value) ? value : [];
    const at = typeof resolution === 'string' ? resolution.lastIndexOf('@') : -1;
    const name = at > 0 ? (resolution as string).slice(0, at) : '';
    const version = at > 0 ? (resolution as string).slice(at + 1) : '';
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !REGISTRY_PACKAGE_NAME.test(name) ||
      !EXACT_PACKAGE_VERSION.test(version) ||
      registry !== '' ||
      !isObject(meta) ||
      Object.keys(meta).some((field) => !META_KEYS.has(field)) ||
      !hasStrongIntegrity(integrity) ||
      names.some((folder) => !REGISTRY_PACKAGE_NAME.test(folder) || /^\.\.?$/.test(folder)) ||
      ['os', 'cpu', 'libc'].some((field) => {
        const values = list(meta?.[field] ?? []);
        return !Array.isArray(values) || values.some((entry) => typeof entry !== 'string');
      })
    )
      throw refuse(`bun.lock records ${key} as ${JSON.stringify(value)?.slice(0, 200)}.`);
    if (names.length > 1 && !Object.hasOwn(lock.packages, names.slice(0, -1).join('/')))
      throw refuse(`bun.lock nests ${key} under a package it does not record.`);
    const peers = meta.optionalPeers;
    if (
      peers !== undefined &&
      (!Array.isArray(peers) || peers.some((peer) => typeof peer !== 'string'))
    )
      throw refuse(`bun.lock records unreadable optional peers for ${key}.`);
    packages[location(names)] = {
      ...(names.at(-1) === name ? {} : { name }),
      version,
      ...(meta.bundled === true
        ? { inBundle: true }
        : {
            resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
            integrity,
          }),
      ...Object.fromEntries(
        ['dependencies', 'optionalDependencies', 'peerDependencies', 'bin']
          .filter((field) => meta[field] !== undefined)
          .map((field) => [field, meta[field]]),
      ),
      ...(peers?.length
        ? {
            peerDependenciesMeta: Object.fromEntries(
              (peers as string[]).map((peer) => [peer, { optional: true }]),
            ),
          }
        : {}),
      ...Object.fromEntries(
        ['os', 'cpu', 'libc']
          .filter((field) => meta[field] !== undefined)
          .map((field) => [field, list(meta[field])]),
      ),
    };
  }
  // npm skips a platform package only when the lockfile marks it optional, so mark every package
  // no chain of required edges from the root reaches, resolving each edge as npm and Node do.
  const resolve = (from: string, name: string, peer: boolean) => {
    for (let base = peer ? parentOf(from) : from; ; base = parentOf(base)) {
      const path = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (Object.hasOwn(packages, path)) return path;
      if (!base) return undefined;
    }
  };
  const edges = (path: string, record: Record<string, unknown>) => {
    const optionalPeers = isObject(record.peerDependenciesMeta) ? record.peerDependenciesMeta : {};
    return [
      ...Object.keys(isObject(record.dependencies) ? record.dependencies : {}).map(
        (name) => [name, false, false] as const,
      ),
      ...Object.keys(isObject(record.devDependencies) ? record.devDependencies : {}).map(
        (name) => [name, false, false] as const,
      ),
      ...Object.keys(isObject(record.optionalDependencies) ? record.optionalDependencies : {}).map(
        (name) => [name, true, false] as const,
      ),
      ...Object.keys(isObject(record.peerDependencies) ? record.peerDependencies : {}).map(
        (name) => [name, Object.hasOwn(optionalPeers, name), true] as const,
      ),
    ].map(([name, optional, peer]) => ({
      name,
      optional,
      to: resolve(path, name, peer && path !== ''),
    }));
  };
  const reached = new Set<string>();
  const required = new Set<string>();
  const queue: [string, boolean][] = [['', true]];
  while (queue.length) {
    const [path, needed] = queue.shift()!;
    for (const edge of edges(path, path ? packages[path] : manifest)) {
      if (!edge.to) {
        if (!edge.optional)
          throw refuse(
            `bun.lock leaves ${edge.name} unresolved for ${path ? display(path) : 'the root project'}.`,
          );
        continue;
      }
      const next = needed && !edge.optional;
      if (next ? required.has(edge.to) : reached.has(edge.to)) continue;
      reached.add(edge.to);
      if (next) required.add(edge.to);
      queue.push([edge.to, next]);
    }
  }
  const unreached = Object.keys(packages).find((path) => !reached.has(path));
  if (unreached) {
    const name = unreached.slice(unreached.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const parent = packages[parentOf(unreached)];
    const dependent = display(parentOf(unreached));
    // Bun may nest a peer inside its dependent to satisfy it; npm only looks from the dependent's
    // parent, so no npm lockfile can describe that tree.
    throw refuse(
      parent && isObject(parent.peerDependencies) && Object.hasOwn(parent.peerDependencies, name)
        ? `bun.lock nests ${name}, a peer dependency of ${dependent}, inside ${dependent}. npm resolves a peer from the dependent's parent, so it cannot install the tree Bun installs.`
        : `bun.lock records ${unreached}, which no dependency resolves to.`,
    );
  }
  for (const [path, record] of Object.entries(packages))
    if (!required.has(path)) record.optional = true;
  return `${JSON.stringify(
    {
      name: manifest.name,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': Object.fromEntries(
          ['name', 'version', ...DEPENDENCY_SECTIONS]
            .filter((field) => manifest[field] !== undefined)
            .map((field) => [field, manifest[field]]),
        ),
        ...Object.fromEntries(
          Object.entries(packages).sort(([left], [right]) => left.localeCompare(right, 'en')),
        ),
      },
    },
    null,
    2,
  )}\n`;
}

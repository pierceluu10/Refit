import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseToml, TomlError, type TomlTable } from './package-manifests-toml.ts';
import { resolveLockedDependency, type DependencyLockfile } from './lockfiles.ts';
import { PNPM_LOCKFILE, parsePnpmLock } from './pnpm-lock.ts';
import { parseDocumentObject } from './specifications.ts';
import { PipelineInputError, type DependencyDeclaration, type LockedDependency } from './types.ts';
import { YARN_LOCKFILE, parseYarnLock } from './yarn-lock.ts';

// Monorepo attribution for detection and deadline findings: which package of the repository a
// finding lives in, and whether its path is one Refit does not treat as the product (vendored or
// installed code, build output, examples, docs sites, test fixtures). Read from the repository's
// own files only; nothing is installed or run.

export type WorkspaceTool =
  'npm' | 'yarn' | 'pnpm' | 'lerna' | 'nx' | 'turborepo' | 'rush' | 'uv' | 'cargo' | 'go';

// The package a finding belongs to: the nearest directory above it with a package.json (or an Nx
// project.json, or another ecosystem's manifest), named as that manifest names it.
export interface WorkspacePackage {
  path: string;
  name: string | null;
  // True when the root's workspace configuration includes this directory, or it is the root.
  member: boolean;
}

export interface WorkspaceLayout {
  tools: WorkspaceTool[];
  // Workspace globs from package.json, pnpm-workspace.yaml, lerna.json and rush.json.
  patterns: string[];
  packages: WorkspacePackage[];
  // Directories the repository declares as application code in APPLICATION_PATHS_FILE: no
  // exclusion applies inside them.
  applicationPaths?: string[];
}

export type ExclusionReason =
  'node-modules' | 'vendored' | 'build-output' | 'example' | 'docs-site' | 'test-fixture';

export interface FindingPlace {
  workspace: { path: string; name: string | null } | null;
  excluded: ExclusionReason | null;
}

// Exclusions whose live deadline matches are listed but not counted as exposures (owner decision,
// 2026-10-22): docs sites, examples, test fixtures and build output. Vendored and installed code
// ships with the application, so it still counts.
export const UNCOUNTED_EXCLUSIONS: ReadonlySet<ExclusionReason> = new Set([
  'build-output',
  'example',
  'docs-site',
  'test-fixture',
]);

// An explicit, committed list of directories that are application code although their names match
// an exclusion, such as a deployed `website/`: `{ "formatVersion": 1, "paths": ["website"] }`.
export const APPLICATION_PATHS_FILE = '.refit-application-paths.json';
const MAX_APPLICATION_PATHS = 100;

// Directory names, matched as whole path segments, for each exclusion. The first match wins.
const EXCLUSIONS: [ExclusionReason, RegExp][] = [
  ['node-modules', /^node_modules$/],
  ['vendored', /^(?:vendor|vendors|vendored|third[-_]?party)$/i],
  ['build-output', /^(?:dist|build|out|\.next|\.nuxt|\.output|\.svelte-kit|coverage|\.turbo)$/],
  ['example', /^(?:examples?|samples?|demos?)$/i],
  ['docs-site', /^(?:docs?|website|documentation)$/i],
  ['test-fixture', /^(?:fixtures?|__fixtures__|__mocks__|testdata|test-data|mocks)$/i],
];
// Bundled files are build output wherever they sit.
const BUNDLED = /\.(?:min|bundle)\.[cm]?js$/;
const MANIFESTS = new Set([
  'package.json',
  'project.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);
const SKIPPED = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 100_000;

export function exclusionReason(file: string): ExclusionReason | null {
  const segments = file.split('/');
  const directories = segments.slice(0, -1);
  for (const [reason, pattern] of EXCLUSIONS)
    if (directories.some((segment) => pattern.test(segment))) return reason;
  return BUNDLED.test(segments.at(-1) ?? '') ? 'build-output' : null;
}

// Workspace globs as npm, Yarn and pnpm read them (the same matcher npm-lock.ts uses): a pattern
// names package directories, and a leading `!` excludes.
export function globMatcher(patterns: string[]) {
  const clean = (pattern: string) => pattern.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(clean);
  const exclude = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => clean(pattern.slice(1)));
  return (directory: string) =>
    include.some((pattern) => posix.matchesGlob(directory, pattern)) &&
    !exclude.some((pattern) => posix.matchesGlob(directory, pattern));
}

// The repository reader's per-file limit (pipeline/repository.ts).
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// A regular file's text; symlinks, which may point outside the repository, and files over the
// limit read as missing.
async function readText(path: string) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  return readFile(path, 'utf8').catch(() => undefined);
}

// The directories APPLICATION_PATHS_FILE declares, or none when the file is absent. A file that is
// present but malformed stops the scan rather than being ignored.
export async function readApplicationPaths(root: string): Promise<string[]> {
  const text = await readText(join(root, APPLICATION_PATHS_FILE));
  if (text === undefined) {
    const info = await lstat(join(root, APPLICATION_PATHS_FILE)).catch(() => undefined);
    if (info)
      throw new PipelineInputError(
        `${APPLICATION_PATHS_FILE} must be a regular file of at most 2 MiB.`,
      );
    return [];
  }
  const value = jsonObject(text);
  const paths = value?.paths;
  const invalid = (path: unknown) =>
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[*?[\]{}!]/.test(path) ||
    path.split('/').some((segment) => segment === '..' || segment === '.');
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'formatVersion,paths' ||
    value.formatVersion !== 1 ||
    !Array.isArray(paths) ||
    paths.length > MAX_APPLICATION_PATHS ||
    paths.some(invalid)
  )
    throw new PipelineInputError(
      `${APPLICATION_PATHS_FILE} must be { "formatVersion": 1, "paths": [...] } with at most ${MAX_APPLICATION_PATHS} relative directory paths, without globs, "." or "..".`,
    );
  return (paths as string[]).map((path) => path.replace(/\/+$/, ''));
}

function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function manifestName(file: string, text: string | undefined): string | null {
  if (!text) return null;
  if (file.endsWith('.json')) {
    const name = jsonObject(text)?.name;
    return typeof name === 'string' ? name : null;
  }
  if (file.endsWith('.toml')) {
    // [project] or [tool.poetry] in pyproject.toml, [package] in Cargo.toml.
    try {
      const document = parseToml(text);
      const tables = [
        document.project,
        (document.tool as TomlTable | undefined)?.poetry,
        document.package,
      ] as (TomlTable | undefined)[];
      const name = tables.map((table) => table?.name).find((item) => typeof item === 'string');
      return (name as string | undefined) ?? null;
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
      return null;
    }
  }
  const patterns: Record<string, RegExp> = {
    'setup.cfg': /^\s*name\s*=\s*(\S+)/m,
    'setup.py': /\bname\s*=\s*["']([^"']+)["']/,
    'go.mod': /^module\s+(\S+)/m,
  };
  return patterns[posix.basename(file)]?.exec(text)?.[1] ?? null;
}

export async function readWorkspaceLayout(root: string): Promise<WorkspaceLayout> {
  const tools = new Set<WorkspaceTool>();
  const patterns: string[] = [];
  const manifest = jsonObject(await readText(join(root, 'package.json')));
  const workspaces = manifest?.workspaces;
  const declared = Array.isArray(workspaces)
    ? stringList(workspaces)
    : stringList((workspaces as { packages?: unknown } | undefined)?.packages);
  if (declared.length) {
    patterns.push(...declared);
    tools.add((await readText(join(root, 'yarn.lock'))) !== undefined ? 'yarn' : 'npm');
  }
  const pnpm = await readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpm !== undefined) {
    tools.add('pnpm');
    try {
      patterns.push(...stringList((parseYaml(pnpm) as { packages?: unknown } | null)?.packages));
    } catch {
      // An unreadable pnpm-workspace.yaml still marks the tool; its members stay unknown.
    }
  }
  const lerna = jsonObject(await readText(join(root, 'lerna.json')));
  if (lerna) {
    tools.add('lerna');
    patterns.push(
      ...(stringList(lerna.packages).length ? stringList(lerna.packages) : ['packages/*']),
    );
  }
  const rush = jsonObject(
    (await readText(join(root, 'rush.json')))
      ?.replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, ''),
  );
  if (rush) {
    tools.add('rush');
    for (const project of (rush.projects ?? []) as { projectFolder?: unknown }[])
      if (typeof project.projectFolder === 'string') patterns.push(project.projectFolder);
  }
  // uv and Cargo workspaces list members in the root manifest; go.work `use`s module directories.
  const pyproject = await readText(join(root, 'pyproject.toml'));
  if (pyproject !== undefined)
    try {
      const uv = (parseToml(pyproject).tool as TomlTable | undefined)?.uv as TomlTable | undefined;
      const members = stringList((uv?.workspace as TomlTable | undefined)?.members);
      if (members.length) {
        tools.add('uv');
        patterns.push(
          ...members,
          ...stringList((uv?.workspace as TomlTable).exclude).map((item) => `!${item}`),
        );
      }
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
    }
  const cargo = await readText(join(root, 'Cargo.toml'));
  if (cargo !== undefined)
    try {
      const workspace = parseToml(cargo).workspace as TomlTable | undefined;
      if (workspace) {
        tools.add('cargo');
        patterns.push(
          ...stringList(workspace.members),
          ...stringList(workspace.exclude).map((item) => `!${item}`),
        );
      }
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
    }
  const goWork = await readText(join(root, 'go.work'));
  if (goWork !== undefined) {
    tools.add('go');
    const uses = /^use\s*\(([^)]*)\)/m.exec(goWork)?.[1] ?? '';
    for (const match of [...uses.matchAll(/^\s*(\S+)/gm), ...goWork.matchAll(/^use\s+([^\s(]+)/gm)])
      patterns.push(match[1].replace(/^\.\//, ''));
  }
  if ((await readText(join(root, 'nx.json'))) !== undefined) tools.add('nx');
  if ((await readText(join(root, 'turbo.json'))) !== undefined) tools.add('turborepo');

  const member = globMatcher(patterns);
  const found = new Map<string, WorkspacePackage>();
  let entries = 0;
  async function visit(directory: string): Promise<void> {
    // Sorted so the manifest that names a package does not depend on the file system's order.
    const children = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if ((entries += 1) > MAX_ENTRIES) return;
      if (child.isSymbolicLink()) continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        if (!SKIPPED.has(child.name)) await visit(path);
        continue;
      }
      if (!child.isFile() || !MANIFESTS.has(child.name)) continue;
      const folder = relative(root, directory).split('\\').join('/') || '.';
      const file = folder === '.' ? child.name : `${folder}/${child.name}`;
      const name = manifestName(file, await readText(path));
      const existing = found.get(folder);
      // package.json names the package; other manifests name it only when it has none.
      if (existing && (existing.name || !name)) continue;
      found.set(folder, { path: folder, name, member: folder === '.' || member(folder) });
    }
  }
  await visit(root);
  return {
    tools: [...tools].sort(),
    patterns,
    packages: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)),
    applicationPaths: await readApplicationPaths(root),
  };
}

// The package a repository file belongs to and whether its path is excluded.
export function placeFinding(layout: WorkspaceLayout, file: string): FindingPlace {
  const declared = (layout.applicationPaths ?? []).some((path) => file.startsWith(`${path}/`));
  const excluded = declared ? null : exclusionReason(file);
  let folder = posix.dirname(file);
  for (;;) {
    const found = layout.packages.find((item) => item.path === folder);
    if (found) return { workspace: { path: found.path, name: found.name }, excluded };
    if (folder === '.' || folder === '/' || !folder) break;
    folder = posix.dirname(folder);
  }
  return { workspace: null, excluded };
}

// A dependency declared in a nested package.json that the root lockfile does not cover, resolved
// against that package's own lockfile instead (a nested app with its own package-lock.json,
// pnpm-lock.yaml or yarn.lock). The root result is kept whenever it is locked.
export async function nestedLock(
  root: string,
  dependency: DependencyDeclaration & { lock: LockedDependency },
  packageName: string,
): Promise<LockedDependency> {
  const folder = posix.dirname(dependency.file);
  if (dependency.lock.status === 'locked' || folder === '.') return dependency.lock;
  const lockfiles: DependencyLockfile[] = [];
  for (const name of ['npm-shrinkwrap.json', 'package-lock.json', PNPM_LOCKFILE, YARN_LOCKFILE]) {
    const text = await readText(join(root, folder, name));
    if (text === undefined) continue;
    try {
      const content =
        name === PNPM_LOCKFILE
          ? parsePnpmLock(text).document
          : name === YARN_LOCKFILE
            ? parseYarnLock(text)
            : parseDocumentObject(text, name);
      lockfiles.push({ file: name, content });
    } catch {
      return dependency.lock;
    }
  }
  if (!lockfiles.length) return dependency.lock;
  const lock = resolveLockedDependency(
    { ...dependency, file: 'package.json' },
    packageName,
    lockfiles,
  );
  return lock.file ? { ...lock, file: `${folder}/${lock.file}` } : lock;
}

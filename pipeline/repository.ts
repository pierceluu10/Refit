import { YARN_LOCKFILE, parseYarnLock } from './yarn-lock.ts';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  configurationReferences,
  configurationTarget,
  projectReferences,
  SOURCE_CONFIGURATION_NAMES,
} from './source-configurations.ts';
import { digest, isObject, parseObject, parseDocumentObject } from './specifications.ts';
import { PipelineInputError, type Repository, type DependencyDeclaration } from './types.ts';
import { PNPM_LOCKFILE, parsePnpmLock } from './pnpm-lock.ts';
import {
  DEPENDENCY_LOCKFILES,
  resolveLockedDependency,
  type DependencyLockfile,
} from './lockfiles.ts';

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
]);
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_CONFIGURATION_FILES = 128;
const MAX_CONFIGURATION_BYTES = 128 * 1024;
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

// TypeScript reads UTF-16 files that start with a byte-order mark (PowerShell writes generated
// types that way). They are scanned as text but never edited.
async function sourceFile(path: string, name: string, content: string) {
  // A UTF-16 byte-order mark is not valid UTF-8, so it decodes to two replacement characters.
  if (!content.startsWith('\uFFFD\uFFFD')) return { path: name, content };
  const bytes = await readFile(path);
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  if (!littleEndian && !(bytes[0] === 0xfe && bytes[1] === 0xff)) return { path: name, content };
  const text = littleEndian ? bytes.subarray(2) : Buffer.from(bytes.subarray(2)).swap16();
  return { path: name, content: text.toString('utf16le'), encoding: 'utf-16' as const };
}

export async function readRepository(
  directory: string,
  packageName = 'stripe',
): Promise<Repository> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory())
    throw new PipelineInputError('Repository must be a directory.');
  const repository: Repository = { root, files: [], dependencies: [], lockfiles: [], warnings: [] };
  const declarations: DependencyDeclaration[] = [];
  const lockfiles: DependencyLockfile[] = [];
  const configurationPaths = new Map<string, string>();
  const pendingConfigurations: string[] = [];
  const excludedPaths: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  async function visit(directoryPath: string): Promise<void> {
    const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directoryPath, entry.name);
      const isLockfile =
        directoryPath === root && DEPENDENCY_LOCKFILES.some((name) => name === entry.name);
      if (entry.isSymbolicLink()) {
        repository.warnings.push(`Skipped symbolic link: ${relative(root, path)}`);
        excludedPaths.push(relative(root, path));
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
        else excludedPaths.push(relative(root, path));
        continue;
      }
      if (entry.isFile() && DECLARATION_EXTENSION.test(entry.name))
        excludedPaths.push(relative(root, path));
      if (entry.isFile() && entry.name.endsWith('.json')) {
        configurationPaths.set(path, relative(root, path).split('\\').join('/'));
        if (SOURCE_CONFIGURATION_NAMES.includes(entry.name)) pendingConfigurations.push(path);
      }
      if (
        !entry.isFile() ||
        (!isLockfile &&
          entry.name !== 'package.json' &&
          (!SOURCE_EXTENSION.test(entry.name) || DECLARATION_EXTENSION.test(entry.name)))
      )
        continue;
      const size = (await stat(path)).size;
      totalBytes += size;
      fileCount += 1;
      if (size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES || fileCount > MAX_FILES) {
        throw new PipelineInputError(
          'Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).',
        );
      }
      const content = await readFile(path, 'utf8');
      const name = relative(root, path).split('\\').join('/');
      if (isLockfile) {
        const lockfile =
          name === PNPM_LOCKFILE
            ? parsePnpmLock(content).document
            : name === YARN_LOCKFILE
              ? parseYarnLock(content)
              : parseDocumentObject(content, name);
        lockfiles.push({ file: name, content: lockfile });
        repository.lockfiles.push({
          file: name,
          hash: digest(content),
          version:
            typeof lockfile.lockfileVersion === 'number'
              ? lockfile.lockfileVersion
              : lockfile.lockfileVersion === '9.0'
                ? 9
                : null,
        });
        continue;
      }
      if (entry.name !== 'package.json') {
        repository.files.push(await sourceFile(path, name, content));
        continue;
      }
      const manifest = parseObject(content, name);
      for (const section of DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section];
        if (!isObject(dependencies) || !Object.hasOwn(dependencies, packageName)) continue;
        const version = dependencies[packageName];
        if (typeof version !== 'string')
          throw new PipelineInputError(
            `${name}: ${section}.${packageName} must be a version string.`,
          );
        declarations.push({ file: name, section, version });
      }
    }
  }
  await visit(root);
  const configurations: Repository['files'] = [];
  const loaded = new Set<string>();
  for (let index = 0; index < pendingConfigurations.length; index++) {
    const path = pendingConfigurations[index];
    if (loaded.has(path)) continue;
    loaded.add(path);
    if (loaded.size > MAX_CONFIGURATION_FILES)
      throw new PipelineInputError('Repository exceeds the 128 source-configuration file limit.');
    const size = (await stat(path)).size;
    totalBytes += size;
    fileCount += 1;
    if (size > MAX_CONFIGURATION_BYTES || totalBytes > MAX_TOTAL_BYTES || fileCount > MAX_FILES)
      throw new PipelineInputError('Source configuration exceeds repository scan limits.');
    const content = await readFile(path, 'utf8');
    configurations.push({ path: configurationPaths.get(path)!, content });
    for (const reference of [...configurationReferences(content), ...projectReferences(content)]) {
      const candidate = configurationTarget(
        (name) => configurationPaths.has(name),
        resolve(path, '..', reference),
      );
      if (candidate) pendingConfigurations.push(candidate);
    }
  }
  if (configurations.length)
    repository.configurations = configurations.sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  if (configurations.length && excludedPaths.length)
    repository.excludedPaths = excludedPaths.sort();
  repository.dependencies = declarations.map((dependency) => ({
    ...dependency,
    lock: resolveLockedDependency(dependency, packageName, lockfiles),
  }));
  return repository;
}

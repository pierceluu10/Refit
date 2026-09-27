import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError, type Repository } from './types.ts';

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
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export async function readRepository(directory: string): Promise<Repository> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory())
    throw new PipelineInputError('Repository must be a directory.');
  const repository: Repository = { root, files: [], dependencies: [], warnings: [] };
  let totalBytes = 0;
  let fileCount = 0;
  async function visit(directoryPath: string): Promise<void> {
    const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        repository.warnings.push(`Skipped symbolic link: ${relative(root, path)}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        (entry.name !== 'package.json' &&
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
      if (entry.name !== 'package.json') {
        repository.files.push({ path: name, content });
        continue;
      }
      const manifest = parseObject(content, name);
      for (const section of DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section];
        if (!isObject(dependencies) || !Object.hasOwn(dependencies, 'stripe')) continue;
        if (typeof dependencies.stripe !== 'string')
          throw new PipelineInputError(`${name}: ${section}.stripe must be a version string.`);
        repository.dependencies.push({ file: name, section, version: dependencies.stripe });
      }
    }
  }
  await visit(root);
  return repository;
}

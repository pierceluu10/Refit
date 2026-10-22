import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import { loadParser, withTrees } from '../python/syntax.ts';
import { PipelineInputError } from '../types.ts';

// tree-sitter-go@0.25.0's published tree-sitter-go.wasm, copied as is: the package itself
// runs a native build on install (docs/ARCHITECTURE.md, "Other languages"). Source:
// https://registry.npmjs.org/tree-sitter-go/-/tree-sitter-go-0.25.0.tgz, integrity
// sha512-APBc/Dq3xz/e35Xpkhb1blu5UgW+2E3RyGWawZSCNcbGwa7jhSQPS8KsUupuzBla8PCo8+lz9W/JDJjmfRa2tw==;
// package/tree-sitter-go.wasm in that tarball has GRAMMAR_SHA256 (checked 2026-10-22).
export const GRAMMAR = fileURLToPath(new URL('./tree-sitter-go.wasm', import.meta.url));
export const GRAMMAR_SHA256 = '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7';

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
  // Vendored dependencies are other modules' code.
  'vendor',
  'testdata',
]);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface GoFile {
  path: string;
  content: string;
}

// Go sources under a repository, in path order. Symbolic links, build output, `vendor` and
// `testdata` directories are skipped. Past the 2 MiB, 10,000-file or 50 MiB limit it throws, as
// readRepository does, rather than leaving files out unreported.
export async function readGoFiles(root: string): Promise<GoFile[]> {
  const files: GoFile[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      if (!entry.isFile() || !entry.name.endsWith('.go')) continue;
      const size = (await stat(path)).size;
      total += size;
      if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || files.length >= MAX_FILES)
        throw new PipelineInputError(
          'Go sources exceed scan limits (10,000 files, 2 MiB per file, 50 MiB total).',
        );
      files.push({
        path: relative(root, path).split('\\').join('/'),
        content: await readFile(path, 'utf8'),
      });
    }
  };
  await visit(root);
  return files;
}

let parser: Promise<Parser> | undefined;

// Hands `use` a getter that parses each file once, on first use; every tree is freed once `use`
// has finished (pipeline/python/syntax.ts, which also owns the shared runtime).
export async function withGoTrees<T>(
  files: GoFile[],
  use: (tree: (path: string) => Tree | undefined) => T | Promise<T>,
): Promise<T> {
  return withTrees((parser ??= loadParser(GRAMMAR)), files, use);
}

export type { Node, Tree };

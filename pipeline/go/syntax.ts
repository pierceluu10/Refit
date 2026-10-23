import type { Node, Tree } from 'web-tree-sitter';
import {
  GRAMMARS,
  readSources,
  withTrees,
  type SourceFile,
  type TracerLimits,
  type TracerStop,
} from '../tree-sitter.ts';

// tree-sitter-go@0.25.0, pinned with its provenance in pipeline/tree-sitter.ts (GRAMMARS).
export const GRAMMAR = GRAMMARS.go.wasm;
export const GRAMMAR_SHA256 = GRAMMARS.go.wasmSha256;

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

export type GoFile = SourceFile;

// Go sources under a repository, in path order. Symbolic links, build output, `vendor` and
// `testdata` directories are skipped. A file over the per-file limit is a named stop in `stops`
// (it throws without one); past the file-count or total-size limit it throws, as readRepository
// does.
export async function readGoFiles(
  root: string,
  stops?: TracerStop[],
  limits?: TracerLimits,
): Promise<GoFile[]> {
  return readSources(root, {
    language: 'go',
    extension: '.go',
    excluded: EXCLUDED_DIRECTORIES,
    stops,
    limits,
  });
}

// Hands `use` a getter that parses each file once, within the limits (pipeline/tree-sitter.ts).
export async function withGoTrees<T>(
  files: GoFile[],
  use: (tree: (path: string) => Tree | undefined) => T | Promise<T>,
  stops?: TracerStop[],
): Promise<T> {
  return withTrees('go', files, use, { stops });
}

export type { Node, Tree };

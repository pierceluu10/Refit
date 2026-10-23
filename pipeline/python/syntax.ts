import type { Node, Tree } from 'web-tree-sitter';
import {
  GRAMMARS,
  readSources,
  withTrees,
  type SourceFile,
  type TracerLimits,
  type TracerStop,
} from '../tree-sitter.ts';

// tree-sitter-python@0.25.0, pinned with its provenance in pipeline/tree-sitter.ts (GRAMMARS).
export const GRAMMAR = GRAMMARS.python.wasm;
export const GRAMMAR_SHA256 = GRAMMARS.python.wasmSha256;

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
  '__pycache__',
  'site-packages',
  'venv',
  '.venv',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.eggs',
]);

export type PythonFile = SourceFile;

// Python sources under a repository, in path order. Symbolic links, virtual environments and build
// output are skipped. A file over the per-file limit is a named stop in `stops` (it throws without
// one); past the file-count or total-size limit it throws, as readRepository does.
export async function readPythonFiles(
  root: string,
  stops?: TracerStop[],
  limits?: TracerLimits,
): Promise<PythonFile[]> {
  return readSources(root, {
    language: 'python',
    extension: '.py',
    excluded: EXCLUDED_DIRECTORIES,
    stops,
    limits,
  });
}

// Hands `use` a getter that parses each file once, within the limits (pipeline/tree-sitter.ts).
export async function withPythonTrees<T>(
  files: PythonFile[],
  use: (tree: (path: string) => Tree | undefined) => T | Promise<T>,
  stops?: TracerStop[],
): Promise<T> {
  return withTrees('python', files, use, { stops });
}

export type { Node, Tree };

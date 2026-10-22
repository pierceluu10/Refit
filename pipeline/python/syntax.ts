import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

// tree-sitter-python@0.25.0's published tree-sitter-python.wasm, copied as is: the package itself
// runs a native build on install (docs/ARCHITECTURE.md, "Other languages").
export const GRAMMAR = fileURLToPath(new URL('./tree-sitter-python.wasm', import.meta.url));
export const GRAMMAR_SHA256 = '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47';

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
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface PythonFile {
  path: string;
  content: string;
}

// Python sources under a repository, in path order. Symbolic links, virtual environments and build
// output are skipped. shortcut: files past the 2 MiB, 10,000-file and 50 MiB limits are left out
// silently rather than failing the TypeScript scan they run beside; report them if a set hits it.
export async function readPythonFiles(root: string): Promise<PythonFile[]> {
  const files: PythonFile[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      if (!entry.isFile() || !entry.name.endsWith('.py') || files.length >= MAX_FILES) continue;
      const size = (await stat(path)).size;
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      total += size;
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

async function load() {
  await Parser.init();
  const result = new Parser();
  result.setLanguage(await Language.load(GRAMMAR));
  return result;
}

// Hands `use` a getter that parses each file once, on first use; every tree is freed afterwards,
// since tree-sitter trees live in WebAssembly memory.
export async function withPythonTrees<T>(
  files: PythonFile[],
  use: (tree: (path: string) => Tree | undefined) => T,
): Promise<T> {
  parser ??= load();
  const instance = await parser;
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const trees = new Map<string, Tree | undefined>();
  try {
    return use((path) => {
      if (!trees.has(path)) {
        const content = contents.get(path);
        trees.set(path, content === undefined ? undefined : (instance.parse(content) ?? undefined));
      }
      return trees.get(path);
    });
  } finally {
    for (const tree of trees.values()) tree?.delete();
  }
}

export type { Node, Tree };

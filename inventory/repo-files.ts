// Read-only, repo-confined file access. Every path the agent passes goes through resolveInside,
// so no tool can read outside repoDir, follow a symlink out of it, or write anything.
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class OutsideRepoError extends Error {
  constructor(requested: string) {
    super(`Path is outside the repository: ${requested}`);
    this.name = 'OutsideRepoError';
  }
}

// Directories a new engineer skips when reading a codebase: installed or generated code.
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.idea',
]);
const MAX_TEXT_FILE_BYTES = 1_000_000;
const BINARY_SNIFF_BYTES = 8000;

export async function resolveInside(repoDir: string, relative: string): Promise<string> {
  const root = await realpath(repoDir);
  const candidate = path.resolve(root, relative.replace(/^\/+/, ''));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new OutsideRepoError(relative);
  }
  const real = await realpath(candidate);
  if (real !== root && !real.startsWith(root + path.sep)) throw new OutsideRepoError(relative);
  return real;
}

export function toRepoPath(repoDir: string, absolute: string): string {
  return path.relative(repoDir, absolute).split(path.sep).join('/');
}

// Yields repo-relative paths of regular files, skipping symlinks and installed or generated code.
export async function* walkFiles(repoDir: string, start = '.'): AsyncGenerator<string> {
  const root = await realpath(repoDir);
  const pending = [await resolveInside(root, start)];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolute);
      } else if (entry.isFile()) {
        yield toRepoPath(root, absolute);
      }
    }
  }
}

export async function listFiles(repoDir: string, start = '.'): Promise<string[]> {
  const files: string[] = [];
  for await (const file of walkFiles(repoDir, start)) files.push(file);
  return files.sort();
}

// Returns the file's text, or undefined for binary, oversized or symlinked files.
export async function readText(repoDir: string, relative: string): Promise<string | undefined> {
  const absolute = await resolveInside(repoDir, relative);
  const info = await lstat(absolute);
  if (!info.isFile() || info.size > MAX_TEXT_FILE_BYTES) return undefined;
  const buffer = await readFile(absolute);
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return buffer.toString('utf8');
}

export async function fileSize(repoDir: string, relative: string): Promise<number> {
  return (await stat(await resolveInside(repoDir, relative))).size;
}

export type LineMatch = { file: string; line: number; text: string };

const MAX_MATCH_TEXT = 240;

// Line-by-line regex search over text files. `files` limits the search; default is the whole repo.
export async function grepLines(
  repoDir: string,
  pattern: RegExp,
  options: { files?: string[]; maxResults?: number } = {},
): Promise<{ matches: LineMatch[]; truncated: boolean }> {
  const maxResults = options.maxResults ?? 200;
  const files = options.files ?? (await listFiles(repoDir));
  const matches: LineMatch[] = [];
  for (const file of files) {
    const text = await readText(repoDir, file);
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      pattern.lastIndex = 0;
      if (!pattern.test(lines[index])) continue;
      if (matches.length >= maxResults) return { matches, truncated: true };
      matches.push({ file, line: index + 1, text: lines[index].trim().slice(0, MAX_MATCH_TEXT) });
    }
  }
  return { matches, truncated: false };
}

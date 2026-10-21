// Pure selection helpers for the AI application benchmark (scripts/ai-app-select.mjs), kept in a
// module of their own so pipeline/ai-app-helpers.test.ts can test them. shallowCheckout is the only
// function with side effects. Repository names, SHAs and paths from GitHub are untrusted: every one
// is validated here before it reaches git, gh or the filesystem.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Source: pipeline/repository.ts (MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES). A test keeps them equal.
export const SCAN_LIMITS = {
  files: 10_000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
};
// Source: pipeline/repository.ts (EXCLUDED_DIRECTORIES, SOURCE_EXTENSION, DECLARATION_EXTENSION).
export const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.refit',
]);
export const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/;
// Source: pipeline/lockfiles.ts, pipeline/pnpm-lock.ts, pipeline/yarn-lock.ts (DEPENDENCY_LOCKFILES).
const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

// Source: D-02 in .planning/phases/03-application-benchmark-sets/03-CONTEXT.md.
export const EXCLUDED_NAME =
  /sdk|wrapper|client|langchain|llamaindex|provider|plugin|adapter|framework|boilerplate-generator/i;

// GitHub `size:a..b` ranges are inclusive, so adjacent buckets must not share an endpoint (D-19).
// Source: GitHub code search trials in 03-RESEARCH.md, 2026-10-21.
export const SIZE_BUCKETS = {
  openai: ['<600', '600..899', '900..1299', '1300..1799', '1800..2499', '2500..3999', '>=4000'],
  anthropic: ['<1500', '1500..2999', '>=3000'],
};

export function validRepoName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return false;
  return name.split('/').every((part) => part !== '.' && part !== '..');
}

export function validSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
}

export function validWorkspaceManifest(path) {
  const match = /^(?:apps|packages)\/([A-Za-z0-9_.@-]+)\/package\.json$/.exec(path ?? '');
  return Boolean(match) && match[1] !== '.' && match[1] !== '..';
}

export function declaresSdk(manifest, sdk) {
  const dependencies = manifest?.dependencies;
  return Boolean(
    dependencies && typeof dependencies === 'object' && Object.hasOwn(dependencies, sdk),
  );
}

// Returns why the manifest counts as an application, or null for a library (D-02).
// `paths` is the tree listing; `directory` is '' for the root or e.g. 'apps/web'.
export function appShape(manifest, paths = [], directory = '') {
  if (manifest?.private === true) return 'private';
  if (!['main', 'exports', 'bin', 'files'].some((field) => manifest && field in manifest))
    return 'no-publish-fields';
  const prefix = directory ? `${directory}/` : '';
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (/^(?:next|vite)\.config\.[^/]+$/.test(rest) || rest === 'wrangler.toml')
      return `marker:${rest}`;
    const route = /^((?:src\/)?(?:app|pages))\//.exec(rest);
    if (route) return `marker:${route[1]}/`;
  }
  const dependencies = manifest?.dependencies ?? {};
  for (const server of ['express', 'fastify', 'hono', 'koa'])
    if (Object.hasOwn(dependencies, server)) return `server:${server}`;
  return null;
}

// The regex is tested on the name part and the topics only, never on the owner.
export function excludedName(fullName, topics = []) {
  return [fullName.split('/')[1] ?? '', ...topics].some((text) => EXCLUDED_NAME.test(text));
}

// Mirrors which files readRepository counts: JS/TS sources (not declarations), package.json files
// and root lockfiles, outside the excluded directories. Returns null when the tree passes, or a reason.
export function scanLimitsFromTree(listing) {
  if (listing?.truncated) return 'tree listing truncated';
  let files = 0;
  let total = 0;
  for (const entry of listing?.tree ?? []) {
    if (entry.type !== 'blob') continue;
    const parts = entry.path.split('/');
    const name = parts[parts.length - 1];
    if (parts.slice(0, -1).some((part) => EXCLUDED_DIRECTORIES.has(part))) continue;
    const counted =
      (parts.length === 1 && LOCKFILES.includes(name)) ||
      name === 'package.json' ||
      (SOURCE_EXTENSION.test(name) && !DECLARATION_EXTENSION.test(name));
    if (!counted) continue;
    files += 1;
    total += entry.size ?? 0;
    if ((entry.size ?? 0) > SCAN_LIMITS.fileBytes) return `${entry.path} over 2 MiB`;
    if (files > SCAN_LIMITS.files) return 'more than 10,000 files';
    if (total > SCAN_LIMITS.totalBytes) return 'more than 50 MiB';
  }
  return null;
}

const SDK_IMPORT = {
  openai: /(?:from\s*|require\(\s*)['"]openai['"]/,
  anthropic: /(?:from\s*|require\(\s*)['"]@anthropic-ai\/sdk['"]/,
};
const MODEL_CALL = {
  openai:
    /\.(?:beta\.)?(?:chat\.completions|responses|messages|images|audio(?:\.\w+)?|embeddings)\.\w+\(/,
  anthropic: /\.(?:beta\.)?messages\.\w+\(/,
};
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\./;

// A non-test file that imports the SDK and makes a model call (D-02).
export function detectModelCall(path, text, provider) {
  if (TEST_PATH.test(path)) return false;
  return SDK_IMPORT[provider].test(text) && MODEL_CALL[provider].test(text);
}

// Stars descending, then full name ascending. Plain comparison: localeCompare varies with ICU.
export function compareCandidates(a, b) {
  return b.stars - a.stars || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
}

// Every owner/name in a frozen list, lower-cased. Lists are an array or an object with `repos`.
export function frozenListNames(json) {
  const entries = Array.isArray(json) ? json : (json?.repos ?? []);
  const names = new Set();
  for (const entry of entries)
    for (const field of ['repo', 'repository', 'fullName', 'name'])
      if (validRepoName(entry?.[field])) names.add(entry[field].toLowerCase());
  return [...names];
}

export function checkoutDirectory(root, repo) {
  return join(resolve(root), repo.replace('/', '__'));
}

// Shallow fetch of one commit into <root>/<owner>__<name>; nothing in it is installed or run.
export async function shallowCheckout(root, repo, sha) {
  if (!validRepoName(repo)) throw new Error('Invalid repository name.');
  if (!validSha(sha)) throw new Error('Invalid commit SHA.');
  const directory = checkoutDirectory(root, repo);
  if (existsSync(join(directory, '.git'))) return directory;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  await mkdir(resolve(root), { recursive: true });
  try {
    await execute('git', ['init', '-q', directory]);
    await execute(
      'git',
      ['-C', directory, 'fetch', '-q', '--depth', '1', `https://github.com/${repo}`, sha],
      { timeout: 300_000, env },
    );
    await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD'], { env });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

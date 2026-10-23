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

// Repository names that mark SDKs, wrappers and frameworks rather than applications.
export const EXCLUDED_NAME =
  /sdk|wrapper|client|langchain|llamaindex|provider|plugin|adapter|framework|boilerplate-generator/i;

// Copies of leaked proprietary Claude Code source, removed from the Anthropic app list on
// 2026-10-22 (its `removed` field). Lower-cased, as the candidate pool is.
export const LEAKED_SOURCE = new Set([
  'andforce/openclaude',
  'chenqinggang001/claude-code-build',
  'ddogezd/claudium',
  'doriandarko/kimi-2-6-code',
  'fazxes/claude-code',
  'jrcx7scc/claude-code-source',
  'kill136/claudecode',
  'openaisec/miko',
  'tagoat/claude_code_cli',
  'txl16095/miniclaude',
  'wk42worldworld/cybercode',
  'wyh0626/claude-code-local',
]);

// GitHub `size:a..b` ranges are inclusive, so adjacent buckets must not share an endpoint.
// Bucket edges come from GitHub code search trials on 2026-10-21.
export const SIZE_BUCKETS = {
  openai: ['<600', '600..899', '900..1299', '1300..1799', '1800..2499', '2500..3999', '>=4000'],
  anthropic: ['<1500', '1500..2999', '>=3000'],
  // AI wrapper SDKs (2026-10-22), with the Anthropic set's edges.
  'ai-sdk-openai': ['<1500', '1500..2999', '>=3000'],
  'ai-sdk-anthropic': ['<1500', '1500..2999', '>=3000'],
  'langchain-openai': ['<1500', '1500..2999', '>=3000'],
  'langchain-anthropic': ['<1500', '1500..2999', '>=3000'],
  llamaindex: ['<1500', '1500..2999', '>=3000'],
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

// Returns why the manifest counts as an application, or null for a library.
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
  'ai-sdk-openai': /(?:from\s*|require\(\s*)['"]@ai-sdk\/openai['"]/,
  'ai-sdk-anthropic': /(?:from\s*|require\(\s*)['"]@ai-sdk\/anthropic['"]/,
  'langchain-openai': /(?:from\s*|require\(\s*)['"]@langchain\/openai['"]/,
  'langchain-anthropic': /(?:from\s*|require\(\s*)['"]@langchain\/anthropic['"]/,
  llamaindex: /(?:from\s*|require\(\s*)['"](?:llamaindex|@llamaindex\/(?:openai|anthropic))['"]/,
};
// A wrapper call that names a model: `openai('gpt-4o')`, `anthropic.messages('claude-…')`,
// `new ChatOpenAI({ … })`, LlamaIndex's `new OpenAI({ … })` or `openai({ … })`.
const MODEL_CALL = {
  openai:
    /\.(?:beta\.)?(?:chat\.completions|responses|messages|images|audio(?:\.\w+)?|embeddings)\.\w+\(/,
  anthropic: /\.(?:beta\.)?messages\.\w+\(/,
  'ai-sdk-openai': /\b\w*openai(?:\.(?:chat|responses|completion|languageModel))?\(\s*['"`\w]/i,
  'ai-sdk-anthropic': /\b\w*anthropic(?:\.(?:messages|chat|languageModel))?\(\s*['"`\w]/i,
  'langchain-openai': /\bnew\s+(?:Chat|Azure)?OpenAI\s*\(/,
  'langchain-anthropic': /\bnew\s+ChatAnthropic\s*\(/,
  llamaindex: /\bnew\s+(?:OpenAI|Anthropic)\s*\(|\b(?:openai|anthropic)\(\s*\{/,
};
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\./;

// A non-test file that imports the SDK and makes a model call.
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

// 'retry' only for rate limits and server errors; 'skip' for a repository that is gone, empty or
// legally blocked; everything else, including a permanent 403, is 'fatal' with no waiting.
export function classifyGhError(stderr) {
  if (/rate limit|secondary|abuse|\b(429|502|503|504)\b/i.test(stderr)) return 'retry';
  if (/\b(404|409|451)\b/.test(stderr)) return 'skip';
  return 'fatal';
}

export function checkoutDirectory(root, repo) {
  return join(resolve(root), repo.replace('/', '__'));
}

// Shallow fetch of one commit into <root>/<owner>__<name>; nothing in it is installed or run.
export async function shallowCheckout(root, repo, sha) {
  if (!validRepoName(repo)) throw new Error('Invalid repository name.');
  if (!validSha(sha)) throw new Error('Invalid commit SHA.');
  const directory = checkoutDirectory(root, repo);
  if (existsSync(join(directory, '.git'))) {
    const head = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    if (head === sha) return directory;
    await rm(directory, { recursive: true, force: true });
  }
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

// Label pass (scripts/ai-app-label-candidates.mjs, scripts/ai-app-labels.mjs). An independent text
// search for quoted exact registry model IDs; nothing here imports Refit's scanner or tracer.
export const CANDIDATE_LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
export const VIA = ['sdk-text', 'sdk-non-text', 'raw-http', 'other'];
export const REASONS = [
  'catalog',
  'test',
  'comment',
  'comparison',
  'doc',
  'prompt-text',
  'unused',
  'other-endpoint',
  'other',
];
export const LABEL_KEYS = [
  'repo',
  'provider',
  'file',
  'line',
  'column',
  'model',
  'live',
  'via',
  'reason',
  'replacement',
  'notes',
];
export const COMMITTED_KEYS = [
  'file',
  'line',
  'column',
  'model',
  'deadline',
  'language',
  'generated',
  'live',
  'via',
  'reason',
  'replacement',
  'notes',
];
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every versions[] ID of the provider's model entries, longest first, inside matching quotes.
export function modelPattern(registry, provider) {
  const byId = new Map();
  for (const entry of registry.deadlines)
    if (entry.kind === 'model' && entry.provider === provider)
      for (const id of entry.versions) byId.set(id, { deadline: entry.id });
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return { regex: new RegExp(`(["'\`])(${ids.map(escapeRegex).join('|')})\\1`, 'g'), byId };
}

// 1-based line and column of the model ID itself (not the opening quote).
export function findCandidates(text, pattern) {
  const found = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(pattern.regex))
      found.push({ line: index + 1, column: match.index + 2, model: match[2] });
  });
  return found;
}

export function candidateFile(path, bytes) {
  const segments = path.split('/');
  if (segments.some((s) => s === 'node_modules' || s === '.git')) return false;
  if (CANDIDATE_LOCKFILES.has(segments.at(-1))) return false;
  if (bytes.length > MAX_CANDIDATE_BYTES) return false;
  return !bytes.subarray(0, 8000).includes(0);
}

const LANGUAGES = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
};
export const LANGUAGE_RULES = { ...LANGUAGES, '.env*': 'env' };

export function languageOf(path) {
  const name = path.split('/').at(-1);
  if (name.startsWith('.env')) return 'env';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && LANGUAGES[name.slice(dot + 1).toLowerCase()]) || 'other';
}

export function isGenerated(path) {
  const segments = path.split('/');
  return (
    segments.slice(0, -1).some((s) => ['dist', 'build', '.next', 'out'].includes(s)) ||
    segments.at(-1).endsWith('.min.js')
  );
}

// The registry replacement of id, followed while the target is itself a retiring model.
export function followReplacement(registry, id) {
  const entryFor = (model) =>
    registry.deadlines.find((e) => e.kind === 'model' && e.versions.includes(model));
  const visited = new Set([id]);
  let entry = entryFor(id);
  if (!entry) throw new Error(`${id} is not a registry model.`);
  let target = entry.replacement;
  while ((entry = entryFor(target))) {
    if (visited.has(target)) throw new Error(`Replacement cycle at ${target}.`);
    visited.add(target);
    target = entry.replacement;
  }
  return target;
}

// Whole (repo, provider) groups in order, at most max candidates a batch; an oversized group is alone.
export function packBatches(groups, max) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const group of groups) {
    if (current.length && size + group.length > max) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(...group);
    size += group.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

const CODE_FRAGMENT = /[`{}<>]|=>|==|\$\{|\w\(|\w\.\w+\(/;
const LEAK_WINDOW = 20;

// A note must be plain prose: no code-like fragment and no 20+ character run copied from the
// matched line or its neighbours. A context entry is the line itself or { before, line, after }.
export function noteLeaksCode(notes, context) {
  if (CODE_FRAGMENT.test(notes)) return true;
  const entries = typeof context === 'string' ? { line: context } : (context ?? {});
  const lines = [entries.line, ...(entries.before ?? []), ...(entries.after ?? [])]
    .filter((l) => typeof l === 'string')
    .map((l) => l.trim());
  if (typeof entries.line === 'string' && entries.line.trim().length >= 3)
    if (notes.includes(entries.line.trim())) return true;
  return lines.some((l) => {
    for (let i = 0; i + LEAK_WINDOW <= l.length; i++)
      if (notes.includes(l.slice(i, i + LEAK_WINDOW))) return true;
    return false;
  });
}

const labelId = (x) => [x.repo, x.provider, x.file, x.line, x.column, x.model].join('\u0000');

// Errors name the candidate and the kind of problem, never source text.
export function validateLabels(candidates, labels, contextLines = []) {
  const errors = [];
  const wanted = new Map(candidates.map((c, i) => [labelId(c), { c, line: contextLines[i] }]));
  const seen = new Set();
  const allowed = new Set(LABEL_KEYS);
  for (const label of labels) {
    if (label === null || typeof label !== 'object' || Array.isArray(label)) {
      errors.push({ key: 'non-object', kind: 'label-shape' });
      continue;
    }
    const id = labelId(label);
    const where = `${label.file}:${label.line}:${label.column}`;
    const fail = (kind) => errors.push({ key: where, kind });
    const typed =
      typeof label.repo === 'string' &&
      typeof label.provider === 'string' &&
      typeof label.file === 'string' &&
      typeof label.model === 'string' &&
      Number.isInteger(label.line) &&
      Number.isInteger(label.column);
    if (!typed) {
      fail('identity-type');
      continue;
    }
    if (!wanted.has(id)) {
      fail('extra');
      continue;
    }
    if (seen.has(id)) fail('duplicate');
    seen.add(id);
    const { c, line } = wanted.get(id);
    for (const key of Object.keys(label)) if (!allowed.has(key)) fail(`unknown-key:${key}`);
    if (typeof label.live !== 'boolean') fail('live');
    else if (label.live) {
      const via = label.via;
      const wrapper = typeof via === 'string' && via.startsWith('wrapper:');
      if (!(VIA.includes(via) || (wrapper && NPM_PACKAGE.test(via.slice(8))))) fail('via');
      if ('reason' in label) fail('reason-present');
    } else {
      if (label.via !== null) fail('via-not-null');
      if (!REASONS.includes(label.reason)) fail('reason');
    }
    if (label.replacement !== c.replacement) fail('replacement');
    const notes = label.notes;
    if (typeof notes !== 'string' || !notes.trim() || /[\r\n]/.test(notes) || notes.length > 160)
      fail('notes');
    else if (noteLeaksCode(notes, line)) fail('notes-source-text');
  }
  for (const id of wanted.keys())
    if (!seen.has(id))
      errors.push({ key: id.split('\u0000').slice(2, 5).join(':'), kind: 'missing' });
  return errors;
}

// Deterministic sample of ceil(fraction x n) keys: sort, then mulberry32-driven Fisher-Yates.
export function seededSample(keys, seed, fraction) {
  const pool = [...keys].sort();
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.ceil(fraction * pool.length));
}

// Agreement of the second labels with the first on live and via, over the second's keys.
export function agreement(first, second) {
  const firstById = new Map(first.map((l) => [labelId(l), l]));
  const out = { live: { agree: 0, total: 0 }, via: { agree: 0, total: 0 }, disagreements: [] };
  for (const l of second) {
    const f = firstById.get(labelId(l));
    out.live.total++;
    out.via.total++;
    if (f.live === l.live) out.live.agree++;
    if (f.via === l.via) out.via.agree++;
    if (f.live !== l.live || f.via !== l.via)
      out.disagreements.push([l.repo, l.provider, l.file, l.line, l.column, l.model].join('|'));
  }
  return out;
}

// Independent candidate search for the application label pass: every quoted exact registry model ID
// in every text file of each frozen checkout. It imports no pipeline code and uses no Refit output.
// Writes candidates.json (no code text) and batch-NN.json work files (with context) outside the
// repository. Files are only read; nothing in a checkout is installed or run.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import {
  LANGUAGE_RULES,
  CANDIDATE_LOCKFILES,
  MAX_CANDIDATE_BYTES,
  candidateFile,
  checkoutDirectory,
  findCandidates,
  followReplacement,
  isGenerated,
  languageOf,
  modelPattern,
  packBatches,
  shallowCheckout,
  validRepoName,
  validSha,
} from './ai-app-helpers.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    list: { type: 'string', multiple: true },
    root: { type: 'string' },
    registry: { type: 'string', default: 'data/deadlines.json' },
    output: { type: 'string' },
    batches: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.list?.length || !values.root || !values.output || !values.batches) {
  console.log(
    'Usage: node scripts/ai-app-label-candidates.mjs --list <frozen.json> [--list ...] --root <checkouts> --output <candidates.json> --batches <dir> [--registry <deadlines.json>]',
  );
  process.exit(values.help ? 0 : 1);
}

const registryText = await readFile(values.registry, 'utf8');
const registry = JSON.parse(registryText);
const MAX_BATCH = 40;
const CONTEXT = 8;
const LINE_CAP = 200;

async function* files(directory, prefix = '') {
  for (const entry of (await readdir(directory)).sort()) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const path = join(directory, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) yield* files(path, `${prefix}${entry}/`);
    else if (info.isFile()) yield [path, `${prefix}${entry}`];
  }
}

const lists = [];
const entries = [];
for (const list of values.list) {
  lists.push(list);
  const json = JSON.parse(await readFile(list, 'utf8'));
  for (const entry of json.repos)
    entries.push({ provider: entry.provider ?? json.provider, ...entry });
}

const repos = [];
for (const entry of entries) {
  if (!validRepoName(entry.repo) || !validSha(entry.commit))
    throw new Error(`Invalid repository or commit in a frozen list: ${entry.repo}`);
  const directory = existsSync(join(checkoutDirectory(values.root, entry.repo), '.git'))
    ? checkoutDirectory(values.root, entry.repo)
    : await shallowCheckout(values.root, entry.repo, entry.commit);
  const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
  if (stdout.trim() !== entry.commit)
    throw new Error(`${entry.repo} is at ${stdout.trim()}, not the frozen ${entry.commit}.`);
  const pattern = modelPattern(registry, entry.provider);
  const candidates = [];
  for await (const [path, relative] of files(directory)) {
    const bytes = await readFile(path);
    if (!candidateFile(relative, bytes)) continue;
    for (const found of findCandidates(bytes.toString('utf8'), pattern)) {
      candidates.push({
        repo: entry.repo,
        provider: entry.provider,
        file: relative,
        line: found.line,
        column: found.column,
        model: found.model,
        deadline: pattern.byId.get(found.model).deadline,
        replacement: followReplacement(registry, found.model),
        language: languageOf(relative),
        generated: isGenerated(relative),
      });
    }
  }
  const order = (a, b) =>
    a.file < b.file
      ? -1
      : a.file > b.file
        ? 1
        : a.line - b.line ||
          a.column - b.column ||
          (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
  candidates.sort(order);
  repos.push({
    repo: entry.repo,
    provider: entry.provider,
    commit: entry.commit,
    directory,
    candidates,
  });
}
repos.sort((a, b) =>
  a.repo === b.repo ? (a.provider < b.provider ? -1 : 1) : a.repo < b.repo ? -1 : 1,
);

const candidatesFile = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  lists,
  registry: {
    path: values.registry,
    sha256: createHash('sha256').update(registryText).digest('hex'),
    checkedAt: [
      ...new Set(registry.deadlines.filter((d) => d.kind === 'model').map((d) => d.checkedAt)),
    ].sort(),
  },
  method:
    'Independent text search (scripts/ai-app-label-candidates.mjs) for quoted exact registry model IDs, longest ID first, in each checkout at its frozen commit.',
  scope: {
    included:
      'every other file, any extension, including generated output (flagged generated: true)',
    excluded: [
      'node_modules/',
      '.git/',
      'symbolic links',
      ...[...CANDIDATE_LOCKFILES].sort().map((name) => `lockfile ${name}`),
      'binary files (a NUL byte in the first 8,000 bytes)',
      `files over ${MAX_CANDIDATE_BYTES} bytes (2 MiB)`,
    ],
    languages: LANGUAGE_RULES,
    generated: ['a dist/, build/, .next/ or out/ path segment', 'a file name ending .min.js'],
  },
  repos: repos.map(({ directory, ...rest }) => rest),
};
await mkdir(resolve(values.batches), { recursive: true });
await mkdir(resolve(values.output, '..'), { recursive: true });
await writeFile(values.output, `${JSON.stringify(candidatesFile, null, 2)}\n`);

// Context lines are read back from the checkout; they go into work files only.
const groups = [];
for (const repo of repos) if (repo.candidates.length) groups.push({ repo, list: repo.candidates });
const batches = packBatches(
  groups.map((g) => g.list),
  MAX_BATCH,
);
const directoryOf = new Map(repos.map((r) => [r.repo, r.directory]));
const cache = new Map();
const cap = (line) => line.slice(0, LINE_CAP);
for (const [index, batch] of batches.entries()) {
  const out = [];
  for (const candidate of batch) {
    const path = join(directoryOf.get(candidate.repo), candidate.file);
    if (!cache.has(path)) cache.set(path, (await readFile(path, 'utf8')).split(/\r?\n/));
    const lines = cache.get(path);
    out.push({
      ...candidate,
      context: {
        before: lines.slice(Math.max(0, candidate.line - 1 - CONTEXT), candidate.line - 1).map(cap),
        line: cap(lines[candidate.line - 1]),
        after: lines.slice(candidate.line, candidate.line + CONTEXT).map(cap),
      },
    });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  const nn = String(index + 1).padStart(2, '0');
  await writeFile(
    join(values.batches, `batch-${nn}.json`),
    `${JSON.stringify({ formatVersion: 1, batch: nn, candidates: out }, null, 2)}\n`,
  );
}

const total = repos.reduce((sum, r) => sum + r.candidates.length, 0);
const tally = (key) => {
  const counts = {};
  for (const r of repos) for (const c of r.candidates) counts[c[key]] = (counts[c[key]] ?? 0) + 1;
  return counts;
};
console.log(
  JSON.stringify({
    repositories: repos.length,
    withCandidates: groups.length,
    candidates: total,
    batches: batches.length,
    byLanguage: tally('language'),
    generated: tally('generated'),
  }),
);

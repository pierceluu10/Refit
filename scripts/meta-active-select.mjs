// Freezes the Meta Graph benchmark sets (docs/SHOPIFY-META-ENGINES.md, Benchmarks): active
// repositories that call the Graph API, pre-scanned with Refit's existing Meta scan and kept only
// when affected, then split into a dev set and a blind set with no overlap.
// Usage: GITHUB_TOKEN=… node scripts/meta-active-select.mjs --work <dir>
//          --dev <dev.json> --blind <blind.json> [--frozen-at YYYY-MM-DD] [--dev-size 60]
//          [--blind-size 100] [--limit 2000] [--seed <text>]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset. Each phase caches its
// result in --work (pre-scan results per repository), so an interrupted selection resumes. Cloned
// code is only read by `refit meta-graph`, never installed or run, and deleted after the scan.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkoutDirectory, shallowCheckout } from './ai-app-helpers.mjs';
import { activeSince, ACTIVE_DAYS, SIZE_RANGES } from './stripe-active-select.mjs';

const execute = promisify(execFile);
const METADATA_CONCURRENCY = 2;
const MAX_DISK_KB = 50 * 1024;
const MIN_AUTHORS = 2;
// A version retiring within this many days of frozenAt counts as soon-retiring.
export const SOON_DAYS = 365;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];
const BOT = /\[bot\]|^(dependabot|renovate|github-actions|actions-user|vercel|netlify)/i;
const REFIT = fileURLToPath(new URL('..', import.meta.url));
// Each query names the signal it looks for, recorded on every repository it found.
const QUERIES = [
  ['versioned-url', '"graph.facebook.com/v" language:TypeScript'],
  ['versioned-url', '"graph.facebook.com/v" language:JavaScript'],
  ['business-sdk', '"facebook-nodejs-business-sdk" language:TypeScript'],
  ['business-sdk', '"facebook-nodejs-business-sdk" language:JavaScript'],
  ['fb-init', '"FB.init" version language:TypeScript'],
  ['fb-init', '"FB.init" version language:JavaScript'],
  ['instagram', '"graph.instagram.com" language:TypeScript'],
  ['instagram', '"graph.instagram.com" language:JavaScript'],
  ['whatsapp-cloud', '"graph.facebook.com" messaging_product messages language:TypeScript'],
  ['whatsapp-cloud', '"graph.facebook.com" messaging_product messages language:JavaScript'],
];
// Text-level signals the Graph scan does not read (it follows graph.facebook.com requests only).
const FB_INIT_VERSION = /FB\.init\(\s*\{[\s\S]{0,600}?version\s*:\s*['"`](v\d+\.\d+)['"`]/g;
const BASIC_DISPLAY_SCOPE = /['"`,\s](?:user_profile|user_media)['"`,\s]/;
const SOURCE = /\.(?:[cm]?[jt]sx?|html)$/;
// The deadline scanner's test path, as scripts/meta-platform-select.mjs copies it.
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'out']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHANGE_STOP = /^(.+?:\d+): (v\d+\.\d+) ([a-z-]+) ([a-z0-9-]+): /;

// Each query runs whole; only one with more than 1,000 results, code search's cap, is run again
// once per file-size range (bytes) to reach past it.
export function searchQueries() {
  return QUERIES.map(([signal, query]) => ({ signal, query }));
}

export function splitQuery(query) {
  return SIZE_RANGES.map((size) => `${query} size:${size}`);
}

// Every repository named in any JSON file under `directory` (lower-cased): the `repo` or
// `repository` value of every object, at any depth, that looks like owner/name. Files in `skip`
// (this selection's own outputs, so a rerun reproduces them) are not read.
export async function benchmarkRepositories(directory, skip = []) {
  const found = new Map();
  const visit = (value, file) => {
    if (Array.isArray(value)) for (const item of value) visit(item, file);
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (
          (key === 'repo' || key === 'repository') &&
          typeof item === 'string' &&
          /^[\w.-]+\/[\w.-]+$/.test(item) &&
          !found.has(item.toLowerCase())
        )
          found.set(item.toLowerCase(), file);
        else visit(item, file);
      }
  };
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.json') && !skip.includes(resolve(child)))
        visit(JSON.parse(await readFile(child, 'utf8')), child);
    }
  };
  await walk(directory);
  return found;
}

// Major and minor of `v19.0`, for ordering.
function versionKey(version) {
  const [major, minor] = version.slice(1).split('.').map(Number);
  return major * 1000 + minor;
}

// When each Graph API version retires, from the deadline registry's meta-graph entries.
export function retirements(registry) {
  const dates = new Map();
  for (const entry of registry.deadlines)
    if (entry.provider === 'meta-graph' && entry.kind === 'api-version')
      for (const version of entry.versions) dates.set(version, entry.date);
  return dates;
}

// How a version stands on frozenAt: retired, retiring within SOON_DAYS, or supported. A version
// older than every registry entry retired before the registry starts.
export function versionStatus(version, dates, frozenAt) {
  const date = dates.get(version);
  const oldest = Math.min(...[...dates.keys()].map(versionKey));
  if (!date) return versionKey(version) < oldest ? 'retired' : 'supported';
  const days = (Date.parse(date) - Date.parse(frozenAt)) / 86_400_000;
  return days <= 0 ? 'retired' : days <= SOON_DAYS ? 'retiring' : 'supported';
}

// Text signals in one live file: FB.init versions and Instagram Basic Display scopes.
export function textSignals(text) {
  return {
    fbInit: [...text.matchAll(FB_INIT_VERSION)].map((match) => match[1]),
    basicDisplay: /instagram/i.test(text) && BASIC_DISPLAY_SCOPE.test(text),
  };
}

// Why a pre-scanned repository is affected; empty when it is not. `scan` is `refit meta-graph
// --json`, `moves` is `refit meta-graph --propose-version-moves --json`, `text` the text signals.
export function affectedReasons({ scan, moves, text }, dates, frozenAt) {
  const reasons = new Set();
  const live = scan.calls.filter((call) => call.use === 'live');
  const versions = new Set([...live.map((call) => call.version).filter(Boolean), ...text.fbInit]);
  for (const version of versions) {
    const status = versionStatus(version, dates, frozenAt);
    if (status !== 'supported') reasons.add(`${status}-version`);
  }
  const liveFiles = new Set(live.map((call) => call.file));
  for (const stop of moves?.stops ?? [])
    for (const reason of stop.reasons) {
      const match = CHANGE_STOP.exec(reason);
      if (match && liveFiles.has(match[1].replace(/:\d+$/, '')))
        reasons.add(/removed$/.test(match[3]) ? 'removed-request' : 'changed-request');
    }
  if (text.basicDisplay) reasons.add('instagram-basic-display');
  return [...reasons].sort();
}

// A deterministic order no one chooses: SHA-256 of the seed and the repository name.
export function splitSets(repos, seed, blindSize, devSize) {
  const ordered = [...repos].sort((a, b) => {
    const hash = (entry) =>
      createHash('sha256').update(`${seed}:${entry.repo.toLowerCase()}`).digest('hex');
    return hash(a).localeCompare(hash(b));
  });
  return {
    blind: ordered.slice(0, blindSize),
    dev: ordered.slice(blindSize, blindSize + devSize),
  };
}

async function liveFiles(directory) {
  const files = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (SOURCE.test(entry.name) && !TEST_PATH.test(relative(directory, child)))
        files.push(child);
    }
  };
  await walk(directory);
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      dev: { type: 'string' },
      blind: { type: 'string' },
      limit: { type: 'string', default: '2000' },
      'dev-size': { type: 'string', default: '60' },
      'blind-size': { type: 'string', default: '100' },
      'frozen-at': { type: 'string', default: new Date().toISOString().slice(0, 10) },
      seed: { type: 'string', default: 'meta-sets' },
      benchmarks: { type: 'string', default: 'docs/benchmarks' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work || !values.dev || !values.blind) {
    console.log(
      'Usage: node scripts/meta-active-select.mjs --work <dir> --dev <dev.json> --blind <blind.json> [--frozen-at YYYY-MM-DD] [--dev-size 60] [--blind-size 100] [--limit 2000] [--seed <text>]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const frozenAt = values['frozen-at'];
  const since = activeSince(frozenAt);
  const work = resolve(values.work);
  await mkdir(join(work, 'prescan'), { recursive: true });
  const excluded = await benchmarkRepositories(values.benchmarks, [
    resolve(values.dev),
    resolve(values.blind),
  ]);
  const registry = JSON.parse(await readFile(join(REFIT, 'data', 'deadlines.json'), 'utf8'));
  const dates = retirements(registry);
  const changes = JSON.parse(
    await readFile(join(REFIT, 'data', 'meta-graph-changes.json'), 'utf8'),
  );
  // The newest reviewed version in the change list that has not retired.
  const target = changes.versions
    .filter((entry) => entry.status === 'reviewed')
    .map((entry) => entry.version)
    .filter((version) => versionStatus(version, dates, frozenAt) !== 'retired')
    .sort((a, b) => versionKey(b) - versionKey(a))[0];

  const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));

  async function github(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      let retry = 0;
      let failure = '';
      try {
        const response = await fetch(`https://api.github.com${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            ...init.headers,
          },
        });
        const text = await response.text();
        if (response.ok) {
          try {
            return JSON.parse(text);
          } catch {
            // A truncated body: retry shortly.
            retry = 10;
            failure = `truncated ${text.length}-byte body`;
          }
        } else if ([403, 429].includes(response.status)) {
          // Secondary rate limits answer 403 or 429.
          // Other selections share the token's code-search quota, so waits stay short.
          retry = Math.min(Number(response.headers.get('retry-after')) || 60, 120) + 1;
          failure = `GitHub ${response.status}`;
        } else if (response.status >= 500) {
          retry = 15;
          failure = `GitHub ${response.status}`;
        } else throw new Error(`GitHub ${path} returned ${response.status}: ${text}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('GitHub ')) throw error;
        // A dropped connection.
        retry = 15;
        failure = String(error);
      }
      if (attempt >= 200) throw new Error(`GitHub ${path}: ${failure} after ${attempt + 1} tries`);
      console.error(`${failure}; retrying in ${retry}s`);
      await pause(retry * 1000);
    }
  }

  async function cached(name, compute) {
    const path = join(work, name);
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
    const value = await compute();
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  // 1. Code search: up to 1,000 results per query, 10 requests a minute. Each query's pages are
  // cached on their own, so an interrupted search resumes at the next query.
  const queries = [];
  await mkdir(join(work, 'search'), { recursive: true });
  const foundBy = {};
  const pages = async (query, repositories) => {
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const result = await github(
        `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
      );
      total = result.total_count;
      for (const item of result.items) repositories.add(item.repository.full_name);
      console.error(`${query} page ${page}: ${repositories.size} repositories`);
      await pause(6500);
      if (result.items.length < 100) break;
    }
    return total;
  };
  for (const [index, { signal, query }] of searchQueries().entries()) {
    const result = await cached(`search/${index}.json`, async () => {
      const repositories = new Set();
      const ran = [query];
      if ((await pages(query, repositories)) > 1000)
        for (const split of splitQuery(query)) {
          ran.push(split);
          await pages(split, repositories);
        }
      return { queries: ran, repositories: [...repositories].sort() };
    });
    queries.push(...result.queries);
    for (const repo of result.repositories) (foundBy[repo] ??= new Set()).add(signal);
  }
  const found = Object.keys(foundBy).sort();
  const excludedByList = {};
  const candidates = found.filter((repo) => {
    const list = excluded.get(repo.toLowerCase());
    if (list) excludedByList[list] = (excludedByList[list] ?? 0) + 1;
    return !list;
  });

  function humanAuthors(commit) {
    return new Set(
      (commit?.history?.nodes ?? [])
        .map((node) => node.author?.user?.login ?? node.author?.email)
        .filter((author) => author && !BOT.test(author)),
    );
  }

  function ineligibility(record) {
    const commit = record?.defaultBranchRef?.target;
    const locks = LOCKFILES.filter((_, index) => record?.[`lock${index}`]);
    return !record
      ? 'unavailable'
      : record.isArchived || record.isFork
        ? 'archived or fork'
        : record.diskUsage >= MAX_DISK_KB
          ? 'over 50 MB'
          : !commit || commit.committedDate < since
            ? `no commit in ${ACTIVE_DAYS} days`
            : humanAuthors(commit).size < MIN_AUTHORS
              ? `fewer than ${MIN_AUTHORS} human authors in ${ACTIVE_DAYS} days`
              : !record.workflows?.entries?.length
                ? 'no GitHub Actions workflow'
                : !record.manifest
                  ? 'no root package.json'
                  : locks.length !== 1
                    ? 'not exactly one root lockfile'
                    : null;
  }

  // 2. Metadata, as scripts/stripe-active-select.mjs reads it: a light pass drops archived
  // repositories, forks, large ones and those not pushed to since the window opened; the rest get
  // recent history and root files.
  const metadata = await cached('metadata.json', async () => {
    const query = async (batch, fields) => {
      const aliases = batch
        .map((repo, index) => {
          const [owner, name] = repo.split('/');
          return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
        })
        .join('\n');
      const result = await github('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: `query { ${aliases} }` }),
      });
      return batch.map((repo, index) => [repo, result.data?.[`r${index}`] ?? null]);
    };
    const readAll = async (repos, size, fields, label) => {
      const records = {};
      const step = size * METADATA_CONCURRENCY;
      for (let start = 0; start < repos.length; start += step) {
        const batches = [];
        for (let offset = start; offset < Math.min(start + step, repos.length); offset += size)
          batches.push(repos.slice(offset, offset + size));
        for (const entries of await Promise.all(batches.map((batch) => query(batch, fields))))
          for (const [repo, record] of entries) records[repo] = record;
        console.error(`${label} ${Math.min(start + step, repos.length)}/${repos.length}`);
      }
      return records;
    };
    const light = await readAll(
      candidates,
      100,
      'nameWithOwner isArchived isFork diskUsage pushedAt',
      'light',
    );
    const full = await readAll(
      candidates.filter((repo) => {
        const record = light[repo];
        return (
          record &&
          !record.isArchived &&
          !record.isFork &&
          record.diskUsage < MAX_DISK_KB &&
          record.pushedAt >= since
        );
      }),
      20,
      `nameWithOwner isArchived isFork diskUsage stargazerCount
          owner { __typename }
          defaultBranchRef { target { ... on Commit {
            oid committedDate
            history(since: ${JSON.stringify(since)}, first: 100) {
              totalCount nodes { author { email user { login } } }
            }
          } } }
          workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
          manifest: object(expression: "HEAD:package.json") { oid }
          ${LOCKFILES.map((file, lock) => `lock${lock}: object(expression: "HEAD:${file}") { oid }`).join('\n')}`,
      'full',
    );
    return Object.fromEntries(candidates.map((repo) => [repo, full[repo] ?? light[repo]]));
  });

  const reasons = {};
  const eligible = [];
  for (const repo of candidates) {
    const record = metadata[repo];
    const reason = ineligibility(record);
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    // A repository renamed into an excluded list's name is still excluded.
    const list = excluded.get(record.nameWithOwner.toLowerCase());
    if (list) {
      excludedByList[list] = (excludedByList[list] ?? 0) + 1;
      continue;
    }
    const commit = record.defaultBranchRef.target;
    eligible.push({
      repo: record.nameWithOwner,
      stars: record.stargazerCount,
      commit: commit.oid,
      owner: record.owner.__typename,
      authors90d: humanAuthors(commit).size,
      packageManager: {
        'package-lock.json': 'npm',
        'pnpm-lock.yaml': 'pnpm',
        'yarn.lock': 'yarn',
        'bun.lock': 'bun',
      }[LOCKFILES.find((_, index) => record[`lock${index}`])],
      found: [...foundBy[repo]].sort(),
    });
  }
  eligible.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
  const scanned = eligible.slice(0, Number(values.limit));

  // 3. Pre-scan with Refit's own Meta scan, offline: `refit meta-graph --json` and
  // `--propose-version-moves --target <target> --json` on a shallow clone, plus the text signals
  // the scan does not read. Each result is cached under prescan/, and the clone deleted.
  const refit = join(REFIT, 'bin', 'refit.mjs');
  const runRefit = async (args) =>
    JSON.parse(
      (
        await execute(process.execPath, [refit, 'meta-graph', ...args, '--json'], {
          maxBuffer: 256 * 1024 * 1024,
          timeout: 600_000,
        })
      ).stdout,
    );
  const prescan = {};
  for (const [index, entry] of scanned.entries()) {
    const path = join(work, 'prescan', `${entry.repo.replace('/', '__')}.json`);
    if (existsSync(path)) {
      prescan[entry.repo] = JSON.parse(await readFile(path, 'utf8'));
      continue;
    }
    console.error(`[${index + 1}/${scanned.length}] ${entry.repo}`);
    const clones = join(work, 'repos');
    let result;
    try {
      const directory = await shallowCheckout(clones, entry.repo, entry.commit);
      const scan = await runRefit(['--repository', directory]);
      const moves = await runRefit([
        '--propose-version-moves',
        '--target',
        target,
        '--repository',
        directory,
      ]).catch((error) => ({ error: String(error.message ?? error).slice(0, 500) }));
      const text = { fbInit: [], basicDisplay: false };
      for (const file of await liveFiles(directory)) {
        const content = await readFile(file, 'utf8').catch(() => '');
        if (content.length > MAX_FILE_BYTES) continue;
        const signals = textSignals(content);
        text.fbInit.push(...signals.fbInit);
        text.basicDisplay ||= signals.basicDisplay;
      }
      text.fbInit = [...new Set(text.fbInit)].sort();
      const live = scan.calls.filter((call) => call.use === 'live');
      result = {
        liveCalls: live.length,
        versions: [...new Set(live.map((call) => call.version).filter(Boolean))].sort(
          (a, b) => versionKey(a) - versionKey(b),
        ),
        sdk: scan.sdk ? (scan.sdk.locked ?? scan.sdk.declared) : null,
        text,
        reasons: affectedReasons(
          { scan, moves: moves.error ? null : moves, text },
          dates,
          frozenAt,
        ),
        movesError: moves.error ?? null,
      };
    } catch (error) {
      result = { error: String(error.message ?? error).slice(0, 500) };
    } finally {
      await rm(checkoutDirectory(clones, entry.repo), { recursive: true, force: true });
    }
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
    prescan[entry.repo] = result;
  }

  const notAffected = {};
  const affected = [];
  for (const entry of scanned) {
    const result = prescan[entry.repo];
    const reason = result.error
      ? 'clone or scan failed'
      : !result.liveCalls && !result.text.fbInit.length && !result.text.basicDisplay
        ? 'no live Graph request found by the scan'
        : !result.reasons.length
          ? 'only supported versions, no listed change'
          : null;
    if (reason) {
      notAffected[reason] = (notAffected[reason] ?? 0) + 1;
      continue;
    }
    affected.push({
      ...entry,
      versions: result.versions,
      fbInit: result.text.fbInit,
      ...(result.sdk ? { businessSdk: result.sdk } : {}),
      affected: result.reasons,
    });
  }

  // 4. Freeze. Blind first, so the blind set never depends on the dev set's size. With fewer
  // affected repositories than both sizes, the dev set keeps its size and the blind set takes the
  // rest; the shortfall is recorded in both lists, never hidden.
  const requested = Number(values['blind-size']);
  const devSize = Number(values['dev-size']);
  const blindSize = Math.min(requested, Math.max(0, affected.length - devSize));
  const { blind, dev } = splitSets(affected, values.seed, blindSize, devSize);
  const shortfall =
    blindSize < requested
      ? `Only ${affected.length} affected repositories qualified, fewer than the ${requested + devSize} a ${requested}-repository blind set and a ${devSize}-repository dev set need, so the blind set has ${blind.length} and the dev set ${dev.length}.`
      : null;
  const fileHash = async (path) =>
    createHash('sha256')
      .update(await readFile(join(REFIT, path)))
      .digest('hex');
  const specs = {
    target,
    changes: {
      path: 'data/meta-graph-changes.json',
      sha256: await fileHash('data/meta-graph-changes.json'),
    },
    deadlines: { path: 'data/deadlines.json', sha256: await fileHash('data/deadlines.json') },
    businessSdkEdges: {
      path: 'data/meta-business-sdk-edges.json',
      sha256: await fileHash('data/meta-business-sdk-edges.json'),
    },
    refitCommit: (await execute('git', ['-C', REFIT, 'rev-parse', 'HEAD'])).stdout.trim(),
  };
  const command = `node scripts/meta-active-select.mjs --work <dir> --dev ${values.dev} --blind ${values.blind} --frozen-at ${frozenAt} --dev-size ${values['dev-size']} --blind-size ${values['blind-size']} --limit ${values.limit} --seed ${values.seed}`;
  const criteria = `GitHub code search (${QUERIES.length} queries; one with more than 1,000 results also run once per file-size range: ${SIZE_RANGES.join(', ')} bytes) for graph.facebook.com/v URLs, facebook-nodejs-business-sdk, FB.init with a version, graph.instagram.com and WhatsApp Cloud API messages, excluding every repository named in any JSON file under ${values.benchmarks}/ (${excluded.size} repositories). Kept: not archived, not a fork, under 50 MB; a default-branch commit since ${since.slice(0, 10)} with at least ${MIN_AUTHORS} distinct human commit authors in that window (bots excluded); a .github/workflows directory; a root package.json and exactly one root lockfile (${LOCKFILES.join(', ')}). The ${scanned.length} most starred were cloned at their default-branch HEAD, scanned offline with \`refit meta-graph --json\` and \`refit meta-graph --propose-version-moves --target ${target} --json\` and a text search for FB.init versions and Instagram Basic Display scopes (user_profile, user_media) in live files, then deleted. Affected: a live request or FB.init on a Graph API version retired by ${frozenAt} (data/deadlines.json, or older than its oldest entry) or retiring within ${SOON_DAYS} days, a live request a reviewed change in data/meta-graph-changes.json removes or changes on the way to ${target}, or Instagram Basic Display scopes (product shut down 2024-12-04). Affected repositories are ordered by SHA-256 of "${values.seed}:<owner/name>" (lower-cased); the first ${blindSize} (of ${requested} requested; fewer only when the dev set's ${devSize} would not fit) are the blind set and the next ${devSize} the dev set.`;
  const summary = {
    queries,
    repositories: found.length,
    excludedByList,
    candidates: candidates.length,
    eligible: eligible.length,
    excluded: reasons,
    scanned: scanned.length,
    notAffected,
    affected: affected.length,
    shortfall,
  };
  const write = (path, repos, purpose) =>
    writeFile(
      resolve(path),
      `${JSON.stringify(
        {
          frozenAt,
          provider: 'meta-graph',
          purpose,
          command,
          criteria,
          search: summary,
          specs,
          repos,
        },
        null,
        2,
      )}\n`,
    );
  await write(
    values.dev,
    dev,
    'Meta Graph dev set: active repositories affected by a retired or retiring Graph API version, a removed or changed field or edge, or a shut-down product. Agents tune Refit offline on these.',
  );
  await write(
    values.blind,
    blind,
    'Meta Graph blind set: the same selection as the dev set, no overlap. Nobody opens, traces or debugs these repositories; they run only in the combined Meta benchmark at the end.',
  );
  console.log(
    JSON.stringify(
      { ...summary, dev: dev.length, blindRequested: requested, blind: blind.length, target },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

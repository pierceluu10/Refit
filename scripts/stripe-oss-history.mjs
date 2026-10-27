// Freezes the historical (ground-truth) mode of the open-source Stripe benchmark: for each
// repository of the OSS list, the commits where its maintainers moved the stripe dependency or
// apiVersion pin across a Stripe API version, with the parent commit and the human diff.
// Usage: GITHUB_TOKEN=… node scripts/stripe-oss-history.mjs --list <oss.json> --work <dir>
//          --output <cases.json> --lists <directory for per-target lists> --diffs <directory>
// Refit runs on each parent with the version the maintainers moved to as its target, so its patch
// can be compared with theirs. The benchmark targets the newest spec of a list, so each target
// version gets a list of its own.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { validRepoName, validSha } from './ai-app-helpers.mjs';
import { apiVersionPins, cachedIn, githubClient } from './stripe-active-select.mjs';
import {
  LOCKFILES,
  lockedStripeVersion,
  sdkApiVersion,
  serverStripeFile,
  sourceFiles,
} from './stripe-oss-select.mjs';

const execute = promisify(execFile);

// The oldest API version with a pinned spec (data/stripe-openapi-versions.json); earlier history
// cannot be replayed.
const HISTORY_SINCE = '2022-08-01';
// Commits touching one manifest path; older ones are not read.
const MAX_COMMITS_PER_PATH = 300;
const VERSIONS = 'data/stripe-openapi-versions.json';
// The human diff is frozen without lockfiles, whose churn says nothing about the code change.
const LOCKFILE_NAMES = [...Object.keys(LOCKFILES), 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock'];
const BOT = /\[bot\]|^(dependabot|renovate)/i;

// Every change of the declared stripe range between consecutive manifest versions, oldest first.
// `history` is [{ sha, parent, range }] oldest first; a missing range is a manifest without stripe.
export function dependencyMoves(history) {
  const moves = [];
  for (let index = 1; index < history.length; index++) {
    const [previous, current] = [history[index - 1], history[index]];
    if (previous.range && current.range && previous.range !== current.range)
      moves.push({ sha: current.sha, from: previous.range, to: current.range });
  }
  return moves;
}

// Stripe API versions sort by date, then by release name (acacia < basil < clover < …).
export const versionOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function diffExclusions() {
  return LOCKFILE_NAMES.flatMap((name) => [`:(exclude)${name}`, `:(exclude)**/${name}`]);
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'string' },
      work: { type: 'string' },
      output: { type: 'string' },
      lists: { type: 'string' },
      diffs: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (
    values.help ||
    !values.list ||
    !values.work ||
    !values.output ||
    !values.lists ||
    !values.diffs
  ) {
    console.log(
      'Usage: node scripts/stripe-oss-history.mjs --list <oss.json> --work <dir> --output <cases.json> --lists <dir> --diffs <dir>',
    );
    process.exit(values.help ? 0 : 1);
  }
  const list = JSON.parse(await readFile(values.list, 'utf8'));
  const work = resolve(values.work);
  await mkdir(join(work, 'repos'), { recursive: true });
  const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
  const github = githubClient(token);
  const cached = cachedIn(work);
  const { STRIPE_SDK_RELEASES } = await import('../pipeline/stripe-package-upgrade.ts');
  const table = JSON.parse(await readFile(VERSIONS, 'utf8')).versions;
  const tags = new Map(table.map((entry) => [entry.version, entry.tag]));
  const entries = [...list.repos, ...(list.current ?? [])];

  // 1. Each stripe manifest's history: the commits touching it and its stripe range at each.
  const histories = await cached('histories.json', async () => {
    const found = {};
    for (const entry of entries) {
      found[entry.repo] = {};
      for (const path of entry.evidence.stripeManifests) {
        const commits = [];
        for (let page = 1; commits.length < MAX_COMMITS_PER_PATH; page++) {
          const result = await github(
            `/repos/${entry.repo}/commits?sha=${entry.commit}&path=${encodeURIComponent(path)}&since=${HISTORY_SINCE}T00:00:00Z&per_page=100&page=${page}`,
          );
          commits.push(...result);
          if (result.length < 100) break;
        }
        const history = [];
        for (const commit of commits.slice(0, MAX_COMMITS_PER_PATH).reverse()) {
          const response = await fetch(
            `https://raw.githubusercontent.com/${entry.repo}/${commit.sha}/${path}`,
          );
          let range;
          if (response.ok) {
            try {
              const manifest = JSON.parse(await response.text());
              range = manifest.dependencies?.stripe ?? manifest.devDependencies?.stripe;
            } catch {
              range = undefined;
            }
          }
          history.push({
            sha: commit.sha,
            parent: commit.parents[0]?.sha,
            date: commit.commit.committer.date,
            author: commit.author?.login ?? commit.commit.author.name,
            message: commit.commit.message.split('\n')[0],
            range: typeof range === 'string' ? range : undefined,
          });
        }
        found[entry.repo][path] = history;
        console.error(`${entry.repo} ${path}: ${history.length} commits`);
      }
    }
    return found;
  });

  // 2. Each move's API version on both sides, read from a depth-2 checkout of the moving commit.
  async function versionAt(directory, entry) {
    const pins = [];
    const server = [];
    for (const file of await sourceFiles(directory)) {
      const text = await readFile(file, 'utf8');
      const path = relative(directory, file);
      if (serverStripeFile(path, text)) {
        server.push(path);
        pins.push(...apiVersionPins(text));
      }
    }
    let locked = null;
    try {
      locked = lockedStripeVersion(
        await readFile(join(directory, entry.evidence.lockfile), 'utf8'),
        entry.packageManager,
      );
    } catch {
      locked = null;
    }
    const sorted = [...new Set(pins)].sort(versionOrder);
    return {
      version: sorted[0] ?? (locked ? sdkApiVersion(STRIPE_SDK_RELEASES, locked) : undefined),
      source: sorted.length ? 'apiVersion pin' : 'SDK version',
      locked,
      server: server.length,
    };
  }

  const cases = await cached('cases.json', async () => {
    const found = [];
    for (const entry of entries) {
      const moves = Object.values(histories[entry.repo]).flatMap((history) =>
        dependencyMoves(history).map((move) => ({
          ...move,
          ...history.find((commit) => commit.sha === move.sha),
        })),
      );
      const seen = new Set();
      for (const move of moves) {
        if (seen.has(move.sha) || !validSha(move.sha) || !validSha(move.parent)) continue;
        seen.add(move.sha);
        const directory = join(work, 'repos', entry.repo.replace('/', '__'));
        const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
        const git = (...args) =>
          execute('git', ['-C', directory, ...args], {
            env: environment,
            timeout: 600_000,
            maxBuffer: 256 * 1024 * 1024,
          });
        console.error(`${entry.repo} ${move.sha.slice(0, 12)} ${move.from} -> ${move.to}`);
        try {
          await rm(directory, { recursive: true, force: true });
          await execute('git', ['init', '-q', directory]);
          await git('fetch', '-q', '--depth', '2', `https://github.com/${entry.repo}`, move.sha);
          await git('checkout', '-q', move.parent);
          const before = await versionAt(directory, entry);
          await git('checkout', '-q', move.sha);
          const after = await versionAt(directory, entry);
          const changed = (await git('diff', '--name-only', move.parent, move.sha)).stdout
            .split('\n')
            .filter(Boolean);
          const record = {
            repo: entry.repo,
            parent: move.parent,
            fix: move.sha,
            fixAt: move.date,
            author: move.author,
            bot: BOT.test(move.author ?? ''),
            message: move.message,
            stripeFrom: move.from,
            stripeTo: move.to,
            before: before.version,
            beforeSource: before.source,
            after: after.version,
            afterSource: after.source,
            lockedBefore: before.locked,
            lockedAfter: after.locked,
            serverFilesBefore: before.server,
            changedFiles: changed,
            codeFiles: changed.filter(
              (path) =>
                !LOCKFILE_NAMES.some((name) => path.endsWith(name)) &&
                !path.endsWith('package.json'),
            ),
          };
          const reason =
            !before.version || !after.version
              ? 'no API version'
              : before.version === after.version
                ? 'API version unchanged'
                : versionOrder(after.version, before.version) < 0
                  ? 'API version moved back'
                  : !tags.has(before.version) || !tags.has(after.version)
                    ? 'API version without a pinned spec'
                    : !before.server
                      ? 'no server-side Stripe SDK client at the parent'
                      : null;
          if (!reason) {
            const diff = (await git('diff', move.parent, move.sha, '--', '.', ...diffExclusions()))
              .stdout;
            const name = `${entry.repo.replace('/', '__')}__${move.sha.slice(0, 12)}.diff`;
            await mkdir(resolve(values.diffs), { recursive: true });
            await writeFile(join(resolve(values.diffs), name), diff);
            record.diff = relative(process.cwd(), join(resolve(values.diffs), name));
          }
          found.push(reason ? { ...record, skipped: reason } : record);
        } catch (error) {
          found.push({
            repo: entry.repo,
            fix: move.sha,
            skipped: `checkout failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
    return found;
  });

  const kept = cases.filter((record) => !record.skipped);
  const byTarget = Map.groupBy(kept, (record) => record.after);
  const lists = [];
  await mkdir(resolve(values.lists), { recursive: true });
  for (const [target, group] of [...byTarget].sort(([a], [b]) => versionOrder(a, b))) {
    const file = join(resolve(values.lists), `${list.frozenAt}-stripe-oss-history-${target}.json`);
    const specs = [...new Set([...group.map((record) => record.before), target])].sort(
      versionOrder,
    );
    await writeFile(
      file,
      `${JSON.stringify(
        {
          frozenAt: list.frozenAt,
          purpose: `Historical mode of the open-source Stripe benchmark, target ${target}: each repository at the parent of the commit where its maintainers moved to ${target}, for scripts/stripe-benchmark-setup.mjs --list. Selected by scripts/stripe-oss-history.mjs from ${values.list}.`,
          criteria:
            'A commit that changes the declared stripe range in a stripe manifest of the OSS list, whose API version (the oldest literal apiVersion pin in server-side Stripe files, else the default of the locked stripe-node release) moves forward between the parent and the commit, both with a pinned spec. The human diff, without lockfiles, is frozen beside the list.',
          target,
          specs: specs.map((version) => ({ version, tag: tags.get(version) })),
          repos: group.map((record) => {
            const source = entries.find((entry) => entry.repo === record.repo);
            return {
              repo: record.repo,
              stars: source.stars,
              commit: record.parent,
              before: record.before,
              beforeSource: record.beforeSource,
              stripeDependency: record.stripeFrom,
              packageManager: source.packageManager,
              fix: record.fix,
              diff: record.diff,
            };
          }),
        },
        null,
        2,
      )}\n`,
    );
    lists.push({ target, list: relative(process.cwd(), file), repos: group.length });
  }
  const skipped = {};
  for (const record of cases.filter((entry) => entry.skipped))
    skipped[record.skipped.replace(/:.*/, '')] =
      (skipped[record.skipped.replace(/:.*/, '')] ?? 0) + 1;
  await writeFile(
    resolve(values.output),
    `${JSON.stringify(
      {
        frozenAt: list.frozenAt,
        source: values.list,
        historySince: HISTORY_SINCE,
        repositories: entries.length,
        moves: cases.length,
        kept: kept.length,
        skipped,
        lists,
        cases,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ moves: cases.length, kept: kept.length, skipped, lists }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

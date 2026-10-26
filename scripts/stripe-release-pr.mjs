// Prepares the files of a Stripe release PR (docs/RELEASE-PRS.md) for one stripe/openapi tag:
// the regenerated SDK map, the release's breaking changelog pages and their AI classification when
// the tag brings a new API version, a generated test, and the PR body. Opening the PR is the
// workflow's job; this script never pushes.
//
//   node scripts/stripe-release-pr.mjs --tag v2591 [--if-newer] [--no-ai] [--env <file>]
//     [--specs <directory>] [--body <file>] [--summary <file>]
//
// AI runs only when REFIT_AI_BUDGET_USD (in the environment or --env) is above 0 and --no-ai is absent.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const METADATA = join(ROOT, 'pipeline/stripe-sdk-metadata.json');
const RELEASE_TEST = join(ROOT, 'pipeline/stripe-sdk-release.test.ts');
const CHANGELOG = 'docs/benchmarks/stripe-changelog';
const API = 'https://api.github.com/repos/stripe/openapi';
const RAW = 'https://raw.githubusercontent.com/stripe/openapi';
const SDK_SPEC = 'openapi/spec3.sdk.json';
const DOWNLOADS = 4;

const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const release = await load('../pipeline/stripe-release.ts');
const { captureDocumentation } = await load('../pipeline/documentation-sources.ts');

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    'if-newer': { type: 'boolean' },
    'no-ai': { type: 'boolean' },
    env: { type: 'string' },
    specs: { type: 'string' },
    body: { type: 'string' },
    summary: { type: 'string' },
  },
});
if (!values.tag) throw new Error('Usage: node scripts/stripe-release-pr.mjs --tag vN [options]');
const tag = values.tag;

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function finish(summary) {
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (values.summary) await writeFile(values.summary, text);
  console.log(text);
}

const before = await readJson(METADATA);
const previous = release.sdkMapSource(before);
const order = release.compareTags(tag, previous.tag);
if (order < 0) throw new Error(`${tag} is older than the recorded ${previous.tag}.`);
if (order === 0 && values['if-newer']) {
  await finish({ status: 'up-to-date', tag, previousTag: previous.tag });
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
async function commitOf(name) {
  const response = await fetch(`${API}/commits/${name}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`stripe/openapi ${name} returned ${response.status}.`);
  const { sha, commit } = await response.json();
  return { sha, date: commit.committer.date };
}

// Downloads go to a fresh directory unless --specs names a cache of earlier downloads.
const specs = values.specs ?? (await mkdtemp(join(tmpdir(), 'refit-stripe-specs-')));
await mkdir(specs, { recursive: true });
async function download(name, sha) {
  const file = join(specs, `${name}-${sha}.json`);
  if (existsSync(file)) return file;
  const response = await fetch(`${RAW}/${sha}/${SDK_SPEC}`);
  if (!response.ok) throw new Error(`${SDK_SPEC} at ${name} returned ${response.status}.`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

const target = await commitOf(tag);
// Older specs: every contract Refit pins, plus the tag the map was last generated from.
const table = (await readJson(join(ROOT, 'data/stripe-openapi-versions.json'))).versions;
const older = table.map(({ tag: name, commit }) => ({ name, sha: commit }));
if (!older.some(({ name }) => name === previous.tag))
  older.push({ name: previous.tag, sha: (await commitOf(previous.tag)).sha });
const sources = older.filter(({ name }) => name !== tag);
const newest = await download(tag, target.sha);
const olderFiles = [];
for (let index = 0; index < sources.length; index += DOWNLOADS)
  olderFiles.push(
    ...(await Promise.all(
      sources.slice(index, index + DOWNLOADS).map(({ name, sha }) => download(name, sha)),
    )),
  );
console.error(`Downloaded ${olderFiles.length + 1} SDK specs to ${specs}`);

execFileSync(
  process.execPath,
  [join(ROOT, 'scripts/stripe-sdk-metadata.mjs'), newest, tag, ...olderFiles],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: String(Math.floor(Date.parse(target.date) / 1000)),
    },
  },
);
const after = await readJson(METADATA);
const { version } = release.sdkMapSource(after);
const diff = release.diffSdkMaps(before, after);
const newVersion = !before.operationVersions.includes(version);

let breaking = [];
let classification = { status: 'skipped', reason: 'no new API version' };
if (newVersion) {
  const name = version.slice(version.indexOf('.') + 1);
  const overview = await fetch(`https://docs.stripe.com/changelog/${name}.md`);
  if (!overview.ok) throw new Error(`The ${name} changelog returned ${overview.status}.`);
  breaking = release.breakingPages(await overview.text(), version);
  const pages = join(ROOT, CHANGELOG, 'pages', version);
  await mkdir(pages, { recursive: true });
  for (const page of breaking) {
    const snapshot = await captureDocumentation({ label: page.slug, url: `${page.url}.md` });
    await writeFile(join(pages, `${page.slug}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    console.error(`${version}/${page.slug}: ${snapshot.content.length} characters`);
  }
  if (breaking.length) classification = await classify(version);
}

async function classify(version) {
  const directory = `${CHANGELOG}/classification/${version}`;
  const output = join(ROOT, directory);
  // An earlier run's classification is kept: a rerun on the same tag spends nothing and changes nothing.
  if (!existsSync(join(output, 'audit.json'))) {
    const environment = values.env ? parseEnv(await readFile(values.env, 'utf8')) : {};
    const budget = Number(process.env.REFIT_AI_BUDGET_USD ?? environment.REFIT_AI_BUDGET_USD ?? 0);
    if (values['no-ai']) return { status: 'skipped', reason: 'run with --no-ai' };
    if (!(budget > 0)) return { status: 'skipped', reason: 'REFIT_AI_BUDGET_USD is not above 0' };
    const refit = join(ROOT, 'bin/refit.mjs');
    const help = execFileSync(process.execPath, [refit, 'classify-release', '--help'], {
      encoding: 'utf8',
    });
    // A new release has no hand catalog, so it needs the pages-only mode.
    if (!help.includes('--statements'))
      return {
        status: 'skipped',
        reason:
          "this Refit commit's `refit classify-release` has no `--statements none` (pages-only) mode",
      };
    const scratch = join(await mkdtemp(join(tmpdir(), 'refit-classify-')), 'out');
    execFileSync(
      process.execPath,
      [
        refit,
        'classify-release',
        '--release',
        version,
        '--statements',
        'none',
        '--output',
        scratch,
        ...(values.env ? ['--env', values.env] : []),
      ],
      { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    await mkdir(output, { recursive: true });
    for (const file of ['results.json', 'audit.json'])
      await writeFile(join(output, file), await readFile(join(scratch, file)));
  }
  const pages = release.classifiedPages(await readJson(join(output, 'audit.json')));
  const reviewFile = join(output, 'review.json');
  if (!existsSync(reviewFile))
    await writeFile(reviewFile, `${JSON.stringify(release.reviewEntries(pages), null, 2)}\n`);
  const audit = await readJson(join(output, 'audit.json'));
  const costUsd = audit.pages.reduce((total, page) => total + (page.costUsd ?? 0), 0);
  return { status: 'classified', directory, pages, costUsd };
}

const map = release.checkSdkMap(after);
const classified = classification.status === 'classified';
const review = classified
  ? await readJson(join(ROOT, classification.directory, 'review.json'))
  : null;
await writeFile(
  RELEASE_TEST,
  release.renderReleaseTest({
    map,
    classification: classified
      ? {
          directory: classification.directory,
          pages: classification.pages.length,
          changes: classification.pages.reduce((total, page) => total + page.changes.length, 0),
          review: review.length,
        }
      : null,
  }),
);
execFileSync(join(ROOT, 'node_modules/.bin/prettier'), ['--write', RELEASE_TEST], {
  stdio: 'ignore',
});

const body = release.renderPrBody({
  tag,
  previousTag: previous.tag,
  version,
  newVersion,
  diff,
  breaking,
  classification,
});
if (values.body) await writeFile(values.body, body);
await finish({
  status: newVersion || release.sdkMapChanged(before, after) ? 'changed' : 'unchanged',
  tag,
  previousTag: previous.tag,
  version,
  newVersion,
  breakingPages: breaking.length,
  classification: classified
    ? { directory: classification.directory, costUsd: classification.costUsd }
    : classification,
  sdkMap: Object.fromEntries(
    Object.entries(diff).map(([name, { added, removed }]) => [
      name,
      { added: added.length, removed: removed.length },
    ]),
  ),
});

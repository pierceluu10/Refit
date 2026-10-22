// Selects the frozen data-APIs sample: public JS/TS repositories whose root package.json declares a
// list-B provider's package. Candidates come from GitHub code search through `gh api` (the user's
// existing login; no token is read or stored): root package.json files that name the package.
// A candidate is kept when it is not a fork or archived, was pushed since the cutoff, is under
// 60 MB, is not the provider's own organisation, and its package.json at the fetched HEAD declares
// the package in dependencies, devDependencies or peerDependencies. Each kept repository is
// fetched at that commit into --root without submodules; nothing is installed or run. A repository
// belongs to the first provider that selects it. The code-search index moves, so the frozen file,
// not a rerun, is the reproducible record.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const PROVIDERS = {
  'google-maps': {
    packages: ['@googlemaps/js-api-loader', '@react-google-maps/api', '@vis.gl/react-google-maps'],
    skip: /^(googlemaps|googlemapsplatform|visgl|JustFly1984)\//,
  },
  mapbox: { packages: ['mapbox-gl', '@mapbox/mapbox-sdk'], skip: /^mapbox\// },
  algolia: { packages: ['algoliasearch', 'react-instantsearch'], skip: /^algolia\// },
  hubspot: { packages: ['@hubspot/api-client'], skip: /^HubSpot\//i },
  intercom: { packages: ['intercom-client'], skip: /^intercom\//i },
  mailchimp: {
    packages: ['@mailchimp/mailchimp_marketing', '@mailchimp/mailchimp_transactional'],
    skip: /^mailchimp\//i,
  },
  zoom: { packages: ['@zoom/meetingsdk', '@zoomus/websdk', '@zoom/videosdk'], skip: /^zoom/i },
  dropbox: { packages: ['dropbox'], skip: /^dropbox\//i },
  notion: { packages: ['@notionhq/client'], skip: /^makenotion\// },
  airtable: { packages: ['airtable'], skip: /^airtable\//i },
  segment: {
    packages: ['@segment/analytics-node', '@segment/analytics-next', 'analytics-node'],
    skip: /^segmentio\//,
  },
  sentry: { packages: ['@sentry/node', '@sentry/browser', '@sentry/nextjs'], skip: /^getsentry\// },
  discord: { packages: ['discord.js'], skip: /^discordjs\// },
  contentful: { packages: ['contentful', 'contentful-management'], skip: /^contentful\// },
  cloudinary: { packages: ['cloudinary', '@cloudinary/url-gen'], skip: /^cloudinary\// },
};
const CUTOFF = '2025-10-21';
const MAX_SIZE_KB = 60_000;
const SEARCH_PAUSE_MS = 7000;
const PAGES = 3;

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    root: { type: 'string' },
    per: { type: 'string', default: '12' },
  },
});
if (!values.output || !values.root) {
  console.log(
    'Usage: node scripts/data-apis-select.mjs --output <frozen.json> --root <dir> [--per 12]',
  );
  process.exit(1);
}
const per = Number(values.per);
const root = resolve(values.root);
await mkdir(root, { recursive: true });
const gh = async (...args) => (await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const declares = (manifest, name) =>
  ['dependencies', 'devDependencies', 'peerDependencies'].some((key) => manifest[key]?.[name]);

const queries = [];
const taken = new Set();
const repos = [];
const rejected = {};
for (const [id, provider] of Object.entries(PROVIDERS)) {
  const found = [];
  for (const name of provider.packages)
    for (let page = 1; page <= PAGES; page++) {
      const q = `"${name}" filename:package.json path:/`;
      let items = [];
      try {
        items = JSON.parse(
          await gh(
            'api',
            '-X',
            'GET',
            'search/code',
            '-f',
            `q=${q}`,
            '-f',
            'per_page=100',
            '-f',
            `page=${page}`,
          ),
        ).items;
      } catch {
        /* a failed page ends this query */
      }
      queries.push({ provider: id, q, page, results: items.length });
      for (const item of items) found.push({ repo: item.repository.full_name, name });
      await pause(SEARCH_PAUSE_MS);
      if (items.length < 100) break;
    }
  let kept = 0;
  for (const { repo, name } of found) {
    if (kept >= per) break;
    const key = repo.toLowerCase();
    if (taken.has(key) || provider.skip.test(repo)) continue;
    taken.add(key);
    const reject = (reason) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
    try {
      const meta = JSON.parse(await gh('api', `repos/${repo}`));
      if (meta.fork || meta.archived || meta.disabled) {
        reject('fork or archived');
        continue;
      }
      if (meta.pushed_at < CUTOFF) {
        reject('old');
        continue;
      }
      if (meta.size > MAX_SIZE_KB) {
        reject('large');
        continue;
      }
      const head = (
        await execute('git', ['ls-remote', `https://github.com/${repo}.git`, 'HEAD'])
      ).stdout
        .split('\t')[0]
        .trim();
      const directory = join(root, repo.replace('/', '__'));
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const git = (...args) => execute('git', ['-C', directory, ...args]);
      await git('init', '-q');
      await git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, head);
      await git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (!declares(manifest, name)) {
        reject('not declared at HEAD');
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      repos.push({
        provider: id,
        repo,
        commit: head,
        package: name,
        stars: meta.stargazers_count,
        pushedAt: meta.pushed_at,
      });
      kept++;
    } catch {
      reject('unreachable');
    }
  }
  console.error(`${id}: ${kept}`);
}

await writeFile(
  resolve(values.output),
  `${JSON.stringify(
    {
      formatVersion: 1,
      selectedAt: new Date().toISOString(),
      method: `GitHub code search (gh api search/code, up to ${PAGES} pages of 100) for each package of each provider with the query shape "<package>" filename:package.json path:/ (root package.json files naming the package); candidates in result order, one provider per repository; kept when not a fork or archived, pushed on or after ${CUTOFF}, under ${MAX_SIZE_KB} KB, not the provider's own organisation, and the root package.json at the default-branch HEAD declares the package; first ${per} per provider.`,
      queries,
      rejected,
      repos,
    },
    null,
    2,
  )}\n`,
);
console.log(`${repos.length} repositories frozen`);

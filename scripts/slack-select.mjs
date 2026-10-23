// Selects a frozen benchmark of public GitHub repositories that ship an npm package declaring a
// Slack SDK (@slack/web-api, @slack/bolt, @slack/client, @slack/rtm-api or @slack/webhook) as a
// runtime dependency. GitHub code search is unavailable to Refit's benchmark environment, so
// candidates come from npm search, as in scripts/paypal-select.mjs: each package's latest manifest
// must list a Slack SDK in `dependencies`,
// link a github.com repository and have been published since 2022-01. Repositories are ranked by
// monthly downloads, deduplicated, and frozen at the commit `git ls-remote` reports for HEAD.
// Nothing is installed or executed.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2022-01-01';
const SDKS = ['@slack/web-api', '@slack/bolt', '@slack/client', '@slack/rtm-api', '@slack/webhook'];
const QUERIES = [
  'slack',
  'slack bot',
  'slack app',
  'slack notification',
  'slack notifier',
  'slack integration',
  'slack message',
  'slack api',
  'slack web api',
  'slack bolt',
  'slack webhook',
  'slack alert',
  'slack command',
  'slack reporter',
  'slack plugin',
  'chatops',
  'chat bot',
  'notifications',
];
const CONCURRENCY = 16;
const VENDOR_SCOPES = ['@slack/'];

const { values } = parseArgs({
  options: {
    count: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.count || !values.output) {
  console.log('Usage: node scripts/slack-select.mjs --count N --output <frozen.json>');
  process.exit(values.help ? 0 : 1);
}
const count = Number(values.count);

async function json(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if (response.status === 404) return undefined;
    if (attempt >= 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
}

function githubRepository(url) {
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(
    url ?? '',
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const candidates = new Map();
for (const query of QUERIES)
  for (let page = 0; page < PAGES; page += 1) {
    const result = await json(
      `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${page * PAGE_SIZE}`,
    );
    for (const { package: item, downloads } of result?.objects ?? [])
      if (!candidates.has(item.name))
        candidates.set(item.name, {
          name: item.name,
          date: item.date,
          downloads: downloads?.monthly ?? 0,
        });
    if ((result?.objects ?? []).length < PAGE_SIZE) break;
  }
console.error(`${candidates.size} npm packages from ${QUERIES.length} queries`);

const rejected = {
  vendor: 0,
  old: 0,
  noDependency: 0,
  noRepository: 0,
  duplicate: 0,
  unreachable: 0,
};
const selected = [];
const seen = new Set();
const ranked = [...candidates.values()].sort(
  (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
);
// Latest manifests, fetched ahead in rank order; selection itself stays sequential.
const eligible = ranked.filter((candidate) => {
  if (VENDOR_SCOPES.some((scope) => candidate.name.startsWith(scope))) {
    rejected.vendor += 1;
    return false;
  }
  if (!candidate.date || candidate.date < PUBLISHED_SINCE) {
    rejected.old += 1;
    return false;
  }
  return true;
});
const manifests = new Map();
for (let start = 0; start < eligible.length; start += CONCURRENCY) {
  const batch = eligible.slice(start, start + CONCURRENCY);
  const fetched = await Promise.all(
    batch.map((candidate) => json(`${REGISTRY}/${candidate.name.replace('/', '%2F')}/latest`)),
  );
  batch.forEach((candidate, index) => manifests.set(candidate.name, fetched[index]));
}
for (const candidate of eligible) {
  if (selected.length >= count) break;
  const manifest = manifests.get(candidate.name);
  const declared = Object.fromEntries(
    SDKS.flatMap((sdk) =>
      manifest?.dependencies?.[sdk] ? [[sdk, manifest.dependencies[sdk]]] : [],
    ),
  );
  if (!Object.keys(declared).length) {
    rejected.noDependency += 1;
    continue;
  }
  const repo = githubRepository(
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
  );
  if (!repo) {
    rejected.noRepository += 1;
    continue;
  }
  if (seen.has(repo.toLowerCase())) {
    rejected.duplicate += 1;
    continue;
  }
  seen.add(repo.toLowerCase());
  let commit;
  try {
    const { stdout } = await execute('git', ['ls-remote', `https://github.com/${repo}`, 'HEAD'], {
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    commit = /^([a-f0-9]{40})\tHEAD$/m.exec(stdout)?.[1];
  } catch {
    commit = undefined;
  }
  if (!commit) {
    rejected.unreachable += 1;
    continue;
  }
  selected.push({
    provider: 'slack',
    repo,
    commit,
    package: candidate.name,
    version: manifest.version,
    declared,
    monthlyDownloads: candidate.downloads,
    publishedAt: candidate.date,
  });
  console.error(`[${selected.length}/${count}] ${repo} (${candidate.name})`);
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      provider: 'slack',
      sdks: SDKS,
      selectedAt: new Date().toISOString(),
      method: `npm search for ${QUERIES.map((query) => JSON.stringify(query)).join(', ')} (${PAGES} pages of ${PAGE_SIZE}); latest manifest declares one of ${SDKS.join(', ')} in dependencies; github.com repository; published since ${PUBLISHED_SINCE}; vendor scopes excluded; ranked by monthly downloads; one entry per repository; frozen at HEAD from git ls-remote.`,
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${selected.length}; rejected ${JSON.stringify(rejected)}`);

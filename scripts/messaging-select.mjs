// Selects a frozen benchmark of public GitHub repositories that ship an npm package declaring a
// messaging SDK as a runtime dependency, in one group per provider: Twilio (`twilio`), SendGrid
// (`@sendgrid/mail`, `@sendgrid/client` or the retired `sendgrid`), Resend (`resend`), Postmark
// (`postmark`) and Mailgun (`mailgun.js` or the retired `mailgun-js`). A package declaring several
// lands in the first group above that still has room. GitHub code search is unavailable to Refit's
// benchmark environment, so candidates come from npm search, as in scripts/paypal-select.mjs: the
// latest manifest must declare the SDK in `dependencies`, link a github.com repository outside the
// providers' own organizations and have been published since 2022-01. Repositories are ranked by
// monthly downloads, deduplicated across groups, and frozen at the commit `git ls-remote` reports
// for HEAD. Nothing is installed or executed.
//
//   node scripts/messaging-select.mjs --per-provider 12 --output <frozen.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2022-01-01';
const QUERIES = [
  'twilio',
  'sms',
  'whatsapp',
  'otp verification',
  'sendgrid',
  'email',
  'transactional email',
  'send email',
  'email provider',
  'resend',
  'postmark',
  'mailgun',
  'notifications',
  'nodemailer transport',
  'newsletter',
];
const GROUPS = {
  twilio: ['twilio'],
  sendgrid: ['@sendgrid/mail', '@sendgrid/client', 'sendgrid'],
  resend: ['resend'],
  postmark: ['postmark'],
  mailgun: ['mailgun.js', 'mailgun-js'],
};
const CONCURRENCY = 16;
const VENDOR_SCOPES = ['@sendgrid/', '@twilio/', '@twilio-labs/', '@resend/', '@mailgun/'];
const VENDOR_OWNERS = new Set(
  ['twilio', 'twilio-labs', 'sendgrid', 'resend', 'activecampaign', 'wildbit', 'mailgun'].map(
    (owner) => owner.toLowerCase(),
  ),
);

const { values } = parseArgs({
  options: {
    'per-provider': { type: 'string' },
    // A targeted list: these queries instead of the defaults, only these groups, and none of the
    // repositories already in another frozen list.
    query: { type: 'string', multiple: true },
    group: { type: 'string', multiple: true },
    exclude: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values['per-provider'] || !values.output) {
  console.log(
    'Usage: node scripts/messaging-select.mjs --per-provider N [--query <text>…] [--group <provider>…] [--exclude <frozen.json>] --output <frozen.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const queries = values.query?.length ? values.query : QUERIES;
const quotas = Object.fromEntries(
  Object.keys(GROUPS)
    .filter((group) => !values.group?.length || values.group.includes(group))
    .map((group) => [group, Number(values['per-provider'])]),
);
const excluded = new Set(
  values.exclude
    ? JSON.parse(await readFile(values.exclude, 'utf8')).repos.map((item) =>
        item.repo.toLowerCase(),
      )
    : [],
);

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

// The groups a manifest could belong to, in order, and the SDK packages it declares.
function groupsOf(dependencies = {}) {
  return Object.entries(GROUPS)
    .map(([group, names]) => ({
      group,
      declared: Object.fromEntries(
        names.filter((name) => dependencies[name]).map((name) => [name, dependencies[name]]),
      ),
    }))
    .filter((item) => Object.keys(item.declared).length);
}

const candidates = new Map();
for (const query of queries)
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
console.error(`${candidates.size} npm packages from ${queries.length} queries`);

const rejected = {
  vendor: 0,
  old: 0,
  noDependency: 0,
  noRepository: 0,
  duplicate: 0,
  groupFull: 0,
  unreachable: 0,
};
const selected = [];
const counts = Object.fromEntries(Object.keys(quotas).map((group) => [group, 0]));
const seen = new Set();
const ranked = [...candidates.values()].sort(
  (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
);
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
  if (Object.entries(quotas).every(([group, quota]) => counts[group] >= quota)) break;
  const manifest = manifests.get(candidate.name);
  const groups = groupsOf(manifest?.dependencies);
  if (!groups.length) {
    rejected.noDependency += 1;
    continue;
  }
  const found = groups.find(
    (item) => item.group in quotas && counts[item.group] < quotas[item.group],
  );
  if (!found) {
    rejected.groupFull += 1;
    continue;
  }
  const repo = githubRepository(
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
  );
  if (!repo) {
    rejected.noRepository += 1;
    continue;
  }
  if (VENDOR_OWNERS.has(repo.split('/')[0].toLowerCase())) {
    rejected.vendor += 1;
    continue;
  }
  if (seen.has(repo.toLowerCase()) || excluded.has(repo.toLowerCase())) {
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
  counts[found.group] += 1;
  selected.push({
    group: found.group,
    repo,
    commit,
    package: candidate.name,
    version: manifest.version,
    declared: found.declared,
    monthlyDownloads: candidate.downloads,
    publishedAt: candidate.date,
  });
  console.error(
    `[${found.group} ${counts[found.group]}/${quotas[found.group]}] ${repo} (${candidate.name})`,
  );
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      provider: 'messaging',
      selectedAt: new Date().toISOString(),
      method: `npm search for ${queries.map((query) => JSON.stringify(query)).join(', ')} (${PAGES} pages of ${PAGE_SIZE}); latest manifest declares, in dependencies, a package of ${Object.entries(
        GROUPS,
      )
        .map(([group, names]) => `${group} (${names.join(', ')})`)
        .join(
          ', ',
        )}, assigned to the first of those groups with room; quotas ${JSON.stringify(quotas)}; github.com repository outside ${[...VENDOR_OWNERS].join(', ')}; published since ${PUBLISHED_SINCE}; vendor scopes excluded; ranked by monthly downloads; one entry per repository${values.exclude ? `; repositories in ${values.exclude} excluded` : ''}; frozen at HEAD from git ls-remote.`,
      quotas,
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${JSON.stringify(counts)}; rejected ${JSON.stringify(rejected)}`);

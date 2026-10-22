// Selects a frozen benchmark of public GitHub repositories that ship an npm package declaring a cloud
// SDK as a runtime dependency, in three groups: the AWS SDK for JavaScript v2 (`aws-sdk`), v3 only
// (an `@aws-sdk/client-*` package and no `aws-sdk`), and a legacy Azure SDK package from
// data/azure-sdk-retirements.json. GitHub code search is unavailable to Refit's benchmark
// environment, so candidates come from npm search, as in scripts/paypal-select.mjs: each package's
// latest manifest must declare the SDK in `dependencies`, link a github.com repository outside the
// vendors' own organizations and have been published since 2022-01. Repositories are ranked by
// monthly downloads, deduplicated across groups, and frozen at the commit `git ls-remote` reports for
// HEAD. Nothing is installed or executed.
//
//   node scripts/cloud-sdk-select.mjs --v2 32 --v3 20 --azure 12 --output <frozen.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2022-01-01';
const AWS_QUERIES = [
  'aws',
  'aws-sdk',
  'aws s3',
  's3 upload',
  'dynamodb',
  'lambda',
  'sqs',
  'ses email',
  'sns',
  'cognito',
  'cloudwatch',
  'kinesis',
  'serverless',
  'secrets manager',
  'presigned url',
];
const AZURE_QUERIES = [
  'azure',
  'azure storage',
  'azure blob',
  'azure service bus',
  'azure table',
  'azure queue',
  'azure keyvault',
  'azure functions',
  'azure arm',
];
const CONCURRENCY = 16;
const VENDOR_SCOPES = [
  '@aws-sdk/',
  '@aws-crypto/',
  '@aws-cdk/',
  '@smithy/',
  '@azure/',
  '@azure-rest/',
];
const VENDOR_OWNERS = new Set(
  ['aws', 'awslabs', 'aws-amplify', 'aws-samples', 'aws-powertools', 'azure', 'azure-samples'].map(
    (owner) => owner.toLowerCase(),
  ),
);

const { values } = parseArgs({
  options: {
    v2: { type: 'string' },
    v3: { type: 'string' },
    azure: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.v2 || !values.v3 || !values.azure || !values.output) {
  console.log(
    'Usage: node scripts/cloud-sdk-select.mjs --v2 N --v3 N --azure N --output <frozen.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const quotas = {
  'aws-sdk-v2': Number(values.v2),
  'aws-sdk-v3': Number(values.v3),
  azure: Number(values.azure),
};
const azureNames = new Set(
  JSON.parse(
    await readFile(new URL('../data/azure-sdk-retirements.json', import.meta.url), 'utf8'),
  ).packages.map((item) => item.name),
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

// The group a manifest belongs to, and the SDK packages it declares.
function groupOf(dependencies = {}) {
  const names = Object.keys(dependencies);
  if (names.includes('aws-sdk'))
    return {
      group: 'aws-sdk-v2',
      declared: Object.fromEntries(
        names
          .filter((name) => name === 'aws-sdk' || name.startsWith('@aws-sdk/client-'))
          .map((name) => [name, dependencies[name]]),
      ),
    };
  const v3 = names.filter((name) => name.startsWith('@aws-sdk/client-'));
  if (v3.length)
    return {
      group: 'aws-sdk-v3',
      declared: Object.fromEntries(v3.map((name) => [name, dependencies[name]])),
    };
  const azure = names.filter((name) => azureNames.has(name));
  if (azure.length)
    return {
      group: 'azure',
      declared: Object.fromEntries(azure.map((name) => [name, dependencies[name]])),
    };
  return undefined;
}

const candidates = new Map();
for (const query of [...AWS_QUERIES, ...AZURE_QUERIES])
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
console.error(
  `${candidates.size} npm packages from ${AWS_QUERIES.length + AZURE_QUERIES.length} queries`,
);

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
const counts = { 'aws-sdk-v2': 0, 'aws-sdk-v3': 0, azure: 0 };
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
  const found = groupOf(manifest?.dependencies);
  if (!found) {
    rejected.noDependency += 1;
    continue;
  }
  if (counts[found.group] >= quotas[found.group]) {
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
      provider: 'cloud-sdk',
      selectedAt: new Date().toISOString(),
      method: `npm search for ${[...AWS_QUERIES, ...AZURE_QUERIES].map((query) => JSON.stringify(query)).join(', ')} (${PAGES} pages of ${PAGE_SIZE}); latest manifest declares, in dependencies, aws-sdk (group aws-sdk-v2), else an @aws-sdk/client-* package (aws-sdk-v3), else a package in data/azure-sdk-retirements.json (azure); quotas ${JSON.stringify(quotas)}; github.com repository outside ${[...VENDOR_OWNERS].join(', ')}; published since ${PUBLISHED_SINCE}; vendor scopes excluded; ranked by monthly downloads; one entry per repository; frozen at HEAD from git ls-remote.`,
      quotas,
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${JSON.stringify(counts)}; rejected ${JSON.stringify(rejected)}`);

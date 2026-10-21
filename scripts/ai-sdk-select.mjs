// Selects a frozen benchmark of public GitHub repositories that ship an npm package declaring the
// OpenAI, Anthropic or Gemini SDK as a runtime dependency (for Gemini, either @google/genai or the
// older @google/generative-ai). GitHub code search is unavailable to Refit's
// benchmark environment, so candidates come from npm search instead: each package's latest
// manifest must list the SDK in `dependencies`, link a github.com repository and have been published
// since 2024-01. Repositories are ranked by monthly downloads, deduplicated, and frozen at the
// commit `git ls-remote` reports for HEAD. Nothing is installed or executed.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 4;
const PUBLISHED_SINCE = '2024-01-01';
const PROVIDERS = {
  openai: {
    sdk: 'openai',
    queries: ['openai', 'chatgpt', 'gpt', 'llm', 'ai agent', 'embeddings', 'ai chat'],
    vendorScopes: ['@openai/'],
  },
  anthropic: {
    sdk: '@anthropic-ai/sdk',
    queries: ['anthropic', 'claude', 'llm', 'ai agent', 'ai chat', 'mcp'],
    vendorScopes: ['@anthropic-ai/'],
  },
  gemini: {
    sdks: ['@google/genai', '@google/generative-ai'],
    queries: ['gemini', 'google ai', 'genai', 'llm', 'ai agent', 'ai chat'],
    vendorScopes: ['@google/'],
  },
};

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    count: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const provider = PROVIDERS[values.provider ?? ''];
if (values.help || !provider || !values.count || !values.output) {
  console.log(
    'Usage: node scripts/ai-sdk-select.mjs --provider openai|anthropic|gemini --count N --output <frozen.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const count = Number(values.count);
const sdks = provider.sdks ?? [provider.sdk];

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
for (const query of provider.queries)
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
console.error(`${candidates.size} npm packages from ${provider.queries.length} queries`);

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
for (const candidate of ranked) {
  if (selected.length >= count) break;
  if (provider.vendorScopes.some((scope) => candidate.name.startsWith(scope))) {
    rejected.vendor += 1;
    continue;
  }
  if (!candidate.date || candidate.date < PUBLISHED_SINCE) {
    rejected.old += 1;
    continue;
  }
  const manifest = await json(`${REGISTRY}/${candidate.name.replace('/', '%2F')}/latest`);
  const sdk = sdks.find((name) => manifest?.dependencies?.[name]);
  const declared = sdk && manifest.dependencies[sdk];
  if (!declared) {
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
    provider: values.provider,
    repo,
    commit,
    package: candidate.name,
    version: manifest.version,
    ...(provider.sdks ? { sdk } : {}),
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
      provider: values.provider,
      ...(provider.sdks ? { sdks: provider.sdks } : { sdk: provider.sdk }),
      selectedAt: new Date().toISOString(),
      method: `npm search for ${provider.queries.map((query) => JSON.stringify(query)).join(', ')} (${PAGES} pages of ${PAGE_SIZE}); latest manifest declares ${sdks.join(' or ')} in dependencies; github.com repository; published since ${PUBLISHED_SINCE}; vendor scopes excluded; ranked by monthly downloads; one entry per repository; frozen at HEAD from git ls-remote.`,
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);
console.error(`Selected ${selected.length}; rejected ${JSON.stringify(rejected)}`);

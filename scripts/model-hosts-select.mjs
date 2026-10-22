// Selects the frozen sample for cloud-hosted model detection (docs/MODEL-HOSTS.md): public GitHub
// repositories that ship an npm package calling models through Amazon Bedrock, Azure OpenAI or
// OpenRouter. GitHub code search is unavailable here, so, as scripts/ai-sdk-select.mjs does,
// candidates come from npm search. A package qualifies for a host when its latest manifest
// declares that host's SDK in `dependencies` (or, for Azure OpenAI and OpenRouter, declares
// `openai` and names the host in its description or keywords), links a github.com repository and
// was published since 2024-01. Ranked by monthly downloads, one entry per repository, frozen at
// the commit `git ls-remote` reports for HEAD. Nothing is installed or executed.
//
//   node scripts/model-hosts-select.mjs --count 15 --output <frozen.json>
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';
const PAGE_SIZE = 250;
const PAGES = 2;
const PUBLISHED_SINCE = '2024-01-01';
const VENDOR_SCOPES = ['@aws-sdk/', '@azure/', '@openrouter/', '@anthropic-ai/', '@smithy/'];
const HOSTS = {
  bedrock: {
    queries: ['bedrock', 'aws bedrock', 'amazon bedrock'],
    sdks: ['@aws-sdk/client-bedrock-runtime', '@anthropic-ai/bedrock-sdk'],
  },
  'azure-openai': {
    queries: ['azure openai', 'azure ai', 'azure'],
    sdks: ['@azure/openai'],
    mention: /\bazure\b/i,
  },
  openrouter: {
    queries: ['openrouter'],
    sdks: ['@openrouter/ai-sdk-provider', '@openrouter/sdk'],
    mention: /\bopenrouter\b/i,
  },
};

const { values } = parseArgs({
  options: { count: { type: 'string' }, output: { type: 'string' } },
});
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

const seen = new Set();
const selected = [];
const rejected = {};
const reject = (host, reason) => {
  rejected[host] ??= {};
  rejected[host][reason] = (rejected[host][reason] ?? 0) + 1;
};
for (const [host, rule] of Object.entries(HOSTS)) {
  const candidates = new Map();
  for (const query of rule.queries)
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
  const ranked = [...candidates.values()].sort(
    (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
  );
  let kept = 0;
  for (const candidate of ranked) {
    if (kept >= count) break;
    if (VENDOR_SCOPES.some((scope) => candidate.name.startsWith(scope))) {
      reject(host, 'vendor');
      continue;
    }
    if (!candidate.date || candidate.date < PUBLISHED_SINCE) {
      reject(host, 'old');
      continue;
    }
    const manifest = await json(`${REGISTRY}/${candidate.name.replace('/', '%2F')}/latest`);
    const dependencies = manifest?.dependencies ?? {};
    const text = `${manifest?.description ?? ''} ${(manifest?.keywords ?? []).join(' ')}`;
    const sdk =
      rule.sdks.find((name) => dependencies[name]) ??
      (rule.mention && dependencies.openai && rule.mention.test(text) ? 'openai' : undefined);
    if (!sdk) {
      reject(host, 'noDependency');
      continue;
    }
    const repo = githubRepository(
      typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
    );
    if (!repo) {
      reject(host, 'noRepository');
      continue;
    }
    if (seen.has(repo.toLowerCase())) {
      reject(host, 'duplicate');
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
      reject(host, 'unreachable');
      continue;
    }
    kept += 1;
    selected.push({
      host,
      repo,
      commit,
      package: candidate.name,
      version: manifest.version,
      sdk,
      declared: dependencies[sdk],
      monthlyDownloads: candidate.downloads,
      publishedAt: candidate.date,
    });
    console.error(`${host} [${kept}/${count}] ${repo} (${candidate.name})`);
  }
}

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      selectedAt: new Date().toISOString(),
      method: `npm search (${PAGES} pages of ${PAGE_SIZE} per query) for each host's queries; the latest manifest declares the host SDK in dependencies (Azure OpenAI and OpenRouter also: declares openai and names the host in its description or keywords); github.com repository; published since ${PUBLISHED_SINCE}; vendor scopes excluded; ranked by monthly downloads; one entry per repository across hosts; frozen at HEAD from git ls-remote.`,
      hosts: Object.fromEntries(
        Object.entries(HOSTS).map(([host, rule]) => [
          host,
          { queries: rule.queries, sdks: rule.sdks, mention: rule.mention?.source ?? null },
        ]),
      ),
      rejected,
      repos: selected,
    },
    null,
    2,
  )}\n`,
);

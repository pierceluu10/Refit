// Builds data/api-hosts.json from scripts/api-hosts-candidates.txt. Each candidate's docs page (and
// any further pages listed) is fetched and read; the host is kept only when a page that answered
// with a success status names it (for `*.example.com`, names `example.com`), and that page becomes
// the entry's `source`. Hosts any catalog agent already names are refused, so the two lists never
// overlap. Only public documentation pages are fetched; nothing is sent to the API hosts.
//
//   node scripts/api-hosts-verify.mjs [--output data/api-hosts.json] [--report unverified.txt]
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const CONCURRENCY = 8;
const TIMEOUT_MS = 25_000;
const { values } = parseArgs({
  options: {
    candidates: { type: 'string', default: 'scripts/api-hosts-candidates.txt' },
    output: { type: 'string', default: 'data/api-hosts.json' },
    report: { type: 'string' },
  },
});
const checkedAt = new Date().toISOString().slice(0, 10);
const { AGENT_CATALOG } = await import('../pipeline/agent-catalog.ts');
const catalogHosts = AGENT_CATALOG.flatMap((agent) =>
  agent.hostnames.map((name) => name.split('/')[0].toLowerCase()),
);

const candidates = (await readFile(values.candidates, 'utf8'))
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [host, provider, ...pages] = line.split('|').map((part) => part.trim());
    return { host: host.toLowerCase(), provider, pages };
  });

async function pageText(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'RefitHostCheck/1.0 (+https://github.com/pierceluu10/Refit)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? (await response.text()).toLowerCase() : null;
  } catch {
    return null;
  }
}

async function check(candidate) {
  const needle = candidate.host.replace(/^\*\./, '');
  if (
    catalogHosts.some(
      (name) => name === candidate.host || name.endsWith(`.${needle}`) || name === needle,
    )
  )
    return { candidate, reason: 'catalog host' };
  for (const page of candidate.pages) {
    const text = await pageText(page);
    if (text?.includes(needle)) return { candidate, source: page };
  }
  return { candidate, reason: 'no fetched page names the host' };
}

const results = new Array(candidates.length);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < candidates.length) {
      const index = next++;
      results[index] = await check(candidates[index]);
    }
  }),
);

const seen = new Set();
const hosts = [];
const unverified = [];
for (const { candidate, source, reason } of results) {
  if (!source) unverified.push(`${candidate.host} | ${candidate.provider} | ${reason}`);
  else if (!seen.has(candidate.host)) {
    seen.add(candidate.host);
    hosts.push({
      host: candidate.host,
      provider: candidate.provider,
      docs: candidate.pages[0],
      source,
      checkedAt,
    });
  }
}
hosts.sort((a, b) => a.host.localeCompare(b.host));
await writeFile(values.output, `${JSON.stringify({ formatVersion: 1, hosts }, null, 2)}\n`);
if (values.report) await writeFile(values.report, `${unverified.join('\n')}\n`);
console.log(`${hosts.length} verified, ${unverified.length} not verified of ${candidates.length}`);

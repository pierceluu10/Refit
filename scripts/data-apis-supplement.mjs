// Adds repositories to the frozen data-APIs sample for a provider the package search left short:
// root-level source files that name the provider's API host. Same filters and fetch as
// scripts/data-apis-select.mjs; usage: node scripts/data-apis-supplement.mjs --frozen <file> --root <dir>
// --provider intercom --host api.intercom.io --count 4
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    frozen: { type: 'string' },
    root: { type: 'string' },
    provider: { type: 'string' },
    host: { type: 'string' },
    count: { type: 'string', default: '4' },
  },
});
const gh = async (...args) => (await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const frozen = JSON.parse(await readFile(values.frozen, 'utf8'));
const taken = new Set(frozen.repos.map((entry) => entry.repo.toLowerCase()));
const q = `"${values.host}" language:TypeScript`;
const items = JSON.parse(
  await gh('api', '-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', 'per_page=100'),
).items;
let added = 0;
for (const item of items) {
  if (added >= Number(values.count)) break;
  const repo = item.repository.full_name;
  if (taken.has(repo.toLowerCase()) || new RegExp(`^${values.provider}/`, 'i').test(repo)) continue;
  taken.add(repo.toLowerCase());
  const meta = JSON.parse(await gh('api', `repos/${repo}`));
  if (meta.fork || meta.archived || meta.pushed_at < '2025-10-21' || meta.size > 60_000) continue;
  const head = (
    await execute('git', ['ls-remote', `https://github.com/${repo}.git`, 'HEAD'])
  ).stdout
    .split('\t')[0]
    .trim();
  const directory = join(resolve(values.root), repo.replace('/', '__'));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const git = (...args) => execute('git', ['-C', directory, ...args]);
  await git('init', '-q');
  await git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, head);
  await git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
  frozen.repos.push({
    provider: values.provider,
    repo,
    commit: head,
    package: null,
    host: values.host,
    stars: meta.stargazers_count,
    pushedAt: meta.pushed_at,
  });
  added++;
}
frozen.supplements = [
  ...(frozen.supplements ?? []),
  { provider: values.provider, query: q, added, at: new Date().toISOString() },
];
await writeFile(values.frozen, `${JSON.stringify(frozen, null, 2)}\n`);
console.log(`${added} added`);

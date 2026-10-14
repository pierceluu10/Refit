import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { readRepository } from './repository.ts';
import { measureCoverage, type CallSite, type CoverageProvider } from './sdk-coverage.ts';
import { PipelineInputError, type Repository } from './types.ts';

const USAGE =
  'Usage: npm run benchmark:coverage -- --repos <cloned-repos-dir> --list <pinned.json> --output <new-directory>';
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.refit']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

interface Entry {
  provider: CoverageProvider;
  repo: string;
  stars: number;
  commit: string;
}

const { values } = parseArgs({
  options: { repos: { type: 'string' }, list: { type: 'string' }, output: { type: 'string' } },
});
if (!values.repos || !values.list || !values.output) throw new PipelineInputError(USAGE);

// Measures tracing on repositories Refit's reader refuses, without applying its size limits.
async function readSources(root: string): Promise<Repository> {
  const files: Repository['files'] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await visit(path);
      } else if (SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
        if ((await stat(path)).size <= MAX_SOURCE_BYTES)
          files.push({ path: relative(root, path), content: await readFile(path, 'utf8') });
      }
    }
  };
  await visit(root);
  return { root, files, dependencies: [], lockfiles: [], warnings: [] };
}

const entries = JSON.parse(await readFile(values.list, 'utf8')) as Entry[];
await mkdir(values.output);
const results: Array<
  Entry & { refused?: string; failed?: string; files: number; sites: CallSite[] }
> = [];
for (const entry of entries) {
  const directory = join(values.repos, entry.repo.replace('/', '__'));
  const packageName =
    entry.provider === 'anthropic'
      ? '@anthropic-ai/sdk'
      : entry.provider === 'openai'
        ? 'openai'
        : 'stripe';
  let repository: Repository;
  let refused: string | undefined;
  try {
    repository = await readRepository(directory, packageName);
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    refused = error.message;
    repository = await readSources(directory);
  }
  let sites: CallSite[] = [];
  let failed: string | undefined;
  try {
    sites = measureCoverage(repository, entry.provider);
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    failed = error.message;
  }
  results.push({
    ...entry,
    ...(refused ? { refused } : {}),
    ...(failed ? { failed } : {}),
    files: repository.files.length,
    sites,
  });
  const likely = sites.filter((site) => site.likelySdk);
  console.error(
    `${entry.provider.padEnd(9)} ${entry.repo}: ${likely.filter((s) => s.traced).length}/${likely.length} traced${refused ? ' (Refit refused: size limits)' : ''}${failed ? ` (scanner failed: ${failed})` : ''}`,
  );
}

await writeFile(join(values.output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
await writeFile(join(values.output, 'report.md'), report());
console.log(`Report: ${join(values.output, 'report.md')}`);

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : 'n/a';
}

function report() {
  const providers: CoverageProvider[] = ['openai', 'anthropic', 'stripe'];
  const all = results.flatMap((result) =>
    result.sites.filter((site) => site.likelySdk).map((site) => ({ ...site, result })),
  );
  const reasons = [...new Set(all.filter((s) => !s.traced).map((s) => s.reason!))];
  const missCount = (reason: string, provider?: string) =>
    all.filter(
      (s) => !s.traced && s.reason === reason && (!provider || s.result.provider === provider),
    ).length;
  reasons.sort((a, b) => missCount(b) - missCount(a));
  const lines = [
    '# SDK call coverage benchmark',
    '',
    `Repositories: ${results.length}. Refused by Refit's reader (size limits): ${results.filter((r) => r.refused).length}; their tracing was still measured from source files. Scanner failed entirely: ${results.filter((r) => r.failed).length}${
      results.some((r) => r.failed)
        ? ` (${results
            .filter((r) => r.failed)
            .map((r) => `${r.repo}: ${r.failed}`)
            .join('; ')})`
        : ''
    }.`,
    '',
    '## Traced SDK call sites by provider',
    '',
    '| Provider | Repos | Likely SDK call sites | Traced by Refit | Coverage | Repos with zero traced |',
    '|---|---|---|---|---|---|',
    ...providers.map((provider) => {
      const sites = all.filter((s) => s.result.provider === provider);
      const repos = results.filter((r) => r.provider === provider);
      const zero = repos.filter(
        (r) => r.sites.some((s) => s.likelySdk) && !r.sites.some((s) => s.traced),
      ).length;
      return `| ${provider} | ${repos.length} | ${sites.length} | ${sites.filter((s) => s.traced).length} | ${percent(sites.filter((s) => s.traced).length, sites.length)} | ${zero} |`;
    }),
    `| **all** | ${results.length} | ${all.length} | ${all.filter((s) => s.traced).length} | **${percent(all.filter((s) => s.traced).length, all.length)}** | |`,
    '',
    '## Why calls were missed',
    '',
    `| Reason | ${providers.join(' | ')} | Total | Share of misses | Repos affected |`,
    `|---|${providers.map(() => '---').join('|')}|---|---|---|`,
    ...reasons.map(
      (reason) =>
        `| \`${reason}\` | ${providers.map((p) => missCount(reason, p)).join(' | ')} | ${missCount(reason)} | ${percent(missCount(reason), all.filter((s) => !s.traced).length)} | ${new Set(all.filter((s) => !s.traced && s.reason === reason).map((s) => s.result.repo)).size} |`,
    ),
    '',
    '## Per repository',
    '',
    '| Provider | Repository | Stars | Commit | Files | Likely SDK calls | Traced | Refused | Scanner failed |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const likely = r.sites.filter((s) => s.likelySdk);
      return `| ${r.provider} | [${r.repo}](https://github.com/${r.repo}) | ${r.stars} | \`${r.commit.slice(0, 7)}\` | ${r.files} | ${likely.length} | ${likely.filter((s) => s.traced).length} | ${r.refused ? 'yes' : ''} | ${r.failed ? 'yes' : ''} |`;
    }),
    '',
    '## Examples of each miss reason',
    '',
    ...reasons.flatMap((reason) => [
      `### \`${reason}\``,
      '',
      ...all
        .filter((s) => !s.traced && s.reason === reason)
        .slice(0, 4)
        .map((s) => `- \`${s.expression}\` in ${s.result.repo} \`${s.file}:${s.line}\``),
      '',
    ]),
    '## Excluded call sites',
    '',
    `${results.flatMap((r) => r.sites).filter((s) => !s.likelySdk).length} calls matched an SDK resource name but neither the file imports the SDK nor the receiver name suggests a client (for example \`db.customers.create\`). They are excluded from coverage.`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

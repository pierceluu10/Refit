// npm run -w providers <command> -- <provider|all> [since]
//   live-read   fetch every source and save it under <provider>/fixtures/live (no AI)
//   watch       run the watcher agent and print the report (spends AI, capped by APTITUDE_AI_BUDGET_USD)
//   knowledge   have the agent draft knowledge.json and print it (spends AI, capped)
//   any         watch any provider from hints, folder or not (spends AI, capped):
//               any <provider> [--packages a,b] [--hosts h] [--docs url,url] [--since YYYY-MM-DD]
//                   [--save <dir>] [--no-search] [--max-turns n] [--max-tokens n]
//               --save writes hints.json, packages.json, pages/ and live-run.json for offline tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAnyWatch, DEFAULT_WEB_SEARCH, type AnyWatchReport } from './any-watcher.ts';
import { httpFetcher, recordSnapshot } from './fetch.ts';
import { draftKnowledge } from './knowledge.ts';
import { budgetFromEnv } from './model.ts';
import { savePages, type PageReader } from './page-tools.ts';
import { ANY_WATCH_PROMPT_VERSION } from './prompt.ts';
import { listProviderIds, loadProvider } from './registry.ts';

const [command, target = 'all', ...rest] = process.argv.slice(2);
const budget = budgetFromEnv(1);
// GITHUB_TOKEN is optional and only ever sent to api.github.com (see httpFetcher).
const githubToken = process.env.GITHUB_TOKEN || undefined;

if (command === 'any') {
  const { values } = parseArgs({
    args: rest,
    options: {
      packages: { type: 'string' },
      hosts: { type: 'string' },
      docs: { type: 'string' },
      since: { type: 'string' },
      save: { type: 'string' },
      'no-search': { type: 'boolean' },
      'max-turns': { type: 'string' },
      'max-tokens': { type: 'string' },
    },
  });
  const list = (value?: string) =>
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const hints = {
    ...(list(values.packages) ? { packages: list(values.packages) } : {}),
    ...(list(values.hosts) ? { hosts: list(values.hosts) } : {}),
    ...(list(values.docs) ? { docsUrls: list(values.docs) } : {}),
  };
  const maxTurns = values['max-turns'] ? Number(values['max-turns']) : undefined;
  const maxTokens = values['max-tokens'] ? Number(values['max-tokens']) : undefined;
  let reader: PageReader | undefined;
  const runAt = new Date().toISOString();
  const report: AnyWatchReport = await runAnyWatch(target, hints, values.since, {
    budget,
    fetcher: httpFetcher({ githubToken }),
    webSearch: values['no-search'] ? false : undefined,
    maxTurns,
    maxTokens,
    onPages: (pages) => (reader = pages),
  });
  console.log(JSON.stringify(report, null, 2));
  if (values.save && reader) {
    const dir = resolve(values.save);
    mkdirSync(dir, { recursive: true });
    savePages(reader, join(dir, 'pages'), { provider: report.provider });
    writeFileSync(
      join(dir, 'hints.json'),
      `${JSON.stringify({ provider: target, hints, since: values.since }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'packages.json'), `${JSON.stringify(report.packages, null, 2)}\n`);
    const record = {
      note: `Live run: ${report.model} through the Messages API on ${runAt.slice(0, 10)}, reading live pages${values['no-search'] ? '' : ' with web search'}. pages/ keeps what the agent was shown. Output recorded as returned, not edited.`,
      runAt,
      model: report.model,
      promptVersion: ANY_WATCH_PROMPT_VERSION,
      input: {
        provider: target,
        hints,
        ...(values.since ? { since: values.since } : {}),
        maxTurns: maxTurns ?? 20,
        maxTokens: maxTokens ?? 16_000,
        webSearch: values['no-search'] ? false : DEFAULT_WEB_SEARCH,
        capUsd: budget.capUsd,
      },
      report,
    };
    writeFileSync(join(dir, 'live-run.json'), `${JSON.stringify(record, null, 2)}\n`);
    console.error(`saved ${dir}`);
  }
  console.error(
    `${report.provider}: ${report.changes.length} changes, ${report.unverifiedQuotes.length} unverified quotes, ${report.issues.length} issues, ${report.turns} turns`,
  );
  console.error(`AI spend: $${budget.spentUsd.toFixed(4)} of $${budget.capUsd}`);
} else {
  const since = rest[0];
  const ids = target === 'all' ? listProviderIds() : [target];
  for (const id of ids) {
    const provider = loadProvider(id);
    if (command === 'live-read') {
      const fetcher = httpFetcher({ githubToken });
      const manifest = await recordSnapshot(provider, join(provider.dir, 'fixtures', 'live'), {
        fetcher,
      });
      for (const source of manifest.sources) {
        console.log(
          `${id}/${source.id}: ${source.ok ? 'ok' : 'FAILED'} ${source.status} ${source.chars} chars${source.error ? ` (${source.error})` : ''}`,
        );
      }
    } else if (command === 'watch') {
      // The production path: discovery with the folder as its head start.
      const report = await runAnyWatch(provider.id, {}, since, {
        budget,
        fetcher: httpFetcher({ githubToken }),
      });
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'knowledge') {
      console.log(JSON.stringify(await draftKnowledge(provider, [], { budget }), null, 2));
    } else {
      console.error(
        'usage: cli.ts <live-read|watch|knowledge> <provider|all> [since]\n       cli.ts any <provider> [--packages a,b] [--hosts h] [--docs url] [--since d] [--save dir]',
      );
      process.exit(2);
    }
  }
  if (command !== 'live-read')
    console.error(`AI spend: $${budget.spentUsd.toFixed(4)} of $${budget.capUsd}`);
}

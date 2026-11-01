// npm run -w providers <command> -- <provider|all> [since]
//   live-read   fetch every source and save it under <provider>/fixtures/live (no AI)
//   watch       run the watcher agent and print the report (spends AI, capped by APTITUDE_AI_BUDGET_USD)
//   knowledge   have the agent draft knowledge.json and print it (spends AI, capped)

import { join } from 'node:path';
import { httpFetcher, recordSnapshot } from './fetch.ts';
import { draftKnowledge } from './knowledge.ts';
import { budgetFromEnv } from './model.ts';
import { listProviderIds, loadProvider } from './registry.ts';
import { runWatch } from './watcher.ts';

const [command, target = 'all', since] = process.argv.slice(2);
const ids = target === 'all' ? listProviderIds() : [target];
const budget = budgetFromEnv(1);

for (const id of ids) {
  const provider = loadProvider(id);
  if (command === 'live-read') {
    // GITHUB_TOKEN is optional and only ever sent to api.github.com (see httpFetcher).
    const fetcher = httpFetcher({ githubToken: process.env.GITHUB_TOKEN || undefined });
    const manifest = await recordSnapshot(provider, join(provider.dir, 'fixtures', 'live'), {
      fetcher,
    });
    for (const source of manifest.sources) {
      console.log(
        `${id}/${source.id}: ${source.ok ? 'ok' : 'FAILED'} ${source.status} ${source.chars} chars${source.error ? ` (${source.error})` : ''}`,
      );
    }
  } else if (command === 'watch') {
    console.log(JSON.stringify(await runWatch(provider, since, { budget }), null, 2));
  } else if (command === 'knowledge') {
    console.log(JSON.stringify(await draftKnowledge(provider, [], { budget }), null, 2));
  } else {
    console.error('usage: cli.ts <live-read|watch|knowledge> <provider|all> [since]');
    process.exit(2);
  }
}
if (command !== 'live-read')
  console.error(`AI spend: $${budget.spentUsd.toFixed(4)} of $${budget.capUsd}`);

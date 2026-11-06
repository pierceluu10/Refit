// One real match run on the illustrative fixtures:
//   REFIT_AI_BUDGET_USD=3 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts              (API changes)
//   REFIT_AI_BUDGET_USD=3 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts --external   (the three sample repos)
//   REFIT_AI_BUDGET_USD=3 node orchestrator/match-real.ts --agent-sdk   (logged-in Claude Code credentials)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ApiUsage, ExternalChange, ProviderChange } from '../shared/types.ts';
import { agentSdk } from './agent-sdk.ts';
import { createBudget } from './budget.ts';
import { createExternalMatchAgent } from './external-match.ts';
import { createMatchAgent } from './match.ts';
import { stubInventoryDependencies } from './stubs-external.ts';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const viaAgentSdk = process.argv.includes('--agent-sdk');
const external = process.argv.includes('--external');
if (!viaAgentSdk && !process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; the real match run was not done.');
  process.exit(0);
}
const budget = createBudget();
const ask = viaAgentSdk ? agentSdk({ budget }) : undefined;

if (external) {
  // Every fixture change against every sample, so the agent has to judge the irrelevant ones too.
  const changes: ExternalChange[] = load('external-changes.json');
  const match = createExternalMatchAgent({ ask, budget });
  for (const name of ['demo-node-api', 'demo-next-web', 'demo-python-app']) {
    const dir = fileURLToPath(new URL(`./fixtures/samples/${name}`, import.meta.url));
    const dependencies = await stubInventoryDependencies()(dir, name);
    const usages: ApiUsage[] = load(`samples/${name}/usages.json`);
    const result = await match({ repo: name, changes, dependencies, usages, repoDir: dir });
    console.log(`\n# ${name}`);
    for (const t of result.tasks)
      console.log(
        `task ${t.priority}: ${t.change.id} (${t.impact}) moves ${t.dependencies.map((d) => d.name).join(', ')}${t.alsoResolves.length ? `; also ${t.alsoResolves.map((a) => a.changeId).join(', ')}` : ''}\n  ${t.reasoning}`,
      );
    for (const n of result.notAffected)
      console.log(`not affected: ${n.changeId}\n  ${n.reasoning}`);
    console.log(`costUsd: ${result.costUsd}`);
  }
} else {
  const changes: ProviderChange[] = load('changes.json');
  const usages: ApiUsage[] = load('usages.json');
  const result = await createMatchAgent({ ask, budget })({ repo: 'example/shop', changes, usages });
  console.log(JSON.stringify(result, null, 2));
  console.log(`costUsd: ${result.costUsd}`);
}
console.log(
  `transport: ${viaAgentSdk ? 'Claude Agent SDK (cost is its estimate, not a bill)' : 'Messages API'}`,
);
console.log(`budget.spentUsd(): ${budget.spentUsd()} of $${budget.capUsd}`);

// One real match run on the illustrative fixtures:
//   REFIT_AI_BUDGET_USD=2 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts
//   REFIT_AI_BUDGET_USD=2 node orchestrator/match-real.ts --agent-sdk   (logged-in Claude Code credentials)
import { readFileSync } from 'node:fs';
import type { ApiUsage, ProviderChange } from '../shared/types.ts';
import { agentSdk } from './agent-sdk.ts';
import { createBudget } from './budget.ts';
import { createMatchAgent } from './match.ts';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const changes: ProviderChange[] = load('changes.json');
const usages: ApiUsage[] = load('usages.json');

const viaAgentSdk = process.argv.includes('--agent-sdk');
if (!viaAgentSdk && !process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; the real match run was not done.');
  process.exit(0);
}
const budget = createBudget();
const ask = viaAgentSdk ? agentSdk({ budget }) : undefined;

const result = await createMatchAgent({ ask, budget })({ repo: 'example/shop', changes, usages });
console.log(JSON.stringify(result, null, 2));
console.log(
  `transport: ${viaAgentSdk ? 'Claude Agent SDK (cost is its estimate, not a bill)' : 'Messages API'}`,
);
console.log(`costUsd: ${result.costUsd}`);
console.log(`budget.spentUsd(): ${budget.spentUsd()} of $${budget.capUsd}`);

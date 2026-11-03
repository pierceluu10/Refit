// One real match run on the illustrative fixtures:
//   APTITUDE_AI_BUDGET_USD=2 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts
//   APTITUDE_AI_BUDGET_USD=2 node orchestrator/match-real.ts --agent-sdk   (logged-in Claude Code credentials)
// The round 3 task-shape check (one task per upgrade) on jiro, financehb, branded and lobe-chat:
//   APTITUDE_AI_BUDGET_USD=5 ANTHROPIC_API_KEY=... node orchestrator/match-real.ts --round-3
import { readFileSync } from 'node:fs';
import type { ApiUsage, ProviderChange } from '../shared/types.ts';
import { agentSdk } from './agent-sdk.ts';
import { createBudget } from './budget.ts';
import { createMatchAgent, type MatchResult } from './match.ts';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

type Round3 = {
  changes: Record<string, ProviderChange[]>;
  repos: {
    repo: string;
    provider: string;
    usages: ApiUsage[];
    expect: { oneTask: string[]; separate: string[] };
  }[];
};

// What went wrong with the task shape, or nothing: the oneTask changes that came back affected all
// sit in one task, there is only that one task, and no separate change is bundled into another.
export function shapeProblems(result: MatchResult, expect: Round3['repos'][number]['expect']) {
  const taskOf = new Map<string, string>();
  for (const task of result.tasks) {
    taskOf.set(task.change.id, task.id);
    for (const b of task.alsoResolves ?? []) taskOf.set(b.change.id, task.id);
  }
  const problems: string[] = [];
  const upgrade = new Set(expect.oneTask.flatMap((id) => taskOf.get(id) ?? []));
  if (upgrade.size > 1) problems.push(`the upgrade is split over ${upgrade.size} tasks`);
  if (expect.oneTask.length && result.tasks.length > 1) {
    problems.push(`${result.tasks.length} tasks where the upgrade should be the only one`);
  }
  for (const id of expect.separate) {
    const task = result.tasks.find((t) => t.alsoResolves?.some((b) => b.change.id === id));
    if (task) problems.push(`${id} is bundled into ${task.id}`);
    else if (!result.tasks.some((t) => t.change.id === id)) problems.push(`${id} has no task`);
  }
  return problems;
}

const viaAgentSdk = process.argv.includes('--agent-sdk');
if (!viaAgentSdk && !process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; the real match run was not done.');
  process.exit(0);
}
const budget = createBudget();
const ask = viaAgentSdk ? agentSdk({ budget }) : undefined;
const match = createMatchAgent({ ask, budget });

if (process.argv.includes('--round-3')) {
  const round3: Round3 = load('round-3.json');
  for (const { repo, provider, usages, expect } of round3.repos) {
    const result = await match({ repo, changes: round3.changes[provider], usages });
    const problems = shapeProblems(result, expect);
    console.log(`\n## ${repo}: ${result.tasks.length} task(s), $${result.costUsd.toFixed(4)}`);
    for (const task of result.tasks) {
      console.log(`- ${task.change.id} (${task.urgency})`);
      for (const b of task.alsoResolves ?? []) console.log(`    + ${b.change.id}: ${b.why}`);
    }
    console.log(problems.length ? `SHAPE FAIL: ${problems.join('; ')}` : 'SHAPE OK');
  }
} else {
  const changes: ProviderChange[] = load('changes.json');
  const usages: ApiUsage[] = load('usages.json');
  const result = await match({ repo: 'example/shop', changes, usages });
  console.log(JSON.stringify(result, null, 2));
  console.log(`costUsd: ${result.costUsd}`);
}
console.log(
  `transport: ${viaAgentSdk ? 'Claude Agent SDK (cost is its estimate, not a bill)' : 'Messages API'}`,
);
console.log(`budget.spentUsd(): ${budget.spentUsd()} of $${budget.capUsd}`);

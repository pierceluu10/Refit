#!/usr/bin/env node
// Learns from stored runs, in a batch, off the fix path. It spends only memory's own small budget:
// unset, nothing is spent. With an API key it uses the Message Batches API at half price; without
// one, the Agent SDK on the machine's login, at full price.
//   APTITUDE_MEMORY_BUDGET_USD=0.50 node memory/scripts/learn.ts
import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentSdkModel,
  Budget,
  customerStores,
  defaultMemory,
  learnPending,
  memoryDir,
  type Model,
} from '../index.ts';
import { BatchModel, LEARN_MODEL } from '../batch.ts';

export function learnModel(env: NodeJS.ProcessEnv, budget: Budget): Model {
  return env.ANTHROPIC_API_KEY
    ? new BatchModel(new Anthropic(), budget)
    : new AgentSdkModel(budget, query, LEARN_MODEL);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const budget = new Budget(Number(env.APTITUDE_MEMORY_BUDGET_USD ?? 0));
  if (budget.capUsd === 0) {
    console.log(
      'learn: APTITUDE_MEMORY_BUDGET_USD is unset, so nothing runs and nothing is spent.',
    );
    return;
  }
  const { embedder } = defaultMemory();
  let learned = 0;
  let failed = 0;
  // One customer at a time: a recipe never mixes two customers' runs.
  for (const store of customerStores(memoryDir(env))) {
    const result = await learnPending({ store, embedder, model: learnModel(env, budget) });
    learned += result.learned;
    failed += result.failed;
  }
  console.log(
    `learn: ${learned} run(s) learned from, ${failed} failed, $${budget.spentUsd.toFixed(4)} of $${budget.capUsd} spent`,
  );
}

if (process.argv[1] === import.meta.filename) await main();

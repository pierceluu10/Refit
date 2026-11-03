import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ApiUsage, ProviderChange } from '../shared/types.ts';
import { BudgetExceededError, createBudget } from './budget.ts';
import { createMatchAgent } from './match.ts';
// Illustrative fixtures for the made-up repo example/shop, not real customer data.
import changesJson from './fixtures/changes.json';
import usagesJson from './fixtures/usages.json';
// Real recorded changes with usage maps rebuilt from the 2026-11-03 benchmark; see its note.
import round3 from './fixtures/round-3.json';

const changes = changesJson as ProviderChange[];
const usages = usagesJson as ApiUsage[];
const repo = 'example/shop';

const usage = { input_tokens: 10_000, output_tokens: 2_000 } as Anthropic.Usage;

function fakeClient(output: unknown, stopReason = 'end_turn') {
  const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) => ({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stopReason,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage,
  }));
  return { client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>, create };
}

const agentOutput = {
  tasks: [
    {
      changeId: 'openai-gpt-4o-retirement',
      usageIndexes: [1],
      callSites: [{ file: 'src/support/reply.ts', line: 27, why: 'names gpt-4o' }],
      reasoning: 'The support reply calls gpt-4o, which is shut down first.',
      urgency: 'critical',
      deadline: '2027-01-15',
    },
    {
      changeId: 'stripe-charges-source-removed',
      usageIndexes: [0],
      callSites: [{ file: 'src/checkout.ts', line: 42, why: 'passes source' }],
      reasoning: 'Checkout passes source to charges.create.',
      urgency: 'high',
      deadline: '2027-03-01',
    },
  ],
  notAffected: [{ changeId: 'twilio-conversations-webhook-payload', reasoning: 'Only sends SMS.' }],
};

describe('createMatchAgent', () => {
  it('builds ranked tasks from the agent output with change and usages attached', async () => {
    const { client } = fakeClient(agentOutput);
    const match = createMatchAgent({ client, budget: createBudget(2) });
    const result = await match({ repo, changes, usages });

    expect(result.tasks.map((t) => [t.id, t.priority])).toEqual([
      ['example/shop:openai-gpt-4o-retirement', 1],
      ['example/shop:stripe-charges-source-removed', 2],
      ['example/shop:shopify-rest-products-deprecated', 3],
    ]);
    const [first] = result.tasks;
    expect(first.change).toBe(changes[1]);
    expect(first.usages).toEqual([usages[1]]);
    expect(first.deadline).toBe('2027-01-15');
    expect(first.urgency).toBe('critical');
    expect(first.callSites[0].why).toBe('names gpt-4o');
  });

  it('attempts a change the model omitted instead of dropping it or calling it not affected', async () => {
    const { client } = fakeClient(agentOutput);
    const result = await createMatchAgent({ client, budget: createBudget(2) })({
      repo,
      changes,
      usages,
    });
    expect(result.notAffected).toEqual([
      { changeId: 'twilio-conversations-webhook-payload', reasoning: 'Only sends SMS.' },
    ]);
    const omitted = result.tasks.find((t) => t.change.id === 'shopify-rest-products-deprecated');
    expect(omitted?.usages).toEqual(usages);
    expect(omitted?.notes).toMatch(/no verdict/);
  });

  it('charges the budget from the response usage', async () => {
    const { client } = fakeClient(agentOutput);
    const budget = createBudget(2);
    const result = await createMatchAgent({ client, budget })({ repo, changes, usages });
    // 10k input at $4/M + 2k output at $20/M
    expect(result.costUsd).toBeCloseTo(0.08, 10);
    expect(budget.spentUsd()).toBeCloseTo(0.08, 10);
  });

  it('refuses before calling the model when the cap cannot cover the worst case', async () => {
    const { client, create } = fakeClient(agentOutput);
    const match = createMatchAgent({ client, budget: createBudget(0.01) });
    await expect(match({ repo, changes, usages })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });

  it('settles the hold whatever the call does', async () => {
    const budget = createBudget(2);
    const create = vi
      .fn()
      // An error the API answered with is not billed.
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      // A response without usage may have been billed, so it counts the whole hold.
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
    const match = createMatchAgent({ client, budget });

    await expect(match({ repo, changes, usages })).rejects.toThrow('overloaded');
    expect(budget.spentUsd()).toBe(0);
    await expect(match({ repo, changes, usages })).rejects.toThrow();
    expect(budget.spentUsd()).toBeGreaterThan(0.3);
    expect(budget.heldUsd()).toBe(0);
  });

  it('throws on a refusal instead of parsing it', async () => {
    const { client } = fakeClient(agentOutput, 'refusal');
    const match = createMatchAgent({ client, budget: createBudget(2) });
    await expect(match({ repo, changes, usages })).rejects.toThrow(/refused/);
  });

  it('throws when the output was cut off at max_tokens', async () => {
    const { client } = fakeClient(agentOutput, 'max_tokens');
    const match = createMatchAgent({ client, budget: createBudget(2) });
    await expect(match({ repo, changes, usages })).rejects.toThrow(/max_tokens/);
  });

  it('judges each half of a batch whose answer was cut off, rather than none of it', async () => {
    const create = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const prompt = params.messages[0].content as string;
      const ids = changes.map((c) => c.id).filter((id) => prompt.includes(`"id": "${id}"`));
      const output = {
        tasks: [],
        notAffected: ids.map((changeId) => ({ changeId, reasoning: '-' })),
      };
      return {
        stop_reason: ids.length === changes.length ? 'max_tokens' : 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(output) }],
        usage,
      };
    });
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
    const budget = createBudget(2);
    const result = await createMatchAgent({ client, budget })({ repo, changes, usages });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.notAffected.map((n) => n.changeId)).toEqual(changes.map((c) => c.id));
    // The cut-off call was billed too.
    expect(result.costUsd).toBeCloseTo(0.24, 10);
    expect(budget.spentUsd()).toBeCloseTo(0.24, 10);
  });

  it('sends every change with hints and does not filter on overlap', async () => {
    const { client, create } = fakeClient(agentOutput);
    await createMatchAgent({ client, budget: createBudget(2) })({ repo, changes, usages });

    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params).not.toHaveProperty('temperature');
    expect(params.output_config?.format?.type).toBe('json_schema');
    const prompt = params.messages[0].content as string;
    expect(prompt).toContain('HINTS (string overlap only, may be wrong');
    // The Shopify change has no string overlap with the repo's REST call, yet it still reaches the model.
    expect(prompt).toContain('shopify-rest-products-deprecated: usage 2 (same provider)');
    for (const change of changes) expect(prompt).toContain(`"id": "${change.id}"`);
  });

  describe('one task per upgrade', () => {
    const jiro = round3.repos[0];
    const stripe = round3.changes.stripe as ProviderChange[];
    const upgrade = 'stripe:node-v23-0-0';
    const bundled = [
      'stripe:2026-09-30-endive-api-version',
      'stripe:2026-09-30-endive-checkout-remove-payment-method-types',
      'stripe:node-v23-drop-node18',
    ];
    const answer = (extraTasks: object[] = []) => ({
      tasks: [
        {
          changeId: upgrade,
          alsoResolves: bundled.map((changeId) => ({
            changeId,
            why: `the v23 bump forces ${changeId}`,
          })),
          usageIndexes: [0],
          callSites: [
            { file: 'src/trpc/controller/index.ts', line: 102, why: 'payment_method_types' },
          ],
          reasoning: 'Upgrade stripe-node 14 to 23, which pins Endive.',
          urgency: 'medium',
          deadline: '',
        },
        ...extraTasks,
      ],
      notAffected: stripe
        .filter((c) => c.id !== upgrade && !bundled.includes(c.id))
        .map((c) => ({ changeId: c.id, reasoning: 'not used' })),
    });
    const run = (output: unknown) =>
      createMatchAgent({ ask: async () => ({ output, costUsd: 0 }), budget: createBudget(2) })({
        repo: jiro.repo,
        changes: stripe,
        usages: jiro.usages as ApiUsage[],
      });

    it('makes one task that carries every change the upgrade resolves', async () => {
      const result = await run(answer());
      expect(result.tasks).toHaveLength(1);
      const [task] = result.tasks;
      expect(task.change.id).toBe(upgrade);
      expect(task.alsoResolves?.map((b) => b.change.id)).toEqual(bundled);
      expect(task.deadline).toBe('2026-09-30');
      // The harness reads the bundled changes, with their sources, in the task's notes.
      for (const id of bundled) {
        const change = stripe.find((c) => c.id === id)!;
        expect(task.notes).toContain(id);
        expect(task.notes).toContain(change.source.url);
      }
      // Each bundled change keeps a verdict that names the task resolving it, so the loop makes no
      // second task for it.
      for (const id of bundled) {
        expect(result.notAffected.find((n) => n.changeId === id)?.reasoning).toMatch(
          `resolved inside ${task.id}`,
        );
      }
      expect(result.tasks.length + result.notAffected.length).toBe(stripe.length);
    });

    it('keeps a change its own task when the model also bundled it', async () => {
      const own = {
        changeId: bundled[0],
        alsoResolves: [],
        usageIndexes: [0],
        callSites: [],
        reasoning: 'Needs its own edit.',
        urgency: 'low',
        deadline: '',
      };
      const result = await run(answer([own]));
      expect(result.tasks.map((t) => t.change.id)).toEqual([upgrade, bundled[0]]);
      expect(result.tasks[0].alsoResolves?.map((b) => b.change.id)).toEqual(bundled.slice(1));
    });

    it('tells the model to make one task per upgrade and keep independent changes apart', async () => {
      const { client, create } = fakeClient(answer());
      await createMatchAgent({ client, budget: createBudget(2) })({ repo, changes, usages });
      const params = create.mock.calls[0][0];
      expect(params.system).toContain('One task per upgrade');
      expect(params.system).toContain('Twelve retired models the repo names are twelve tasks.');
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTool } from '../shared/types.ts';
import { claudeAgentSession, toSdkTool } from './agent.ts';
import { BudgetLedger } from './ledger.ts';
import type { Sandbox } from './types.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));

describe('toSdkTool', () => {
  it('keeps the JSON Schema properties and returns the tool output as text', async () => {
    const echo: AgentTool = {
      name: 'echo',
      description: 'Echo the input',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, times: { type: 'number' } },
        required: ['text'],
      },
      run: async (input, context) => `${JSON.stringify(input)} in ${context.repoDir}`,
    };
    const converted = toSdkTool(echo, '/sandbox');
    expect(Object.keys(converted.inputSchema)).toEqual(['text', 'times']);
    const result = await converted.handler({ text: 'hi' }, undefined);
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"hi"} in /sandbox' }]);
  });
});

// Partial SDK messages: only the fields the session reads.
const event = (body: object) =>
  ({ type: 'stream_event', event: body, parent_tool_use_id: null }) as unknown as SDKMessage;
const callStart = event({
  type: 'message_start',
  message: {
    model: 'claude-sonnet-5-5',
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 10_000,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    },
  },
});
const callEnd = event({
  type: 'message_delta',
  usage: {
    input_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens: 500,
  },
});
const result = (totalCostUsd: number) =>
  ({
    type: 'result',
    subtype: 'success',
    session_id: 'session-1',
    total_cost_usd: totalCostUsd,
    num_turns: 1,
    result: 'done',
  }) as unknown as SDKMessage;

// At Sonnet 5.5 rates: 1,000 input at $2/M, 10,000 5-minute cache writes at $2.50/M, 500 output at $10/M.
const CALL_USD = 0.002 + 0.025 + 0.005;

function session(messages: SDKMessage[], failure?: Error, budgetUsd = 4) {
  // Like the SDK, the fake stops when the session aborts the query.
  vi.mocked(query).mockImplementation((({ options }: Parameters<typeof query>[0]) =>
    (async function* () {
      for (const message of messages) {
        if (options?.abortController?.signal.aborted) throw new Error('aborted by the caller');
        yield message;
      }
      if (failure) throw failure;
    })()) as unknown as typeof query);
  const charges: [number, string][] = [];
  const logged: unknown[] = [];
  const ledger = new BudgetLedger(5, (usd, label) => charges.push([usd, label]));
  const run = claudeAgentSession({
    model: 'claude-sonnet-5-5',
    systemPrompt: 'system',
    prompt: 'go',
    tools: [],
    sandbox: { dir: '/sandbox' } as Sandbox,
    ledger,
    budgetUsd,
    maxTurns: 10,
    log: (message) => logged.push(message),
  });
  return { run, ledger, charges, logged };
}

describe('claudeAgentSession charging', () => {
  it('charges each model call while it streams, so a query that dies mid-run has reported its spend', async () => {
    const { run, ledger, charges, logged } = session(
      [callStart, callEnd],
      new Error('connection reset'),
    );
    const outcome = await run;
    expect(outcome).toMatchObject({ stopReason: 'error', error: 'connection reset' });
    expect(ledger.spentUsd).toBeCloseTo(CALL_USD);
    expect(charges).toEqual([
      [expect.closeTo(0.027 + 0.00001), 'harness claude-sonnet-5-5: model call'],
      [expect.closeTo(0.005 - 0.00001), 'harness claude-sonnet-5-5: model call'],
    ]);
    // Stream events feed the meter, not the transcript.
    expect(logged).toEqual([]);
  });

  it('estimates the web searches the stream did not show when no result arrives', async () => {
    const search = event({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} },
    });
    const stopped = session([callStart, search, callEnd], new Error('connection reset'));
    await stopped.run;
    // 20,000 input tokens at $2/M plus the $0.01 search fee.
    expect(stopped.ledger.entries.at(-1)).toMatchObject({
      costUsd: expect.closeTo(0.05),
      note: '1 web search, estimated',
    });
    const finished = session([callStart, search, callEnd, result(0.1)]);
    await finished.run;
    expect(finished.ledger.entries.map((entry) => entry.note)).not.toContain(
      '1 web search, estimated',
    );
  });

  it("charges only what the SDK's total adds beyond the live charges", async () => {
    const { run, ledger } = session([callStart, callEnd, result(0.05)]);
    expect(await run).toMatchObject({ stopReason: 'done', sessionId: 'session-1' });
    expect(ledger.spentUsd).toBeCloseTo(0.05);
    expect(ledger.entries.at(-1)).toMatchObject({
      costUsd: expect.closeTo(0.05 - CALL_USD),
      note: expect.stringContaining('beyond its live charges'),
    });
  });

  it('stops the query mid-turn once its metered spend reaches the grant', async () => {
    const { run, ledger } = session([callStart, callEnd, callStart, callEnd], undefined, 0.02);
    const outcome = await run;
    expect(outcome.stopReason).toBe('budget');
    expect(outcome.error).toMatch(/^stopped mid-turn: \$0\.0270 spent of this query's \$0\.0200/);
    // The first call's input crossed the grant; its output and the second call never ran.
    expect(ledger.entries).toHaveLength(1);
  });

  it('keeps a live charge that came out above the SDK total rather than refunding it', async () => {
    const { run, ledger } = session([callStart, callEnd, result(0.03)]);
    await run;
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.spentUsd).toBeCloseTo(CALL_USD);
  });
});

describe('claudeAgentSession tools', () => {
  it("gives the agent only Refit's tools, never the host's claude.ai connectors", async () => {
    const { run } = session([result(0)]);
    await run;
    const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
    expect(Object.keys(options.mcpServers!)).toEqual(['refit']);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    // The env replaces the subprocess environment, so it must still carry what the CLI needs.
    expect(options.env?.PATH).toBe(process.env.PATH);
  });
});

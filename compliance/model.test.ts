import { describe, expect, it } from 'vitest';
import {
  anthropicClient,
  Budget,
  BudgetExceededError,
  createComplianceModel,
  fakeModel,
  metered,
} from './model.ts';
import { findClaims, redactSecrets, scrubClaims } from './wording.ts';

const request = { system: 's', messages: [], tools: [], maxTokens: 1_000 };

describe('the run-level dollar cap', () => {
  it('refuses to build a model without REFIT_AI_BUDGET_USD', () => {
    expect(() => createComplianceModel({ ANTHROPIC_API_KEY: 'test-key' })).toThrow(
      /REFIT_AI_BUDGET_USD/,
    );
    expect(() => createComplianceModel({ REFIT_AI_BUDGET_USD: '4' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => new Budget(0)).toThrow();
  });

  it('charges each call and refuses one whose worst case does not fit', async () => {
    const budget = new Budget(0.05);
    const model = metered(
      fakeModel(() => ({ text: 'ok' }), 'claude-sonnet-5-5'),
      budget,
    );
    await model.complete(request);
    // 1,000 input and 200 output tokens at $2 and $10 per million.
    expect(budget.spentUsd).toBeCloseTo(0.004, 6);
    await expect(model.complete({ ...request, maxTokens: 10_000 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });
});

describe('anthropicClient', () => {
  it('sends a Messages API request and never echoes the key', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const client = anthropicClient({
      apiKey: 'test-key-value',
      model: 'claude-haiku-5-5',
      fetch: async (url, init) => {
        sent = { url, init };
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200 },
        );
      },
    });
    const response = await client.complete(request);
    expect(sent!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(String(sent!.init.body))).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1_000,
    });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 2 });

    const failing = anthropicClient({
      apiKey: 'test-key-value',
      fetch: async () => new Response('{"error":"overloaded"}', { status: 529 }),
    });
    const error = await failing.complete(request).catch((e: Error) => e);
    expect(String(error)).toContain('Anthropic API 529');
    expect(String(error)).not.toContain('test-key-value');
  });
});

describe('wording', () => {
  it('finds compliance claims and legal conclusions', () => {
    expect(findClaims('The page is now compliant.')).toEqual(['now compliant']);
    expect(findClaims('This change meets GDPR Article 17.').length).toBe(1);
    expect(findClaims('in compliance with PCI DSS')).toEqual(['in compliance with']);
    expect(findClaims('Adds a label to the email input.')).toEqual([]);
    expect(scrubClaims('Checkout is fully compliant.')).toBe(
      'Checkout is [claim removed: needs human review].',
    );
  });

  it('redacts common secret shapes', () => {
    expect(redactSecrets('key sk-ant-api03-abcdefghijklmnopqrstuv')).toBe('key [redacted]');
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('[redacted]');
    expect(redactSecrets('no secrets here')).toBe('no secrets here');
  });
});

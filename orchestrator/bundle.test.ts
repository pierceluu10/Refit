import { describe, expect, it } from 'vitest';
import { bundleTasks } from './bundle.ts';
import type { MatchedTask } from './match.ts';

const task = (id: string, provider: string, priority: number): MatchedTask => ({
  id: `acme/shop:${provider}:${id}`,
  repo: 'acme/shop',
  change: {
    provider,
    id,
    kind: 'model-retirement',
    title: `${id} retires`,
    source: { url: `https://example.com/${id}`, quote: `${id} shuts down.` },
    affects: { operations: [id] },
  },
  usages: [{ provider, via: 'sdk', callSites: [] } as never],
  priority,
  reasoning: `the repo calls ${id}`,
  urgency: 'high',
  callSites: [{ file: 'src/ai.ts', line: priority, why: id }],
});

describe('bundleTasks', () => {
  it("puts one provider's changes for a repo into one task, and keeps providers apart", () => {
    const bundled = bundleTasks([
      task('gpt-4', 'openai', 2),
      task('gpt-3.5', 'openai', 1),
      task('claude-3', 'anthropic', 3),
    ]);
    expect(bundled).toHaveLength(2);
    const openai = bundled.find((t) => t.change.provider === 'openai');
    expect(openai?.id).toBe('acme/shop:openai:gpt-3.5+1');
    expect(openai?.change.title).toBe('2 changes: gpt-3.5 retires and more');
    expect(openai?.notes).toContain('1. gpt-3.5 retires');
    expect(openai?.notes).toContain('2. gpt-4 retires');
    expect(openai?.notes).toContain('Quote: gpt-4 shuts down.');
    expect(openai?.callSites).toHaveLength(2);
    expect(openai?.usages).toHaveLength(1);
    expect(bundled.find((t) => t.change.provider === 'anthropic')?.id).toBe(
      'acme/shop:anthropic:claude-3',
    );
  });
});

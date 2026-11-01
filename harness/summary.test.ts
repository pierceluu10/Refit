import { describe, expect, it } from 'vitest';
import type { MigrationTask } from '../shared/types.ts';
import { summarizeRun } from './summary.ts';

// Illustrative fixture task, not a real customer.
const task = {
  id: 'fixture-task',
  change: { title: 'Move to v2', provider: 'stripe', kind: 'sdk-major' },
} as MigrationTask;

describe('summarizeRun', () => {
  it('keeps up to three lines of each result, so a verdict after a header survives', () => {
    const summary = summarizeRun({
      task,
      outcome: 'needs-review',
      costUsd: 0.5,
      before: [],
      files: [],
      iterations: [
        {
          model: 'claude-sonnet-5-5',
          stopReason: 'done',
          comparisons: [],
          steps: [
            {
              tool: 'install',
              input: {},
              output: 'package manager: npm\n\ncommand: npm ci\nexit code: 1\n--- stdout ---',
            },
            { tool: 'write_file', input: { path: 'a.ts', content: 'x'.repeat(100) }, output: 'ok' },
          ],
        },
      ],
    });
    expect(summary).toContain(
      '1. install  → package manager: npm | command: npm ci | exit code: 1\n2. write_file path=a.ts content=<100 chars> → ok\n',
    );
    expect(summary).toContain('The agent did not call finish.');
  });
});

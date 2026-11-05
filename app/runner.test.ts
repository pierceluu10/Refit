import type Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../inventory/budget.ts';
import { checkUnclear, CHECK_MODEL } from '../inventory/dead-check.ts';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import { makeRecord, makeTask } from '../memory/fixtures/tasks.ts';
import {
  AnthropicModel,
  Budget as MemoryBudget,
  JsonMemoryStore,
  learnFromRun,
  LocalEmbedder,
} from '../memory/index.ts';
import { createBudget, type Budget as RunBudget } from '../orchestrator/budget.ts';
import type { ModelClient } from '../providers/core/model.ts';
import type { Finding } from '../shared/types.ts';
import { rescanWith, sharedLedger, verdictWith } from './runner.ts';
import type { UnderstandJob } from './types.ts';

const JOB: UnderstandJob = {
  kind: 'understand',
  installationId: 70000001,
  repo: 'aptitude-example-org/billing-api',
  reason: 'push',
};
const FINDINGS: Finding[] = [
  { entryId: 'illustrative-entry', file: 'billing.ts', line: 1, matchClass: 'live' },
];
const AT = '2026-11-05T12:00:00.000Z';

describe('rescanWith', () => {
  it('leaves evidence alone for a repo with no merged fix to watch', async () => {
    const rescanFound = vi.fn(async () => {});
    await rescanWith({ hasFixToWatch: async () => false, rescanFound })(JOB, FINDINGS, AT);
    expect(rescanFound).not.toHaveBeenCalled();
  });

  it('passes on the scan it was given for a repo with a merged fix', async () => {
    const rescanFound = vi.fn(async () => {});
    await rescanWith({ hasFixToWatch: async () => true, rescanFound })(JOB, FINDINGS, AT);
    expect(rescanFound).toHaveBeenCalledExactlyOnceWith(JOB.installationId, JOB.repo, FINDINGS, AT);
  });
});

describe('one cap across the check, the loop and verdicts', () => {
  let dir: string;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'aptitude-cap-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe('the AI check', () => {
    const CHECK_USD = 0.01; // haiku-5-5: 50k tokens in at $0.10 and 10k out at $0.50, per million
    const client = (): ModelClient & { calls: number } => ({
      model: CHECK_MODEL,
      calls: 0,
      async complete() {
        this.calls += 1;
        return {
          content: [{ type: 'text', text: '[]' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 50_000, outputTokens: 10_000 },
        };
      },
    });
    const unclear = async () => {
      await writeFile(join(dir, 'package.json'), '{"dependencies":{"openai":"^6.0.0"}}');
      await writeFile(join(dir, 'a.ts'), "fetch('/v1/edits');");
      const report = await scanDeadApis(dir, 'example-org/billing', { today: '2026-11-05' });
      expect(report.details.map((one) => one.matchClass)).toEqual(['unclear']);
      return report;
    };
    const check = async (run: RunBudget, model: ModelClient) =>
      checkUnclear(await unclear(), dir, {
        client: model,
        openLedger: async () => sharedLedger(new BudgetLedger({ capUsd: run.capUsd }), run),
      });

    it("takes what it spends out of the loop's budget", async () => {
      const run = createBudget(1);
      const checked = await check(run, client());
      expect(checked.check?.outcome).toBe('checked');
      expect(run.spentUsd()).toBeCloseTo(CHECK_USD);
      const hold = await run.reserve('the fix', 1, 0);
      expect(hold.usd).toBeCloseTo(1 - CHECK_USD);
    });

    it('gives its worst case back when the call fails or its own ledger refuses', async () => {
      const run = createBudget(1);
      const down: ModelClient = {
        model: CHECK_MODEL,
        complete: () => Promise.reject(new Error('model is down')),
      };
      expect((await check(run, down)).check?.outcome).toBe('failed');
      expect(run.spentUsd()).toBeCloseTo(0);

      const refused = await checkUnclear(await unclear(), dir, {
        client: client(),
        openLedger: async () => sharedLedger(new BudgetLedger({ capUsd: 0 }), run),
      });
      expect(refused.check?.outcome).toBe('capped');
      expect(run.spentUsd()).toBeCloseTo(0);
    });

    it('is capped once the loop has spent the cap, and its findings stay unclear', async () => {
      const run = createBudget(1);
      (await run.reserve('the fix', 1)).settle(1);
      const model = client();
      const checked = await check(run, model);
      expect(model.calls).toBe(0);
      expect(checked.check?.outcome).toBe('capped');
      expect(checked.clean).toBe(false);
      expect(run.spentUsd()).toBe(1);
    });
  });

  describe('a verdict', () => {
    const PR = 'https://github.com/example-org/billing/pull/7';
    const VERDICT_CALL_USD = 0.06; // opus-5-5: 10k tokens in at $4 and 1k out at $20, per million
    const RECIPE = {
      sameAsRecipeId: null,
      preconditions: 'Calls stripe.charges.create.',
      steps: 'Move to stripe.paymentIntents.create.',
      pitfalls: 'Handle requires_action.',
      diffSketch: '- charges.create\n+ paymentIntents.create',
    };

    async function storedRun() {
      const store = new JsonMemoryStore(dir);
      const embedder = new LocalEmbedder();
      await learnFromRun(
        {
          task: makeTask(),
          record: makeRecord({ outcome: 'needs-review', pr: PR, transcriptPath: 'run.jsonl' }),
          transcript: 'ok',
        },
        { store, embedder },
      );
      const create = vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(RECIPE) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10_000, output_tokens: 1_000 },
      }));
      const client = { messages: { create } } as unknown as Anthropic;
      const memory = (share: MemoryBudget) => ({
        store,
        embedder,
        model: new AnthropicModel(share, client),
      });
      return { store, create, memory };
    }

    it('spends nothing with no cap, and is still stored', async () => {
      const { store, create, memory } = await storedRun();
      await verdictWith(undefined, memory)(PR, 'merged');
      expect(create).not.toHaveBeenCalled();
      const [run] = await store.listRuns();
      expect(run.record.humanVerdict).toBe('merged');
    });

    it("spends from the run's cap, and only what is free of it", async () => {
      const { store, create, memory } = await storedRun();
      const poor = createBudget(0.1);
      await verdictWith(poor, memory)(PR, 'merged');
      expect(create, 'the worst case of a call passes $0.10').not.toHaveBeenCalled();
      expect(poor.spentUsd()).toBe(0);
      expect((await store.listRuns())[0].record.humanVerdict).toBe('merged');

      const run = createBudget(5);
      await verdictWith(run, memory)(PR, 'merged');
      expect(create).toHaveBeenCalledTimes(1);
      expect(run.spentUsd()).toBeCloseTo(VERDICT_CALL_USD);
      expect(run.heldUsd(), 'the rest of the hold goes back').toBe(0);
    });
  });
});

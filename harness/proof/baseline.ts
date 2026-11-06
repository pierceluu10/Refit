// Before/after support for checks that compare runs (accessibility, payment-page scripts). The baseline
// comes from the untouched copy the harness passes as ctx.baselineDir, or else from the first call
// made for the same repo and pages, which the agent should make before it edits.
import type { ProofContext } from './types.ts';
import { withSandbox } from './util.ts';
import type { Sandbox } from '../types.ts';

const recorded = new Map<string, unknown>();

export function clearProofBaselines(): void {
  recorded.clear();
}

export type Baseline<T> = { value: T; source: string } | undefined;

// Returns the baseline for `key` and the current value. When there is no baseline yet, the current
// value becomes it.
export async function beforeAndAfter<T>(
  ctx: ProofContext,
  key: string,
  phase: 'before' | 'after' | undefined,
  measure: (sandbox: Sandbox) => Promise<T>,
): Promise<{ before: Baseline<T>; after: T; recordedNow: boolean }> {
  const cacheKey = `${ctx.repoDir}\u0000${key}`;
  const after = await withSandbox(ctx, measure);
  if (phase === 'before') {
    recorded.set(cacheKey, after);
    return { before: undefined, after, recordedNow: true };
  }
  if (ctx.baselineDir) {
    const value = await withSandbox(
      { ...ctx, sandbox: undefined, repoDir: ctx.baselineDir },
      measure,
    );
    return {
      before: { value, source: 'the untouched copy of the repo' },
      after,
      recordedNow: false,
    };
  }
  if (recorded.has(cacheKey))
    return {
      before: {
        value: recorded.get(cacheKey) as T,
        source: 'the earlier call made before the edit',
      },
      after,
      recordedNow: false,
    };
  if (phase === undefined) recorded.set(cacheKey, after);
  return { before: undefined, after, recordedNow: phase === undefined };
}

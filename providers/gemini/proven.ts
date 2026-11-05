// Proven fixes for the Gemini API. Each is built from real fixes that passed their locked tests.
import type { ProvenFix } from '../../harness/proven.ts';
import { modelSwap } from '../toolkit/proven.ts';

// Gemini 3 ignores sampling settings today and says it will reject them, and it drops candidate
// counts and thinking budgets. A file that sets one of them needs a person's kind of reading.
const SETS_SAMPLING =
  /\b(temperature|top_?p|top_?k|candidate_?count|thinking_?budget|thinkingConfig)\b/i;

// Benchmark-only so far: its evidence is locked tests, not merged PRs.
export const provenFixes: ProvenFix[] = [
  modelSwap('GE-1.gemini-2.0-flash', 'gemini-2.0-flash', 'gemini-3.6-flash', SETS_SAMPLING),
];

// Proven fixes for the OpenAI API. Each is built from real fixes that passed their locked tests.
import type { ProvenFix } from '../../harness/proven.ts';
import { modelSwap } from '../toolkit/proven.ts';

// Fine-tuning needs a model that supports it, and these others are settings the real fixes never
// had to move, so a file with one of them goes to Claude.
const NEEDS_READING = /fineTuning|fine_tuning|top_p|topP|logprobs|\bn:\s*\d|frequency_penalty/;
// The newer reasoning models reject `temperature`, and every real fix took out this one line.
const TEMPERATURE_LINE = /^[ \t]*temperature\s*:\s*[\d.]+,?[ \t]*(?:\/\/.*)?\r?\n/gm;

// Benchmark-only so far: its evidence is locked tests, not merged PRs.
export const provenFixes: ProvenFix[] = [
  modelSwap('openai-1', 'gpt-3.5-turbo', 'gpt-5.6-terra', NEEDS_READING, TEMPERATURE_LINE),
];

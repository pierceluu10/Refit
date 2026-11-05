// The AI sweep: on a small sample of repos each month, one read-only session looks for dead API use
// the scan missed. It's how we know how often a $0 "clean" is a silent miss. It reads a filtered copy
// of the repo, runs nothing, and every miss becomes a detection lesson for the scanner.
import { createHash } from 'node:crypto';
import type { DeadApiEntry, ScanResult } from '../shared/types.ts';
import type { DetectionLesson } from '../memory/lessons.ts';
import type { AskModel } from './match.ts';

export const SWEEP_MODEL = 'claude-sonnet-5-5';
// About 1 repo in 20 each month.
export const SWEEP_RATE = 0.05;

type SweepMiss = { provider: string; what: string; file: string; line: number; why: string };

const SYSTEM = `You check whether a scanner missed anything. Read this repository and find code that still uses an external API, model, endpoint, field or SDK call that its provider has already shut down or removed. You get what the scanner found and the list it works from.

Report only what is dead today and that the scanner did not find, with the file, the line and why you know it is dead. Say nothing about upcoming deprecations, style or app bugs. An empty list is a good answer: don't stretch to fill it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    misses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          what: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['provider', 'what', 'file', 'line', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['misses'],
  additionalProperties: false,
};

// A stable pick for the month, so a rerun looks at the same repos and next month at others.
export function inSweep(repo: string, month: string, rate = SWEEP_RATE): boolean {
  const roll = createHash('sha256').update(`${month}\n${repo}`).digest().readUInt32BE(0) / 2 ** 32;
  return roll < rate;
}

export async function sweepRepo(input: {
  repo: string;
  dir: string;
  commit?: string;
  scan: ScanResult;
  list: DeadApiEntry[];
  ask: AskModel;
}): Promise<{ lessons: DetectionLesson[]; costUsd: number }> {
  const { repo, dir, commit, scan, list, ask } = input;
  const names = list.map((entry) => `- ${entry.provider}: ${entry.what}`).join('\n');
  const found = scan.findings.map((f) => `- ${f.entryId} at ${f.file}:${f.line}`).join('\n');
  const { output, costUsd } = await ask({
    system: SYSTEM,
    prompt: `The scanner's list:\n${names}\n\nWhat it found here:\n${found || 'Nothing.'}`,
    schema: SCHEMA,
    repoDir: dir,
  });
  const { misses } = output as { misses: SweepMiss[] };
  return {
    costUsd,
    lessons: misses.map((miss) => ({
      kind: 'sweep-miss',
      repo,
      ...(commit && { commit }),
      file: `${miss.file}:${miss.line}`,
      why: `${miss.provider}: ${miss.what}. ${miss.why}`,
    })),
  };
}

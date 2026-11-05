// Each repo's habits: the setup that worked, the checks that passed and what the team rejected.
// Kept per repo, used on its next run, never shared. No model: these are facts from its runs.
import type { Plan } from '../harness/prepare.ts';
import type { RunRecord } from '../shared/types.ts';
import type { StoredRun } from './types.ts';

export type RepoHabits = {
  repo: string;
  updatedAt: string;
  // The codegen and placeholder env that got its checks running, so the next run needs no plan call.
  setup?: { steps: { command: string; why: string }[]; env: Record<string, string> };
  // Checks a session added that passed.
  checks: { name: string; command: string }[];
  rejected: { why: string; at: string }[];
  // Files people keep changing on our merged PRs.
  repeatedEdits?: string[];
};

type HarnessFields = {
  preparation?: {
    steps?: { command: string; why: string; code: number }[];
    env?: Record<string, string>;
  };
  agentChecks?: { name: string; command: string; after: string }[];
};

export function mergeHabits(old: RepoHabits | undefined, run: StoredRun, at: string): RepoHabits {
  const { preparation, agentChecks = [] } = run.record as RunRecord & HarnessFields;
  const steps = preparation?.steps ?? [];
  const closed = run.evidence?.closed;
  const passed = agentChecks.filter((check) => /^pass/.test(check.after));
  return {
    repo: run.task.repo,
    updatedAt: at,
    ...(steps.length > 0 && steps.every((step) => step.code === 0)
      ? {
          setup: {
            steps: steps.map(({ command, why }) => ({ command, why })),
            env: preparation?.env ?? {},
          },
        }
      : old?.setup
        ? { setup: old.setup }
        : {}),
    checks: [
      ...new Map(
        [...(old?.checks ?? []), ...passed].map(({ name, command }) => [
          command,
          { name, command },
        ]),
      ).values(),
    ],
    rejected: [
      ...(old?.rejected ?? []),
      ...(closed?.comment && !old?.rejected.some((item) => item.at === closed.at)
        ? [{ why: closed.comment, at: closed.at }]
        : []),
    ],
    ...(old?.repeatedEdits ? { repeatedEdits: old.repeatedEdits } : {}),
  };
}

// The setup an earlier run proved, in place of a model's plan.
export const knownPlan = (habits: RepoHabits | undefined): Plan | undefined =>
  habits?.setup && {
    steps: habits.setup.steps,
    env: habits.setup.env,
    reasoning: 'The setup an earlier run of this repo proved.',
  };

// What the session should know, in the kickoff message.
export function habitNotes(habits: RepoHabits | undefined): string[] {
  if (!habits) return [];
  return [
    ...habits.checks.map((check) => `An earlier run's check passed here: \`${check.command}\``),
    ...habits.rejected.map((item) => `The team rejected an earlier PR here: ${item.why}`),
    ...(habits.repeatedEdits ?? []).map(
      (file) => `People keep changing this file after our PRs, so read it closely: \`${file}\``,
    ),
  ];
}

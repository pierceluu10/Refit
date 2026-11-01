// A provider validator counts as proof only when the harness recorded the ToolPack call itself.
// What the agent says in finish is a claim; it is shown in the PR but never grades the run.
import type { FinishReport, ValidatorRun } from './types.ts';

// shortcut: ToolPack tools return free text, so pass/fail is read from the problem lines the provider
// packs print; use a structured result once the packs return one. Matching too much only costs a
// verified grade; matching too little would grade a validator that found problems as proof.
const PROBLEMS = [
  /^error:|\binvalid\b|\bfail(?:s|ed|ure|ures)?\b|"valid"\s*:\s*false/i,
  /\b[1-9]\d* error\(s\)/, // shopify_validate_graphql: "Result: 1 error(s), 0 warning(s)"
  /^unknown param(?:eter)?s\b(?!: none)/im, // openai_check_request, stripe_check_params
  /^(?:deprecated or legacy parameters|deprecated in the spec):/im,
  /^(?:required by the spec but missing|required params missing):/im,
  /^enum mismatch:/im,
  /\bis not (?:supported|compatible)\b/i, // openai_check_request on reasoning models
  /^status\b[^:\n]*:\s*(?:deprecated|shut down)/im, // openai_model_lookup on a retiring model
];

export const runPassed = (output: string) => !PROBLEMS.some((problem) => problem.test(output));

export type ValidatorGrade = { name: string; ran: boolean; passed: boolean; detail: string };

const matches = (claim: string, tool: string) => tool === claim || tool.endsWith(`__${claim}`);

// One grade per claimed validator, from the latest recorded call of that tool.
export function gradeValidators(
  claims: FinishReport['validators'],
  runs: ValidatorRun[],
): ValidatorGrade[] {
  return claims.map((claim) => {
    const run = runs.filter((candidate) => matches(claim.name, candidate.tool)).at(-1);
    if (!run) {
      return {
        name: claim.name,
        ran: false,
        passed: false,
        detail: 'claimed by the agent, but the harness recorded no call of it',
      };
    }
    const detail = run.output.trim().split('\n')[0].slice(0, 200);
    return { name: claim.name, ran: true, passed: claim.passed && run.passed, detail };
  });
}

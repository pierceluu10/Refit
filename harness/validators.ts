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
  // openai_check_request: the endpoint itself is legacy, deprecated or shut down. "models deprecated"
  // names other models on the endpoint; the request's own model is graded by the line below.
  /^endpoint note \((?!supported\b|models deprecated\b)/im,
  /^model \S+: (?:deprecated|shut down)\b/im, // openai_check_request: the request's own model
  /^old sdk shapes found:/im, // openai_sdk_migration
  /^status\b[^:\n]*:\s*(?:deprecated|shut down)/im, // openai_model_lookup on a retiring model
  /^(?:product|version \S+) status:\s*(?:deprecated|end-of-life|retired|sunset)/im, // twilio_endpoint_lookup
  /`:\s*(?:removed|renamed|deprecated)\b/, // meta_lookup_field: "field `x`: removed -> y"
  /\bnot in (?:the )?snapshot\b/i, // an unknown model, version or endpoint in any pack
];

export const runPassed = (output: string) => !PROBLEMS.some((problem) => problem.test(output));

// A pack tool that couldn't run ("failed to run: ... Nothing was checked") found no problem either:
// it is no proof, and it doesn't hold back the grade.
export const couldNotRun = (output: string) =>
  /\bfailed to run:[\s\S]*Nothing was checked/.test(output);

export type ValidatorGrade = { name: string; ran: boolean; passed: boolean; detail: string };

// The model sees the harness tools through the SDK's MCP server, so it may claim one by that full name.
export const claimMatches = (claim: string, tool: string) => {
  const name = claim.replace(/^mcp__aptitude__/, '');
  return tool === name || tool.endsWith(`__${name}`);
};

// One grade per claimed validator, from the latest recorded call of that tool.
export function gradeValidators(
  claims: FinishReport['validators'],
  runs: ValidatorRun[],
): ValidatorGrade[] {
  return claims.map((claim) => {
    const run = runs.filter((candidate) => claimMatches(claim.name, candidate.tool)).at(-1);
    if (!run) {
      return {
        name: claim.name,
        ran: false,
        passed: false,
        detail: 'claimed by the agent, but the harness recorded no call of it',
      };
    }
    if (couldNotRun(run.output)) {
      return {
        name: claim.name,
        ran: false,
        passed: true,
        detail: 'claimed, but it could not run, so nothing was checked',
      };
    }
    const detail = run.output.trim().split('\n')[0].slice(0, 200);
    return { name: claim.name, ran: true, passed: claim.passed && run.passed, detail };
  });
}

// Provider checkers (a check or validate tool) whose latest call reported problems. They block
// verified even when the agent leaves them out of finish; lookups and docs searches only inform.
export function failingCheckers(runs: ValidatorRun[]): string[] {
  const latest = new Map(runs.map((run) => [run.tool, run]));
  return [...latest.values()]
    .filter((run) => /check|validat/i.test(run.tool) && !run.passed && !couldNotRun(run.output))
    .map((run) => run.tool);
}

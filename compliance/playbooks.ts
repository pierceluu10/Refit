// Guidance the harness injects into the prompt for rule tasks, and the rule PR writer. Rule PRs
// are needs-review unless every item is proven by a check, and never claim the code satisfies a law.

import { readFileSync } from 'node:fs';
import type { ExternalChange, Obligation, ProofResult, RunRecord } from '../shared/types.ts';
import { familyOf, RULE_FAMILIES, type RuleFamilyId } from './families.ts';
import { redactSecrets, scrubClaims } from './wording.ts';

export const NO_LEGAL_ADVICE = "Refit doesn't give legal advice.";

const read = (id: RuleFamilyId) =>
  readFileSync(new URL(`./playbooks/${id}.md`, import.meta.url), 'utf8');

export const RULE_PLAYBOOKS: Record<RuleFamilyId, string> = Object.fromEntries(
  RULE_FAMILIES.map((family) => [family.id, read(family.id)]),
) as Record<RuleFamilyId, string>;

// What the harness adds to its system prompt for any rule task.
export const RULE_TASK_GUIDANCE = `This task comes from a rule or regulation, not a software release. ${NO_LEGAL_ADVICE}
- Make the change the rule's text points to, in the code the task names, and keep it small.
- Run every check a tool can run (accessibility scans, the payment page's script list, tests) before and after.
- The outcome is needs-review unless every item is proven by a check. List what you changed, what each check showed, and what a person or lawyer must confirm.
- Never write that the code is compliant, meets, satisfies or conforms to a law or standard. Describe what changed and what the checks showed.
- If the rule plausibly doesn't touch this code after all, say so with the reason; that is a "not affected" verdict, not a silent stop.`;

// The playbook for a rule change or obligation, by its id's family. Unknown ids get every playbook,
// so the agent still has guidance to work from.
export function rulePlaybook(idOrChange: string | ExternalChange | Obligation): string {
  const id = typeof idOrChange === 'string' ? idOrChange : idOrChange.id;
  const family = familyOf(id.replace(/^rule:/, ''));
  if (family) return RULE_PLAYBOOKS[family.id];
  return RULE_FAMILIES.map((f) => RULE_PLAYBOOKS[f.id]).join('\n\n---\n\n');
}

export type RulePrInput = {
  change: ExternalChange;
  obligation?: Obligation;
  changed: string[]; // what was changed, one line each
  checks: ProofResult[];
  needsHuman?: string[]; // on top of the obligation's own list
  filesTouched?: string[];
  notes?: string;
};

// Verified only when there is at least one check, every check passed, and nothing is left for a
// person to confirm. Rule changes almost always leave something, so this is almost always needs-review.
export function ruleOutcome(
  input: RulePrInput,
): Extract<RunRecord['outcome'], 'verified' | 'needs-review'> {
  const open = [...(input.obligation?.needsHuman ?? []), ...(input.needsHuman ?? [])];
  const proven = input.checks.length > 0 && input.checks.every((c) => c.passed === true);
  return proven && open.length === 0 ? 'verified' : 'needs-review';
}

const status = (passed: ProofResult['passed']) =>
  passed === true ? 'passed' : passed === false ? 'failed' : 'unknown';

export function rulePrBody(input: RulePrInput): { title: string; body: string; outcome: string } {
  const { change, obligation } = input;
  const outcome = ruleOutcome(input);
  const confirm = [...(obligation?.needsHuman ?? []), ...(input.needsHuman ?? [])];
  const rule = obligation?.rule.name ?? change.title.split(':')[0];
  const title = scrubClaims(
    `${rule}: ${obligation?.requirement ?? change.title}`.replace(/\s+/g, ' ').slice(0, 110),
  );
  const lines = [
    `> ${NO_LEGAL_ADVICE} This PR is ${outcome === 'verified' ? 'verified by the checks below' : '**needs review**'}. Have counsel confirm the items marked for review.`,
    '',
    '## Why',
    obligation?.requirement ?? change.title,
    '',
    `Source: ${change.source.url}`,
    '',
    ...change.source.quote.split('\n').map((line) => `> ${line}`),
    '',
    change.effectiveDate
      ? `Effective: ${change.effectiveDate}`
      : 'Effective date: not stated in the source.',
    '',
    '## What changed',
    ...(input.changed.length ? input.changed.map((c) => `- ${c}`) : ['- Nothing yet.']),
    '',
    '## What each check showed',
    ...(input.checks.length
      ? input.checks.map((c) => {
          const evidence = c.evidence.slice(0, 5).map((e) => `  - ${e}`);
          return [`- ${c.check}: ${status(c.passed)}`, ...evidence].join('\n');
        })
      : ['- No check could prove this change; every item below needs a person.']),
    '',
    '## For a person or lawyer to confirm',
    ...(confirm.length
      ? confirm.map((c) => `- [ ] ${c}`)
      : ['- [ ] That the change matches what the rule asks for.']),
  ];
  if (input.filesTouched?.length) {
    lines.push('', '## Files touched', ...input.filesTouched.map((f) => `- \`${f}\``));
  }
  if (input.notes) lines.push('', '## Notes', input.notes);
  // The source quote is the rule's own words and is kept as is; Refit's own text is cleaned.
  const quoteLines = new Set(change.source.quote.split('\n').map((line) => `> ${line}`));
  const body = redactSecrets(
    lines.map((line) => (quoteLines.has(line) ? line : scrubClaims(line))).join('\n'),
  );
  return { title, body, outcome };
}

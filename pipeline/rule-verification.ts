import type { CapturedDocumentation } from './documentation-sources.ts';
import { listOpenApiOperations } from './openapi-operations.ts';
import { RESPONSE_REMOVALS, responsePropertyOwner } from './operation-reach.ts';
import { requestMoveMatches } from './request-move-families.ts';
import { bodySchema } from './request-removals.ts';
import { isFieldMove, type FieldMove, type RequestMove, type RuleProvenance } from './rule-pack.ts';
import { isObject } from './specifications.ts';
import { propertyExists } from './stripe-field-moves.ts';

// What a rule is checked against: the saved vendor pages, by URL without `.md`, and the two pinned
// contracts with the oasdiff changelog between them (compareOpenApi's kept entries).
export interface RuleEvidence {
  pages: Map<string, CapturedDocumentation>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: Record<string, unknown>[];
}

type CheckedRule = (FieldMove | RequestMove) & Pick<RuleProvenance, 'quote' | 'diff' | 'also'>;

const removedRequestText = (parameter: string) => `removed the request property \`${parameter}\``;
export const removedEnumValueText = (parameter: string, value: string) =>
  `removed the enum value \`${value}\` of the request property \`${parameter}\``;
// The oasdiff entry a request move answers.
const answered = (rule: RequestMove) =>
  rule.family === 'request-enum-value'
    ? {
        id: 'request-property-enum-value-removed',
        text: removedEnumValueText(rule.parameter, rule.value!),
      }
    : { id: 'request-property-removed', text: removedRequestText(rule.parameter) };

function schemas(document: Record<string, unknown>) {
  return isObject(document.components) && isObject(document.components.schemas)
    ? document.components.schemas
    : {};
}

// The removed response properties the diff reports, by the component schema that owned them.
export function responseRemovals(diff: Record<string, unknown>[], before: Record<string, unknown>) {
  const owners = new Map<Record<string, unknown>, { schema: string; property: string }>();
  for (const entry of diff)
    if (RESPONSE_REMOVALS.has(String(entry.id))) {
      const owner = responsePropertyOwner(entry, before);
      if (owner) owners.set(entry, owner);
    }
  return owners;
}

// Every reason the rule is not backed by its evidence; empty when it is. The page must be the one
// the rule cites and hold the quote verbatim; the recorded diff entry must be in the diff and be
// the change the rule answers, and the rule must agree with both contracts.
export function verifyRule(
  rule: CheckedRule,
  evidence: RuleEvidence,
  removals = responseRemovals(evidence.diff, evidence.before),
) {
  const problems: string[] = [];
  const entries: Record<string, unknown>[] = [];
  for (const item of [rule, ...(rule.also ?? [])]) {
    const page = evidence.pages.get(item.source);
    if (!page) problems.push(`no captured page for ${item.source}`);
    else if (!page.content.includes(item.quote))
      problems.push(`the quote is not in the captured page ${item.source} verbatim`);
    const entry = evidence.diff.find(
      (change) =>
        change.id === item.diff.id &&
        change.operationId === item.diff.operationId &&
        change.text === item.diff.text,
    );
    if (entry) entries.push(entry);
    else
      problems.push('the diff entry is not in the oasdiff changelog between the pinned contracts');
  }
  if (problems.some((problem) => problem.startsWith('the diff entry'))) return problems;
  if (!isFieldMove(rule) && rule.also)
    return [...problems, 'only a field move combines several sources'];
  return [
    ...problems,
    ...(isFieldMove(rule)
      ? fieldMoveProblems(rule, entries, evidence, removals)
      : requestMoveProblems(rule, entries[0], evidence)),
  ];
}

function fieldMoveProblems(
  rule: FieldMove,
  entries: Record<string, unknown>[],
  evidence: RuleEvidence,
  removals: Map<Record<string, unknown>, { schema: string; property: string }>,
) {
  const problems: string[] = [];
  const properties = rule.family === 'period-helper' ? Object.keys(rule.helpers) : [rule.property];
  for (const entry of entries) {
    const owner = removals.get(entry);
    if (!owner || !rule.schemas.includes(owner.schema) || !properties.includes(owner.property))
      problems.push('a diff entry does not remove a property the rule moves');
  }
  const removed = new Set(
    [...removals.values()].map((value) => `${value.schema}.${value.property}`),
  );
  for (const schema of rule.schemas)
    for (const property of properties)
      if (!removed.has(`${schema}.${property}`))
        problems.push(`the diff does not remove ${schema}.${property}`);
  const after = schemas(evidence.after);
  for (const target of rule.targets)
    if (!propertyExists(after, target))
      problems.push(`the after contract has no ${target.join('.')}`);
  return problems;
}

function requestMoveProblems(
  rule: RequestMove,
  entry: Record<string, unknown>,
  evidence: RuleEvidence,
) {
  const problems: string[] = [];
  const expected = answered(rule);
  if (
    entry.id !== expected.id ||
    entry.text !== expected.text ||
    !rule.operations.includes(String(entry.operationId))
  )
    problems.push('the diff entry does not remove the parameter on an operation the rule moves');
  const operations = (document: Record<string, unknown>) =>
    new Map(
      listOpenApiOperations(document).map((operation) => [
        operation.operation.operationId,
        operation.operation,
      ]),
    );
  const [before, after] = [operations(evidence.before), operations(evidence.after)];
  for (const operationId of rule.operations) {
    if (
      !evidence.diff.some(
        (change) =>
          change.id === expected.id &&
          change.operationId === operationId &&
          change.text === expected.text,
      )
    )
      problems.push(`the diff does not remove ${rule.value ?? rule.parameter} from ${operationId}`);
    const old = before.get(operationId);
    const current = after.get(operationId);
    const oldBody = old && bodySchema(old, evidence.before);
    const newBody = current && bodySchema(current, evidence.after);
    if (
      !oldBody ||
      !newBody ||
      !requestMoveMatches(
        rule,
        { schema: oldBody, document: evidence.before },
        { schema: newBody, document: evidence.after },
      )
    )
      problems.push(`the contracts do not agree with the ${rule.family} on ${operationId}`);
  }
  return problems;
}

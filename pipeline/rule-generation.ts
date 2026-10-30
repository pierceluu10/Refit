import type { AiOptions } from './ai-budget.ts';
import type { CapturedDocumentation } from './documentation-sources.ts';
import { listOpenApiOperations } from './openapi-operations.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import { pageText } from './release-classification.ts';
import { local } from './request-removals.ts';
import {
  FIELD_FAMILIES,
  isFieldMove,
  REQUEST_FAMILIES,
  type FieldMove,
  type RequestMove,
  type TableRule,
} from './rule-pack.ts';
import { removedEnumValueText, verifyRule, type RuleEvidence } from './rule-verification.ts';
import { isObject, parseObject } from './specifications.ts';
import { HELPER_TARGETS, PERIOD_HELPERS } from './stripe-subscription-periods.ts';
import { PipelineInputError } from './types.ts';

// Generates Stripe migration rules from a changelog page (owner decision D3, 2026-10-27). The model
// proposes candidates with a verbatim quote; code then binds each one to the oasdiff changelog,
// derives everything the contracts decide (operation IDs, guards, dropped fields, the helper that
// reads the new location) and verifies it. Only verified candidates become table rules, and they
// start review-only: a rule edits code only after a benchmark run shows zero wrong patches.

export const FAMILIES = [...FIELD_FAMILIES, ...REQUEST_FAMILIES] as string[];
const MAX_CANDIDATES = 20;
const MAX_TEXT_LENGTH = 1000;
const MAX_DIFF_LINES = 400;

const INSTRUCTIONS = `You turn one Stripe API changelog page into deterministic migration rules for Refit, which edits customer code that calls Stripe through stripe-node. You receive the page's Markdown and the relevant entries of the oasdiff changelog between the pinned OpenAPI contracts before and after the version.

Propose a rule only where the page names an exact one-to-one replacement that keeps behaviour, in one of these families:
- "moved-value": a response field moved to another location holding the same value (reads of the old field read the new location).
- "moved-id": an object field replaced by a location holding its ID (or the object when expanded); reads of \`.field.id\` read that ID.
- "period-helper": a period field moved from a parent object onto its child items.
- "request-rename": a request parameter renamed, with the same value and shape.
- "request-wrap": a removed request parameter whose value is sent inside a new wrapper object as { type: <discriminator>, <parameter>: value }.
- "request-enum-value": a removed enum value of a request parameter that the page says a new value replaces; one rule per removed value.

Propose nothing for changes without an exact replacement: removed fields with no equivalent, behaviour changes, new error codes, values that change meaning, lists that replace a single value, Stripe.js, API v2. A missing rule is safe; a wrong rule edits customer code wrongly.

Fields, all required; use "" or [] where a field does not apply to the family:
- family: one of the families above.
- schemas: the response object schemas the field is removed from, as OpenAPI component names (for example "invoice", "checkout.session", "line_item"). Field families only.
- properties: the removed response properties (for "period-helper" every moved property). Field families only.
- targets: every new location, as a component schema name followed by properties ("invoice.parent.subscription_details.subscription"); for "period-helper" the parent's list property and each item property ("subscription.items", "subscription_item.current_period_end"). Field families only.
- operations: every affected request as "METHOD /v1/path" ("POST /v1/promotion_codes"). Request families only.
- parameter, replacement: the removed request parameter and its replacement; discriminator: the wrapper's type value ("request-wrap" only).
- value: the removed enum value; parameter is the request parameter and replacement the value that replaces it ("request-enum-value" only).
- quote: one sentence or table row copied character for character from the page that states the change. Copy it exactly, including backticks and punctuation; do not join or shorten text.
- warning: one or two sentences for a reviewer saying what the edit does.
- rationale: why the page shows the replacement keeps behaviour.

Return at most ${MAX_CANDIDATES} rules; return an empty list when the page has none.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'family',
          'schemas',
          'properties',
          'targets',
          'operations',
          'parameter',
          'replacement',
          'discriminator',
          'value',
          'quote',
          'warning',
          'rationale',
        ],
        properties: {
          family: { type: 'string', enum: FAMILIES },
          schemas: { type: 'array', items: { type: 'string' } },
          properties: { type: 'array', items: { type: 'string' } },
          targets: { type: 'array', items: { type: 'string' } },
          operations: { type: 'array', items: { type: 'string' } },
          parameter: { type: 'string' },
          replacement: { type: 'string' },
          discriminator: { type: 'string' },
          value: { type: 'string' },
          quote: { type: 'string' },
          warning: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

export interface Candidate {
  family: string;
  schemas: string[];
  properties: string[];
  targets: string[];
  operations: string[];
  parameter: string;
  replacement: string;
  discriminator: string;
  value: string;
  quote: string;
  warning: string;
  rationale: string;
}

const text = (value: unknown, empty = false): value is string =>
  typeof value === 'string' &&
  (empty || value.trim().length > 0) &&
  value.length <= MAX_TEXT_LENGTH;
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_CANDIDATES && value.every((entry) => text(entry));

export function parseCandidates(content: string): Candidate[] {
  const value = parseObject(content, 'Rule generation');
  if (!Array.isArray(value.rules) || value.rules.length > MAX_CANDIDATES)
    throw new PipelineInputError('Rule generation does not match the expected schema.');
  return value.rules.map((rule: unknown, index) => {
    const item = rule as Record<string, unknown>;
    if (
      !FAMILIES.includes(item?.family as string) ||
      !texts(item.schemas) ||
      !texts(item.properties) ||
      !texts(item.targets) ||
      !texts(item.operations) ||
      !text(item.parameter, true) ||
      !text(item.replacement, true) ||
      !text(item.discriminator, true) ||
      !text(item.value, true) ||
      !text(item.quote) ||
      !text(item.warning) ||
      !text(item.rationale)
    )
      throw new PipelineInputError(`Rule generation rule ${index} does not match the schema.`);
    return item as unknown as Candidate;
  });
}

// The diff entries a page can be about: every request property change, and each removed response
// property (once per owning schema) whose name the page mentions.
export function diffDigest(
  page: CapturedDocumentation,
  diff: Record<string, unknown>[],
  removals: Map<Record<string, unknown>, { schema: string; property: string }>,
) {
  const words = new Set(page.content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const lines = new Set<string>();
  for (const entry of diff)
    if (String(entry.id).startsWith('request-') || String(entry.id).startsWith('new-required'))
      lines.add(`${entry.operation} ${entry.path}: ${entry.text}`);
  for (const { schema, property } of removals.values())
    if (words.has(property)) lines.add(`response property removed: ${schema}.${property}`);
  return [...lines].sort().slice(0, MAX_DIFF_LINES);
}

export interface PageGeneration {
  slug: string;
  url: string;
  candidates: Candidate[];
  error: string | null;
  evidence: unknown;
  content: string | null;
  model: string | null;
  responseId: string | null;
  costUsd: number;
}

// One request per page; an unusable answer is recorded as the page's error, never retried.
export async function generateCandidates(
  version: string,
  slug: string,
  page: CapturedDocumentation,
  digest: string[],
  options: AiOptions,
): Promise<PageGeneration> {
  const evidence = {
    version,
    page: { url: page.url, sha256: page.hash, markdown: pageText(page.content) },
    diff: digest,
  };
  const failed = { slug, url: page.url, candidates: [], evidence, model: null, responseId: null };
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await requestStructuredOutput(
      { evidence, instructions: INSTRUCTIONS, name: 'migration_rules', schema: SCHEMA },
      options,
    );
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    const costUsd = error instanceof UnusableAiResponse ? (error.budget?.costUsd ?? 0) : 0;
    return { ...failed, error: error.message, content: null, costUsd };
  }
  const recorded = {
    slug,
    url: page.url,
    evidence,
    content: response.content,
    model: response.model,
    responseId: response.responseId,
    costUsd: response.budget?.costUsd ?? 0,
  };
  try {
    return { ...recorded, candidates: parseCandidates(response.content), error: null };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { ...recorded, candidates: [], error: error.message };
  }
}

function property(document: Record<string, unknown>, schema: string, name: string) {
  const schemas =
    isObject(document.components) && isObject(document.components.schemas)
      ? document.components.schemas
      : {};
  const owner = schemas[schema];
  const value = isObject(owner) && isObject(owner.properties) ? owner.properties[name] : undefined;
  return isObject(value) ? value : undefined;
}

// The object schema a property holds: itself, its only `$ref` member, or its array items.
function objectSchema(value: unknown, document: Record<string, unknown>) {
  let current = local(value, document);
  if (current && Array.isArray(current.anyOf) && current.anyOf.length === 1)
    current = local(current.anyOf[0], document);
  if (current?.type === 'array') current = local(current.items, document);
  return current && isObject(current.properties) ? current.properties : undefined;
}

function targetSchema(document: Record<string, unknown>, path: string[]) {
  let value: unknown = property(document, path[0], path[1]);
  for (const name of path.slice(2)) {
    const properties = objectSchema(value, document);
    value = properties?.[name];
  }
  return value;
}

const ruleName = (version: string, parts: string[]) =>
  `stripe-${version.slice(0, 10)}-${parts.join('-').replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase();

// A verified table rule, or why the candidate cannot be one. Everything the contracts decide is
// derived here, never taken from the model: operation IDs, the diff entry, the guards of a moved
// value and the helper that reads its new location.
export function completeCandidate(
  candidate: Candidate,
  context: {
    version: string;
    source: string;
    checkedAt: string;
    generatedBy: { model: string; responseId: string };
  },
  evidence: RuleEvidence,
  removals: Map<Record<string, unknown>, { schema: string; property: string }>,
): { rule: TableRule } | { reason: string } {
  const provenance = {
    source: context.source,
    warning: candidate.warning,
    quote: candidate.quote,
    checkedAt: context.checkedAt,
    status: 'review-only' as const,
    origin: 'generated' as const,
    generatedBy: context.generatedBy,
  };
  let move: FieldMove | RequestMove;
  let diff: Record<string, unknown> | undefined;
  if (FIELD_FAMILIES.has(candidate.family)) {
    // Component names such as `checkout.session` contain dots: the longest known schema wins.
    let paths = candidate.targets.map((target) => {
      const parts = target.split('.');
      for (let length = parts.length - 1; length > 0; length--) {
        const schema = parts.slice(0, length).join('.');
        if (property(evidence.after, schema, parts[length]))
          return [schema, ...parts.slice(length)];
      }
      return parts;
    });
    if (!candidate.schemas.length || !candidate.properties.length || !paths.length)
      return { reason: 'a field move needs schemas, properties and targets' };
    diff = [...removals].find(
      ([, owner]) =>
        candidate.schemas.includes(owner.schema) && candidate.properties.includes(owner.property),
    )?.[0];
    if (!diff) return { reason: 'the diff removes none of the named properties' };
    const sorted = (list: string[][]) => JSON.stringify(list.map((path) => path.join('.')).sort());
    if (candidate.family === 'period-helper') {
      const helper = Object.entries(HELPER_TARGETS).find(
        ([, reads]) => sorted(reads) === sorted(paths),
      )?.[0];
      if (!helper || !Object.values(PERIOD_HELPERS).includes(helper as never))
        return { reason: 'no generated helper reads these period locations' };
      move = {
        rule: ruleName(context.version, [candidate.schemas[0], 'periods']),
        family: 'period-helper',
        schemas: candidate.schemas,
        targets: paths,
        helpers: Object.fromEntries(
          candidate.properties.map((name) => [
            name,
            PERIOD_HELPERS[name as keyof typeof PERIOD_HELPERS],
          ]),
        ),
        ...provenance,
      };
    } else {
      if (candidate.properties.length !== 1)
        return { reason: 'a moved value or ID moves exactly one property' };
      // Each schema keeps its own targets; the helper is the one reading every target of the most
      // schemas, and schemas whose new location it does not read are left out (they stay findings).
      const bound = Object.entries(HELPER_TARGETS)
        .map(([name, reads]) => {
          const read = new Set(reads.map((path) => path.join('.')));
          const schemas = candidate.schemas.filter((schema) => {
            const own = paths.filter((path) => path[0] === schema);
            return own.length > 0 && own.every((path) => read.has(path.join('.')));
          });
          return { name, schemas };
        })
        .sort((left, right) => right.schemas.length - left.schemas.length)[0];
      if (!bound?.schemas.length) return { reason: 'no generated helper reads this location yet' };
      const helper = bound.name;
      candidate = { ...candidate, schemas: bound.schemas };
      paths = paths.filter((path) => bound.schemas.includes(path[0]));
      const name = candidate.properties[0];
      const rule = ruleName(context.version, [candidate.schemas[0], name]);
      if (candidate.family === 'moved-id')
        move = {
          rule,
          family: 'moved-id',
          schemas: candidate.schemas,
          property: name,
          helper,
          targets: paths,
          ...provenance,
        };
      else {
        const old = property(evidence.before, candidate.schemas[0], name);
        if (!old) return { reason: `the before contract has no ${candidate.schemas[0]}.${name}` };
        const expandable = isObject(old['x-expansionResources']);
        const before = objectSchema(old, evidence.before);
        const after = objectSchema(targetSchema(evidence.after, paths[0]), evidence.after);
        const dropped =
          before && after
            ? Object.keys(before)
                .filter((key) => !(key in after))
                .sort()
            : [];
        move = {
          rule,
          family: 'moved-value',
          schemas: candidate.schemas,
          property: name,
          helper,
          ...(dropped.length ? { droppedFields: dropped } : {}),
          ...(expandable ? { unlessExpanded: true, typeofGuard: true } : {}),
          ...(old.nullable === true ? { narrowTested: true } : {}),
          targets: paths,
          ...provenance,
        };
      }
    }
  } else {
    const operations = new Map(
      listOpenApiOperations(evidence.before).map((entry) => [
        `${entry.httpMethod} ${entry.path}`,
        entry.operation.operationId,
      ]),
    );
    const ids = candidate.operations.map((operation) => operations.get(operation.trim()));
    if (!ids.length || ids.some((id) => typeof id !== 'string'))
      return { reason: 'an operation is not in the before contract' };
    if (!candidate.parameter || !candidate.replacement)
      return { reason: 'a request move needs a parameter and a replacement' };
    if (candidate.family === 'request-wrap' && !candidate.discriminator)
      return { reason: 'a request wrap needs a discriminator' };
    const enumValue = candidate.family === 'request-enum-value';
    if (enumValue && !candidate.value)
      return { reason: 'a request enum value needs the removed value' };
    diff = evidence.diff.find(
      (change) =>
        change.operationId === ids[0] &&
        (enumValue
          ? change.id === 'request-property-enum-value-removed' &&
            change.text === removedEnumValueText(candidate.parameter, candidate.value)
          : change.id === 'request-property-removed' &&
            change.text === `removed the request property \`${candidate.parameter}\``),
    );
    if (!diff)
      return {
        reason: `the diff does not remove ${enumValue ? candidate.value : candidate.parameter}`,
      };
    move = {
      rule: ruleName(context.version, [
        candidate.parameter,
        ...(enumValue ? [candidate.value] : []),
        candidate.replacement,
      ]),
      family: candidate.family as RequestMove['family'],
      operations: (ids as string[]).sort(),
      parameter: candidate.parameter,
      replacement: candidate.replacement,
      ...(candidate.family === 'request-wrap' ? { discriminator: candidate.discriminator } : {}),
      ...(enumValue ? { value: candidate.value } : {}),
      ...provenance,
    };
  }
  const rule = {
    ...move,
    diff: { id: String(diff.id), operationId: String(diff.operationId), text: String(diff.text) },
  } as TableRule;
  const problems = verifyRule(rule, evidence, removals);
  return problems.length ? { reason: problems.join('; ') } : { rule };
}

// The fields that decide what a rule edits. Names, helper identifiers, warnings and provenance
// are labels; two rules with the same behaviour edit the same code the same way.
export function behaviour(move: FieldMove | RequestMove) {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  if (isFieldMove(move))
    return JSON.stringify({
      family: move.family,
      schemas: sorted(move.schemas),
      targets: sorted(move.targets.map((path) => path.join('.'))),
      ...(move.family === 'period-helper'
        ? { helpers: Object.entries(move.helpers).sort() }
        : {
            property: move.property,
            helper: move.helper,
            ...(move.family === 'moved-value' && {
              droppedFields: sorted(move.droppedFields),
              unlessExpanded: Boolean(move.unlessExpanded),
              typeofGuard: Boolean(move.typeofGuard),
              narrowTested: Boolean(move.narrowTested),
            }),
          }),
    });
  return JSON.stringify({
    family: move.family,
    operations: sorted(move.operations),
    parameter: move.parameter,
    replacement: move.replacement,
    discriminator: move.discriminator ?? null,
    value: move.value ?? null,
  });
}

// The generated rules that together reproduce each hand-written rule: one rule with the same
// behaviour, or field moves that differ from it only in which schemas each covers (one page per
// object) and together cover exactly its schemas and targets.
export function reproductions(hand: (FieldMove | RequestMove)[], generated: TableRule[]) {
  const found = new Map<string, string[]>();
  for (const rule of hand) {
    const same = generated.filter((entry) => behaviour(entry) === behaviour(rule));
    if (same.length) {
      found.set(rule.rule, [same[0].rule]);
      continue;
    }
    if (!isFieldMove(rule)) continue;
    const covers = (entry: TableRule) =>
      isFieldMove(entry) &&
      entry.schemas.every((schema) => rule.schemas.includes(schema)) &&
      behaviour({ ...entry, schemas: rule.schemas, targets: rule.targets }) === behaviour(rule);
    const parts = generated.filter(covers) as FieldMove[];
    const union = {
      ...rule,
      schemas: [...new Set(parts.flatMap((entry) => entry.schemas))],
      targets: [
        ...new Map(
          parts.flatMap((entry) => entry.targets).map((path) => [path.join('.'), path]),
        ).values(),
      ],
    };
    if (parts.length && behaviour(union) === behaviour(rule))
      found.set(
        rule.rule,
        parts.map((entry) => entry.rule),
      );
  }
  return found;
}

// Adds a verified rule to a version's kept rules: a rule with the same behaviour is a duplicate; a
// field move that differs from a kept one only in the schemas it covers (one page per object, such
// as promotion codes and discounts read through one coupon helper) joins it, its page kept as
// further evidence, when the joined rule still verifies; names stay unique.
export function keep(
  kept: TableRule[],
  rule: TableRule,
  evidence: RuleEvidence,
  removals: Map<Record<string, unknown>, { schema: string; property: string }>,
) {
  if (kept.some((entry) => behaviour(entry) === behaviour(rule))) return;
  if (isFieldMove(rule)) {
    const index = kept.findIndex(
      (entry) =>
        isFieldMove(entry) &&
        behaviour({ ...entry, schemas: rule.schemas, targets: rule.targets }) === behaviour(rule),
    );
    const twin = kept[index];
    if (twin && isFieldMove(twin)) {
      const joined = {
        ...twin,
        schemas: [...new Set([...twin.schemas, ...rule.schemas])],
        targets: [
          ...new Map(
            [...twin.targets, ...rule.targets].map((path) => [path.join('.'), path]),
          ).values(),
        ],
        also: [...(twin.also ?? []), { source: rule.source, quote: rule.quote, diff: rule.diff }],
      } as TableRule;
      if (!verifyRule(joined, evidence, removals).length) {
        kept[index] = joined;
        return;
      }
    }
  }
  const taken = new Set(kept.map((entry) => entry.rule));
  let name = rule.rule;
  for (let count = 2; taken.has(name); count++) name = `${rule.rule}-${count}`;
  kept.push({ ...rule, rule: name });
}

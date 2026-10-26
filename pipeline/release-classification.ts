import type { AiOptions } from './ai-budget.ts';
import type { CapturedDocumentation } from './documentation-sources.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const CATEGORIES = ['api', 'stripejs'] as const;
// The catalog's handling values, weakest first: a page's handling is its weakest change's.
export const HANDLINGS = ['none', 'stop', 'ai', 'generic', 'rule'] as const;
// The Stripe rule pack's families (field moves, request moves, removed reads kept for review).
export const FAMILIES = [
  'moved-value',
  'moved-id',
  'period-helper',
  'request-rename',
  'request-wrap',
  'read-review',
  'none',
] as const;
// Where the change statements come from: the hand catalog's, or the model lists them itself from
// the page, as it must for a release nobody has catalogued.
export const STATEMENT_SOURCES = ['catalog', 'none'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Handling = (typeof HANDLINGS)[number];
export type Family = (typeof FAMILIES)[number];
export type StatementSource = (typeof STATEMENT_SOURCES)[number];

// Refit traces stripe-node only; the other server SDK tabs repeat the REST tables and would push
// the largest pages past the AI input limit. Stripe.js tabs (HTML + JS, React) stay.
const OTHER_SERVER_SDKS = new Set(['Ruby', 'Python', 'PHP', 'Java', 'Go', '.NET']);
const MAX_IDENTIFIERS = 20;
const MAX_TEXT_LENGTH = 600;
const MAX_LISTED_CHANGES = 30;

const INTRODUCTION =
  'You classify the breaking changes on one Stripe API changelog page for Refit, which migrates customer code that calls Stripe through stripe-node, using the published OpenAPI contracts of the old and new API versions. ';
const TASKS: Record<StatementSource, { input: string; output: string }> = {
  catalog: {
    input:
      "You receive the page's Markdown and a numbered list of change statements taken from it. Classify the page and every statement. Use only the page; do not guess what is not written.",
    output: 'Return one entry per statement, by its index, in order.',
  },
  none: {
    input:
      "You receive the page's Markdown. List every breaking change the page describes as one statement each, naming the objects, fields, parameters or methods as the page does, and split a change into separate statements where its parts would be handled differently. Classify the page and every statement. Use only the page; do not guess what is not written.",
    output: `statement (each change): one sentence naming what changed.\n\nReturn at most ${MAX_LISTED_CHANGES} entries, one per breaking change, in the page's order.`,
  },
};
const GUIDE = `category (the page): "api" for the REST API and server SDKs, "stripejs" for Stripe.js, Elements, Embedded or Custom Checkout and other browser libraries.

handling (each statement), what Refit can do about it:
- "rule": a deterministic edit migrates every affected use because the page names an exact one-to-one replacement (a field moved to a new path with the same value, a request parameter renamed or moved into a wrapper with the same value).
- "generic": a contract change Refit's OpenAPI comparison reports without an edit, such as values added to a response enum, which matters where code switches over or compares the field.
- "ai": a response field removed from the contract with no exact replacement; Refit reports each traced read and only a reviewed AI patch may change it.
- "stop": a request parameter or request value removed or changed with no exact replacement, or another contract change that must stop for human review.
- "none": no contract signal Refit can trace: a behaviour change the OpenAPI contract does not record, new error, decline or reason codes that are plain strings, Stripe.js changes, API v2 (/v2) changes, or objects the contract does not have.

family (each statement), the rule pattern it would use:
- "moved-value": a response field moved to another path with the same value.
- "moved-id": an object's id is read from a different field, for example an expandable object replaced by an id inside a new sub-object.
- "period-helper": a period field moved from a parent object onto its child items.
- "request-rename": a request parameter renamed with the same value.
- "request-wrap": a request parameter moved inside a new wrapper object.
- "read-review": a removed response field with no exact replacement, whose reads stay for review.
- "none": anything else.

identifiers (each statement): the affected schema properties as "object.property" (for example "invoice.some_field") and operations as "METHOD /v1/path" or "METHOD /v1/path parameter", only as the page names them; an empty list if it names none.

rationale (each statement): one or two sentences citing the page.`;

export function instructions(source: StatementSource) {
  return `${INTRODUCTION}${TASKS[source].input}\n\n${GUIDE}\n\n${TASKS[source].output}`;
}

const CLASSIFICATION = {
  handling: { type: 'string', enum: [...HANDLINGS] },
  family: { type: 'string', enum: [...FAMILIES] },
  identifiers: { type: 'array', items: { type: 'string' } },
  rationale: { type: 'string' },
};

function schema(source: StatementSource) {
  const key =
    source === 'catalog' ? { index: { type: 'integer' } } : { statement: { type: 'string' } };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'changes'],
    properties: {
      category: { type: 'string', enum: [...CATEGORIES] },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [...Object.keys(key), ...Object.keys(CLASSIFICATION)],
          properties: { ...key, ...CLASSIFICATION },
        },
      },
    },
  };
}

// `changes` is null when the model lists the statements itself.
export interface ChangelogPage {
  slug: string;
  snapshot: CapturedDocumentation;
  changes: string[] | null;
}

export interface ChangePrediction {
  // The model's own statement, when it listed them.
  statement?: string;
  handling: Handling;
  family: Family;
  identifiers: string[];
  rationale: string;
}

export interface PagePrediction {
  category: Category;
  changes: ChangePrediction[];
}

export interface PageClassification {
  slug: string;
  prediction: PagePrediction | null;
  error: string | null;
  // Exactly what was sent and returned, for audit.
  evidence: unknown;
  content: string | null;
  model: string | null;
  responseId: string | null;
  costUsd: number;
}

export function pageText(content: string) {
  let skipping = false;
  return content
    .split('\n')
    .filter((line) => {
      const tab = /^#### (.+)$/.exec(line);
      if (tab) skipping = OTHER_SERVER_SDKS.has(tab[1].trim());
      else if (/^#{1,3} /.test(line)) skipping = false;
      return !skipping;
    })
    .join('\n');
}

export function pageEvidence(release: string, page: ChangelogPage) {
  return {
    release,
    page: {
      url: page.snapshot.url,
      sha256: page.snapshot.hash,
      markdown: pageText(page.snapshot.content),
    },
    ...(page.changes && {
      changes: page.changes.map((statement, index) => ({ index, statement })),
    }),
  };
}

const text = (value: unknown, empty = false): value is string =>
  typeof value === 'string' &&
  (empty || value.trim().length > 0) &&
  value.length <= MAX_TEXT_LENGTH;
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

// `count` is the number of statements sent, or null when the model listed them.
export function parsePrediction(content: string, count: number | null): PagePrediction {
  const value = parseObject(content, 'Release classification');
  if (!member(CATEGORIES, value.category) || !Array.isArray(value.changes))
    throw new PipelineInputError('Release classification does not match the expected schema.');
  if (count === null ? value.changes.length > MAX_LISTED_CHANGES : value.changes.length !== count)
    throw new PipelineInputError(
      `Release classification has ${value.changes.length} changes; the page has ${count ?? `at most ${MAX_LISTED_CHANGES}`}.`,
    );
  const changes = value.changes.map((change: unknown, index): ChangePrediction => {
    const item = change as Record<string, unknown>;
    if (
      (count === null ? !text(item?.statement) : item?.index !== index) ||
      !member(HANDLINGS, item.handling) ||
      !member(FAMILIES, item.family) ||
      !Array.isArray(item.identifiers) ||
      item.identifiers.length > MAX_IDENTIFIERS ||
      !item.identifiers.every((identifier) => text(identifier)) ||
      !text(item.rationale)
    )
      throw new PipelineInputError(
        `Release classification change ${index} does not match the expected schema.`,
      );
    return {
      ...(count === null && { statement: item.statement as string }),
      handling: item.handling,
      family: item.family,
      identifiers: item.identifiers as string[],
      rationale: item.rationale,
    };
  });
  return { category: value.category, changes };
}

// A request or response Refit cannot use is recorded as the page's error, never retried or
// guessed, so the score counts it against the classifier.
export async function classifyPage(
  release: string,
  page: ChangelogPage,
  options: AiOptions,
): Promise<PageClassification> {
  const evidence = pageEvidence(release, page);
  const source = page.changes ? 'catalog' : 'none';
  const failed = { slug: page.slug, prediction: null, evidence, model: null, responseId: null };
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await requestStructuredOutput(
      {
        evidence,
        instructions: instructions(source),
        name: 'release_classification',
        schema: schema(source),
      },
      options,
    );
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    const costUsd = error instanceof UnusableAiResponse ? (error.budget?.costUsd ?? 0) : 0;
    return { ...failed, error: error.message, content: null, costUsd };
  }
  const recorded = {
    slug: page.slug,
    evidence,
    content: response.content,
    model: response.model,
    responseId: response.responseId,
    costUsd: response.budget?.costUsd ?? 0,
  };
  try {
    return {
      ...recorded,
      prediction: parsePrediction(response.content, page.changes?.length ?? null),
      error: null,
    };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { ...recorded, prediction: null, error: error.message };
  }
}

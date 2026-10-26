import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDLINGS,
  type Category,
  type ChangePrediction,
  type Family,
  type Handling,
  type PageClassification,
} from './release-classification.ts';
import { PipelineInputError } from './types.ts';

// Handlings that change code: a deterministic rule or a reviewed AI patch.
const AUTOMATIC: readonly Handling[] = ['rule', 'ai'];
// Handlings under which Refit changes no code.
const NO_EDIT: readonly Handling[] = ['stop', 'none'];
// The pack family each catalog rule uses, by the function its `how` names first. The invoice
// preview move changes the method called, which no pack family covers.
const RULE_FAMILIES: ReadonlyArray<[RegExp, Family]> = [
  [/^subscriptionPeriodHelperEdit\b/, 'period-helper'],
  [/^(invoiceSubscriptionHelperEdit|checkoutShippingHelperEdit)\b/, 'moved-value'],
  [/^(invoicePriceIdHelperEdit|couponIdHelperEdit)\b/, 'moved-id'],
  [/^requestMove\b/, 'request-wrap'],
  [/\b(cardReplacement|card rename)\b/, 'request-rename'],
  [/^invoicePreviewMove\b/, 'none'],
];
const UNCLASSIFIED = 'unclassified';
// Statements assigned to one catalog statement that disagree on handling.
const MIXED = 'mixed';
// Words that say how something changed rather than what, so they do not tie two statements.
const STOPWORDS = new Set(
  (
    'a an and are as at be by can for from in is it its no not now of on or that the this to ' +
    'when which with will instead longer only new use uses added removed changed change changes ' +
    'replaced renamed moved field fields parameter parameters property properties value values ' +
    'request response reads read api'
  ).split(' '),
);

interface CatalogPart {
  changed: string[];
  handling: Handling;
  how?: string;
  fullDiffOnly?: true;
}
export interface CatalogEntry {
  slug: string;
  category: Category;
  handling: Handling;
  changed: string[];
  parts: CatalogPart[];
}

export function readCatalog(directory: string): CatalogEntry[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const entry = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      return {
        slug: file.replace(/\.json$/, ''),
        category: entry.category,
        handling: entry.handling,
        changed: entry.changed,
        parts: entry.parts ?? [entry],
      };
    });
}

export function catalogFamily(part: CatalogPart): Family {
  if (part.handling === 'ai') return 'read-review';
  if (part.handling !== 'rule') return 'none';
  const match = RULE_FAMILIES.find(([pattern]) => pattern.test(part.how ?? ''));
  if (!match) throw new PipelineInputError(`No pack family is recorded for the rule: ${part.how}`);
  return match[1];
}

const weakest = (handlings: Handling[]) =>
  handlings.reduce((low, handling) =>
    HANDLINGS.indexOf(handling) < HANDLINGS.indexOf(low) ? handling : low,
  );

// The words of a statement that name things: lowercased, camelCase and snake_case split (keeping
// the whole snake_case name too), stopwords and single characters dropped.
export function contentWords(text: string) {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .flatMap((word) => (word.includes('_') ? [word, ...word.split('_')] : [word]))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

// Dice coefficient of two sets of content words.
export function similarity(left: Set<string>, right: Set<string>) {
  const shared = [...left].filter((word) => right.has(word)).length;
  return left.size + right.size ? (2 * shared) / (left.size + right.size) : 0;
}

// Assigns each listed change to the catalog statement on the same page it shares the most
// content words with (the first on a tie), its statement and identifiers counting. A change
// that shares none is extra. Several changes may share one catalog statement.
export function assignChanges(statements: string[], changes: ChangePrediction[]) {
  const catalogWords = statements.map(contentWords);
  return changes.map((change) => {
    const words = contentWords([change.statement ?? '', ...change.identifiers].join(' '));
    const scores = catalogWords.map((catalog) => similarity(words, catalog));
    const best = Math.max(...scores);
    return { change, index: best > 0 ? scores.indexOf(best) : null, similarity: best };
  });
}

export function scoreRelease(
  release: string,
  catalog: CatalogEntry[],
  classifications: PageClassification[],
) {
  const bySlug = new Map(classifications.map((result) => [result.slug, result]));
  const entries = catalog.map((entry) => {
    const result = bySlug.get(entry.slug);
    const prediction = result?.prediction ?? null;
    return {
      release,
      slug: entry.slug,
      catalog: { category: entry.category, handling: entry.handling },
      predicted: prediction
        ? {
            category: prediction.category,
            handling: weakest(prediction.changes.map((change) => change.handling)),
          }
        : null,
      error: result ? result.error : 'not classified',
    };
  });
  const extras = [];
  const rows = [];
  for (const entry of catalog) {
    const changes = bySlug.get(entry.slug)?.prediction?.changes ?? [];
    // Statements the catalog gave are answered by index; listed ones are matched by words.
    const assigned: Array<{
      change: ChangePrediction;
      index: number | null;
      similarity: number | null;
    }> = changes.some((change) => change.statement !== undefined)
      ? assignChanges(entry.changed, changes)
      : changes.map((change, index) => ({ change, index, similarity: null }));
    for (const { change, index } of assigned)
      if (index === null)
        extras.push({
          release,
          slug: entry.slug,
          ...change,
          automatic: AUTOMATIC.includes(change.handling),
        });
    rows.push(
      ...entry.changed.map((statement, index) => {
        const part = entry.parts.find((candidate) => candidate.changed.includes(statement))!;
        const expected = {
          handling: part.handling,
          family: catalogFamily(part),
          fullDiffOnly: part.fullDiffOnly === true,
        };
        const predicted = assigned
          .filter((assignment) => assignment.index === index)
          .map(({ change, similarity }) => ({ ...change, similarity }));
        const handlings = new Set(predicted.map((change) => change.handling));
        return {
          release,
          slug: entry.slug,
          index,
          statement,
          catalog: expected,
          predicted,
          handling: predicted.length
            ? handlings.size === 1
              ? predicted[0].handling
              : MIXED
            : null,
          handlingCorrect:
            predicted.length > 0 &&
            predicted.every((change) => change.handling === expected.handling),
          familyCorrect:
            predicted.length > 0 && predicted.every((change) => change.family === expected.family),
          dangerous: predicted.some(
            (change) => AUTOMATIC.includes(change.handling) && NO_EDIT.includes(expected.handling),
          ),
        };
      }),
    );
  }
  return { entries, rows, extras };
}

export type ScoredEntry = ReturnType<typeof scoreRelease>['entries'][number];
export type ScoredRow = ReturnType<typeof scoreRelease>['rows'][number];
export type ExtraChange = ReturnType<typeof scoreRelease>['extras'][number];

export function summarize(entries: ScoredEntry[], rows: ScoredRow[], extras: ExtraChange[]) {
  const count = <T>(items: T[], test: (item: T) => boolean) => items.filter(test).length;
  const confusion = Object.fromEntries(
    HANDLINGS.map((expected) => [
      expected,
      Object.fromEntries(
        [...HANDLINGS, MIXED, UNCLASSIFIED].map((predicted) => [
          predicted,
          count(
            rows,
            (row) =>
              row.catalog.handling === expected && (row.handling ?? UNCLASSIFIED) === predicted,
          ),
        ]),
      ),
    ]),
  );
  const implied = rows.filter((row) => row.catalog.family !== 'none');
  const predictions = rows.flatMap((row) =>
    row.predicted.map((change) => ({ change, catalog: row.catalog })),
  );
  return {
    pages: entries.length,
    pagesClassified: count(entries, (entry) => entry.predicted !== null),
    pageCategoryCorrect: count(
      entries,
      (entry) => entry.predicted?.category === entry.catalog.category,
    ),
    pageHandlingCorrect: count(
      entries,
      (entry) => entry.predicted?.handling === entry.catalog.handling,
    ),
    changes: rows.length,
    changesClassified: count(rows, (row) => row.predicted.length > 0),
    handlingCorrect: count(rows, (row) => row.handlingCorrect),
    handlingConfusion: confusion,
    familyImplied: implied.length,
    familyImpliedCorrect: count(implied, (row) => row.familyCorrect),
    familySpurious: count(
      rows,
      (row) =>
        row.catalog.family === 'none' && row.predicted.some((change) => change.family !== 'none'),
    ),
    modelStatements: predictions.length + extras.length,
    extraStatements: extras.length,
    // Catalog statements given a code edit where the catalog stops or has no signal, plus extra
    // statements given a code edit.
    dangerous: count(rows, (row) => row.dangerous) + count(extras, (extra) => extra.automatic),
    extraAutomatic: count(extras, (extra) => extra.automatic),
    ruleNotInCatalog:
      count(
        predictions,
        ({ change, catalog }) => change.handling === 'rule' && catalog.handling !== 'rule',
      ) + count(extras, (extra) => extra.handling === 'rule'),
  };
}

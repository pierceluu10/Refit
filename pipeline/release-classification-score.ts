import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDLINGS,
  type Category,
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
  const rows = catalog.flatMap((entry) => {
    const prediction = bySlug.get(entry.slug)?.prediction ?? null;
    return entry.changed.map((statement, index) => {
      const part = entry.parts.find((candidate) => candidate.changed.includes(statement))!;
      const expected = {
        handling: part.handling,
        family: catalogFamily(part),
        fullDiffOnly: part.fullDiffOnly === true,
      };
      const predicted = prediction?.changes[index] ?? null;
      return {
        release,
        slug: entry.slug,
        index,
        statement,
        catalog: expected,
        predicted,
        handlingCorrect: predicted?.handling === expected.handling,
        familyCorrect: predicted?.family === expected.family,
        dangerous:
          predicted !== null &&
          AUTOMATIC.includes(predicted.handling) &&
          NO_EDIT.includes(expected.handling),
      };
    });
  });
  return { entries, rows };
}

export type ScoredEntry = ReturnType<typeof scoreRelease>['entries'][number];
export type ScoredRow = ReturnType<typeof scoreRelease>['rows'][number];

export function summarize(entries: ScoredEntry[], rows: ScoredRow[]) {
  const count = <T>(items: T[], test: (item: T) => boolean) => items.filter(test).length;
  const confusion = Object.fromEntries(
    HANDLINGS.map((expected) => [
      expected,
      Object.fromEntries(
        [...HANDLINGS, UNCLASSIFIED].map((predicted) => [
          predicted,
          count(
            rows,
            (row) =>
              row.catalog.handling === expected &&
              (row.predicted?.handling ?? UNCLASSIFIED) === predicted,
          ),
        ]),
      ),
    ]),
  );
  const implied = rows.filter((row) => row.catalog.family !== 'none');
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
    changesClassified: count(rows, (row) => row.predicted !== null),
    handlingCorrect: count(rows, (row) => row.handlingCorrect),
    handlingConfusion: confusion,
    familyImplied: implied.length,
    familyImpliedCorrect: count(implied, (row) => row.familyCorrect),
    familySpurious: count(
      rows,
      (row) =>
        row.catalog.family === 'none' && row.predicted !== null && row.predicted.family !== 'none',
    ),
    dangerous: count(rows, (row) => row.dangerous),
    ruleNotInCatalog: count(
      rows,
      (row) => row.predicted?.handling === 'rule' && row.catalog.handling !== 'rule',
    ),
  };
}

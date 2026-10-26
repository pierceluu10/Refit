// Pure parts of the Stripe release PR generator (scripts/stripe-release-pr.mjs): tag comparison,
// SDK map diffs, the changelog's breaking pages, classification checks and the PR body.
import { readFileSync } from 'node:fs';
import { CATEGORIES, FAMILIES, HANDLINGS } from './release-classification.ts';
import { PipelineInputError } from './types.ts';

export interface SdkOperation {
  schema: string;
  method: string;
  operation: string;
  path: string;
}

export interface SdkMap {
  source: string;
  generated: string;
  operationVersions: string[];
  classes: Record<string, string>;
  events: Record<string, string>;
  operations: SdkOperation[];
}

export interface Change {
  added: string[];
  removed: string[];
}

export interface SdkMapDiff {
  versions: Change;
  classes: Change;
  events: Change;
  operations: Change;
}

export interface ReviewEntry {
  slug: string;
  index: number;
  handling: 'rule' | 'ai';
  family: string;
  identifiers: string[];
  decision: 'pending' | 'accepted' | 'rejected';
}

export const REVIEW_DECISIONS = ['pending', 'accepted', 'rejected'] as const;
// Handlings that would edit code; every such prediction waits for a person (RELEASE-CLASSIFICATION.md).
export const REVIEWED_HANDLINGS = ['rule', 'ai'] as const;

// Names the Stripe tracer and its tests resolve through the SDK map; a release that drops one breaks them.
export const CORE_SDK_NAMES = {
  classes: ['Charge', 'Checkout.Session', 'Customer', 'Event', 'Invoice', 'PaymentIntent', 'Price'],
  events: [
    'checkout.session.completed',
    'customer.subscription.updated',
    'invoice.paid',
    'payment_intent.succeeded',
  ],
  operations: [
    'checkout.session create post /v1/checkout/sessions',
    'customer retrieve get /v1/customers/{customer}',
    'invoice retrieve get /v1/invoices/{invoice}',
    'payment_intent cancel post /v1/payment_intents/{intent}/cancel',
    'subscription cancel delete /v1/subscriptions/{subscription_exposed_id}',
    'subscription list get /v1/subscriptions',
  ],
};

// What the release-classification run measured on the hand catalog; repeated in every PR body.
export const MEASURED_ACCURACY =
  'Measured on the basil-to-endive hand catalog (refit-bench run 40283655210, gpt-6.1-sol): 95 of 125 handlings correct (76%), and 8 of 30 `rule` or `ai` predictions were dangerous (a code edit where the catalog stops or has no signal). See docs/RELEASE-CLASSIFICATION.md.';

const TAG = /^v(\d+)$/;
const SOURCE = /^stripe\/openapi (v\d+) openapi\/spec3\.sdk\.json \((.+)\)$/;
const LIST_LIMIT = 40;

export function tagNumber(tag: string) {
  const match = TAG.exec(tag);
  if (!match) throw new PipelineInputError(`${tag} is not a stripe/openapi release tag (vN).`);
  return Number(match[1]);
}

export function compareTags(left: string, right: string) {
  return tagNumber(left) - tagNumber(right);
}

export function sdkMapSource(map: Pick<SdkMap, 'source'>) {
  const match = SOURCE.exec(map.source);
  if (!match) throw new PipelineInputError(`Unrecognized SDK map source: ${map.source}`);
  return { tag: match[1], version: match[2] };
}

export const operationName = (entry: SdkOperation) =>
  `${entry.schema} ${entry.method} ${entry.operation} ${entry.path}`;

function change(before: Iterable<string>, after: Iterable<string>): Change {
  const old = new Set(before);
  const now = new Set(after);
  const sorted = (values: string[]) => values.sort((a, b) => a.localeCompare(b));
  return {
    added: sorted([...now].filter((value) => !old.has(value))),
    removed: sorted([...old].filter((value) => !now.has(value))),
  };
}

export function diffSdkMaps(before: SdkMap, after: SdkMap): SdkMapDiff {
  return {
    versions: change(before.operationVersions, after.operationVersions),
    classes: change(Object.keys(before.classes), Object.keys(after.classes)),
    events: change(Object.keys(before.events), Object.keys(after.events)),
    operations: change(before.operations.map(operationName), after.operations.map(operationName)),
  };
}

// A class or event that now maps to another schema counts as removed and added.
export function sdkMapChanged(before: SdkMap, after: SdkMap) {
  const content = ({ source, generated, ...rest }: SdkMap) => JSON.stringify(rest);
  return content(before) !== content(after);
}

// The rows a release overview page (docs.stripe.com/changelog/<name>.md) marks Breaking under
// `## <version>`, as the changelog page each one links to.
export function breakingPages(overview: string, version: string) {
  const pages: { slug: string; title: string; url: string }[] = [];
  let inVersion = false;
  for (const line of overview.split('\n')) {
    const heading = /^## (\S+)\s*$/.exec(line);
    if (heading) inVersion = heading[1] === version;
    if (!inVersion || !line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const link = /^\[(.+)\]\((https:\/\/docs\.stripe\.com\/changelog\/[^)\s]+)\.md\)$/.exec(
      cells[1],
    );
    if (!link || cells[3] !== 'Breaking') continue;
    const slug = link[2].slice(link[2].lastIndexOf('/') + 1);
    if (!/^[a-z0-9_-]+$/.test(slug))
      throw new PipelineInputError(`Unexpected changelog page slug: ${slug}`);
    if (!pages.some((page) => page.slug === slug))
      pages.push({ slug, title: link[1], url: link[2] });
  }
  return pages;
}

const fail = (message: string): never => {
  throw new PipelineInputError(message);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const member = (values: readonly string[], value: unknown) =>
  typeof value === 'string' && values.includes(value);

export interface ClassifiedChange {
  slug: string;
  index: number;
  statement: string | null;
  handling: string;
  family: string;
  identifiers: string[];
}

export interface ClassifiedPage {
  slug: string;
  category: string | null;
  error: string | null;
  changes: ClassifiedChange[];
}

// Checks an audit.json written by `refit classify-release` and returns its predictions.
export function classifiedPages(audit: unknown): ClassifiedPage[] {
  if (!isRecord(audit) || !Array.isArray(audit.pages))
    fail('Classification audit has no pages list.');
  return (audit as { pages: unknown[] }).pages.map((page, position) => {
    if (!isRecord(page) || typeof page.slug !== 'string' || !page.slug)
      return fail(`Classification page ${position} has no slug.`);
    const slug = page.slug;
    if (page.prediction === null) {
      if (typeof page.error !== 'string') fail(`${slug}: no prediction and no error.`);
      return { slug, category: null, error: page.error as string, changes: [] };
    }
    const prediction = page.prediction;
    if (!isRecord(prediction) || !member(CATEGORIES, prediction.category))
      return fail(`${slug}: prediction has no valid category.`);
    if (!Array.isArray(prediction.changes)) return fail(`${slug}: prediction has no changes.`);
    const evidence = isRecord(page.evidence) && Array.isArray(page.evidence.changes);
    const changes = prediction.changes.map((item: unknown, index): ClassifiedChange => {
      if (
        !isRecord(item) ||
        !member(HANDLINGS, item.handling) ||
        !member(FAMILIES, item.family) ||
        !Array.isArray(item.identifiers) ||
        !item.identifiers.every((identifier) => typeof identifier === 'string')
      )
        return fail(`${slug}: change ${index} does not match the classification schema.`);
      // Pages-only runs carry the statement the model extracted; catalog runs carry it in evidence.
      const statement =
        typeof item.statement === 'string'
          ? item.statement
          : evidence
            ? ((page.evidence as { changes: { statement?: string }[] }).changes[index]?.statement ??
              null)
            : null;
      return {
        slug,
        index,
        statement,
        handling: item.handling as string,
        family: item.family as string,
        identifiers: item.identifiers as string[],
      };
    });
    return { slug, category: prediction.category as string, error: null, changes };
  });
}

export function reviewEntries(pages: ClassifiedPage[]): ReviewEntry[] {
  return pages.flatMap((page) =>
    page.changes
      .filter((item) => member(REVIEWED_HANDLINGS, item.handling))
      .map(({ slug, index, handling, family, identifiers }) => ({
        slug,
        index,
        handling: handling as ReviewEntry['handling'],
        family,
        identifiers,
        decision: 'pending' as const,
      })),
  );
}

// Every `rule` and `ai` prediction must be listed for review, each with a person's decision field.
export function checkReview(pages: ClassifiedPage[], review: unknown) {
  if (!Array.isArray(review)) fail('review.json is not a list.');
  const key = (entry: { slug: unknown; index: unknown }) => `${entry.slug}#${entry.index}`;
  const expected = reviewEntries(pages).map(key).sort();
  const listed = (review as unknown[]).map((entry) => {
    if (!isRecord(entry) || !member(REVIEW_DECISIONS, entry.decision))
      fail(`review.json entry ${JSON.stringify(entry)} has no valid decision.`);
    return key(entry as ReviewEntry);
  });
  if (JSON.stringify(listed.sort()) !== JSON.stringify(expected))
    fail('review.json must list exactly the rule and ai predictions of audit.json.');
  return (review as ReviewEntry[]).filter((entry) => entry.decision === 'pending').length;
}

export function checkSdkMap(map: SdkMap) {
  const { tag, version } = sdkMapSource(map);
  if (!map.operationVersions.includes(version)) fail(`operationVersions lacks ${version}.`);
  for (const name of CORE_SDK_NAMES.classes)
    if (!map.classes[name]) fail(`The SDK map has no class ${name}.`);
  for (const name of CORE_SDK_NAMES.events)
    if (!map.events[name]) fail(`The SDK map has no event ${name}.`);
  const operations = map.operations.map(operationName);
  for (const name of CORE_SDK_NAMES.operations)
    if (!operations.includes(name)) fail(`The SDK map has no operation ${name}.`);
  if (new Set(operations).size !== operations.length) fail('The SDK map repeats an operation.');
  return {
    tag,
    version,
    versions: map.operationVersions.length,
    classes: Object.keys(map.classes).length,
    events: Object.keys(map.events).length,
    operations: operations.length,
  };
}

export const readJson = <T = unknown>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;

export function renderReleaseTest(input: {
  map: ReturnType<typeof checkSdkMap>;
  classification: { directory: string; pages: number; changes: number; review: number } | null;
}) {
  const { tag, version } = input.map;
  const lines = [
    `// Generated by scripts/stripe-release-pr.mjs for stripe/openapi ${tag}; regenerate it rather than edit it.`,
    `import { expect, it } from 'vitest';`,
    `import { ${input.classification ? 'checkReview, checkSdkMap, classifiedPages' : 'checkSdkMap'}, readJson, type SdkMap } from './stripe-release.ts';`,
    ``,
    `it('pins the SDK map to stripe/openapi ${tag} (${version})', () => {`,
    `  expect(checkSdkMap(readJson<SdkMap>('pipeline/stripe-sdk-metadata.json'))).toEqual(${JSON.stringify(input.map)});`,
    `});`,
  ];
  if (input.classification) {
    const { directory, ...counts } = input.classification;
    lines.push(
      ``,
      `// No rule pack entry comes from a prediction: each rule or ai one waits in review.json for a person.`,
      `it('checks the ${version} classification and lists every rule and ai prediction for review', () => {`,
      `  const pages = classifiedPages(readJson('${directory}/audit.json'));`,
      `  const changes = pages.reduce((total, page) => total + page.changes.length, 0);`,
      `  const review = readJson<unknown[]>('${directory}/review.json');`,
      `  checkReview(pages, review);`,
      `  expect({ pages: pages.length, changes, review: review.length }).toEqual(${JSON.stringify(counts)});`,
      `});`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function list(title: string, values: string[]) {
  if (!values.length) return [];
  const shown = values.slice(0, LIST_LIMIT).map((value) => `- \`${value}\``);
  if (values.length > LIST_LIMIT) shown.push(`- … and ${values.length - LIST_LIMIT} more`);
  return [
    `<details><summary>${title} (${values.length})</summary>`,
    '',
    ...shown,
    '',
    '</details>',
  ];
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

export type ClassificationOutcome =
  | { status: 'classified'; directory: string; pages: ClassifiedPage[]; costUsd: number }
  | { status: 'skipped'; reason: string };

export function renderPrBody(input: {
  tag: string;
  previousTag: string;
  version: string;
  newVersion: boolean;
  diff: SdkMapDiff;
  breaking: { slug: string; title: string; url: string }[];
  classification: ClassificationOutcome;
}) {
  const { diff } = input;
  const counts = (name: keyof SdkMapDiff) =>
    `| ${name} | ${diff[name].added.length} | ${diff[name].removed.length} |`;
  const lines = [
    `Regenerates \`pipeline/stripe-sdk-metadata.json\` from \`stripe/openapi\` ${input.tag} (\`openapi/spec3.sdk.json\`, API version \`${input.version}\`); the map was at ${input.previousTag}. Generated by \`scripts/stripe-release-pr.mjs\` (docs/RELEASE-PRS.md). A person reviews and merges it; nothing merges automatically.`,
    '',
    '## SDK map',
    '',
    '| | Added | Removed |',
    '| --- | --- | --- |',
    ...(['versions', 'classes', 'events', 'operations'] as const).map(counts),
    '',
  ];
  for (const name of ['versions', 'classes', 'events', 'operations'] as const) {
    lines.push(...list(`Added ${name}`, diff[name].added));
    lines.push(...list(`Removed ${name}`, diff[name].removed));
  }
  lines.push('', '## Classification', '');
  if (!input.newVersion)
    lines.push(
      `\`${input.version}\` is already in the SDK map, so there is no new release to classify.`,
    );
  else if (!input.breaking.length)
    lines.push(
      `The \`${input.version}\` changelog lists no breaking change, so nothing was classified.`,
    );
  else if (input.classification.status === 'skipped')
    lines.push(
      `Not classified: ${input.classification.reason}. The ${input.breaking.length} breaking changelog pages were saved under \`docs/benchmarks/stripe-changelog/pages/${input.version}/\`:`,
      '',
      ...input.breaking.map((page) => `- [${cell(page.title)}](${page.url})`),
    );
  else {
    const { directory, pages, costUsd } = input.classification;
    lines.push(
      `AI classification of the ${pages.length} breaking changelog pages ($${costUsd.toFixed(2)}), in \`${directory}/\`. **${MEASURED_ACCURACY}** Rows marked review are \`rule\` or \`ai\` predictions; each is listed in \`review.json\` as pending and no rule pack entry is created from it.`,
      '',
      '| Page | Category | Change | Handling | Family | Identifiers | Review |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const page of pages) {
      if (page.error) {
        lines.push(`| ${page.slug} | | | error: ${cell(page.error)} | | | yes |`);
        continue;
      }
      for (const item of page.changes)
        lines.push(
          `| ${page.slug} | ${page.category} | ${cell(item.statement ?? `#${item.index}`)} | ${item.handling} | ${item.family} | ${cell(item.identifiers.join(', '))} | ${member(REVIEWED_HANDLINGS, item.handling) ? 'yes' : ''} |`,
        );
    }
  }
  lines.push(
    '',
    '## Review checklist',
    '',
    '- [ ] Removed classes, events or operations are expected (Stripe dropped them, or an older pinned spec is no longer included), and no traced application relies on them.',
    '- [ ] `npm test` passes, including the regenerated `pipeline/stripe-sdk-release.test.ts`.',
  );
  if (input.newVersion && input.breaking.length)
    lines.push(
      '- [ ] Each saved changelog page matches the page on docs.stripe.com.',
      '- [ ] Each `rule` and `ai` prediction in `review.json` has a decision; accepted ones become a hand catalog entry or rule-pack change in a separate, reviewed PR.',
      '- [ ] `stop`, `generic` and `none` predictions were sample-checked; they edit nothing but are often wrong.',
      "- [ ] Moving Refit's target contract to the new version (`data/stripe-openapi-versions.json`) is a separate owner decision.",
    );
  return `${lines.join('\n')}\n`;
}

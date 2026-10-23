// Checks every endpoint in data/shopify-rest-deprecations.json against shopify.dev and writes the
// result per endpoint, with its sources. Two kinds of evidence:
//
// - The REST Admin reference for every supported version, read live as Markdown
//   (`https://shopify.dev/docs/api/admin-rest/<version>/resources/<resource>.md`). An endpoint the
//   reference still documents at or after `removedIn` is contradicted. Each page's SHA-256 is
//   recorded, since a live page cannot be pinned.
// - Release notes and changelog posts that state a removal or deprecation (EVIDENCE below). Old
//   release notes are no longer served by shopify.dev, so they are cited by their shopify.dev URL and
//   a pinned Wayback Machine copy of that page; each was read by a person on the day in --checked-at.
//
// Statuses: `confirmed` (shopify.dev states this version), `confirmed-earlier` (shopify.dev states
// an earlier version, which replaces the SDK's), `not-in-current-reference` (no supported version
// documents it, but no shopify.dev page names the version), `contradicted` (still documented).
// scripts/shopify-rest-deprecations.mjs --verification applies the result.
//
//   node scripts/shopify-rest-verify.mjs --list data/shopify-rest-deprecations.json \
//     --versions 2026-01,2026-04,2026-07,2026-10 --checked-at 2026-10-22 --output <file.json>
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    versions: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.list || !values.versions || !values.output || !values['checked-at'])
  throw new Error('Usage: --list <file> --versions <v,v> --checked-at YYYY-MM-DD --output <file>');

const ARCHIVE = 'https://web.archive.org/web';
const NOTES = 'https://shopify.dev/docs/api/release-notes';
// What shopify.dev says, per resource (and method, where only some endpoints are affected).
const EVIDENCE = [
  {
    resource: 'Fulfillment',
    removedIn: '2022-07',
    source: `${NOTES}/previous-versions/2022-07`,
    archived: `${ARCHIVE}/20250615032224/${NOTES}/previous-versions/2022-07`,
    says: 'Lists the five order-based paths (orders/{order_id}/fulfillments.json, …/{fulfillment_id}.json and its complete, open and cancel actions) as removed from the Fulfillment resource as of 2022-07. The GET forms are still documented, so only the writes are removed.',
  },
  {
    resource: 'ApplicationCredit',
    method: 'POST',
    removedIn: '2023-07',
    source: `${NOTES}/previous-versions/2023-07`,
    archived: `${ARCHIVE}/20250713060211/${NOTES}/previous-versions/2023-07`,
    says: 'Creating app credits through the Admin API (REST POST application_credits.json) is deprecated as of 2023-07, replaced by the Partner API appCreditCreate mutation.',
  },
  {
    resource: 'CustomerSavedSearch',
    removedIn: '2022-04',
    source: `${NOTES}/2022-04`,
    archived: `${ARCHIVE}/20230331001851/${NOTES}/2022-04`,
    says: 'Lists search, count, create, destroy, index, show and update as removed from the CustomerSavedSearch resource in 2022-04, replaced by customer segments. The SDK kept generating the resource until 2023-07.',
  },
  {
    resource: 'Payment',
    source: 'https://shopify.dev/changelog/posts/checkout-apis-will-be-shut-down-april-1-2025',
    archived: `${ARCHIVE}/20250614141519/${NOTES}/previous-versions/2024-04`,
    says: 'The REST Checkout endpoints, which checkouts/{token}/payments belongs to, were deprecated (2024-04 release notes) and shut off on 2025-04-01 (changelog). Neither names 2025-01 or these two endpoints.',
  },
];

const versions = values.versions.split(',');
const list = JSON.parse(await readFile(values.list, 'utf8'));
const normal = (path) =>
  path
    .replace(/\\/g, '')
    .replace(/​/g, '')
    .replace(/[{<][^}>]+[}>]/g, '{}');
// Endpoints a reference page documents: a method link followed by its /admin/api/<version>/ path.
function documented(markdown) {
  const text = markdown.replace(/\\/g, '').replace(/​/g, '');
  const found = new Set();
  for (const match of text.matchAll(
    /\* \[(get|post|put|del|delete|patch)\]\([^)]*\)\s*\n\s*\n\s*\[\/admin\/api\/[^/]+\/([^\]?]+)/gi,
  )) {
    const method = match[1].toUpperCase();
    found.add(`${method === 'DEL' ? 'DELETE' : method} ${normal(match[2])}`);
  }
  return found;
}
// shopify.dev names resources in lower case, some with hyphens (customer-address), most without.
const slugs = (resource) => [
  resource.toLowerCase(),
  resource.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
];
const pages = new Map();
async function page(resource, version) {
  const key = `${resource} ${version}`;
  if (!pages.has(key))
    pages.set(
      key,
      (async () => {
        for (const slug of [...new Set(slugs(resource))]) {
          const url = `https://shopify.dev/docs/api/admin-rest/${version}/resources/${slug}.md`;
          const response = await fetch(url, { redirect: 'manual' });
          if (response.status === 404) continue;
          if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
          const text = await response.text();
          return {
            url,
            sha256: createHash('sha256').update(text).digest('hex'),
            endpoints: documented(text),
          };
        }
        return { url: null, sha256: null, endpoints: new Set() };
      })(),
    );
  return pages.get(key);
}

const results = [];
for (const endpoint of list.endpoints) {
  const reference = [];
  for (const version of versions) {
    const found = await page(endpoint.resource, version);
    reference.push({
      version,
      page: found.url,
      sha256: found.sha256,
      documented: found.endpoints.has(`${endpoint.method} ${normal(endpoint.path)}`),
    });
  }
  const evidence = EVIDENCE.find(
    (item) =>
      item.resource === endpoint.resource && (!item.method || item.method === endpoint.method),
  );
  const contradicted = reference.some(
    (item) => item.documented && item.version >= endpoint.removedIn,
  );
  const status = contradicted
    ? 'contradicted'
    : evidence?.removedIn === endpoint.removedIn
      ? 'confirmed'
      : evidence?.removedIn && evidence.removedIn < endpoint.removedIn
        ? 'confirmed-earlier'
        : 'not-in-current-reference';
  results.push({
    resource: endpoint.resource,
    method: endpoint.method,
    path: endpoint.path,
    sdkRemovedIn: endpoint.removedIn,
    status,
    ...(status === 'confirmed' || status === 'confirmed-earlier'
      ? { removedIn: evidence.removedIn }
      : {}),
    source:
      status === 'contradicted' || !evidence
        ? (reference.find((item) => item.page)?.page ??
          `https://shopify.dev/docs/api/admin-rest/${versions.at(-1)}`)
        : evidence.source,
    ...(evidence && status !== 'contradicted'
      ? { archived: evidence.archived, says: evidence.says }
      : {}),
    reference,
    checkedAt: values['checked-at'],
  });
}
const count = (status) => results.filter((item) => item.status === status).length;
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/shopify-rest-verify.mjs',
      checkedAt: values['checked-at'],
      supportedVersions: versions,
      summary: Object.fromEntries(
        ['confirmed', 'confirmed-earlier', 'not-in-current-reference', 'contradicted'].map(
          (status) => [status, count(status)],
        ),
      ),
      endpoints: results,
    },
    null,
    2,
  )}\n`,
);
console.error(
  JSON.stringify(Object.fromEntries(results.map((item) => [item.status, count(item.status)]))),
);

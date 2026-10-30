#!/usr/bin/env node
// Saves Meta's changelog pages as documentation snapshots in docs/benchmarks/meta-graph-changelog/pages,
// so every quote in data/meta-graph/changes.json and data/rules/meta-graph is checked against the
// text someone read. Pages already saved are kept unless --refresh is given.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { documentationText } from '../pipeline/documentation-sources.ts';
import { META_PAGES, META_PAGE_SOURCES } from '../pipeline/meta-graph-rules.ts';
import { digest } from '../pipeline/specifications.ts';

const MAX_BYTES = 16 * 1024 * 1024;
const { values } = parseArgs({ options: { refresh: { type: 'boolean' } } });
await mkdir(META_PAGES, { recursive: true });
for (const [label, url] of Object.entries(META_PAGE_SOURCES)) {
  const path = new URL(`${label}.json`, META_PAGES);
  if (existsSync(path) && !values.refresh) continue;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  // Meta moves pages between /docs and /documentation; anything off developers.facebook.com is refused.
  if (!response.ok || new URL(response.url).hostname !== 'developers.facebook.com')
    throw new Error(`${label}: ${url} returned HTTP ${response.status} from ${response.url}`);
  const html = await response.text();
  if (html.length > MAX_BYTES) throw new Error(`${label}: page is larger than ${MAX_BYTES} bytes`);
  const content = documentationText(html);
  const hash = digest(content);
  const snapshot = {
    formatVersion: 1,
    kind: 'refit-documentation-snapshot',
    label,
    url,
    revision: hash,
    hash,
    content,
    contentType: 'text/html',
  };
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`${label}: ${content.length} characters from ${response.url}`);
}

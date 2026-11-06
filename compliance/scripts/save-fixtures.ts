// Replaces the transcribed fixtures in compliance/fixtures/official/ with text fetched from the
// official pages, so tests run on real snapshots. No AI spend. Run on a machine that can reach them:
//   node --experimental-strip-types compliance/scripts/save-fixtures.ts
// Sources it can't read (PDFs, blocked pages) are listed and their fixture is left as it was.
// After saving, re-run the tests: the quotes in watch.test.ts must still be found in the new text.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpFetcher } from '../fetch.ts';

const dir = fileURLToPath(new URL('../fixtures/official/', import.meta.url));
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
  url: string;
  file: string;
}[];
const fetcher = httpFetcher();
for (const { url, file } of index) {
  const page = await fetcher.fetch(url);
  if (!page.ok) {
    console.log(`kept ${file}: could not read ${url} (${page.error ?? page.status})`);
    continue;
  }
  const header = `SNAPSHOT of ${url}, fetched ${new Date().toISOString()} and converted to text by compliance/fetch.ts.\n\n`;
  writeFileSync(join(dir, file), header + page.text);
  console.log(`saved ${file} (${page.text.length} characters)`);
}

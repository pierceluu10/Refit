// Saves the Markdown of every docs.stripe.com changelog page the breaking-change catalog cites
// as a refit-documentation-snapshot, the input `refit classify-release` reads.
//
//   node scripts/stripe-changelog-pages.mjs
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const CHANGELOG = fileURLToPath(new URL('../docs/benchmarks/stripe-changelog/', import.meta.url));
const { captureDocumentation } = await tsImport('../pipeline/documentation-sources.ts', {
  parentURL: import.meta.url,
  tsconfig: false,
});

for (const release of (await readdir(join(CHANGELOG, 'catalog'))).sort()) {
  await mkdir(join(CHANGELOG, 'pages', release), { recursive: true });
  for (const file of (await readdir(join(CHANGELOG, 'catalog', release))).sort()) {
    const { source } = JSON.parse(
      await readFile(join(CHANGELOG, 'catalog', release, file), 'utf8'),
    );
    const slug = file.replace(/\.json$/, '');
    const snapshot = await captureDocumentation({ label: slug, url: `${source}.md` });
    await writeFile(
      join(CHANGELOG, 'pages', release, file),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    console.log(`${release}/${slug}: ${snapshot.content.length} characters`);
  }
}

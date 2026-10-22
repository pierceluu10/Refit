// Merges the per-wrapper selections of scripts/ai-app-select.mjs (--provider ai-sdk-openai,
// ai-sdk-anthropic, langchain-openai, langchain-anthropic, llamaindex) into the frozen AI wrapper
// sample. A repository selected by several lists is kept once, under the first list that chose
// it; each list's queries, filters and rejection counts are kept with it.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: { output: { type: 'string' } },
  allowPositionals: true,
});
if (!values.output || !positionals.length) {
  console.log(
    'Usage: node scripts/model-wrapper-sample.mjs --output <frozen.json> <selection.json>...',
  );
  process.exit(1);
}
const lists = [];
const repos = [];
const seen = new Set();
for (const path of positionals) {
  const { repos: selected, ...selection } = JSON.parse(await readFile(path, 'utf8'));
  let kept = 0;
  for (const entry of selected) {
    const name = entry.repo.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    repos.push({ ...entry, wrapper: selection.provider });
    kept += 1;
  }
  lists.push({ ...selection, selected: selected.length, kept });
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, note: 'AI wrapper SDK sample for docs/MODEL-WRAPPERS.md: one ai-app-select.mjs run per wrapper, merged in this order.', lists, repos }, null, 2)}\n`,
);
console.error(`${repos.length} repositories from ${lists.length} lists`);

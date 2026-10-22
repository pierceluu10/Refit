// Runs the AI wrapper SDK detector on each blind-labelled repository at its frozen commit and
// scores it (scripts/model-wrapper-score.mjs). Files are read only; nothing is installed or run.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scoreWrapperSites } from '../scripts/model-wrapper-score.mjs';
import { TEST_PATH } from './deadline-exposure.ts';
import { modelWrapperSites } from './model-wrappers.ts';
import { readRepository } from './repository.ts';

const { values } = parseArgs({
  options: {
    labels: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.labels || !values.root || !values.output) {
  console.log(
    'Usage: tsx pipeline/model-wrapper-score-cli.ts --labels <labels.json> --root <checkouts> --output <score.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const labels = JSON.parse(await readFile(values.labels, 'utf8'));
const detected: Record<string, ReturnType<typeof modelWrapperSites>> = {};
// A repository Refit cannot read (an invalid manifest, say) is listed and left out of the score.
const errors: { repo: string; error: string }[] = [];
let custom = 0;
for (const entry of labels.repos)
  try {
    const repository = await readRepository(join(values.root, entry.repo.replace('/', '__')));
    // Scored like the labels: matches only, outside test and example files. Sites on a provider
    // set to another endpoint are named stops, not matches, and are counted apart.
    const sites = modelWrapperSites(repository).filter((site) => !TEST_PATH.test(site.file));
    detected[entry.repo] = sites.filter((site) => !site.custom);
    custom += sites.length - detected[entry.repo].length;
  } catch (error) {
    errors.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
const score = scoreWrapperSites(
  labels.repos.filter(
    (entry: { repo: string }) => !errors.some((item) => item.repo === entry.repo),
  ),
  detected,
);
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, labels: values.labels, scoredAt: new Date().toISOString(), errors, customStops: custom, ...score }, null, 2)}\n`,
);
console.error(JSON.stringify({ precision: score.precision, recall: score.recall }));

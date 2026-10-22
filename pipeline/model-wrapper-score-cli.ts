// Runs the AI wrapper SDK detector on each blind-labelled repository at its frozen commit and
// scores it (scripts/model-wrapper-score.mjs). Files are read only; nothing is installed or run.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scoreWrapperSites } from '../scripts/model-wrapper-score.mjs';
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
for (const entry of labels.repos) {
  const repository = await readRepository(join(values.root, entry.repo.replace('/', '__')));
  detected[entry.repo] = modelWrapperSites(repository);
}
const score = scoreWrapperSites(labels.repos, detected);
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, labels: values.labels, scoredAt: new Date().toISOString(), ...score }, null, 2)}\n`,
);
console.error(JSON.stringify({ precision: score.precision, recall: score.recall }));

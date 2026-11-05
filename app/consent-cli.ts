// Sets whether a customer agrees to shared learning, once they have told us. The default is no.
//   node --experimental-strip-types app/consent-cli.ts <installationId> <yes|no>
// Stored under APTITUDE_APP_DIR and read fresh for every piece of evidence, so a change applies at once.
import { join } from 'node:path';
import { appDataDir } from './config.ts';
import { createConsentStore } from './consent.ts';

const USAGE = 'usage: consent-cli.ts <installationId> <yes|no>';
const ANSWERS = new Map([
  ['yes', true],
  ['no', false],
]);

const [installation, answer] = process.argv.slice(2);
const shareLearning = ANSWERS.get(answer ?? '');
if (shareLearning === undefined) {
  console.error(USAGE);
  process.exit(1);
}
await createConsentStore(join(appDataDir(), 'installations')).set(
  Number(installation),
  shareLearning,
);
console.log(`installation ${installation} shareLearning: ${shareLearning}`);

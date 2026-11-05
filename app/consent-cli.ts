// Sets whether a customer agrees to shared learning, once they have told us. The default is no.
//   node --experimental-strip-types app/consent-cli.ts <installationId> <yes|no>
// Stored under APTITUDE_APP_DIR and read fresh for every piece of evidence, so a change applies at once.
import { join } from 'node:path';
import { appDataDir } from './config.ts';
import { createConsentStore } from './consent.ts';

const USAGE = 'usage: consent-cli.ts <installationId> <yes|no>';
const INSTALLATION_ID = /^[1-9]\d*$/;
const ANSWERS = new Map([
  ['yes', true],
  ['no', false],
]);

const [installation, answer] = process.argv.slice(2);
const shareLearning = ANSWERS.get(answer ?? '');
if (shareLearning === undefined || !INSTALLATION_ID.test(installation ?? '')) {
  console.error(USAGE);
  process.exit(1);
}
const store = createConsentStore(join(appDataDir(), 'installations'));
// A yes for an id not installed yet would still stand when it's installed, past the default of no.
if (!(await store.known(Number(installation)))) {
  console.error(`installation ${installation} has no install on record`);
  process.exit(1);
}
await store.set(Number(installation), shareLearning);
console.log(`installation ${installation} shareLearning: ${shareLearning}`);

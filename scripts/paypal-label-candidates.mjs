// Lists the lines of a repository's non-test JS/TS source that may send a PayPal REST request, so a
// person can label the real requests without looking at Refit's output: lines naming a PayPal REST
// host, a @paypal package, a server SDK controller class, a `new …Request(` of the old SDK, or a
// PayPal base held in a variable. A plain text search; nothing from the repository is run.
//
//   node scripts/paypal-label-candidates.mjs --repository <directory>
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TESTS =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$|\.d\.ts$|\.min\.js$/i;
const LINE =
  /paypal\.com|@paypal\/|(?:Orders|Payments|Vault|Subscriptions|Transactions|OAuthAuthorization|Authentication)Controller|\bnew\s+[\w$.]*\w+Request\s*\(|paypal(?:_|-)?(?:api|base|url|client)/i;

const { values } = parseArgs({ options: { repository: { type: 'string' } } });
if (!values.repository) {
  console.log('Usage: node scripts/paypal-label-candidates.mjs --repository <directory>');
  process.exit(1);
}
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) await visit(path);
    } else if (SOURCE.test(entry.name)) {
      const name = relative(values.repository, path);
      if (TESTS.test(name)) continue;
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (LINE.test(line)) console.log(`${name}:${index + 1}: ${line.trim().slice(0, 150)}`);
      });
    }
  }
}
await visit(values.repository);

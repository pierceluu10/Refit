import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [mode, scenario = 'pages'] = process.argv.slice(2);
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const billingRequire = createRequire(new URL('../packages/billing/package.json', import.meta.url));
assert.equal(billingRequire('stripe/package.json').version, '10.17.0');
assert.equal(
  JSON.parse(readFileSync('node_modules/stripe/package.json', 'utf8')).version,
  '19.1.0',
);
assert.equal(typeof createRequire(import.meta.url)('stripe'), 'function');
assert.equal(existsSync('node_modules/root-script-ran'), false);
assert.equal(existsSync('packages/billing/node_modules/workspace-script-ran'), false);
const { paymentIntentId } = await import('@refit-fixture/ids');
assert.equal(paymentIntentId, 'pi_refit_contract');
process.env.REFIT_FIXTURE_PAGINATION = '1';
process.env.REFIT_FIXTURE_EMPTY = scenario === 'empty' ? '1' : '0';
process.env.REFIT_EXPECTED_API_VERSION = '2022-08-01';
process.argv.splice(2, process.argv.length, './packages/billing/src/history.ts', mode);
await import('./stripe-contract.mjs');

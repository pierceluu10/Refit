import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SHOPIFY_REST_DEPRECATIONS,
  checkShopifyRestDeprecations,
  scanShopifyRestDeprecations,
  type ShopifyRestDeprecationScan,
} from './shopify-rest-deprecations.ts';
import { parseObject } from './specifications.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit shopify-rest [--repository <root>] [--json]
       refit shopify-rest --check-deprecations [--deprecations <path>] [--json]
Lists the REST Admin calls a Shopify app makes to endpoints that a later Admin API version no longer has, with file:line, the version that removes the endpoint, whether the version the app is served already lacks it, and the registry sunset of the last version that has it. Calls are the ones refit scan reports under shopify.restCalls; removals come from data/shopify-rest-deprecations.json, generated from the REST resources Shopify ships per version in @shopify/shopify-api.
--check-deprecations validates that list and exits 1 on any error.
Review only: nothing is changed, installed, run or sent to Shopify.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      'check-deprecations': { type: 'boolean' },
      deprecations: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (values['check-deprecations']) {
    const errors = checkShopifyRestDeprecations(
      parseObject(
        await readFile(
          values.deprecations ? resolve(values.deprecations) : SHOPIFY_REST_DEPRECATIONS,
          'utf8',
        ),
        'Shopify REST deprecations',
      ),
    );
    if (values.json) console.log(JSON.stringify({ errors }));
    else {
      console.log(
        errors.length
          ? 'Shopify REST deprecations are invalid'
          : 'Shopify REST deprecations are valid',
      );
      for (const error of errors) console.log(`  error     ${terminalText(error)}`);
    }
    if (errors.length) process.exitCode = 1;
  } else {
    const root = resolve(values.repository ?? '.');
    const scan = await scanShopifyRestDeprecations(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, checkedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function print(root: string, scan: ShopifyRestDeprecationScan) {
  console.log(`Refit Shopify REST deprecations  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to Shopify.');
  console.log(
    `Pinned       ${scan.pinned.length ? scan.pinned.join(', ') : 'none found'}${scan.served ? `; served ${scan.served}` : ''}`,
  );
  const live = scan.calls.filter((call) => call.use === 'live');
  console.log(
    `\n${live.length} live REST ${live.length === 1 ? 'call' : 'calls'} to a removed endpoint; ${scan.unmatched} other REST calls match no removal; ${scan.unreadable} could not be read.`,
  );
  for (const call of live) {
    const { endpoint } = call;
    console.log(
      `\n${terminalText(`${call.file}:${call.line}`)}  ${endpoint.method} ${terminalText(endpoint.path)}  (${terminalText(endpoint.resource)})`,
    );
    console.log(
      `  Removed in ${endpoint.removedIn}; last in ${endpoint.lastVersion}${call.deadline ? `, which Shopify retires on ${call.deadline.date}` : ''}`,
    );
    console.log(
      `  shopify.dev  ${
        endpoint.shopifyDev.status === 'confirmed'
          ? `confirms the removal in ${endpoint.removedIn}`
          : endpoint.shopifyDev.status === 'confirmed-earlier'
            ? `removes it in ${endpoint.removedIn} (the SDK resources say ${endpoint.sdkRemovedIn})`
            : 'no supported version documents it; the removal version is from the SDK only'
      } (${terminalText(endpoint.shopifyDev.source)})`,
    );
    console.log(
      `  Status     ${call.status === 'removed' ? 'the version this app is served no longer has it' : call.status === 'upcoming' ? 'still served; removed when the app moves to ' + endpoint.removedIn : 'unknown: no API version pin found'}`,
    );
  }
  const tests = scan.calls.length - live.length;
  if (tests) console.log(`\n${tests} more in tests, examples and fixtures.`);
}

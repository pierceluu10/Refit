import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanPayPalCalls, type PayPalCall, type PayPalCallScan } from './paypal-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit paypal [--repository <root>] [--json]
Lists the PayPal REST requests a repository makes: @paypal/checkout-server-sdk request classes sent with client.execute, @paypal/paypal-server-sdk controller calls, and raw calls to api-m.paypal.com, api-m.sandbox.paypal.com, api.paypal.com and api.sandbox.paypal.com through fetch, axios and helpers. Each shows file:line, the HTTP method and path, the matching operation in PayPal's published OpenAPI documents, and the controller method of the newest recorded @paypal/paypal-server-sdk release that makes the same request. Values built at runtime are marked unknown, with the reason.
Review only: nothing is changed, installed, run or sent to PayPal. Replacing @paypal/checkout-server-sdk is an owner decision; this command proposes no edit.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const root = resolve(values.repository ?? '.');
    const scan = await scanPayPalCalls(root);
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

function via(call: PayPalCall) {
  if (call.kind === 'checkout-sdk')
    return call.client
      ? `${call.request} via ${call.client}`
      : `${call.request}, no execute call traced`;
  if (call.kind === 'server-sdk') return call.request!;
  return `${call.client ?? 'no request call traced'} to ${call.hosts.join(' or ')}`;
}

function print(root: string, scan: PayPalCallScan) {
  console.log(`Refit PayPal REST calls  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to PayPal.');
  for (const item of scan.packages)
    console.log(
      `SDK          ${item.name} ${terminalText(item.locked ?? item.declared)} in ${terminalText(item.file)}${item.deprecated ? ' (deprecated on npm)' : ''}`,
    );
  console.log(
    `Contracts    ${terminalText(scan.specification.repository)} at ${scan.specification.commit.slice(0, 7)}`,
  );
  const live = scan.calls.filter((call) => call.use === 'live');
  const tests = scan.calls.filter((call) => call.use === 'test');
  if (!scan.calls.length) {
    console.log('\nNo PayPal REST request was found.');
    return;
  }
  const count = (test: (call: PayPalCall) => boolean) => live.filter(test).length;
  console.log(
    `\n${live.length} ${live.length === 1 ? 'request' : 'requests'} in live code: path known in ${count((call) => call.path !== null)}, matched to a published operation in ${count((call) => call.operation !== null)}.`,
  );
  for (const call of live) {
    console.log(
      `\n${terminalText(`${call.file}:${call.line}`)}  ${call.method ?? 'method unknown'} ${terminalText(call.path ?? 'path unknown')}`,
    );
    console.log(`  Via        ${terminalText(via(call))}`);
    if (call.operation)
      console.log(
        `  Operation  ${terminalText(`${call.operation.operationId ?? 'unnamed'} in ${call.operation.document}`)}`,
      );
    if (call.counterpart && call.kind !== 'server-sdk')
      console.log(
        `  New SDK    ${terminalText(call.counterpart.length ? call.counterpart.join(', ') : 'no controller method makes this request')}`,
      );
    for (const note of call.notes) console.log(`  Note       ${terminalText(note)}`);
    for (const reason of call.unknown) console.log(`  Unknown    ${terminalText(reason)}`);
  }
  if (tests.length) {
    const files = new Map<string, number[]>();
    for (const call of tests) files.set(call.file, [...(files.get(call.file) ?? []), call.line]);
    console.log(
      `\nIn tests and examples (${tests.length}): ${terminalText(
        [...files].map(([file, lines]) => `${file}:${lines.join(',')}`).join(' '),
      )}`,
    );
  }
}

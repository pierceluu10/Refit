import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanGraphCalls, type GraphCall } from './meta-graph-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit meta-graph [--repository <root>] [--json]
Lists the Meta Graph API requests a repository makes: raw graph.facebook.com calls through fetch, axios and helpers, and facebook-nodejs-business-sdk resource-class calls. Each shows file:line, the pinned version, the path and edge, and the requested fields and metrics where they are written literally. Values built at runtime are marked unknown, with the reason.
Review only: nothing is changed, installed, run or sent to Meta.`;

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
    const scan = await scanGraphCalls(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, checkedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan.calls, scan.sdk);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function list(values: string[] | null) {
  if (values === null) return 'unknown';
  return values.length ? values.join(', ') : 'none';
}

function print(
  root: string,
  calls: GraphCall[],
  sdk: Awaited<ReturnType<typeof scanGraphCalls>>['sdk'],
) {
  console.log(`Refit Meta Graph API calls  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to Meta.');
  if (sdk)
    console.log(
      `SDK          facebook-nodejs-business-sdk ${terminalText(sdk.locked ?? sdk.declared)} in ${terminalText(`${sdk.file}:${sdk.line}`)}${sdk.version ? ` targets Graph API ${sdk.version}` : ''}`,
    );
  const live = calls.filter((call) => call.use === 'live');
  const tests = calls.filter((call) => call.use === 'test');
  if (!calls.length) {
    console.log('\nNo Graph API request was found.');
    return;
  }
  const count = (test: (call: GraphCall) => boolean) => live.filter(test).length;
  console.log(
    `\n${live.length} ${live.length === 1 ? 'request' : 'requests'} in live code: version known in ${count((call) => call.version !== null)}, path known in ${count((call) => call.path !== null)}, fields known in ${count((call) => call.fields !== null)}.`,
  );
  for (const call of live) {
    const where = terminalText(`${call.file}:${call.line}`);
    console.log(
      `\n${where}  ${call.method ?? 'method unknown'} ${terminalText(call.path ?? 'path unknown')}`,
    );
    const pin = call.pin ? ` (${terminalText(`${call.pin.file}:${call.pin.line}`)})` : '';
    console.log(
      `  Version    ${call.version ?? (call.versionSource === 'unversioned' ? 'none in the URL' : 'unknown')}${pin}`,
    );
    console.log(
      `  Via        ${terminalText(call.client ?? 'no request call traced')}${call.edge ? `, edge ${terminalText(call.edge)}` : ''}`,
    );
    console.log(`  Fields     ${terminalText(list(call.fields))}`);
    if (call.metrics === null || call.metrics.length)
      console.log(`  Metrics    ${terminalText(list(call.metrics))}`);
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

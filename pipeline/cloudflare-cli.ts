import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  scanCloudflareCalls,
  type CloudflareCall,
  type CloudflareScan,
} from './cloudflare-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit cloudflare [--repository <root>] [--json]
Lists the Cloudflare API requests a repository makes: calls of the cloudflare npm SDK (client.<resource>.<method>, mapped to the endpoint each method requests, and client.get('/path')), and raw requests to https://api.cloudflare.com/client/v4 through fetch, axios and helpers. Each shows file:line, the HTTP method and path, and what Cloudflare's API deprecations page and published OpenAPI document say about the endpoint. Values built at runtime are marked unknown, with the reason.
It also lists each Worker's compatibility_date and compatibility_flags from wrangler.toml, wrangler.json and wrangler.jsonc as inventory facts: Cloudflare supports old compatibility dates indefinitely, so none of them is a deadline.
Review only: nothing is changed, installed, run or sent to Cloudflare.`;

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
    const scan = await scanCloudflareCalls(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, scannedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function via(call: CloudflareCall) {
  if (call.kind === 'url')
    return `${call.client ?? 'no request call traced'} to api.cloudflare.com`;
  return call.client ?? 'unknown';
}

function print(root: string, scan: CloudflareScan) {
  console.log(`Refit Cloudflare API calls  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to Cloudflare.');
  for (const item of scan.packages)
    console.log(
      `SDK          ${item.name} ${terminalText(item.locked ?? item.declared)} in ${terminalText(item.file)}`,
    );
  console.log(
    `Contracts    ${terminalText(scan.sources.openapi.repository)} at ${scan.sources.openapi.commit.slice(0, 7)}; deprecations page at ${scan.sources.deprecations.commit.slice(0, 7)}`,
  );
  const live = scan.calls.filter((call) => call.use === 'live');
  const tests = scan.calls.filter((call) => call.use === 'test');
  if (!scan.calls.length) console.log('\nNo Cloudflare API request was found.');
  else {
    const flagged = live.filter((call) =>
      call.notices.some((notice) => notice.change === 'deprecated'),
    ).length;
    console.log(
      `\n${live.length} ${live.length === 1 ? 'request' : 'requests'} in live code, ${flagged} to a deprecated endpoint.`,
    );
    for (const call of live) {
      console.log(
        `\n${terminalText(`${call.file}:${call.line}`)}  ${call.method ?? 'method unknown'} ${terminalText(call.path ?? 'path unknown')}`,
      );
      console.log(`  Via        ${terminalText(via(call))}`);
      for (const notice of call.notices)
        console.log(
          `  ${notice.change === 'deprecated' ? 'Deprecated' : 'Changes   '} ${terminalText(notice.title)}${notice.endOfLife ? `, end of life ${notice.endOfLife}` : ''} (${notice.source === 'openapi' ? 'OpenAPI document' : 'deprecations page'})`,
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
  if (scan.workers.length) console.log('\nWorkers compatibility (inventory facts, no deadline):');
  for (const worker of scan.workers) {
    console.log(
      `  ${terminalText(`${worker.file}:${worker.line}`)}${worker.environment ? ` [env.${terminalText(worker.environment)}]` : ''}  ${worker.compatibilityDate ?? 'no compatibility_date'}${worker.flags.length ? `, flags ${terminalText(worker.flags.join(', '))}` : ''}`,
    );
    if (worker.laterDefaults.length)
      console.log(
        `    ${worker.laterDefaults.length} compatibility ${worker.laterDefaults.length === 1 ? 'flag turns' : 'flags turn'} on by default for later dates`,
      );
    for (const note of worker.notes) console.log(`    Note  ${terminalText(note)}`);
  }
}

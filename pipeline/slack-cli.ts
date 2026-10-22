import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanSlackCalls, type SlackCall, type SlackCallScan } from './slack-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit slack [--repository <root>] [--json]
Lists the Slack Web API methods a repository calls: @slack/web-api WebClient calls (client.<group>.<method>, apiCall, paginate, filesUploadV2), Bolt's app.client and handler client calls, and raw requests to https://slack.com/api/<method> through fetch, axios and helpers. It also lists incoming webhooks (@slack/webhook and hooks.slack.com requests) and Legacy RTM API clients, report only. Each call shows file:line, the method, and what Slack's SDKs say about it: a deprecation with its changelog post, a method @slack/web-api 8 removed, or one no recorded release defines. Values built at runtime are marked unknown, with the reason.
Review only: nothing is changed, installed, run or sent to Slack. Retired methods with a published date also appear in refit deadlines.`;

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
    const scan = await scanSlackCalls(root);
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

function print(root: string, scan: SlackCallScan) {
  console.log(`Refit Slack Web API calls  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to Slack.');
  for (const item of scan.packages)
    console.log(
      `SDK          ${item.name} ${terminalText(item.locked ?? item.declared)} in ${terminalText(item.file)}`,
    );
  const live = scan.calls.filter((call) => call.use === 'live');
  const tests = scan.calls.filter((call) => call.use === 'test');
  printFindings(scan);
  if (!scan.calls.length) {
    console.log('\nNo Slack Web API call was found.');
    return;
  }
  const deprecated = live.filter((call) => call.deprecation).length;
  console.log(
    `\n${live.length} ${live.length === 1 ? 'call' : 'calls'} in live code, ${deprecated} to a deprecated or removed method.`,
  );
  for (const call of live) {
    console.log(
      `\n${terminalText(`${call.file}:${call.line}`)}  ${terminalText(call.methods.join(' + ') || 'method unknown')}`,
    );
    console.log(`  Via        ${terminalText(via(call))}`);
    if (call.deprecation) {
      console.log(`  Deprecated ${terminalText(call.deprecation.reason)}`);
      if (call.deprecation.announcement)
        console.log(`  Notice     ${terminalText(call.deprecation.announcement)}`);
    }
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

// Incoming webhooks and the Legacy RTM API, report only.
function printFindings(scan: SlackCallScan) {
  for (const [label, items] of [
    ['Incoming webhooks', scan.webhooks],
    ['Legacy RTM API', scan.rtm],
  ] as const) {
    const live = items.filter((item) => item.use === 'live');
    if (!live.length) continue;
    console.log(`\n${label} (${live.length}):`);
    for (const item of live) {
      console.log(`  ${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.via)}`);
      for (const note of item.notes) console.log(`    Note  ${terminalText(note)}`);
    }
  }
}

function via(call: SlackCall) {
  if (call.kind === 'url') return `${call.client ?? 'no request call traced'} to slack.com/api`;
  return call.client ?? 'unknown';
}

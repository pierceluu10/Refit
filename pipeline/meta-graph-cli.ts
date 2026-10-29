import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { scanGraphCalls, type GraphCall } from './meta-graph-calls.ts';
import {
  checkMetaGraphChanges,
  DEFAULT_META_GRAPH_CHANGES,
  loadMetaGraphChanges,
} from './meta-graph-changes.ts';
import { proposeVersionMoves, type VersionMoveProposal } from './meta-graph-moves.ts';
import { loadMetaGraphRules } from './meta-graph-rules.ts';
import {
  loadMetaPlatformAlerts,
  planMetaGraphFixes,
  type MetaGraphFixPlan,
} from './meta-graph-fixes.ts';
import { parseObject } from './specifications.ts';
import { terminalText } from './workflow-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE = `Usage: refit meta-graph [--repository <root>] [--json]
       refit meta-graph --propose-version-moves --target <version> [--repository <root>] [--output <patch>] [--changes <path>] [--json]
       refit meta-graph --fix --target <version> [--repository <root>] [--output <patch>] [--changes <path>] [--rules <dir>] [--alerts <path>] [--json]
       refit meta-graph --check-changes [--changes <path>] [--json]
Lists the Meta Graph API requests a repository makes: raw graph.facebook.com calls through fetch, axios and helpers, and facebook-nodejs-business-sdk resource-class calls. Each shows file:line, the pinned version, the path and edge, and the requested fields and metrics where they are written literally. Values built at runtime are marked unknown, with the reason.
--propose-version-moves proposes moving each pinned Graph API version to --target only where every request through it is fully known and every changelog crossed is reviewed and lists nothing those requests use; every other pin stops for review with the exact reasons. It prints a patch, or writes it to --output; it never applies, validates or publishes it.
--fix adds the documented rules in data/rules/meta-graph to those moves (a field or metric renamed in a literal list moves with the version; every other rule, and any rule marked for review, stops the move with its source), lists product migrations that need a person with Meta's documented plan (Instagram Basic Display), and lists dated alerts for permission, product and policy changes from data/meta-platform-alerts.json, which never edit code. It prints the patch, or writes it to --output; it never applies, validates or publishes it.
--check-changes validates the reviewed per-version change list in data/meta-graph-changes.json, lists versions whose changelog was not read, and versions the deadline registry has that the list does not. It exits 1 on any error.
Review only: nothing is changed, installed, run or sent to Meta.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      'check-changes': { type: 'boolean' },
      'propose-version-moves': { type: 'boolean' },
      target: { type: 'string' },
      output: { type: 'string' },
      changes: { type: 'string' },
      fix: { type: 'boolean' },
      rules: { type: 'string' },
      alerts: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (values['check-changes']) await checkChanges(values.changes, values.json);
  else if (values.fix)
    await fix(
      resolve(values.repository ?? '.'),
      values.target,
      values.changes,
      values.rules,
      values.alerts,
      values.output,
      values.json,
    );
  else if (values['propose-version-moves'])
    await proposeMoves(
      resolve(values.repository ?? '.'),
      values.target,
      values.changes,
      values.output,
      values.json,
    );
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
  console.error(cliErrorMessage(error, 'meta-graph'));
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

async function checkChanges(path: string | undefined, json: boolean | undefined) {
  const now = new Date();
  const registry = await loadDeadlineRegistry(undefined, now);
  const versions = registry.deadlines
    .filter((entry) => entry.provider === 'meta-graph')
    .flatMap((entry) => entry.versions);
  const report = checkMetaGraphChanges(
    parseObject(
      await readFile(path ? resolve(path) : DEFAULT_META_GRAPH_CHANGES, 'utf8'),
      'Meta Graph API change list',
    ),
    now,
    versions,
  );
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(
      report.errors.length
        ? 'Meta Graph API change list is invalid'
        : 'Meta Graph API change list is valid',
    );
    for (const error of report.errors) console.log(`  error     ${terminalText(error)}`);
    if (report.unread.length)
      console.log(
        `  unread    ${terminalText(report.unread.join(', '))} (a version move across these stops for review)`,
      );
    if (report.missing.length)
      console.log(
        `  missing   ${terminalText(report.missing.join(', '))} (in the deadline registry, not in the change list)`,
      );
  }
  process.exitCode = report.errors.length ? 1 : 0;
}

async function proposeMoves(
  root: string,
  target: string | undefined,
  changesPath: string | undefined,
  output: string | undefined,
  json: boolean | undefined,
) {
  if (!target) throw new TypeError('--propose-version-moves requires --target, such as v24.0.');
  const now = new Date();
  const changes = await loadMetaGraphChanges(
    changesPath ? resolve(changesPath) : DEFAULT_META_GRAPH_CHANGES,
    now,
  );
  const registry = await loadDeadlineRegistry(undefined, now);
  const proposal = await proposeVersionMoves(root, target, changes, registry, now);
  if (output && proposal.patch) await writeFile(resolve(output), proposal.patch);
  if (json) {
    console.log(JSON.stringify({ repository: root, checkedAt: now.toISOString(), ...proposal }));
    return;
  }
  console.log(
    `Refit Meta Graph API version moves to ${terminalText(target)}  ${terminalText(root)}`,
  );
  console.log(
    'Review only: nothing was applied or validated. Whether a hand-kept change list is enough evidence for an automatic edit is an owner decision; apply a move on a branch and run your checks.',
  );
  printProposal(target, proposal, output);
}

async function fix(
  root: string,
  target: string | undefined,
  changesPath: string | undefined,
  rulesPath: string | undefined,
  alertsPath: string | undefined,
  output: string | undefined,
  json: boolean | undefined,
) {
  if (!target) throw new TypeError('--fix requires --target, such as v24.0.');
  const now = new Date();
  const plan: MetaGraphFixPlan = await planMetaGraphFixes(root, target, {
    changes: await loadMetaGraphChanges(
      changesPath ? resolve(changesPath) : DEFAULT_META_GRAPH_CHANGES,
      now,
    ),
    registry: await loadDeadlineRegistry(undefined, now),
    rules: await loadMetaGraphRules(rulesPath ? resolve(rulesPath) : undefined),
    alerts: await loadMetaPlatformAlerts(alertsPath ? resolve(alertsPath) : undefined),
    now,
  });
  if (output && plan.proposal.patch) await writeFile(resolve(output), plan.proposal.patch);
  if (json) {
    console.log(JSON.stringify({ repository: root, checkedAt: now.toISOString(), ...plan }));
    return;
  }
  console.log(`Refit Meta Graph API fixes for ${terminalText(target)}  ${terminalText(root)}`);
  console.log('Nothing was applied, validated or sent to Meta.');
  printProposal(target, plan.proposal, output);
  for (const migration of plan.migrations) {
    console.log(`\nProduct migration needs review: ${migration.product}`);
    for (const use of migration.uses)
      console.log(`  ${terminalText(`${use.file}:${use.line}`)}  ${terminalText(use.evidence)}`);
    for (const step of migration.plan) console.log(`  - ${terminalText(step)}`);
    for (const source of migration.sources) console.log(`  Source  ${terminalText(source)}`);
  }
  if (plan.alerts.length) console.log('\nAlerts (never edited):');
  for (const alert of plan.alerts)
    console.log(
      `  ${terminalText(`${alert.file}:${alert.line}`)}  ${alert.effective ?? 'undated'} ${alert.status}  ${terminalText(alert.matched)}: ${terminalText(alert.summary)}${alert.replacement ? ` Replacement: ${terminalText(alert.replacement.join(', '))}.` : ''} ${terminalText(alert.source)}`,
    );
}

function printProposal(target: string, proposal: VersionMoveProposal, output: string | undefined) {
  if (!proposal.moves.length && !proposal.stops.length)
    console.log('\nNo request pins a Graph API version older than the target.');
  for (const move of proposal.moves)
    console.log(
      `\n${terminalText(`${move.file}:${move.line}`)}  ${move.from} to ${move.to}\n  Crosses      ${terminalText(move.crossed.join(', '))}\n  Requests     ${terminalText(move.requests.map((item) => `${item.file}:${item.line}`).join(' '))}${move.rules.length ? `\n  Rules        ${terminalText(move.rules.join(', '))}` : ''}`,
    );
  if (proposal.stops.length) console.log('\nStopped for review:');
  for (const stop of proposal.stops) {
    console.log(
      `\n  ${stop.file ? terminalText(`${stop.file}:${stop.line}  ${stop.from}`) : 'No pinned version'}  (${stop.requests.length} ${stop.requests.length === 1 ? 'request' : 'requests'})`,
    );
    for (const reason of stop.reasons) console.log(`    ${terminalText(reason)}`);
  }
  if (proposal.current.length)
    console.log(`\n${proposal.current.length} requests already use ${terminalText(target)}.`);
  if (proposal.patch && output) console.log(`\nPatch written to ${terminalText(resolve(output))}`);
  else if (proposal.patch) console.log(`\n${proposal.patch}`);
}

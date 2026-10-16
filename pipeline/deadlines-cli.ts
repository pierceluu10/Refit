import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrationNote, timing } from './deadline-alerts.ts';
import {
  agentStatus,
  configuredIntegrations,
  scanDeadlines,
  type DeadlineEvidence,
} from './deadline-exposure.ts';
import {
  checkDeadlineRegistry,
  DEFAULT_DEADLINE_REGISTRY,
  loadDeadlineRegistry,
} from './deadline-registry.ts';
import { parseObject } from './specifications.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE =
  'Usage: refit deadlines [--repository <root>] [--registry <path>] [--json]\n       refit deadlines --check-registry [--registry <path>] [--json]\nLists API versions and models a repository pins that have a provider sunset date in the reviewed registry, with file:line evidence. Only live code counts; model lists, tests, examples, comments, tokenizers and checks are listed separately. --check-registry validates the registry and flags past-due entries and entries without a source. Nothing runs, installs or contacts a provider.';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      registry: { type: 'string' },
      'check-registry': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const now = new Date();
  const registryPath = values.registry ? resolve(values.registry) : DEFAULT_DEADLINE_REGISTRY;
  if (values.help) console.log(USAGE);
  else if (values['check-registry']) {
    const report = checkDeadlineRegistry(
      parseObject(await readFile(registryPath, 'utf8'), 'Deadline registry'),
      now,
    );
    if (values.json) console.log(JSON.stringify(report));
    else {
      console.log(
        report.errors.length ? 'Deadline registry is invalid' : 'Deadline registry is valid',
      );
      for (const error of report.errors) console.log(`  error     ${terminalText(error)}`);
      for (const id of report.missingSource)
        console.log(`  no source ${terminalText(id)} (ignored for matching and alerts)`);
      for (const entry of report.pastDue)
        console.log(
          `  past due  ${terminalText(entry.id)} (${entry.date}, ${timing(-entry.days)})`,
        );
    }
    process.exitCode = report.errors.length ? 1 : 0;
  } else {
    const root = resolve(values.repository ?? '.');
    const registry = await loadDeadlineRegistry(registryPath, now);
    const [scan, integrations] = await Promise.all([
      scanDeadlines(root, registry, now),
      configuredIntegrations(root),
    ]);
    const results = scan.exposures.map((exposure) => ({
      ...exposure,
      agent: agentStatus(exposure.deadline.provider, integrations),
    }));
    if (values.json)
      console.log(
        JSON.stringify({
          repository: root,
          checkedAt: now.toISOString(),
          exposures: results,
          mentions: scan.mentions,
        }),
      );
    else {
      console.log(`Refit deadlines  ${terminalText(root)}`);
      if (!results.length)
        console.log(
          '\nNo API version or model this repository uses in live code has a deadline in the registry.',
        );
      for (const { deadline, days, evidence, more, nonLive, nonLiveMore, agent } of results) {
        console.log(
          `\n${terminalText(deadline.summary)}\n  Deadline     ${deadline.date} (${timing(days)})`,
        );
        if (deadline.replacement)
          console.log(`  Replacement  ${terminalText(deadline.replacement)}`);
        console.log(
          `  Source       ${terminalText(deadline.source ?? '')} (checked ${deadline.checkedAt})`,
        );
        for (const item of evidence)
          console.log(`  ${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.text)}`);
        if (more) console.log(`  …and ${more} more matches`);
        printNonLive(nonLive, nonLiveMore);
        console.log(`  Migration    ${terminalText(migrationNote(deadline.provider, agent))}`);
      }
      if (scan.mentions.length) {
        console.log('\nNamed only outside live code (not counted as exposure):');
        for (const { deadline, days, nonLive, nonLiveMore } of scan.mentions) {
          console.log(`\n${terminalText(deadline.summary)} ${deadline.date} (${timing(days)})`);
          printNonLive(nonLive, nonLiveMore);
        }
      }
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

// Non-live matches, collapsed to one line per use with each file's line numbers.
function printNonLive(items: DeadlineEvidence[], more: number) {
  if (!items.length) return;
  const uses = new Map<string, Map<string, number[]>>();
  for (const item of items) {
    const files = uses.get(item.use) ?? new Map<string, number[]>();
    uses.set(item.use, files);
    files.set(item.file, [...(files.get(item.file) ?? []), item.line]);
  }
  let label = 'Not live';
  for (const [use, files] of uses) {
    const places = [...files].map(([file, lines]) => `${file}:${lines.join(',')}`).join(' ');
    console.log(`  ${label.padEnd(11)}  ${use.padEnd(9)}  ${terminalText(places)}`);
    label = '';
  }
  if (more) console.log(`  ${''.padEnd(11)}  …and ${more} more`);
}

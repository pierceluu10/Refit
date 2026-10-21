import { readFile, writeFile } from 'node:fs/promises';
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
  type DeadlineRegistry,
} from './deadline-registry.ts';
import {
  applyDeadlineIgnores,
  DEADLINE_IGNORE_FILE,
  deadlineCheck,
  parseFailWithin,
  readDeadlineIgnores,
  type DeadlineIgnore,
} from './deadline-ignores.ts';
import { proposeModelReplacements } from './model-retirements.ts';
import {
  ANTHROPIC_DEPRECATIONS,
  parseAnthropicDeprecations,
  syncAnthropicDeadlines,
} from './deadline-sync.ts';
import { parseObject } from './specifications.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit deadlines [--repository <root>] [--fail-within <days>] [--ignore-file <path>] [--registry <path>] [--json]
       refit deadlines --propose-model-fixes [--repository <root>] [--output <patch>] [--registry <path>] [--json]
       refit deadlines --check-registry [--registry <path>] [--json]
       refit deadlines --sync anthropic [--registry <path>] [--write] [--json]
Lists API versions and models a repository pins, and SDK packages it declares, that have a provider sunset or end-of-support date in the reviewed registry, with file:line evidence. Only live code counts; model lists, tests, examples, comments, tokenizers and checks are listed separately.
--fail-within <days> exits 2 when a live exposure is past due or within that many days, for CI. Reviewed, expiring exceptions go in ${DEADLINE_IGNORE_FILE} at the repository root; --ignore-file reads another file. Exit 0 means the check passed, 1 an error (including an invalid ignore file).
--propose-model-fixes proposes replacing retiring OpenAI and Anthropic model IDs with the registry replacement, only where the ID is a literal model in a traced SDK call, and lists every case that stops for review. It prints a patch, or writes it to --output; it never applies, validates or publishes it.
--sync anthropic reads Anthropic's model deprecations page and lists registry entries to add or update; --write saves them. It never deletes an entry. A scheduled workflow runs it and opens a pull request for review.
--check-registry validates the registry and flags past-due entries and entries without a source. Nothing runs, installs or contacts a provider.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      registry: { type: 'string' },
      'check-registry': { type: 'boolean' },
      'fail-within': { type: 'string' },
      'ignore-file': { type: 'string' },
      'propose-model-fixes': { type: 'boolean' },
      sync: { type: 'string' },
      write: { type: 'boolean' },
      output: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const now = new Date();
  const registryPath = values.registry ? resolve(values.registry) : DEFAULT_DEADLINE_REGISTRY;
  if (values.help) console.log(USAGE);
  else if (values.sync !== undefined) {
    if (values.sync !== 'anthropic')
      throw new Error('--sync supports anthropic; other providers are maintained by hand.');
    const path = values.registry ? resolve(values.registry) : DEFAULT_DEADLINE_REGISTRY;
    const registry = parseObject(await readFile(path, 'utf8'), 'Deadline registry');
    const response = await fetch(`${ANTHROPIC_DEPRECATIONS}.md`);
    if (!response.ok)
      throw new Error(`${ANTHROPIC_DEPRECATIONS}.md answered HTTP ${response.status}.`);
    const rows = parseAnthropicDeprecations(await response.text());
    const today = now.toISOString().slice(0, 10);
    const current = checkDeadlineRegistry(registry, now);
    if (current.errors.length)
      throw new Error(`Deadline registry is invalid: ${current.errors.slice(0, 5).join(' ')}`);
    const sync = syncAnthropicDeadlines(registry as unknown as DeadlineRegistry, rows, today);
    const report = checkDeadlineRegistry(sync.registry, now);
    if (report.errors.length)
      throw new Error(`Synced registry would be invalid: ${report.errors.slice(0, 5).join(' ')}`);
    const write = values.write && (sync.added.length > 0 || sync.changed.length > 0);
    if (write) await writeFile(path, `${JSON.stringify(sync.registry, null, 2)}\n`);
    if (values.json)
      console.log(
        JSON.stringify({
          source: ANTHROPIC_DEPRECATIONS,
          rows: rows.length,
          added: sync.added,
          changed: sync.changed,
          missing: sync.missing,
          written: Boolean(write),
        }),
      );
    else {
      console.log(
        `Anthropic deprecations  ${rows.length} retirements on ${ANTHROPIC_DEPRECATIONS}`,
      );
      for (const id of sync.added) console.log(`  add      ${terminalText(id)}`);
      for (const id of sync.changed) console.log(`  update   ${terminalText(id)}`);
      for (const id of sync.missing)
        console.log(`  missing  ${terminalText(id)} (no longer on the page; kept for review)`);
      if (!sync.added.length && !sync.changed.length)
        console.log('  The registry already matches the page.');
      else if (write) console.log(`Written to ${terminalText(String(path))}`);
      else console.log('Run with --write to save these changes.');
    }
  } else if (values['check-registry']) {
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
  } else if (values['propose-model-fixes']) {
    const root = resolve(values.repository ?? '.');
    const registry = await loadDeadlineRegistry(registryPath, now);
    const proposal = await proposeModelReplacements(root, registry, now);
    if (values.output && proposal.patch) await writeFile(resolve(values.output), proposal.patch);
    if (values.json)
      console.log(JSON.stringify({ repository: root, checkedAt: now.toISOString(), ...proposal }));
    else {
      console.log(`Refit model replacements  ${terminalText(root)}`);
      console.log(
        'Review only: nothing was applied or validated. A replacement model changes behaviour, cost and limits; apply it on a branch and run your checks.',
      );
      if (!proposal.replacements.length && !proposal.stops.length)
        console.log(
          '\nNo traced OpenAI or Anthropic SDK call sends a retiring model as a literal.',
        );
      for (const item of proposal.replacements)
        console.log(
          `\n${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.call)}\n  Replace      ${terminalText(item.from)} with ${terminalText(item.to)} at ${terminalText(`${item.edited.file}:${item.edited.line}`)}\n  Deadline     ${terminalText(item.via.join(' then '))} ${item.date} (${timing(item.days)})`,
        );
      if (proposal.stops.length) console.log('\nStopped for review:');
      for (const item of proposal.stops)
        console.log(
          `  ${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.model)} at ${terminalText(`${item.at.file}:${item.at.line}`)}  ${terminalText(item.reason)}`,
        );
      if (proposal.patch && values.output)
        console.log(`\nPatch written to ${terminalText(resolve(values.output))}`);
      else if (proposal.patch) console.log(`\n${proposal.patch}`);
    }
  } else {
    // Parse the window first, so a typo fails before any scanning.
    const failWithin =
      values['fail-within'] === undefined ? undefined : parseFailWithin(values['fail-within']);
    const root = resolve(values.repository ?? '.');
    const registry = await loadDeadlineRegistry(registryPath, now);
    const [scan, integrations, ignores] = await Promise.all([
      scanDeadlines(root, registry, now),
      configuredIntegrations(root),
      readDeadlineIgnores(root, now, values['ignore-file']),
    ]);
    const { decisions, expired, unknown } = applyDeadlineIgnores(
      scan.exposures,
      ignores.entries,
      new Set(registry.deadlines.map((entry) => entry.id)),
      now,
    );
    const results = scan.exposures.map((exposure) => {
      const decision = decisions.get(exposure.deadline.id);
      return {
        ...exposure,
        agent: agentStatus(exposure.deadline.provider, integrations),
        ignored: decision?.ignoredBy.length ? decision.ignoredBy : null,
        ignoreNote: decision?.note ?? null,
      };
    });
    const check =
      failWithin === undefined ? undefined : deadlineCheck(scan.exposures, decisions, failWithin);
    if (values.json)
      console.log(
        JSON.stringify({
          repository: root,
          checkedAt: now.toISOString(),
          exposures: results,
          mentions: scan.mentions,
          ignores: { file: ignores.file, expired, unknown },
          ...(check ? { check } : {}),
        }),
      );
    else {
      console.log(`Refit deadlines  ${terminalText(root)}`);
      if (!results.length)
        console.log(
          '\nNo API version or model this repository uses in live code has a deadline in the registry.',
        );
      for (const {
        deadline,
        days,
        evidence,
        more,
        nonLive,
        nonLiveMore,
        agent,
        ignored,
        ignoreNote,
      } of results) {
        console.log(
          `\n${terminalText(deadline.summary)}\n  Deadline     ${deadline.date} (${timing(days)})`,
        );
        for (const entry of ignored ?? [])
          console.log(
            `  Ignored      until ${entry.until}${entry.paths ? ` in ${terminalText(entry.paths.join(', '))}` : ''}: ${terminalText(entry.reason)}`,
          );
        if (ignoreNote) console.log(`  Not ignored  ${terminalText(ignoreNote)}`);
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
      printIgnoreWarnings(ignores.file, expired, unknown);
      if (check) {
        const byId = new Map(results.map((result) => [result.deadline.id, result]));
        const window =
          check.failWithin === 0
            ? 'past due or due today'
            : `past due or within ${check.failWithin} days`;
        if (check.status === 'fail') {
          console.log(
            `\nDeadline check failed: ${check.failing.length} live ${check.failing.length === 1 ? 'exposure is' : 'exposures are'} ${window}.`,
          );
          for (const id of check.failing) {
            const result = byId.get(id)!;
            console.log(`  ${id}  ${result.deadline.date} (${timing(result.days)})`);
          }
          console.log(
            `Fix the code, or record a reviewed exception with a reason and an expiry in ${DEADLINE_IGNORE_FILE}.`,
          );
        } else
          console.log(
            `\nDeadline check passed: no live exposure is ${window}${check.ignored.length ? ` (${check.ignored.length} accepted by ${ignores.file})` : ''}.`,
          );
      }
    }
    if (check?.status === 'fail') process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

// Ignores that no longer apply, so a stale exception file gets noticed.
function printIgnoreWarnings(
  file: string | null,
  expired: DeadlineIgnore[],
  unknown: DeadlineIgnore[],
) {
  if (!file || (!expired.length && !unknown.length)) return;
  console.log(`\nIn ${terminalText(file)}:`);
  for (const entry of expired)
    console.log(
      `  expired      ${terminalText(entry.deadline)} (until ${entry.until}); it no longer applies`,
    );
  for (const entry of unknown)
    console.log(
      `  unknown      ${terminalText(entry.deadline)} is not a registry deadline; check for a typo`,
    );
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

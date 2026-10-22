import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrationNote, timing } from './deadline-alerts.ts';
import {
  agentStatus,
  configuredIntegrations,
  scanDeadlines,
  type AgentStatus,
  type DeadlineEvidence,
  type DeadlineUse,
} from './deadline-exposure.ts';
import {
  checkDeadlineRegistry,
  DEFAULT_DEADLINE_REGISTRY,
  loadDeadlineRegistry,
  STALE_CHECK_DAYS,
  reportOnly,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import {
  applyDeadlineIgnores,
  DEADLINE_IGNORE_FILE,
  deadlineCheck,
  parseAllowPastDue,
  parseFailWithin,
  readDeadlineIgnores,
  type DeadlineIgnore,
} from './deadline-ignores.ts';
import {
  checkModelParameters,
  DEFAULT_MODEL_PARAMETERS,
  loadModelParameters,
} from './model-parameters.ts';
import { proposeModelReplacements } from './model-retirements.ts';
import { DEPRECATION_SOURCES, syncDeadlines, type SyncProvider } from './deadline-sync.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

// Providers whose retiring model IDs `--propose-model-fixes` can replace; Gemini is report only.
const MODEL_FIX_PROVIDERS = new Set(['openai', 'anthropic']);
import { cliErrorMessage } from './cli-errors.ts';

const USAGE = `Usage: refit deadlines [--repository <root>] [--fail-within <days> [--allow-past-due <id>[,<id>]...]] [--ignore-file <path>] [--registry <path>] [--json]
       refit deadlines --propose-model-fixes [--repository <root>] [--output <patch>] [--registry <path>] [--parameters <path>] [--json]
       refit deadlines --check-registry [--registry <path>] [--json]
       refit deadlines --check-parameters [--parameters <path>] [--json]
       refit deadlines --sync anthropic|openai|gemini|shopify|meta-graph [--registry <path>] [--write] [--json]
Lists API versions and models a repository pins, and SDK packages it declares, that have a provider sunset or end-of-support date in the reviewed registry, with file:line evidence. Only live code counts; model lists, tests, examples, comments, tokenizers and checks are listed separately.
--fail-within <days> exits 2 when a live exposure is past due or within that many days, for CI. Report-only deadlines (a derived date, or kind method, endpoint, field or feature) are listed but never fail it. Reviewed, expiring exceptions go in ${DEADLINE_IGNORE_FILE} at the repository root; --ignore-file reads another file. A deadline that has already passed keeps failing, with what to upgrade to and whether Refit can propose the upgrade. --allow-past-due <id> (repeatable or comma-separated) turns the named past-due deadlines into warnings; it never applies to a deadline that has not passed yet, and an ID the registry does not have is an error. Exit 0 means the check passed, 1 an error (including an invalid ignore file).
--propose-model-fixes proposes replacing retiring OpenAI and Anthropic model IDs with the registry replacement, only where the ID is a literal model in a traced SDK call, lists every case that stops for review, and lists every other live model ID with why no traced request sends it. It prints a patch, or writes it to --output; it never applies, validates or publishes it.
--sync reads a provider's deprecations page (Anthropic, OpenAI and Gemini API models; Shopify and Meta Graph API versions) and lists registry entries to add or update; --write saves them. It never deletes an entry. A scheduled workflow runs every sync and opens a pull request for review.
--check-registry validates the registry and flags past-due entries, entries without a source and entries checked more than ${STALE_CHECK_DAYS} days ago. Nothing runs, installs or contacts a provider.
--check-parameters validates the sourced model parameter table (data/model-parameters.json) and rejects the whole file on any error. Nothing runs, installs or contacts a provider.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      registry: { type: 'string' },
      'check-registry': { type: 'boolean' },
      'check-parameters': { type: 'boolean' },
      parameters: { type: 'string' },
      'fail-within': { type: 'string' },
      'allow-past-due': { type: 'string', multiple: true },
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
    if (!Object.hasOwn(DEPRECATION_SOURCES, values.sync))
      throw new Error(`--sync supports ${Object.keys(DEPRECATION_SOURCES).join(', ')}.`);
    const source = DEPRECATION_SOURCES[values.sync as SyncProvider];
    const path = values.registry ? resolve(values.registry) : DEFAULT_DEADLINE_REGISTRY;
    const registry = parseObject(await readFile(path, 'utf8'), 'Deadline registry');
    const response = await fetch(source.download);
    if (!response.ok) throw new Error(`${source.download} answered HTTP ${response.status}.`);
    const page = source.parse(await response.text());
    const today = now.toISOString().slice(0, 10);
    const current = checkDeadlineRegistry(registry, now);
    if (current.errors.length)
      throw new Error(`Deadline registry is invalid: ${current.errors.slice(0, 5).join(' ')}`);
    const sync = syncDeadlines(registry as unknown as DeadlineRegistry, source, page.rows, today);
    const report = checkDeadlineRegistry(sync.registry, now);
    if (report.errors.length)
      throw new Error(`Synced registry would be invalid: ${report.errors.slice(0, 5).join(' ')}`);
    const changes = sync.added.length + sync.changed.length + sync.rechecked.length;
    const write = values.write && changes > 0;
    if (write) await writeFile(path, `${JSON.stringify(sync.registry, null, 2)}\n`);
    if (values.json)
      console.log(
        JSON.stringify({
          provider: source.provider,
          source: source.page,
          rows: page.rows.length,
          added: sync.added,
          changed: sync.changed,
          rechecked: sync.rechecked,
          missing: sync.missing,
          skipped: page.skipped,
          written: Boolean(write),
        }),
      );
    else {
      console.log(
        `${source.name} deprecations  ${page.rows.length} retiring ${source.kind === 'model' ? 'models' : 'API versions'} on ${source.page}`,
      );
      for (const id of sync.added) console.log(`  add      ${terminalText(id)}`);
      for (const id of sync.changed) console.log(`  update   ${terminalText(id)}`);
      for (const id of sync.rechecked)
        console.log(`  recheck  ${terminalText(id)} (unchanged; checkedAt was stale)`);
      for (const id of sync.missing)
        console.log(`  missing  ${terminalText(id)} (no longer on the page; kept for review)`);
      for (const row of page.skipped)
        console.log(
          `  skipped  ${terminalText(row.text)}${row.date ? ` (${row.date})` : ''}: ${terminalText(row.reason)}`,
        );
      if (!changes) console.log('  The registry already matches the page.');
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
      for (const entry of report.stale)
        console.log(
          `  stale     ${terminalText(entry.id)} (checked ${entry.checkedAt}, ${entry.days} days ago; read its source again)`,
        );
    }
    process.exitCode = report.errors.length ? 1 : 0;
  } else if (values['check-parameters']) {
    const path = values.parameters ? resolve(values.parameters) : DEFAULT_MODEL_PARAMETERS;
    const table = parseObject(await readFile(path, 'utf8'), 'Model parameter table');
    const report = checkModelParameters(table, now);
    if (values.json) console.log(JSON.stringify(report));
    else {
      const count = Array.isArray(table.models) ? table.models.length : 0;
      console.log(
        report.errors.length
          ? 'Model parameter table is invalid'
          : `Model parameter table is valid (${count} models)`,
      );
      for (const error of report.errors) console.log(`  error     ${terminalText(error)}`);
    }
    process.exitCode = report.errors.length ? 1 : 0;
  } else if (values['propose-model-fixes']) {
    const root = resolve(values.repository ?? '.');
    const registry = await loadDeadlineRegistry(registryPath, now);
    // The sourced parameter table is off by default (owner decision, 2026-10-22).
    const parameters = values.parameters
      ? await loadModelParameters(resolve(values.parameters), now)
      : undefined;
    const proposal = await proposeModelReplacements(root, registry, now, { parameters });
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
      if (proposal.unresolved.length) console.log('\nNot sent by a traced request:');
      for (const item of proposal.unresolved)
        console.log(
          `  ${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.model)}${item.to ? ` (replacement ${terminalText(item.to)})` : ''}  ${terminalText(item.reason)}`,
        );
      if (proposal.patch && values.output)
        console.log(`\nPatch written to ${terminalText(resolve(values.output))}`);
      else if (proposal.patch) console.log(`\n${proposal.patch}`);
    }
  } else {
    // Parse the window first, so a typo fails before any scanning.
    const failWithin =
      values['fail-within'] === undefined ? undefined : parseFailWithin(values['fail-within']);
    if (values['allow-past-due'] && failWithin === undefined)
      throw new PipelineInputError('--allow-past-due only applies with --fail-within.');
    const root = resolve(values.repository ?? '.');
    const registry = await loadDeadlineRegistry(registryPath, now);
    const allowPastDue = parseAllowPastDue(
      values['allow-past-due'] ?? [],
      new Set(registry.deadlines.map((entry) => entry.id)),
    );
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
        reportOnly: reportOnly(exposure.deadline),
        ignored: decision?.ignoredBy.length ? decision.ignoredBy : null,
        ignoreNote: decision?.note ?? null,
      };
    });
    const check =
      failWithin === undefined
        ? undefined
        : deadlineCheck(scan.exposures, decisions, failWithin, allowPastDue);
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
        nonLiveCounts,
        outside,
        outsideMore,
        agent,
        ignored,
        ignoreNote,
      } of results) {
        console.log(
          `\n${days < 0 ? 'Past due: ' : ''}${terminalText(deadline.summary)}\n  Deadline     ${deadline.date} (${timing(days)}${days < 0 ? '; already in effect' : ''})`,
        );
        for (const entry of ignored ?? [])
          console.log(
            `  Ignored      until ${entry.until}${entry.paths ? ` in ${terminalText(entry.paths.join(', '))}` : ''}: ${terminalText(entry.reason)}`,
          );
        if (ignoreNote) console.log(`  Not ignored  ${terminalText(ignoreNote)}`);
        if (reportOnly(deadline)) console.log(`  Report only  ${reportOnlyReason(deadline)}`);
        if (deadline.replacement)
          console.log(`  Replacement  ${terminalText(deadline.replacement)}`);
        console.log(
          `  Source       ${terminalText(deadline.source ?? '')} (checked ${deadline.checkedAt})`,
        );
        for (const item of evidence)
          console.log(`  ${terminalText(`${item.file}:${item.line}`)}  ${terminalText(item.text)}`);
        if (more) console.log(`  …and ${more} more matches`);
        printNonLive(nonLive, nonLiveMore, nonLiveCounts);
        printOutside(outside, outsideMore);
        // A retiring OpenAI or Anthropic model is replaced by a model fix, not an API contract run.
        console.log(
          `  Migration    ${terminalText(
            deadline.kind === 'model' && MODEL_FIX_PROVIDERS.has(deadline.provider)
              ? `Run \`refit deadlines --propose-model-fixes\` to see a patch that moves each traced call${deadline.replacement ? ` to ${deadline.replacement}` : ''}; it applies nothing. \`refit serve --model-fixes\` can validate it and open a draft pull request.`
              : migrationNote(deadline.provider, agent),
          )}`,
        );
      }
      if (scan.mentions.length) {
        console.log('\nNamed only outside live code (not counted as exposure):');
        for (const mention of scan.mentions) {
          const { deadline, days, nonLive, nonLiveMore, nonLiveCounts } = mention;
          console.log(`\n${terminalText(deadline.summary)} ${deadline.date} (${timing(days)})`);
          printNonLive(nonLive, nonLiveMore, nonLiveCounts);
          printOutside(mention.outside, mention.outsideMore);
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
            if (result.days < 0) printPastDue(result.deadline, result.agent);
          }
          console.log(
            `Fix the code, or record a reviewed exception with a reason and an expiry in ${DEADLINE_IGNORE_FILE}${check.failing.some((id) => byId.get(id)!.days < 0) ? '; --allow-past-due <id> turns a passed deadline into a warning' : ''}.`,
          );
        } else
          console.log(
            `\nDeadline check passed${check.allowed ? ` with ${check.allowed.length} past-due ${check.allowed.length === 1 ? 'deadline' : 'deadlines'} allowed by --allow-past-due` : ''}: no ${check.allowed ? 'other ' : ''}live exposure is ${window}${check.ignored.length ? ` (${check.ignored.length} accepted by ${ignores.file})` : ''}.`,
          );
        for (const id of check.allowed ?? []) {
          const result = byId.get(id)!;
          console.log(
            `Warning: ${id} passed on ${result.deadline.date} (${timing(result.days)}); allowed by --allow-past-due, so it does not fail the check.`,
          );
          printPastDue(result.deadline, result.agent);
        }
        for (const id of allowPastDue)
          if ((byId.get(id)?.days ?? -1) >= 0)
            console.log(
              `Note: ${id} has not passed yet (${byId.get(id)!.deadline.date}), so --allow-past-due does not apply to it.`,
            );
      }
    }
    if (check?.status === 'fail') process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'deadlines'));
  process.exitCode = 1;
}

// What a passed deadline means and what to do about it. Refit offers a draft pull request only
// where a fixer exists: model replacements for OpenAI and Anthropic, and API version migrations
// through a provider agent. Everything else is reported and upgraded by hand.
function printPastDue(deadline: DeadlineEntry, agent: AgentStatus) {
  const modelFix =
    deadline.kind === 'model' && MODEL_FIX_PROVIDERS.has(deadline.provider) && deadline.replacement;
  const action = modelFix
    ? 'Refit can propose this replacement as a draft PR where the model is a literal in a traced SDK call (`refit serve --model-fixes`; `refit deadlines --propose-model-fixes` shows the patch and every site it stops on).'
    : deadline.kind === 'api-version' && agent.state !== 'none'
      ? `Refit can propose this upgrade as a draft PR through its ${deadline.provider} agent${agent.state === 'configured' ? '' : ` once it is added (\`refit agents --add ${deadline.provider}\`)`}.`
      : 'Refit reports this, and the upgrade is manual.';
  console.log(`    Passed       on ${deadline.date}; this deadline is already in effect`);
  console.log(`    Source       ${terminalText(deadline.source ?? '')}`);
  console.log(
    `    Upgrade to   ${terminalText(deadline.replacement ?? 'the registry names no replacement; see the source')}`,
  );
  console.log(`    Action       ${action}`);
}

function reportOnlyReason(deadline: DeadlineEntry) {
  const why = deadline.derivedDate
    ? 'the provider has not announced this date; it is an estimate, see the summary'
    : `${deadline.kind} deadlines are report only`;
  return `${why}, so it never fails --fail-within or opens an alert`;
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

// Non-live matches, collapsed to one line per use: the exact count, then each listed file's line
// numbers. A use whose matches all fall past the listing limit still gets a line with its count.
// Live matches on docs, example, test-fixture and build-output paths, with the reason each path is
// excluded. Listed so nothing is hidden; never counted (docs/WORKSPACE-ATTRIBUTION.md).
function printOutside(items: DeadlineEvidence[] = [], more = 0) {
  if (!items.length) return;
  console.log('  Also found outside application code (not counted):');
  for (const item of items)
    console.log(
      `    ${terminalText(`${item.file}:${item.line}`)}  ${item.excluded}  ${terminalText(item.text)}`,
    );
  if (more) console.log(`    …and ${more} more`);
}

function printNonLive(
  items: DeadlineEvidence[],
  more: number,
  counts: Partial<Record<DeadlineUse, number>> = {},
) {
  if (!items.length) return;
  const uses = new Map<DeadlineUse, Map<string, number[]>>();
  for (const item of items) {
    const files = uses.get(item.use) ?? new Map<string, number[]>();
    uses.set(item.use, files);
    files.set(item.file, [...(files.get(item.file) ?? []), item.line]);
  }
  for (const use of Object.keys(counts) as DeadlineUse[])
    if (!uses.has(use)) uses.set(use, new Map());
  const total = (use: DeadlineUse, files: Map<string, number[]>) =>
    counts[use] ?? [...files.values()].reduce((sum, lines) => sum + lines.length, 0);
  const width = Math.max(...[...uses].map(([use, files]) => String(total(use, files)).length));
  let label = 'Not live';
  for (const [use, files] of uses) {
    const places = [...files].map(([file, lines]) => `${file}:${lines.join(',')}`).join(' ');
    console.log(
      `  ${label.padEnd(11)}  ${use.padEnd(9)}  ${String(total(use, files)).padStart(width)}${places ? `  ${terminalText(places)}` : ''}`,
    );
    label = '';
  }
  if (more) console.log(`  ${''.padEnd(11)}  …and ${more} more`);
}

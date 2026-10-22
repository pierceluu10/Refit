// Ground truth for the fresh Stripe set (docs/benchmarks/2026-10-16-stripe-fresh-repos.json).
//   sample:   a seeded draw of 40 "affected" and 40 "not affected" repositories from the committed
//             outcomes, plus the "stopped" order the next 40 come from.
//   prepare:  a labelling root for `npm run benchmark:stripe-labels`: the sampled clones, each
//             one's locked (else declared minimum) stripe version, and that version's type
//             definitions, extracted from the npm tarball and never installed.
//   assemble: oracle output plus hand decisions into the labels file.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { seededSample } from './ai-app-helpers.mjs';

const execute = promisify(execFile);
const LIST = 'docs/benchmarks/2026-10-16-stripe-fresh-repos.json';
const RESULTS = 'docs/benchmarks/2026-10-16-stripe-fresh-results.json';
const SEED = 20261022;
// The next repositories labelled come from the seeded "stopped" order, after the 80.
const EXTENSION = 40;
// Outcomes in which Refit reported nothing to change. `exceeds-scan-limits` was never scanned and
// belongs to neither group.
const NOT_AFFECTED = new Set(['not-affected', 'no-mapped-methods', 'no-sdk-calls']);
const UNSCANNED = new Set(['exceeds-scan-limits']);

export function group(outcome) {
  if (UNSCANNED.has(outcome)) return null;
  return NOT_AFFECTED.has(outcome) ? 'not-affected' : 'affected';
}

// Each group in seeded order; the first `size` of each are the sample, and the "stopped" order
// (outcomes starting `stopped-`, sample excluded) supplies the extension.
export function draw(rows, seed = SEED, size = 40) {
  const order = (keys) => seededSample(keys, seed, 1);
  const outcome = new Map(rows.map((row) => [row.repo, row.outcome]));
  const keys = (name) => rows.filter((row) => group(row.outcome) === name).map((row) => row.repo);
  const affected = order(keys('affected')).slice(0, size);
  const notAffected = order(keys('not-affected')).slice(0, size);
  const taken = new Set([...affected, ...notAffected]);
  const stopped = order(
    rows
      .filter((row) => row.outcome.startsWith('stopped-') && !taken.has(row.repo))
      .map((r) => r.repo),
  );
  return { affected, notAffected, stopped, outcome };
}

// The stripe version a repository installs: its lockfile's, else the declared range's minimum.
export function lockedStripe(files, declared) {
  const npm = files['package-lock.json'] && JSON.parse(files['package-lock.json']);
  const fromNpm =
    npm?.packages?.['node_modules/stripe']?.version ?? npm?.dependencies?.stripe?.version;
  if (fromNpm) return { version: fromNpm, source: 'package-lock.json' };
  const pnpm = files['pnpm-lock.yaml'];
  if (pnpm) {
    // v9: importers → '.' → dependencies; v6: top-level dependencies, both with specifier and
    // version; v5: a top-level `stripe: x.y.z`.
    const root = /^importers:\n {2}\.:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(pnpm)?.[1] ?? pnpm;
    const match =
      /^( +)stripe:\n\1 {2}specifier: .*\n\1 {2}version: (\d+\.\d+\.\d+)/m.exec(root)?.slice(1) ??
      /^ {2,4}stripe: (\d+\.\d+\.\d+)/m.exec(root);
    if (match) return { version: match[1], source: 'pnpm-lock.yaml' };
  }
  const yarn = files['yarn.lock'];
  if (yarn) {
    const match = /^"?stripe@[^\n]*:\n {2}version:? "?(\d+\.\d+\.\d+)"?/m.exec(yarn);
    if (match) return { version: match[1], source: 'yarn.lock' };
  }
  const bun = files['bun.lock'];
  if (bun) {
    const match = /"stripe": \["stripe@(\d+\.\d+\.\d+)"/.exec(bun);
    if (match) return { version: match[1], source: 'bun.lock' };
  }
  const minimum = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(declared ?? '');
  if (!minimum) return null;
  return {
    version: `${minimum[1]}.${minimum[2] ?? 0}.${minimum[3] ?? 0}`,
    source: 'declared minimum',
  };
}

async function readOptional(path) {
  return existsSync(path) ? readFile(path, 'utf8') : undefined;
}

async function sample() {
  const { rows } = JSON.parse(await readFile(RESULTS, 'utf8'));
  const { affected, notAffected, stopped, outcome } = draw(rows);
  const entry = (repo) => ({ repo, outcome: outcome.get(repo) });
  console.log(
    JSON.stringify(
      {
        seed: SEED,
        affected: affected.map(entry),
        notAffected: notAffected.map(entry),
        stoppedOrder: stopped.map(entry),
      },
      null,
      2,
    ),
  );
}

async function prepare(source, root, repos) {
  const pinned = JSON.parse(await readFile(LIST, 'utf8'));
  const byRepo = new Map(pinned.repos.map((entry) => [entry.repo, entry]));
  await mkdir(join(root, 'repos'), { recursive: true });
  await mkdir(join(root, 'stripe-types'), { recursive: true });
  // Specs are copied from an existing benchmark root (built by stripe-benchmark-setup.mjs).
  if (!existsSync(join(root, 'specs')))
    await cp(join(source, 'specs'), join(root, 'specs'), { recursive: true });
  const sdk = [];
  for (const repo of repos) {
    const entry = byRepo.get(repo);
    if (!entry) throw new Error(`${repo} is not in ${LIST}`);
    const name = repo.replace('/', '__');
    const directory = join(root, 'repos', name);
    if (!existsSync(directory))
      await cp(join(source, 'repos', name), directory, { recursive: true, verbatimSymlinks: true });
    // A clone counts only when it is the pinned commit with no local change.
    const { stdout: head } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    const { stdout: status } = await execute('git', ['-C', directory, 'status', '--porcelain']);
    if (head.trim() !== entry.commit || status.trim())
      throw new Error(`${repo}: clone is not the pinned commit ${entry.commit} or has changes`);
    const files = {};
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'])
      files[lock] = await readOptional(join(directory, lock));
    const locked = lockedStripe(files, entry.stripeDependency);
    if (!locked) throw new Error(`${repo}: no stripe version in ${entry.stripeDependency}`);
    const types = join(root, 'stripe-types', `stripe@${locked.version}`);
    if (!existsSync(join(types, 'package'))) {
      await mkdir(types, { recursive: true });
      // `npm pack` downloads the published tarball; it runs no install scripts.
      const { stdout } = await execute('npm', ['pack', `stripe@${locked.version}`, '--silent'], {
        cwd: types,
      });
      await execute('tar', ['-xzf', join(types, stdout.trim()), '-C', types]);
    }
    sdk.push({ repo, before: entry.before, dep: entry.stripeDependency, ...locked });
  }
  const versions = [...new Set([...sdk.map((entry) => entry.before), pinned.target])].sort();
  await writeFile(join(root, 'labelled-sdk.json'), `${JSON.stringify(sdk, null, 1)}\n`);
  await writeFile(
    join(root, 'needed-specs.json'),
    `${JSON.stringify(
      versions.map((version) => ({ version })),
      null,
      1,
    )}\n`,
  );
  console.log(JSON.stringify({ root, repos: sdk.length, versions: versions.length }));
}

const key = (read) => `${read.file}\0${read.line}\0${read.column}\0${read.property}`;
// Unresolved reads in files that never mention Stripe (any case) are app code; a file that
// mentions it only in a comment or an import of a local helper goes to hand review instead.
const MENTIONS_STRIPE = /stripe/i;
const EVENT_RECEIVER = /(?:^|[^\w$.])(?:event|evt|e|stripeEvent|webhookEvent)\??\.$/;

// One repository's labels: the oracle's decided reads and typed request parameters, the
// documented rules, then hand decisions for every read the oracle left unknown. An override
// replaces an oracle label where a cast to a hand-written type hides a Stripe object.
export function labelRepository({ entry, oracle, decisions, source }) {
  const forRepo = (list) =>
    new Map(list.filter((d) => d.repo === entry.repo).map((d) => [key(d), d]));
  const manual = forRepo(decisions.reads);
  const disputed = forRepo(decisions.disputed ?? []);
  const overrides = forRepo(decisions.overrides ?? []);
  const reads = [];
  const requests = [];
  for (const read of oracle.reads) {
    const base = {
      file: read.file,
      line: read.line,
      column: read.column,
      property: read.property,
      // A chain that spans lines starts earlier; Refit reports a read where its chain starts.
      ...(read.start && read.start.line !== read.line ? { startLine: read.start.line } : {}),
    };
    if (read.request) {
      requests.push({ ...base, label: 'breaking', source: 'oracle', field: read.request });
      continue;
    }
    const decision = manual.get(key(read));
    const override = overrides.get(key(read));
    if (override) {
      if (read.label === 'unknown')
        throw new Error(`${entry.repo} ${key(read)}: override of unknown`);
      reads.push({
        ...base,
        label: override.label,
        source: 'manual',
        ...(override.field ? { field: override.field } : {}),
        note: `${override.note} (oracle: ${read.label})`,
      });
    } else if (read.label !== 'unknown') {
      if (decision)
        throw new Error(`${entry.repo} ${key(read)}: decided by the oracle and by hand`);
      reads.push({
        ...base,
        label: read.label,
        source: 'oracle',
        ...(read.label === 'breaking' ? { field: `${read.schemas[0]}.${read.property}` } : {}),
        ...(disputed.has(key(read)) ? { disputed: disputed.get(key(read)).disputed } : {}),
      });
    } else if (decision) {
      reads.push({
        ...base,
        label: decision.label,
        source: 'manual',
        ...(decision.field ? { field: decision.field } : {}),
        note: decision.note,
      });
    } else if (!MENTIONS_STRIPE.test(source(read.file))) {
      reads.push({ ...base, label: 'not-stripe', source: 'rule-no-stripe-in-file' });
    } else if (
      read.property === 'type' &&
      EVENT_RECEIVER.test(
        source(read.file)
          .split('\n')
          [read.line - 1].slice(0, read.column - 1),
      )
    ) {
      reads.push({ ...base, label: 'stripe-unaffected', source: 'rule-event-type' });
    } else
      throw new Error(
        `${entry.repo} ${read.file}:${read.line}:${read.column} ${read.property}: no decision`,
      );
  }
  for (const request of decisions.requests.filter((d) => d.repo === entry.repo)) {
    const { repo: _repo, ...rest } = request;
    requests.push({ ...rest, source: 'manual' });
  }
  const used = reads.filter((read) => read.source === 'manual').length;
  if (used !== manual.size + overrides.size)
    throw new Error(
      `${entry.repo}: ${manual.size + overrides.size - used} hand decisions match no read`,
    );
  const breaking = reads.filter((read) => read.label === 'breaking').length;
  const removed = requests.filter((request) => request.label === 'breaking').length;
  return {
    repo: entry.repo,
    before: entry.before,
    sdk: entry.version,
    sdkSource: entry.source,
    verdict: breaking || removed ? 'broken' : 'unaffected',
    reason:
      breaking || removed
        ? `${breaking} breaking reads, ${removed} removed request parameters`
        : 'every read of a removed property name and every request is decided, and none breaks',
    breaking,
    reads,
    requests,
  };
}

async function assemble(root, oracleDirectory, decisionsPath, output) {
  const { rows } = JSON.parse(await readFile(RESULTS, 'utf8'));
  const { affected, notAffected, stopped, outcome } = draw(rows);
  const extension = stopped.slice(0, EXTENSION);
  const sdk = JSON.parse(await readFile(join(root, 'labelled-sdk.json'), 'utf8'));
  const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
  const repos = [];
  for (const repo of [...affected, ...notAffected, ...extension]) {
    const entry = sdk.find((candidate) => candidate.repo === repo);
    if (!entry) throw new Error(`${repo} is not in ${join(root, 'labelled-sdk.json')}`);
    const name = repo.replace('/', '__');
    const oracle = JSON.parse(await readFile(join(oracleDirectory, `${name}.json`), 'utf8'));
    const cache = new Map();
    const source = (file) => {
      if (!cache.has(file)) cache.set(file, readFileSync(join(root, 'repos', name, file), 'utf8'));
      return cache.get(file);
    };
    repos.push({
      ...labelRepository({ entry, oracle, decisions, source }),
      outcome: outcome.get(repo),
    });
  }
  const labels = {
    formatVersion: 2,
    labelledAt: '2026-10-22',
    target: JSON.parse(await readFile(LIST, 'utf8')).target,
    sample: {
      seed: SEED,
      list: LIST,
      results: RESULTS,
      affected,
      notAffected,
      extension,
    },
    labelled: [...affected, ...notAffected, ...extension],
    heldOut: [],
    repos,
  };
  await writeFile(output, `${JSON.stringify(labels, null, 1)}\n`);
  const count = (verdict) => repos.filter((repo) => repo.verdict === verdict).length;
  console.log(
    JSON.stringify({
      repos: repos.length,
      broken: count('broken'),
      unaffected: count('unaffected'),
    }),
  );
}

// Refit reports a removed request parameter as `<call> argument[n].<path>`; the shared scorer
// counts those against read precision, so they are scored here against the request labels.
const REQUEST_FINDING = / argument\[\d+\]\./;

// Read and request precision and recall, repository detection, and every miss and false alarm.
// Disputed reads (labelled stripe-unaffected) are also scored as breaking.
export function scoreLabels(labels, results) {
  const byRepo = new Map(results.filter(Boolean).map((row) => [row.repo, row]));
  const count = () => ({ tp: 0, fp: 0, fn: 0 });
  const totals = {
    reads: { confirmed: count(), any: count() },
    readsDisputedBreaking: { confirmed: count(), any: count() },
    requests: { confirmed: count(), any: count() },
  };
  // detected: a confirmed finding names a break; flagged: any finding does.
  const repos = { broken: 0, detected: 0, flagged: 0, unaffected: 0, falseAlarms: 0 };
  const misses = [];
  const falsePositives = [];
  for (const labelled of labels.repos) {
    const row = byRepo.get(labelled.repo);
    const findings = (row?.fullAdapter ?? row?.shippedAdapter)?.findings ?? [];
    const readFindings = findings.filter((finding) => !REQUEST_FINDING.test(finding.property));
    const requestFindings = findings.filter((finding) => REQUEST_FINDING.test(finding.property));
    const at = (value) => `${value.file}\0${value.line}\0${value.property}`;
    const starts = (read) =>
      read.startLine ? [at(read), at({ ...read, line: read.startLine })] : [at(read)];
    const labelOf = new Map(
      labelled.reads.flatMap((read) => starts(read).map((key) => [key, read])),
    );
    const requestOf = (finding) =>
      labelled.requests.find(
        (request) =>
          request.file === finding.file &&
          request.line === finding.line &&
          finding.property.endsWith(`.${request.property}`),
      );
    const hit = { confirmed: false, any: false };
    for (const level of ['confirmed', 'any']) {
      const reported = (list) =>
        list.filter((finding) => level === 'any' || finding.confidence === 'confirmed');
      const reads = new Set(reported(readFindings).map(at));
      for (const [target, disputedBreaking] of [
        [totals.reads[level], false],
        [totals.readsDisputedBreaking[level], true],
      ]) {
        const breaking = (read) =>
          read.label === 'breaking' || (disputedBreaking && Boolean(read.disputed));
        for (const key of reads) {
          const read = labelOf.get(key);
          if (read && (['excluded', 'unknown'].includes(read.label) || breaking(read))) continue;
          target.fp += 1;
          if (!disputedBreaking && level === 'confirmed')
            falsePositives.push({
              repo: labelled.repo,
              file: key.split('\0')[0],
              line: Number(key.split('\0')[1]),
              property: key.split('\0')[2],
              label: read?.label ?? 'not a labelled read',
              ...(read?.disputed ? { disputed: true } : {}),
            });
        }
        // Reads are keyed by file, line and property, as in the shared scorer.
        const unique = new Map(labelled.reads.filter(breaking).map((read) => [at(read), read]));
        for (const read of unique.values())
          if (starts(read).some((key) => reads.has(key))) target.tp += 1;
          else {
            target.fn += 1;
            if (!disputedBreaking && level === 'confirmed')
              misses.push({
                repo: labelled.repo,
                kind: 'read',
                file: read.file,
                line: read.line,
                field: read.field,
                reported: readFindings.some((finding) => starts(read).includes(at(finding)))
                  ? 'review'
                  : 'none',
              });
          }
      }
      const requests = reported(requestFindings);
      const matched = new Set(requests.map(requestOf).filter(Boolean));
      const breakingRequests = labelled.requests.filter((request) => request.label === 'breaking');
      totals.requests[level].tp += breakingRequests.filter((request) =>
        matched.has(request),
      ).length;
      totals.requests[level].fp += requests.filter(
        (finding) =>
          requestOf(finding)?.label !== 'breaking' && requestOf(finding)?.label !== 'excluded',
      ).length;
      for (const request of breakingRequests)
        if (!matched.has(request)) {
          totals.requests[level].fn += 1;
          if (level === 'confirmed')
            misses.push({
              repo: labelled.repo,
              kind: 'request',
              file: request.file,
              line: request.line,
              field: request.field,
              reported: requestFindings.some((finding) => requestOf(finding) === request)
                ? 'review'
                : 'none',
            });
        }
      hit[level] =
        [...reads].some((key) => labelOf.get(key)?.label === 'breaking') ||
        breakingRequests.some((request) => matched.has(request));
    }
    if (labelled.verdict === 'broken') {
      repos.broken += 1;
      if (hit.confirmed) repos.detected += 1;
      if (hit.any) repos.flagged += 1;
    } else {
      repos.unaffected += 1;
      if (findings.some((finding) => finding.confidence === 'confirmed')) repos.falseAlarms += 1;
    }
  }
  return { totals, repos, misses, falsePositives };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      root: { type: 'string' },
      repos: { type: 'string' },
      oracle: { type: 'string' },
      decisions: { type: 'string' },
      output: { type: 'string' },
      labels: { type: 'string' },
      results: { type: 'string', multiple: true },
    },
  });
  const [command] = positionals;
  if (command === 'sample') await sample();
  else if (command === 'prepare' && values.source && values.root && values.repos)
    await prepare(
      resolve(values.source),
      resolve(values.root),
      JSON.parse(await readFile(values.repos, 'utf8')),
    );
  else if (
    command === 'assemble' &&
    values.root &&
    values.oracle &&
    values.decisions &&
    values.output
  )
    await assemble(resolve(values.root), resolve(values.oracle), values.decisions, values.output);
  else if (command === 'score' && values.labels && values.results) {
    // Several results files (shards) are scored as one run.
    const results = [];
    for (const path of values.results) results.push(...JSON.parse(await readFile(path, 'utf8')));
    const score = scoreLabels(JSON.parse(await readFile(values.labels, 'utf8')), results);
    if (values.output) await writeFile(values.output, `${JSON.stringify(score, null, 1)}\n`);
    const rate = ({ tp, fp, fn }) =>
      `recall ${tp}/${tp + fn} (${Math.round((100 * tp) / (tp + fn || 1))}%)  precision ${tp}/${tp + fp} (${Math.round((100 * tp) / (tp + fp || 1))}%)`;
    for (const [name, levels] of Object.entries(score.totals))
      for (const [level, value] of Object.entries(levels))
        console.log(`${name.padEnd(22)} ${level.padEnd(9)} ${rate(value)}`);
    console.log(JSON.stringify(score.repos));
  } else {
    console.error(
      'Usage: node scripts/stripe-fresh-labels.mjs sample\n   or: prepare --source <fresh benchmark root> --root <new labelling root> --repos <repos.json>\n   or: assemble --root <labelling root> --oracle <benchmark:stripe-labels output> --decisions <decisions.json> --output <labels.json>\n   or: score --labels <labels.json> --results <results.json> [--results …] [--output <score.json>]',
    );
    process.exit(1);
  }
}

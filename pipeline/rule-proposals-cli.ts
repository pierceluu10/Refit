// Rule proposals from AI fixes that passed every gate (pipeline/rule-proposals.ts).
//
//   propose  one run's merged results -> rule-proposals.json and rule-proposals.md (refit-bench runs
//            this after every AI provider benchmark; it never writes the ledger)
//   record   folds a run's rule-proposals.json into data/rule-proposals/ledger.json (a reviewed PR)
//   accept   a person approves an open proposal: the rule goes into its table with a quote from a
//            saved provider page, and a synthetic fixture test is written
//   reject   a person turns one down with a reason, so it is never proposed again
//   report   misses by category and proposals open / accepted / rejected, per round
//
// propose runs with plain Node (`node --experimental-strip-types`); accept loads the rule tables'
// own checks, so it runs with tsx from a full checkout.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  decide,
  emptyLedger,
  LEDGER,
  loadKnownRules,
  parseLedger,
  recordRun,
  renderReport,
  renderRun,
  runProposals,
  type Ledger,
  type ResultRow,
  type RunProposals,
} from './rule-proposals.ts';

const USAGE = `Usage:
  rule-proposals-cli.ts propose --results <merged results.json> --list <list> --run <id> --commit <sha> --out <dir> [--root .]
  rule-proposals-cli.ts record --proposals <rule-proposals.json>... [--root .]
  rule-proposals-cli.ts accept <id> --by <name> --reason <why> [rule options, docs/RULE-PROPOSALS.md] [--root .]
  rule-proposals-cli.ts reject <id> --by <name> --reason <why> --verdict wrong|out-of-scope|duplicate|other [--root .]
  rule-proposals-cli.ts report [--out docs/benchmarks/rule-proposals.md] [--root .]`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const today = () => new Date().toISOString().slice(0, 10);

export async function readLedger(root: string): Promise<Ledger> {
  const text = await readFile(join(root, LEDGER), 'utf8').catch(() => null);
  return text === null ? emptyLedger() : parseLedger(JSON.parse(text));
}

async function writeLedger(root: string, ledger: Ledger) {
  await mkdir(dirname(join(root, LEDGER)), { recursive: true });
  await writeFile(join(root, LEDGER), json(ledger));
}

const listName = (list: string) =>
  list
    .split('/')
    .at(-1)!
    .replace(/\.json$/, '');

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      results: { type: 'string' },
      list: { type: 'string' },
      run: { type: 'string' },
      commit: { type: 'string' },
      out: { type: 'string' },
      proposals: { type: 'string', multiple: true },
      by: { type: 'string' },
      reason: { type: 'string' },
      verdict: { type: 'string' },
      // accept
      rule: { type: 'string' },
      status: { type: 'string' },
      page: { type: 'string' },
      quote: { type: 'string' },
      summary: { type: 'string' },
      'from-major': { type: 'string' },
      apis: { type: 'string' },
      models: { type: 'string' },
      note: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const root = resolve(values.root!);
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (command === 'propose') {
    if (!values.results || !values.list || !values.run || !values.commit || !values.out)
      throw new Error(USAGE);
    const parsed = JSON.parse(await readFile(values.results, 'utf8'));
    const rows = (Array.isArray(parsed) ? parsed : parsed.results) as ResultRow[];
    const run = runProposals(
      rows,
      { list: listName(values.list), run: values.run, commit: values.commit, date: today() },
      await readLedger(root),
      await loadKnownRules(root),
    );
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, 'rule-proposals.json'), json(run));
    await writeFile(join(values.out, 'rule-proposals.md'), renderRun(run));
    console.log(
      `${run.validatedFixes} validated AI ${run.validatedFixes === 1 ? 'fix' : 'fixes'}: ${run.proposals.filter((item) => item.state === 'new').length} new, ${run.proposals.filter((item) => item.state === 'open').length} open seen again, ${run.covered.length} covered, ${run.suppressed.length} rejected before.`,
    );
    return;
  }
  if (command === 'record') {
    if (!values.proposals?.length) throw new Error(USAGE);
    let ledger = await readLedger(root);
    for (const path of values.proposals) {
      const run = JSON.parse(await readFile(path, 'utf8')) as RunProposals;
      if (run.formatVersion !== 1 || !Array.isArray(run.proposals))
        throw new Error(`${path} is not a rule-proposals.json.`);
      ledger = recordRun(ledger, run);
    }
    await writeLedger(root, ledger);
    console.log(
      `${LEDGER}: ${ledger.proposals.filter((item) => item.status === 'open').length} open.`,
    );
    return;
  }
  if (command === 'reject') {
    const [id] = positionals;
    const verdicts = ['wrong', 'out-of-scope', 'duplicate', 'other'];
    if (!id || !values.by || !values.reason || !verdicts.includes(values.verdict ?? ''))
      throw new Error(USAGE);
    const ledger = decide(await readLedger(root), id, {
      status: 'rejected',
      by: values.by,
      at: today(),
      reason: values.reason,
      verdict: values.verdict as 'wrong',
    });
    await writeLedger(root, ledger);
    console.log(`${id} rejected; it will not be proposed again.`);
    return;
  }
  if (command === 'accept') {
    const [id] = positionals;
    if (!id || !values.by || !values.reason) throw new Error(USAGE);
    // The table checks pull in the engine, so they load only here.
    const { acceptProposal } = await import('./rule-proposals-accept.ts');
    const result = await acceptProposal(root, await readLedger(root), id, {
      by: values.by,
      reason: values.reason,
      date: today(),
      rule: values.rule,
      status: values.status,
      page: values.page,
      quote: values.quote,
      summary: values.summary,
      fromMajor: values['from-major'] === undefined ? undefined : Number(values['from-major']),
      apis: values.apis?.split(','),
      models: values.models?.split(','),
      note: values.note,
    });
    await writeLedger(root, result.ledger);
    console.log(
      `${id} accepted as ${result.rule} in ${result.table}${result.fixture ? `; fixture ${result.fixture}` : ''}. Run npx vitest run pipeline/rule-proposal-fixtures.test.ts.`,
    );
    return;
  }
  if (command === 'report') {
    const text = renderReport(await readLedger(root));
    if (values.out) await writeFile(values.out, text);
    else process.stdout.write(text);
    return;
  }
  throw new Error(USAGE);
}

// Real paths on both sides: refit-bench may run it through a relative or linked path.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))
  await main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });

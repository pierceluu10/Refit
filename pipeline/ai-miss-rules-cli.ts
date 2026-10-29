// Proposed deterministic rules from AI fallback misses (pipeline/ai-misses.ts): reads the merged
// results of AI-provider benchmark runs on dev sets, groups their miss records by the pattern
// Refit missed, and writes the proposal document and one stub per proposed rule. Refuses
// measurement sets: they are measured, never mined (docs/benchmarks/AI-PROVIDER-SETS.md).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { MEASUREMENT_LISTS, renderProposal, ruleCandidates, type MissRecord } from './ai-misses.ts';

const USAGE =
  'Usage: npx tsx pipeline/ai-miss-rules-cli.ts --results <list>=<merged results.json>... --run <id>... --commit <sha> [--doc docs/proposals/ai-miss-rules.md] [--stubs data/rule-candidates]';

export function listName(path: string) {
  return basename(path).replace(/\.json$/, '');
}

async function main() {
  const { values } = parseArgs({
    options: {
      results: { type: 'string', multiple: true },
      run: { type: 'string', multiple: true },
      commit: { type: 'string' },
      doc: { type: 'string', default: 'docs/proposals/ai-miss-rules.md' },
      stubs: { type: 'string', default: 'data/rule-candidates' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.results?.length || !values.commit) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const records: MissRecord[] = [];
  const lists: string[] = [];
  for (const pair of values.results) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`--results takes <list>=<file>, not ${pair}`);
    const list = listName(pair.slice(0, at));
    if (MEASUREMENT_LISTS.has(list))
      throw new Error(`${list} is a measurement set; rules come from dev sets only.`);
    lists.push(list);
    const parsed = JSON.parse(await readFile(pair.slice(at + 1), 'utf8'));
    const rows = (Array.isArray(parsed) ? parsed : parsed.results) as Array<{
      misses?: MissRecord[];
    }>;
    for (const row of rows) records.push(...(row.misses ?? []));
  }
  const candidates = ruleCandidates(records);
  await writeFile(
    values.doc!,
    renderProposal(candidates, {
      lists,
      runs: values.run ?? [],
      commit: values.commit,
      records: records.length,
      date: new Date().toISOString().slice(0, 10),
    }),
  );
  // The stub directory holds only this run's proposals.
  await rm(values.stubs!, { recursive: true, force: true });
  await mkdir(values.stubs!, { recursive: true });
  const proposed = candidates.filter((item) =>
    ['rule-candidate', 'needs-fix-example'].includes(item.status),
  );
  for (const item of proposed)
    await writeFile(join(values.stubs!, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
  console.log(
    `${records.length} miss records, ${candidates.length} groups, ${proposed.length} proposed (${proposed.filter((item) => item.status === 'rule-candidate').length} with a validated AI fixture).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

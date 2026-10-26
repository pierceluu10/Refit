import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { readDocumentationSnapshots } from './documentation-sources.ts';
import { classifyPage, INSTRUCTIONS, type PageClassification } from './release-classification.ts';
import {
  readCatalog,
  scoreRelease,
  summarize,
  type ScoredEntry,
  type ScoredRow,
} from './release-classification-score.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: refit classify-release --release <version> [--release <version> ...] --output <new-directory>';
const CHANGELOG = fileURLToPath(new URL('../docs/benchmarks/stripe-changelog/', import.meta.url));

const { values } = parseArgs({
  options: {
    release: { type: 'string', multiple: true },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`${USAGE}

Classifies each breaking change on a Stripe release's saved changelog pages with OpenAI
(handling, rule family, affected identifiers) and scores it against the hand catalog in
docs/benchmarks/stripe-changelog/catalog. Pages: docs/benchmarks/stripe-changelog/pages.
Needs OPENAI_API_KEY and OPENAI_MODEL; spends at most REFIT_AI_BUDGET_USD (default $1).
Writes results.json (predictions and score) and audit.json (every prompt and model output).`);
  process.exit(0);
}
if (!values.release?.length || !values.output)
  throw new PipelineInputError(
    `At least one --release and an --output directory are required.\n${USAGE}`,
  );
const ai = assessmentConfiguration(true, process.env)!;

await mkdir(values.output);
const startedAt = new Date().toISOString();
const classifications: Array<PageClassification & { release: string }> = [];
const entries: ScoredEntry[] = [];
const rows: ScoredRow[] = [];
const byRelease: Record<string, ReturnType<typeof summarize>> = {};
for (const release of values.release) {
  const catalog = readCatalog(join(CHANGELOG, 'catalog', release));
  const results: PageClassification[] = [];
  for (const [index, entry] of catalog.entries()) {
    const [snapshot] = await readDocumentationSnapshots([
      join(CHANGELOG, 'pages', release, `${entry.slug}.json`),
    ]);
    const result = await classifyPage(
      release,
      { slug: entry.slug, snapshot, changes: entry.changed },
      ai,
    );
    results.push(result);
    classifications.push({ release, ...result });
    console.error(
      `[${release} ${index + 1}/${catalog.length}] ${entry.slug}: ${result.error ?? 'classified'} ($${result.costUsd.toFixed(4)})`,
    );
  }
  const scored = scoreRelease(release, catalog, results);
  entries.push(...scored.entries);
  rows.push(...scored.rows);
  byRelease[release] = summarize(scored.entries, scored.rows);
}

const costUsd = classifications.reduce((total, result) => total + result.costUsd, 0);
const summary = summarize(entries, rows);
await writeFile(
  join(values.output, 'results.json'),
  `${JSON.stringify(
    {
      formatVersion: 1,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      startedAt,
      configuredModel: ai.model,
      reportedModels: [
        ...new Set(classifications.flatMap((result) => (result.model ? [result.model] : []))),
      ],
      budgetUsd: ai.budget.limitUsd,
      costUsd,
      releases: values.release,
      summary,
      byRelease,
      entries,
      rows,
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(values.output, 'audit.json'),
  `${JSON.stringify({ instructions: INSTRUCTIONS, pages: classifications }, null, 2)}\n`,
);
console.log(
  `${summary.handlingCorrect}/${summary.changes} handlings match the catalog; ${summary.dangerous} dangerous; $${costUsd.toFixed(4)} spent. Results: ${join(values.output, 'results.json')}`,
);

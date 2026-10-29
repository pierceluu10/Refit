#!/usr/bin/env node
// Mines Meta's saved changelog pages (scripts/meta-graph-pages.mjs) for the change table.
// Pass 1 asks OpenAI for every change a page states, with a verbatim quote; pass 2 asks again,
// separately, whether each quote supports its entry; a deterministic check then requires the quote
// in the saved page and the entry's name and replacement in the quote. Existing entries of
// data/meta-graph/changes.json get their quotes the same way. Writes every candidate and verdict to
// --output/out-openai.json for scripts/meta-graph-merge.mjs; nothing in data/ changes. Needs OPENAI_API_KEY and OPENAI_MODEL; spends at most
// REFIT_AI_BUDGET_USD.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assessmentConfiguration } from '../pipeline/assessment.ts';
import { CHANGE_KINDS, DEFAULT_META_GRAPH_CHANGES } from '../pipeline/meta-graph-changes.ts';
import { META_PAGES, pageLabel, quoteProblems } from '../pipeline/meta-graph-rules.ts';
import { requestStructuredOutput } from '../pipeline/openai.ts';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    page: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: '6' },
  },
});
if (!values.output) throw new Error('--output <directory> is required');
await mkdir(values.output, { recursive: true });
const ai = assessmentConfiguration(true, process.env);
const LIMITS = { maxOutputTokens: 100_000, maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 900_000 };
const CHUNK = 20_000;

const nullable = (type) => ({ type: [type, 'null'] });
const ENTRY = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'appliesToAll',
    'node',
    'edge',
    'path',
    'name',
    'replacement',
    'summary',
    'quote',
  ],
  properties: {
    kind: { type: 'string', enum: [...CHANGE_KINDS] },
    version: nullable('string'),
    appliesToAll: nullable('string'),
    node: nullable('string'),
    edge: nullable('string'),
    path: nullable('string'),
    name: nullable('string'),
    replacement: nullable('string'),
    summary: { type: 'string' },
    quote: { type: 'string' },
  },
};
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: { changes: { type: 'array', items: ENTRY } },
};
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'supported', 'problem'],
        properties: {
          index: { type: 'integer' },
          supported: { type: 'boolean' },
          problem: nullable('string'),
        },
      },
    },
  },
};
const QUOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['quotes'],
  properties: {
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'quote'],
        properties: { id: { type: 'string' }, quote: nullable('string') },
      },
    },
  },
};

const KINDS = `Kinds:
- endpoint-removed: an endpoint or root path is removed or no longer accepts requests (path, or edge for /{id}/<edge>).
- endpoint-changed: an endpoint or root path (such as /{campaign-id}) keeps working but its behaviour, results or rules change.
- product-removed: a whole product or API is shut down and the text prints no path (name is the product as printed).
- edge-removed / edge-changed: an edge (/{node-id}/<edge>) is removed, or its behaviour, required permissions or results change.
- field-removed / field-changed: a field on a node is removed, renamed, moved or deprecated, or its type, values or meaning change.
- metric-removed / metric-changed: an Insights metric (Page, Instagram, Ads insights fields or metric= values) is removed, renamed or changes meaning.
- breakdown-removed: an Insights breakdown or action breakdown value is removed or deprecated (name is the breakdown).
- parameter-removed / parameter-changed: a request parameter is removed, renamed, or its accepted values or meaning change (name is the parameter).
- parameter-required: a request parameter becomes required (name is the parameter, edge or path where it is required).
- webhook-field-removed / webhook-field-changed: a webhook field or subscription topic is removed, or its payload changes (name is the webhook field).
- error-changed: an error code, subcode or error response changes or is added for an existing request (name is the code).
- permission-changed: a permission, scope or access requirement for existing requests changes (name is the permission).`;

const EXTRACT = `You read part of one of Meta's developer changelogs (Graph API, Marketing API, Instagram Platform, WhatsApp Business Platform or Messenger Platform). List every change it states that can break or alter an existing integration: removed, renamed or moved fields and edges per node type; deprecated or removed endpoints and product shutdowns; new required parameters; removed parameters and changed parameter semantics; Insights metric and breakdown deprecations; webhook field changes; error code changes; permission changes. Skip pure additions and new features that change nothing an existing integration relies on.

${KINDS}

For each change:
- version: the Graph API version from which the change applies, as the text states it (for example "Applies to v24.0+" gives "v24.0"). On a per-version changelog page, the page's version unless the entry names another. null when the change applies to every version at once (out-of-cycle and most platform changelog entries).
- appliesToAll: the YYYY-MM-DD date from which the change applies to all versions, when the text gives one ("Will apply to all versions January 6, 2026", or the dated entry of an out-of-cycle or platform changelog when it applies to all versions); otherwise null. When version is null, appliesToAll is required.
- node: the node type as the text names it (Page, IG User, Ad Account, WhatsApp Business Account), else null.
- edge: the edge name in /{id}/<edge>, else null. path: a root endpoint path such as /instagram_oembed, else null.
- name: the field, metric, breakdown, parameter, webhook field, error code or permission exactly as printed, without backticks; null only for endpoint and edge changes.
- replacement: the identifier the text says to use instead, exactly as printed, else null. Never infer a replacement the text does not name.
- summary: one sentence in your own words.
- quote: the shortest contiguous passage of the provided text that states the change, copied character for character (keep markdown, backticks and punctuation; no ellipses, no joining of separate passages). It must contain the name and, when given, the replacement.
One entry per name: a passage listing five metrics gives five entries sharing the quote. Use only the provided text.`;

const VERIFY = `You check proposed change-table entries against the changelog text they were taken from. For each entry, decide strictly whether the quote appears in the text and, read with its heading and surrounding context, states exactly this change: the kind, the version or all-versions date, the node, edge or path, the name, and the replacement are each stated in the text. Mark supported false for additions or new features, guessed or wrong versions or dates, replacements the text does not name, names not in the quote, or changes the passage does not make. Give the problem in one sentence when unsupported, else null. Return one verdict per index.`;

const BACKFILL = `You are given changelog text and change-table entries someone wrote from it by hand. For each entry id, copy from the text the shortest contiguous passage that states that change, character for character (keep markdown, backticks and punctuation; no ellipses). It must contain the entry's name, or its edge or path when name is null. Return null for an entry the text does not state.`;

function chunks(content) {
  const parts = [];
  let current = '';
  for (const block of content.split(/\n(?=#+ |\n)/)) {
    if (current && current.length + block.length > CHUNK) {
      parts.push(current);
      current = '';
    }
    current += `${block}\n`;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

async function ask(name, instructions, schema, evidence) {
  const response = await requestStructuredOutput(
    { evidence, instructions, name, schema },
    ai,
    LIMITS,
  );
  return {
    value: JSON.parse(response.content),
    model: response.model,
    responseId: response.responseId,
    costUsd: response.budget?.costUsd ?? 0,
  };
}

async function pool(items, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

const pages = [];
for (const file of (await readdir(META_PAGES)).filter((name) => name.endsWith('.json')).sort()) {
  const page = JSON.parse(await readFile(new URL(file, META_PAGES), 'utf8'));
  if (page.label === 'graph-api-changelog') continue;
  if (values.page?.length && !values.page.includes(page.label)) continue;
  pages.push(page);
}
const existing = JSON.parse(await readFile(DEFAULT_META_GRAPH_CHANGES, 'utf8'));
const pageOf = (source) => pages.find((page) => page.label === pageLabel(source));

let spent = 0;
const jobs = pages.flatMap((page) =>
  chunks(page.content).map((text, part) => ({ page, part, text })),
);
console.error(`${pages.length} pages, ${jobs.length} chunks`);
const mined = await pool(jobs, async ({ page, part, text }) => {
  const evidence = { page: page.label, url: page.url, part, text };
  try {
    const extract = await ask('meta_changes', EXTRACT, EXTRACT_SCHEMA, evidence);
    const changes = extract.value.changes;
    const verify = changes.length
      ? await ask('meta_change_verdicts', VERIFY, VERIFY_SCHEMA, {
          ...evidence,
          entries: changes.map((change, index) => ({ index, ...change })),
        })
      : null;
    spent += extract.costUsd + (verify?.costUsd ?? 0);
    console.error(
      `${page.label}#${part}: ${changes.length} candidates ($${spent.toFixed(2)} so far)`,
    );
    return {
      page: page.label,
      url: page.url,
      part,
      extractedBy: { model: extract.model, responseId: extract.responseId },
      verifiedBy: verify && { model: verify.model, responseId: verify.responseId },
      candidates: changes.map((change, index) => {
        const verdict = verify?.value.verdicts.find((entry) => entry.index === index);
        return {
          ...change,
          supported: verdict?.supported ?? false,
          problem: verdict?.problem ?? (verdict ? null : 'no verdict'),
          quoteProblems: quoteProblems(change, page.content),
        };
      }),
    };
  } catch (error) {
    console.error(`${page.label}#${part}: ${error.message}`);
    return { page: page.label, url: page.url, part, error: error.message, candidates: [] };
  }
});

// Quotes for the entries read by hand before this script existed.
const bySource = new Map();
for (const change of existing.changes) {
  const page = pageOf(change.source);
  if (!page) continue;
  bySource.set(page, [...(bySource.get(page) ?? []), change]);
}
const backfill = await pool([...bySource], async ([page, changes]) => {
  try {
    const result = await ask('meta_change_quotes', BACKFILL, QUOTE_SCHEMA, {
      page: page.label,
      text: page.content,
      entries: changes.map(({ id, kind, node, edge, path, name, summary }) => ({
        id,
        kind,
        node,
        edge,
        path,
        name,
        summary,
      })),
    });
    spent += result.costUsd;
    console.error(
      `backfill ${page.label}: ${changes.length} entries ($${spent.toFixed(2)} so far)`,
    );
    return result.value.quotes.map(({ id, quote }) => {
      const change = changes.find((entry) => entry.id === id);
      return {
        id,
        page: page.label,
        quote,
        model: result.model,
        responseId: result.responseId,
        quoteProblems:
          change && quote ? quoteProblems({ ...change, quote }, page.content) : ['no quote'],
      };
    });
  } catch (error) {
    console.error(`backfill ${page.label}: ${error.message}`);
    return [];
  }
});
// The shape scripts/meta-graph-merge.mjs reads; candidates carry their pass-2 verdict.
await writeFile(
  `${values.output}/out-openai.json`,
  `${JSON.stringify({ pages: mined, backfill: backfill.flat() }, null, 2)}\n`,
);
console.error(`done, $${spent.toFixed(2)}`);

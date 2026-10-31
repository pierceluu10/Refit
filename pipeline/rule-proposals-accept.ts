import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkAiRuleTables, parseAiRuleTable } from './ai-rules.ts';
import { checkParameterChanges } from './model-parameter-changes.ts';
import {
  decide,
  FIXTURES,
  type Ledger,
  type LedgerEntry,
  type Transformation,
} from './rule-proposals.ts';

// A person's approval of an open proposal (docs/RULE-PROPOSALS.md). The rule goes into the table
// the engine already reads for its transformation, quoting a saved provider page, and only after
// that table's own check passes; the fixture is a synthetic program built from the transformation,
// never code from an evidence row. A transformation no table can hold (a model replacement the
// registry lacks, a rewrite) is accepted only against a rule someone already wrote by hand.

export interface AcceptOptions {
  by: string;
  reason: string;
  date: string;
  // The rule's id; for a linked acceptance, the existing rule, change or deadline that covers it.
  rule?: string;
  status?: string;
  page?: string;
  quote?: string;
  summary?: string;
  fromMajor?: number;
  apis?: string[];
  models?: string[];
  note?: string;
}

export interface RuleFixture {
  formatVersion: 1;
  proposal: string;
  rule: string;
  table: string;
  provider: string;
  transformation: Transformation;
  engine: 'openai-sdk-major' | 'parameter-change' | 'linked';
  // A synthetic program the rule must rewrite (for openai-sdk-major), or the request it must
  // change (for parameter-change). Built from the transformation, never from a repository.
  synthetic:
    | { version: string; file: string; before: string; expect: string[]; reject: string[] }
    | { model: string; api: string; parameter: string; action: 'rename' | 'remove'; to?: string }
    | null;
  // Where the pattern was seen (repository names only; no code is copied).
  evidence: Array<{ list: string; run: string; repo: string }>;
}

const ruleId = (entry: LedgerEntry) => entry.id.toLowerCase();

function need(value: unknown, flag: string, why: string): asserts value {
  if (value === undefined || value === null || value === '' || Number.isNaN(value))
    throw new Error(`accept needs --${flag}: ${why}.`);
}

// The v3 client calls methods on an OpenAIApi instance; v4 and later on resource paths.
export function sdkFixture(from: string, to: string, fromMajor: number) {
  if (fromMajor === 3)
    return {
      version: '3.3.0',
      file: 'src/learned.ts',
      before: `import { Configuration, OpenAIApi } from 'openai';

const client = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

export async function run(input: { model: string }) {
  const response = await client.${from}(input);
  return response.data;
}
`,
      expect: [`.${to}(`],
      reject: [`.${from}(`],
    };
  return {
    version: `${fromMajor}.0.0`,
    file: 'src/learned.ts',
    before: `import OpenAI from 'openai';

const client = new OpenAI();

export async function run(input: { model: string }) {
  return client.${from}(input);
}
`,
    expect: [`.${to}(`],
    reject: [`.${from}(`],
  };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// readParameterPages (model-parameter-changes.ts) for a checkout other than this one.
async function parameterPages(root: string) {
  const folder = join(root, 'docs/benchmarks/parameter-pages');
  const index = await readJson(join(folder, 'index.json')).catch(() => ({ pages: [] }));
  const pages: Record<string, { text: string; sha256: string; url: string }> = {};
  for (const item of Array.isArray(index.pages) ? index.pages : [])
    if (typeof item?.file === 'string' && /^[a-z0-9-]+\.md$/.test(item.file))
      pages[item.file] = {
        text: await readFile(join(folder, item.file), 'utf8'),
        sha256: String(item.sha256),
        url: String(item.url),
      };
  return pages;
}

// Every place a hand-written rule can live, for a linked acceptance.
async function ruleExists(root: string, id: string) {
  const { readdir } = await import('node:fs/promises');
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const folder = join(root, 'data/rules', provider);
    for (const file of await readdir(folder).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue;
      const table = await readJson(join(folder, file));
      if ((table.rules ?? []).some((rule: { rule: string }) => rule.rule === id))
        return `data/rules/${provider}/${file}`;
    }
  }
  const changes = await readJson(join(root, 'data/model-parameter-changes.json')).catch(() => ({}));
  if ((changes.changes ?? []).some((change: { id: string }) => change.id === id))
    return 'data/model-parameter-changes.json';
  const registry = await readJson(join(root, 'data/deadlines.json')).catch(() => ({}));
  if ((registry.deadlines ?? []).some((deadline: { id: string }) => deadline.id === id))
    return 'data/deadlines.json';
  return null;
}

export async function acceptProposal(
  root: string,
  ledger: Ledger,
  id: string,
  options: AcceptOptions,
): Promise<{ ledger: Ledger; rule: string; table: string; fixture: string | null }> {
  const entry = ledger.proposals.find((item) => item.id === id);
  if (!entry) throw new Error(`No proposal ${id} in the ledger; record the run first.`);
  if (entry.status !== 'open') throw new Error(`${id} is already ${entry.status}.`);
  const t = entry.transformation;
  const evidence = entry.evidence.map(({ list, run, repo }) => ({ list, run, repo }));
  let rule: string;
  let table: string;
  let fixture: RuleFixture;
  if (t.kind === 'method-rename' && entry.provider === 'openai' && !options.rule) {
    need(options.page, 'page', 'the saved page id in data/rules/openai/sdk-majors.json');
    need(options.quote, 'quote', 'the sentence on that page that documents the rename');
    need(options.fromMajor, 'from-major', 'the SDK major the old name belongs to');
    if (options.status !== 'auto' && options.status !== 'review')
      throw new Error('accept needs --status auto (Refit edits) or review (Refit lists it).');
    table = 'data/rules/openai/sdk-majors.json';
    const value = await readJson(join(root, table));
    rule = ruleId(entry);
    value.rules.push({
      rule,
      family: 'method-rename',
      status: options.status,
      page: options.page,
      quote: options.quote,
      checkedAt: options.date,
      origin: 'docs',
      summary:
        options.summary ??
        `Renames \`${t.from}(\` to \`${t.to}(\` with the same arguments (proposal ${entry.id}, accepted by ${options.by}).`,
      data: { fromMajor: options.fromMajor, old: t.from, new: t.to, arguments: 'same' },
    });
    // The table's own checks decide: its shape, and the quote on the saved page.
    const parsed = parseAiRuleTable(value, table);
    const problems = (await checkAiRuleTables([parsed], { root })).filter(
      (problem) => problem.rule === rule,
    );
    if (problems.length)
      throw new Error(`${rule}: ${problems.map((problem) => problem.problem).join('; ')}.`);
    await writeFile(join(root, table), `${JSON.stringify(value, null, 2)}\n`);
    fixture = {
      formatVersion: 1,
      proposal: entry.id,
      rule,
      table,
      provider: entry.provider,
      transformation: t,
      engine: 'openai-sdk-major',
      synthetic: sdkFixture(t.from, t.to, options.fromMajor!),
      evidence,
    };
  } else if (
    (t.kind === 'parameter-rename' || t.kind === 'parameter-remove') &&
    (entry.provider === 'openai' || entry.provider === 'anthropic') &&
    !options.rule
  ) {
    need(options.page, 'page', 'the saved page in docs/benchmarks/parameter-pages');
    need(options.quote, 'quote', 'the sentence on that page that documents the change');
    need(
      options.apis?.length,
      'apis',
      'the request APIs the change covers (chat.completions, responses, messages)',
    );
    need(options.models?.length, 'models', 'the replacement models the page covers, or *');
    need(options.note, 'note', 'what the customer should know, for the draft');
    table = 'data/model-parameter-changes.json';
    const value = await readJson(join(root, table));
    rule = ruleId(entry);
    const parameter = t.kind === 'parameter-rename' ? t.from : t.parameter;
    value.changes.push({
      id: rule,
      provider: entry.provider,
      apis: options.apis,
      models: options.models,
      parameters: [parameter],
      action: t.kind === 'parameter-rename' ? 'rename' : 'remove',
      ...(t.kind === 'parameter-rename' ? { to: t.to } : {}),
      page: options.page,
      quote: options.quote,
      checkedAt: options.date,
      note: options.note,
    });
    const { errors } = checkParameterChanges(value, await parameterPages(root));
    if (errors.length) throw new Error(`${table}: ${errors.slice(0, 5).join(' ')}`);
    await writeFile(join(root, table), `${JSON.stringify(value, null, 2)}\n`);
    fixture = {
      formatVersion: 1,
      proposal: entry.id,
      rule,
      table,
      provider: entry.provider,
      transformation: t,
      engine: 'parameter-change',
      synthetic: {
        model: options.models![0] === '*' ? 'any-model' : options.models![0],
        api: options.apis![0],
        parameter,
        action: t.kind === 'parameter-rename' ? 'rename' : 'remove',
        ...(t.kind === 'parameter-rename' ? { to: t.to } : {}),
      },
      evidence,
    };
  } else {
    // No table holds this transformation: accepted only against a rule a person already wrote,
    // with its own tests.
    need(
      options.rule,
      'rule',
      `no rule table holds a ${t.kind} ${entry.provider} transformation; write the engine rule by hand with its tests, then accept with --rule <its id>`,
    );
    rule = options.rule!;
    const found = await ruleExists(root, rule);
    if (!found) throw new Error(`${rule} is in no rule table, parameter changes or the registry.`);
    table = found;
    fixture = {
      formatVersion: 1,
      proposal: entry.id,
      rule,
      table,
      provider: entry.provider,
      transformation: t,
      engine: 'linked',
      synthetic: null,
      evidence,
    };
  }
  const path = `${FIXTURES}/${entry.id}.json`;
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(fixture, null, 2)}\n`);
  return {
    ledger: decide(ledger, id, {
      status: 'accepted',
      by: options.by,
      at: options.date,
      reason: options.reason,
      rule,
      table,
      fixture: path,
    }),
    rule,
    table,
    fixture: path,
  };
}

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissRecord } from './ai-misses.ts';
import { loadAiRuleTables } from './ai-rules.ts';
import { checkParameterChanges } from './model-parameter-changes.ts';
import { checkFixture } from './rule-proposal-fixtures.ts';
import { acceptProposal, type RuleFixture } from './rule-proposals-accept.ts';
import {
  decide,
  emptyLedger,
  fixProposals,
  hunkTransformation,
  lineTransformation,
  loadKnownRules,
  missesByCategory,
  parseLedger,
  patchHunks,
  recordRun,
  renderReport,
  renderRun,
  runProposals,
  type Ledger,
  type ResultRow,
} from './rule-proposals.ts';

// Every repository, file and patch here is made up; no benchmark row is a fixture.
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const GATES = [
  'output',
  'secrets',
  'scope',
  'runtime',
  'resolves',
  'checks',
  'request-proof',
] as const;

function patch(file: string, removed: string[], added: string[], line = 4) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${line},${removed.length + 2} +${line},${added.length + 2} @@`,
    ' const a = 1;',
    ...removed.map((text) => `-${text}`),
    ...added.map((text) => `+${text}`),
    ' const b = 2;',
    '',
  ].join('\n');
}

function miss(repo: string, file: string, extra: Partial<MissRecord> = {}): MissRecord {
  return {
    formatVersion: 1,
    repo,
    commit: 'c0ffee',
    provider: 'openai',
    language: 'js',
    changeType: 'old-sdk-major',
    kind: 'sdk-stop',
    ref: 'openai-node-target-6',
    pattern: 'p',
    shape: 's',
    file,
    line: 5,
    stopReason: 'The call is not one Refit rewrites.',
    source: {
      ref: 'openai-node-target-6',
      url: 'https://github.com/openai/openai-node/discussions/217',
      quote: 'The v4 SDK renames every method.',
      summary: '',
    },
    ai: {
      status: 'validated',
      reason: 'validated',
      costUsd: 0.02,
      gatesFailed: [],
      diff: null,
      pattern: null,
    },
    ...extra,
  } as MissRecord;
}

function row(repo: string, diff: string, extra: Partial<ResultRow> = {}): ResultRow {
  return {
    repo,
    commit: 'c0ffee',
    provider: 'openai',
    misses: [miss(repo, 'src/ai.ts')],
    fallback: {
      status: 'validated',
      patch: diff,
      gates: GATES.map((gate) => ({ gate, status: 'passed', detail: '' })),
    },
    ...extra,
  };
}

const moderation = (repo: string) =>
  row(
    repo,
    patch(
      'src/ai.ts',
      ['  const result = await openai.createModeration({ input: text });'],
      ['  const result = await openai.moderations.create({ input: text });'],
    ),
  );

describe('reading a validated AI patch', () => {
  it('names method renames, key renames, removals, model replacements and rewrites', () => {
    expect(
      lineTransformation(
        'const r = await api.createChatCompletion({ model });',
        'const r = await api.chat.completions.create({ model });',
      ),
    ).toEqual({
      kind: 'method-rename',
      from: 'createChatCompletion',
      to: 'chat.completions.create',
    });
    expect(
      lineTransformation(
        'const r = await client.completions.create(body);',
        'const r = await client.responses.create(body);',
      ),
    ).toEqual({ kind: 'method-rename', from: 'completions.create', to: 'responses.create' });
    expect(lineTransformation('  max_tokens: limit,', '  max_completion_tokens: limit,')).toEqual({
      kind: 'parameter-rename',
      from: 'max_tokens',
      to: 'max_completion_tokens',
    });
    expect(lineTransformation("  model: 'gpt-4-0613',", "  model: 'gpt-5.6-terra',")).toEqual({
      kind: 'model-replace',
      from: 'gpt-4-0613',
      to: 'gpt-5.6-terra',
    });
    // A changed argument is not a pure rename.
    expect(
      lineTransformation('await api.createImage(a);', 'await api.images.generate(b);'),
    ).toBeNull();
    expect(
      hunkTransformation({ file: 'a.ts', line: 1, removed: ['    temperature: 0.2,'], added: [] }),
    ).toEqual({ kind: 'parameter-remove', parameter: 'temperature' });
    expect(
      hunkTransformation({
        file: 'a.ts',
        line: 1,
        removed: ['const text = res.data.choices[0].text;'],
        added: ['const text = res.output_text;', 'log(text);'],
      }),
    ).toEqual({
      kind: 'rewrite',
      before: ['const <id> = <id>.data.choices[<n>].text;'],
      after: ['const <id> = <id>.output_text;', '<id>(<id>);'],
    });
  });

  it('splits a patch into change blocks at their original lines', () => {
    const text =
      patch('src/a.ts', ['old();'], ['fresh();'], 10) + patch('src/b.ts', ['x: 1,'], [], 3);
    expect(patchHunks(text)).toEqual([
      { file: 'src/a.ts', line: 11, removed: ['old();'], added: ['fresh();'] },
      { file: 'src/b.ts', line: 4, removed: ['x: 1,'], added: [] },
    ]);
  });
});

describe('proposals from validated fixes', () => {
  it('groups one pattern across repositories with its evidence, conditions and gates', () => {
    const { proposals, validatedFixes } = fixProposals(
      [moderation('fixture/one'), moderation('fixture/two')],
      { list: 'openai-dev-30', run: '101' },
    );
    expect(validatedFixes).toBe(2);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      provider: 'openai',
      changeType: 'old-sdk-major',
      transformation: { kind: 'method-rename', from: 'createModeration', to: 'moderations.create' },
      repositories: 2,
      callShapes: ['const <id> = await <id>.createModeration({ input: <id> });'],
      conditions: {
        refs: ['openai-node-target-6'],
        kinds: ['sdk-stop'],
        dependencyChange: false,
        gatesPassed: [...GATES],
      },
      sources: [{ url: 'https://github.com/openai/openai-node/discussions/217' }],
    });
    expect(proposal.evidence.map((item) => [item.repo, item.run, item.file])).toEqual([
      ['fixture/one', '101', 'src/ai.ts'],
      ['fixture/two', '101', 'src/ai.ts'],
    ]);
    expect(proposal.safeUnder.join(' ')).toContain('keeps its arguments unchanged');
    // The same pattern gets the same id in every run.
    expect(
      fixProposals([moderation('fixture/three')], { list: 'openai-dev-30', run: '202' })
        .proposals[0].id,
    ).toBe(proposal.id);
  });

  it('skips suggestions, new test files and dependency files, and notes the dependency move', () => {
    const diff =
      patch('src/ai.ts', ['  temperature: 0.7,'], []) +
      patch('package.json', ['    "openai": "^3.3.0"'], ['    "openai": "^6.1.0"']) +
      patch('test/ai.test.ts', [], ['it("works", () => {});']);
    const suggestion = row('fixture/s', diff, {
      fallback: { status: 'needs-review', patch: diff, gates: [] },
    });
    const { proposals, validatedFixes } = fixProposals([row('fixture/a', diff), suggestion], {
      list: 'openai-dev-30',
      run: '1',
    });
    expect(validatedFixes).toBe(1);
    expect(proposals.map((item) => item.transformation)).toEqual([
      { kind: 'parameter-remove', parameter: 'temperature' },
    ]);
    expect(proposals[0].conditions.dependencyChange).toBe(true);
  });

  it('counts a measurement set fixes and mines none of them', () => {
    const result = fixProposals([moderation('fixture/one')], { list: 'openai-100', run: '1' });
    expect(result).toEqual({ proposals: [], validatedFixes: 1, withheld: 1 });
  });
});

describe('deduplication against rules and decisions', () => {
  const meta = { list: 'openai-dev-30', run: '7', commit: 'abc123', date: '2026-10-31' };

  it('does not propose what a shipped rule or the parameter table already makes', async () => {
    const known = await loadKnownRules(REPOSITORY_ROOT);
    const run = runProposals(
      [
        moderation('fixture/one'),
        row(
          'fixture/two',
          patch('src/ai.ts', ['  max_tokens: 50,'], ['  max_completion_tokens: 50,']),
        ),
      ],
      meta,
      emptyLedger(),
      known,
    );
    expect(run.proposals).toEqual([]);
    expect(run.covered.map((item) => item.by)).toEqual([
      'rule openai-node-v4-create-moderation',
      'parameter change openai-chat-max-tokens',
    ]);
  });

  it('records proposals once, keeps a rejection with its reason, and never proposes it again', async () => {
    const known = { methods: new Map(), parameters: new Map(), models: new Map() };
    const first = runProposals([moderation('fixture/one')], meta, emptyLedger(), known);
    expect(first.proposals.map((item) => item.state)).toEqual(['new']);
    let ledger = recordRun(emptyLedger(), first);
    const id = ledger.proposals[0].id;
    expect(ledger.proposals[0]).toMatchObject({ status: 'open', firstSeen: { run: '7' } });
    expect(ledger.rounds[0]).toMatchObject({ run: '7', validatedFixes: 1, proposed: [id] });

    // Seen again in a later run: still one entry, more evidence, not new.
    const second = runProposals([moderation('fixture/two')], { ...meta, run: '8' }, ledger, known);
    expect(second.proposals.map((item) => item.state)).toEqual(['open']);
    ledger = recordRun(ledger, second);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.proposals[0].evidence.map((item) => item.repo)).toEqual([
      'fixture/one',
      'fixture/two',
    ]);

    expect(() =>
      decide(ledger, id, { status: 'rejected', by: 'reviewer', at: '2026-10-31', reason: ' ' }),
    ).toThrow('who made it (--by) and why (--reason)');
    ledger = decide(ledger, id, {
      status: 'rejected',
      by: 'reviewer',
      at: '2026-10-31',
      reason: 'The hand-check found the rename drops the moderation model.',
      verdict: 'wrong',
    });
    expect(() => parseLedger(JSON.parse(JSON.stringify(ledger)))).not.toThrow();
    const third = runProposals([moderation('fixture/three')], { ...meta, run: '9' }, ledger, known);
    expect(third.proposals).toEqual([]);
    expect(third.suppressed).toEqual([
      expect.objectContaining({
        id,
        verdict: 'wrong',
        reason: expect.stringContaining('hand-check'),
      }),
    ]);
    // Recording never reopens a decision.
    expect(recordRun(ledger, third).proposals[0].status).toBe('rejected');
    expect(renderRun(third)).toContain('Rejected earlier, so not proposed again');
  });

  it('refuses a ledger with a decision that names no one or no reason', () => {
    const ledger = recordRun(
      emptyLedger(),
      runProposals([moderation('fixture/one')], meta, emptyLedger(), {
        methods: new Map(),
        parameters: new Map(),
        models: new Map(),
      }),
    );
    ledger.proposals[0].status = 'rejected';
    expect(() => parseLedger(ledger)).toThrow('without who decided and why');
  });
});

async function tableRoot() {
  const root = await mkdtemp(join(tmpdir(), 'refit-rule-proposals-'));
  roots.push(root);
  for (const path of [
    'data/rules',
    'data/model-parameter-changes.json',
    'data/deadlines.json',
    'docs/ai-docs/pages',
    'docs/benchmarks/parameter-pages',
  ])
    await cp(join(REPOSITORY_ROOT, path), join(root, path), { recursive: true });
  return root;
}

// Takes a shipped rule out of the copied tables, so a proposal can bring it back.
async function withoutRule(root: string, file: string, key: 'rules' | 'changes', id: string) {
  const path = join(root, file);
  const value = JSON.parse(await readFile(path, 'utf8'));
  const removed = value[key].find(
    (item: { rule?: string; id?: string }) => (item.rule ?? item.id) === id,
  );
  value[key] = value[key].filter((item: unknown) => item !== removed);
  await writeFile(path, JSON.stringify(value, null, 2));
  return removed;
}

async function openLedger(root: string, rows: ResultRow[]): Promise<Ledger> {
  return recordRun(
    emptyLedger(),
    runProposals(
      rows,
      { list: 'openai-dev-30', run: '11', commit: 'abc', date: '2026-10-31' },
      emptyLedger(),
      await loadKnownRules(root),
    ),
  );
}

describe('accepting a proposal', () => {
  it('writes the rule with its quote and a synthetic fixture the engine rewrites', async () => {
    const root = await tableRoot();
    const shipped = await withoutRule(
      root,
      'data/rules/openai/sdk-majors.json',
      'rules',
      'openai-node-v4-create-moderation',
    );
    const ledger = await openLedger(root, [moderation('fixture/one'), moderation('fixture/two')]);
    const [entry] = ledger.proposals;
    expect(entry.transformation).toMatchObject({ kind: 'method-rename', from: 'createModeration' });

    const options = {
      by: 'reviewer',
      reason: 'Matches the v4 migration guide.',
      date: '2026-10-31',
      status: 'auto',
      page: shipped.page,
      fromMajor: 3,
    };
    // A quote that is not on the saved page writes nothing.
    await expect(
      acceptProposal(root, ledger, entry.id, { ...options, quote: 'Not a sentence on that page.' }),
    ).rejects.toThrow('the quote is not on the saved page');
    expect(await readFile(join(root, 'data/rules/openai/sdk-majors.json'), 'utf8')).not.toContain(
      entry.id,
    );

    const accepted = await acceptProposal(root, ledger, entry.id, {
      ...options,
      quote: shipped.quote,
    });
    expect(accepted.ledger.proposals[0]).toMatchObject({
      status: 'accepted',
      decision: { by: 'reviewer', rule: entry.id, table: 'data/rules/openai/sdk-majors.json' },
    });
    const fixture = JSON.parse(
      await readFile(join(root, accepted.fixture!), 'utf8'),
    ) as RuleFixture;
    expect(fixture).toMatchObject({ engine: 'openai-sdk-major', rule: entry.id });
    // The fixture is synthetic: none of the evidence rows' code is in it.
    expect(JSON.stringify(fixture.synthetic)).not.toContain('input: text');
    expect(fixture.evidence).toEqual([
      { list: 'openai-dev-30', run: '11', repo: 'fixture/one' },
      { list: 'openai-dev-30', run: '11', repo: 'fixture/two' },
    ]);
    const tables = await loadAiRuleTables(pathToFileURL(`${join(root, 'data/rules')}/`));
    const context = {
      tables,
      parameters: { formatVersion: 1 as const, changes: [] },
      known: () => true,
    };
    expect(await checkFixture(fixture, context)).toEqual([]);
    // Without the accepted rule the same fixture fails: the test proves the rule, not the engine.
    const others = tables.map((table) => ({
      ...table,
      rules: table.rules.filter((rule) => rule.rule !== entry.id),
    }));
    expect(await checkFixture(fixture, { ...context, tables: others })).not.toEqual([]);

    // Accepted patterns count as covered from then on.
    const later = runProposals(
      [moderation('fixture/three')],
      { list: 'openai-dev-30', run: '12', commit: 'abc', date: '2026-11-01' },
      accepted.ledger,
      { methods: new Map(), parameters: new Map(), models: new Map() },
    );
    expect(later.covered[0].by).toBe(`accepted proposal (rule ${entry.id})`);
    await expect(acceptProposal(root, accepted.ledger, entry.id, options)).rejects.toThrow(
      'already accepted',
    );
  });

  it('adds a parameter change the parameter table checks, with its lookup fixture', async () => {
    const root = await tableRoot();
    const shipped = await withoutRule(
      root,
      'data/model-parameter-changes.json',
      'changes',
      'openai-chat-max-tokens',
    );
    const ledger = await openLedger(root, [
      row(
        'fixture/one',
        patch('src/ai.ts', ['  max_tokens: 50,'], ['  max_completion_tokens: 50,']),
      ),
    ]);
    const [entry] = ledger.proposals;
    await expect(
      acceptProposal(root, ledger, entry.id, {
        by: 'reviewer',
        reason: 'Documented.',
        date: '2026-10-31',
        page: shipped.page,
        quote: shipped.quote,
      }),
    ).rejects.toThrow('accept needs --apis');
    const accepted = await acceptProposal(root, ledger, entry.id, {
      by: 'reviewer',
      reason: 'Documented on the Chat Completions page.',
      date: '2026-10-31',
      page: shipped.page,
      quote: shipped.quote,
      apis: shipped.apis,
      models: shipped.models,
      note: shipped.note,
    });
    const value = JSON.parse(
      await readFile(join(root, 'data/model-parameter-changes.json'), 'utf8'),
    );
    expect(value.changes.at(-1)).toMatchObject({
      id: entry.id,
      action: 'rename',
      parameters: ['max_tokens'],
      to: 'max_completion_tokens',
    });
    const fixture = JSON.parse(
      await readFile(join(root, accepted.fixture!), 'utf8'),
    ) as RuleFixture;
    expect(
      await checkFixture(fixture, { tables: [], parameters: value, known: () => true }),
    ).toEqual([]);
    expect(checkParameterChanges(value, {}).errors.some((error) => error.includes(entry.id))).toBe(
      true,
    );
  });

  it('accepts a rewrite only against a rule someone wrote, and checks it exists', async () => {
    const root = await tableRoot();
    const ledger = await openLedger(root, [
      row(
        'fixture/one',
        patch(
          'src/ai.ts',
          ['const text = res.data.choices[0].text;'],
          ['const text = res.output_text;', 'log(text);'],
        ),
      ),
    ]);
    const [entry] = ledger.proposals;
    const base = { by: 'reviewer', reason: 'Hand-written rule.', date: '2026-10-31' };
    await expect(acceptProposal(root, ledger, entry.id, base)).rejects.toThrow(
      'write the engine rule by hand',
    );
    await expect(
      acceptProposal(root, ledger, entry.id, { ...base, rule: 'no-such-rule' }),
    ).rejects.toThrow('in no rule table');
    const accepted = await acceptProposal(root, ledger, entry.id, {
      ...base,
      rule: 'openai-assistants-removed',
    });
    expect(accepted.table).toBe('data/rules/openai/api-surfaces.json');
    const fixture = JSON.parse(await readFile(join(root, accepted.fixture!), 'utf8'));
    expect(fixture).toMatchObject({ engine: 'linked', synthetic: null });
  });
});

describe('the round report', () => {
  it('counts misses by category and proposals by state', () => {
    const rows = [
      moderation('fixture/one'),
      {
        repo: 'fixture/two',
        commit: 'c',
        misses: [
          miss('fixture/two', 'a.ts', { changeType: 'retired-model', kind: 'model-stop' }),
          miss('fixture/two', 'b.ts', { changeType: 'retired-model', kind: 'model-stop' }),
          miss('fixture/two', 'c.ts', {
            ai: { status: 'ai-unavailable' } as MissRecord['ai'],
          }),
        ],
        fallback: null,
      },
    ];
    expect(missesByCategory(rows)).toEqual({
      'retired-model / model-stop': 2,
      'old-sdk-major / sdk-stop': 1,
    });
    const known = { methods: new Map(), parameters: new Map(), models: new Map() };
    const run = runProposals(
      rows,
      { list: 'openai-dev-30', run: '5', commit: 'abc', date: '2026-10-31' },
      emptyLedger(),
      known,
    );
    const ledger = recordRun(emptyLedger(), run);
    const report = renderReport(ledger);
    expect(report).toContain('| 1 | 0 | 0 |');
    expect(report).toContain('| 5 | `openai-dev-30` | 2026-10-31 | 3 | 1 | 1 | 0 | 0 |');
    expect(report).toContain('| retired-model / model-stop | 2 |');
    expect(renderRun(run)).toContain('| 1 | 0 | 0 | 0 |');
  });
});

describe('the command line', () => {
  it('proposes from merged results with plain Node, as refit-bench runs it', async () => {
    const root = await tableRoot();
    const out = join(root, 'out');
    const results = join(root, 'results.json');
    await writeFile(results, JSON.stringify([moderation('fixture/one')]));
    await withoutRule(
      root,
      'data/rules/openai/sdk-majors.json',
      'rules',
      'openai-node-v4-create-moderation',
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        join(REPOSITORY_ROOT, 'pipeline/rule-proposals-cli.ts'),
        'propose',
        '--results',
        results,
        '--list',
        'subsets/openai-dev-30.json',
        '--run',
        '42',
        '--commit',
        'abcdef1234567890',
        '--out',
        out,
        '--root',
        root,
      ],
      { cwd: root },
    );
    expect(stdout).toContain('1 validated AI fix: 1 new,');
    const written = JSON.parse(await readFile(join(out, 'rule-proposals.json'), 'utf8'));
    expect(written).toMatchObject({
      list: 'openai-dev-30',
      run: '42',
      proposals: [{ state: 'new' }],
    });
    expect(await readFile(join(out, 'rule-proposals.md'), 'utf8')).toContain(
      '`createModeration(` → `moderations.create(`',
    );
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { traceGoFiles } from './go/calls.ts';
import { readGoFiles } from './go/syntax.ts';
import { proposeModelReplacements } from './model-retirements.ts';
import { traceFiles } from './python/models.ts';
import { readPythonFiles } from './python/syntax.ts';
import type { SdkCallRecord } from './sdk-call-record.ts';
import {
  clearLoadedParsers,
  GRAMMARS,
  loadParser,
  parseWithin,
  REPORT_ONLY_LANGUAGES,
  TRACER_LIMITS,
  type SourceFile,
  type TracerLanguage,
  type TracerLimits,
  type TracerStop,
} from './tree-sitter.ts';

// The conformance suite every tracer on the tree-sitter path must pass (docs/ARCHITECTURE.md,
// "Other languages"). Each language supplies the same fixtures in its own syntax; the assertions
// are shared. A grammar added to GRAMMARS without an entry here fails the first test.

interface Conformance {
  extension: string;
  read: (root: string, stops?: TracerStop[], limits?: TracerLimits) => Promise<SourceFile[]>;
  trace: (files: SourceFile[], stops?: TracerStop[]) => Promise<SdkCallRecord[]>;
  // Each sends an OpenAI chat request. `imported` and `aliased` send gpt-4o-mini; `environment`
  // reads OPENAI_MODEL with the default gpt-4.1; `unsupported` sends a model from a call Refit
  // cannot follow; `malformed` has a syntax error and still sends gpt-4o; `retiring` sends gpt-4.
  fixtures: Record<
    'imported' | 'aliased' | 'environment' | 'unsupported' | 'malformed' | 'retiring',
    string
  >;
}

const goFile = (imports: string[], body: string) =>
  `package main\n\nimport (\n${imports.map((item) => `\t${item}`).join('\n')}\n)\n\nfunc run(ctx context.Context) {\n\tc := openai.NewClient()\n${body}\n}\n`;
const goChat = (model: string) =>
  `\tc.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: ${model}})`;
const GO_OPENAI = ['"context"', '"github.com/openai/openai-go"'];

const TRACERS: Record<TracerLanguage, Conformance> = {
  python: {
    extension: '.py',
    read: readPythonFiles,
    trace: traceFiles,
    fixtures: {
      imported:
        'from openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(model="gpt-4o-mini", messages=[])\n',
      aliased:
        'import openai as oa\n\nclient = oa.OpenAI()\nclient.chat.completions.create(model="gpt-4o-mini", messages=[])\n',
      environment:
        'import os\nfrom openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(model=os.getenv("OPENAI_MODEL", "gpt-4.1"), messages=[])\n',
      unsupported:
        'from openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(model=pick_model(), messages=[])\n',
      malformed:
        'from openai import OpenAI\n\nclient = OpenAI()\n\ndef broken(:\n    pass\n\nclient.chat.completions.create(model="gpt-4o", messages=[])\n',
      retiring:
        'from openai import OpenAI\n\nclient = OpenAI()\nclient.chat.completions.create(model="gpt-4", messages=[])\n',
    },
  },
  go: {
    extension: '.go',
    read: readGoFiles,
    trace: traceGoFiles,
    fixtures: {
      imported: goFile(GO_OPENAI, goChat('"gpt-4o-mini"')),
      aliased: goFile(['"context"', 'oa "github.com/openai/openai-go"'], goChat('"gpt-4o-mini"'))
        .replace('openai.NewClient', 'oa.NewClient')
        .replace('openai.ChatCompletionNewParams', 'oa.ChatCompletionNewParams'),
      environment: goFile(
        ['"cmp"', ...GO_OPENAI, '"os"'],
        goChat('cmp.Or(os.Getenv("OPENAI_MODEL"), "gpt-4.1")'),
      ),
      unsupported: goFile(GO_OPENAI, goChat('pickModel()')),
      malformed: `${goFile(GO_OPENAI, goChat('"gpt-4o"'))}\nfunc broken( {\n`,
      retiring: goFile(GO_OPENAI, goChat('"gpt-4"')),
    },
  },
};

const LANGUAGES = Object.keys(TRACERS) as TracerLanguage[];
const NOW = new Date('2026-10-22T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-conformance-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const models = (records: SdkCallRecord[]) =>
  records.map((record) => ({
    provider: record.provider,
    literals: record.arguments.model?.literals.map((literal) => [literal.value, literal.via]),
    stop: record.arguments.model?.stop ?? null,
  }));

it('covers every grammar Refit ships, and no tracer is editable', () => {
  expect(LANGUAGES.sort()).toEqual(Object.keys(GRAMMARS).sort());
  for (const language of LANGUAGES) expect(REPORT_ONLY_LANGUAGES.has(language)).toBe(true);
});

describe.each(LANGUAGES)('%s tracer conformance', (language) => {
  const tracer = TRACERS[language];
  const file = (name: keyof Conformance['fixtures']) => ({
    path: `app/${name}${tracer.extension}`,
    content: tracer.fixtures[name],
  });

  it('traces a plain import and an aliased import', async () => {
    for (const name of ['imported', 'aliased'] as const)
      expect(models(await tracer.trace([file(name)]))).toEqual([
        { provider: 'openai', literals: [['gpt-4o-mini', expect.any(String)]], stop: null },
      ]);
  });

  it('reads an environment variable with a default as that default', async () => {
    expect(models(await tracer.trace([file('environment')]))).toEqual([
      {
        provider: 'openai',
        literals: [['gpt-4.1', 'environment default (OPENAI_MODEL)']],
        stop: null,
      },
    ]);
  });

  it('stops with a reason on a construct it cannot follow', async () => {
    const [record] = models(await tracer.trace([file('unsupported')]));
    expect(record.literals).toEqual([]);
    expect(record.stop).toMatch(/\S/);
  });

  it('reads past a syntax error without throwing', async () => {
    const stops: TracerStop[] = [];
    expect(models(await tracer.trace([file('malformed')], stops))).toEqual([
      { provider: 'openai', literals: [['gpt-4o', expect.any(String)]], stop: null },
    ]);
    expect(stops).toEqual([]);
  });

  it('names an oversized file as a stop and reads the rest', async () => {
    const root = await repository({
      [`app/big${tracer.extension}`]: `${tracer.fixtures.imported}${'\n'.repeat(4096)}`,
      [`app/small${tracer.extension}`]: tracer.fixtures.imported,
    });
    const stops: TracerStop[] = [];
    const limits = { ...TRACER_LIMITS, fileBytes: 2048 };
    const files = await tracer.read(root, stops, limits);
    expect(files.map((item) => item.path)).toEqual([`app/small${tracer.extension}`]);
    expect(stops).toEqual([
      expect.objectContaining({
        language,
        file: `app/big${tracer.extension}`,
        code: 'file-too-large',
      }),
    ]);
    await expect(tracer.read(root, undefined, limits)).rejects.toThrow(/over the 2048-byte limit/);
  }, 20_000);

  it('stops on the parse-time, node-count and depth limits', async () => {
    const parser = await loadParser(language);
    const big = { path: `big${tracer.extension}`, content: tracer.fixtures.imported.repeat(2000) };
    for (const [limits, code] of [
      [{ ...TRACER_LIMITS, parseMilliseconds: -1 }, 'parse-timeout'],
      [{ ...TRACER_LIMITS, nodes: 50 }, 'tree-too-large'],
      [{ ...TRACER_LIMITS, depth: 3 }, 'tree-too-deep'],
    ] as const) {
      const result = parseWithin(parser, language, big, limits);
      expect('rootNode' in result ? 'parsed' : result.code).toBe(code);
    }
    const ok = parseWithin(parser, language, big);
    expect('rootNode' in ok).toBe(true);
    if ('rootNode' in ok) ok.delete();
  });

  it('turns a tracer limit inside a trace into a stop for that file only', async () => {
    const stops: TracerStop[] = [];
    const deep = {
      path: `app/deep${tracer.extension}`,
      content: `${tracer.fixtures.imported}${'\n'.repeat(3 * 1024 * 1024)}`,
    };
    expect(models(await tracer.trace([deep, file('imported')], stops))).toEqual([
      { provider: 'openai', literals: [['gpt-4o-mini', expect.any(String)]], stop: null },
    ]);
    expect(stops.map((stop) => [stop.file, stop.code])).toEqual([[deep.path, 'file-too-large']]);
  });

  it('gives identical records for the same input across runs', async () => {
    const files = (Object.keys(tracer.fixtures) as (keyof Conformance['fixtures'])[]).map(file);
    const first = JSON.stringify(await tracer.trace(files));
    clearLoadedParsers();
    expect(JSON.stringify(await tracer.trace(files))).toBe(first);
    expect(JSON.stringify(await tracer.trace(files))).toBe(first);
  });

  it('never stops the rest of a deadline scan when its grammar fails its check', async () => {
    const pin = GRAMMARS[language];
    const original = pin.wasmSha256;
    const root = await repository({
      'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
      'src/chat.ts':
        "import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.chat.completions.create({ model: 'gpt-4', messages: [] });\n",
      [`app/retiring${tracer.extension}`]: tracer.fixtures.retiring,
    });
    pin.wasmSha256 = '0'.repeat(64);
    clearLoadedParsers();
    try {
      const scan = await scanDeadlines(root, await loadDeadlineRegistry(), NOW);
      const gpt4 = scan.exposures.find((item) => item.deadline.versions.includes('gpt-4'))!;
      expect(gpt4.evidence.map((item) => item.file)).toEqual(['src/chat.ts']);
      expect(scan.stops).toEqual([
        expect.objectContaining({ language, file: null, code: 'grammar-integrity' }),
      ]);
      const proposal = await proposeModelReplacements(root, await loadDeadlineRegistry(), NOW);
      expect(proposal.replacements.map((item) => item.file)).toEqual(['src/chat.ts']);
      expect(proposal.tracerStops).toEqual([
        expect.objectContaining({ language, code: 'grammar-integrity' }),
      ]);
    } finally {
      pin.wasmSha256 = original;
      clearLoadedParsers();
    }
  });

  // Owner decision 2026-10-22: tracers on this path report; they never produce edits.
  it('is report only: a retiring model it traces is a stop, never a replacement or patch', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
      'src/chat.ts':
        "import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.chat.completions.create({ model: 'gpt-4', messages: [] });\n",
      [`app/retiring${tracer.extension}`]: tracer.fixtures.retiring,
    });
    const proposal = await proposeModelReplacements(root, await loadDeadlineRegistry(), NOW);
    expect(proposal.replacements.map((item) => item.edited.file)).toEqual(['src/chat.ts']);
    expect(proposal.patch).not.toContain(tracer.extension);
    expect(proposal.stops.map((item) => item.file)).toContain(`app/retiring${tracer.extension}`);
    expect(proposal.tracerStops).toEqual([]);
  });
});

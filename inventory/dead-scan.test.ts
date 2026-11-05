import { chmod, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readQueue } from '../dead-apis/queue.ts';
import type { ModelClient, ModelRequest } from '../providers/core/model.ts';
import type { MatchClass, ScanRepo } from '../shared/types.ts';
import { BudgetLedger } from './budget.ts';
import { checkUnclear, CHECK_MODEL, scanAndCheck } from './dead-check.ts';
import { loadDeadApis } from '../dead-apis/list.ts';
import { requiredLiterals } from '../dead-apis/match.ts';
import { lex, spanAt } from './dead-scan-lex.ts';
import { compareVersions, lowestVersion, rangeBounds } from './dead-scan-version.ts';
import { scanDeadApis, scanRepoForDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'dead-scan');
const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ dependencies }, null, 2);
const OPENAI_PACKAGE = { 'package.json': manifest({ openai: '^6.0.0' }) };
const ANTHROPIC_PACKAGE = { 'package.json': manifest({ '@anthropic-ai/sdk': '^1.0.0' }) };
const STRIPE_AT = (range: string) => ({ 'package.json': manifest({ stripe: range }) });
const STRIPE_IMPORT = "import Stripe from 'stripe';\n";

const repos: string[] = [];
async function scan(files: Record<string, string>, today = TODAY): Promise<DeadScanReport> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return scanDeadApis(repoDir, 'test/repo', { today });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
  vi.unstubAllEnvs();
});

const scanFixture = (name: string) =>
  scanDeadApis(path.join(FIXTURES, name), name.replace('__', '/'), { today: TODAY });

function classesOf(report: DeadScanReport, entryId: string, file?: string): MatchClass[] {
  return report.details
    .filter((one) => one.entryId === entryId && (!file || one.file === file))
    .map((one) => one.matchClass);
}

/** Shows the whole report when a check fails, since a wrong class is usually about its reason. */
function explain(report: DeadScanReport): string {
  return report.details
    .map((one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`)
    .concat(report.quiet.map((one) => `quiet ${one.entryId} ${one.file}:${one.line} ${one.reason}`))
    .join('\n');
}

const fixTargets = (report: DeadScanReport) =>
  report.details.filter((one) => one.matchClass === 'live' || one.matchClass === 'unclear');

describe('regression fixtures: must flag', () => {
  it('flags Universal Analytics in Spotify-Lyrics', async () => {
    const report = await scanFixture('mantou132__Spotify-Lyrics');
    const file = 'src/common/ga.ts';
    expect(classesOf(report, 'GA-1.measurement-protocol', file), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GA-1.ua-property-id', file), explain(report)).toEqual(['live']);
    expect(report.clean).toBe(false);
  });

  it("flags Clario's webhook reads at its pin, and not the app's own profile field", async () => {
    const report = await scanFixture('MuhammadTanveerAbbas__Clario-ai');
    const file = 'src/app/api/stripe/webhook/route.ts';
    const live = report.details.filter((one) => one.file === file && one.matchClass === 'live');
    expect(new Set(live.map((one) => one.entryId)), explain(report)).toEqual(
      new Set(['ST-1.current_period_end', 'ST-1.current_period_start', 'ST-2.subscription']),
    );
    expect(live.filter((one) => one.entryId === 'ST-2.subscription')).toHaveLength(2);
    expect(live.filter((one) => one.entryId === 'ST-1.current_period_end')).toHaveLength(3);
    expect(live.every((one) => one.version === '2026-02-25.clover')).toBe(true);
    expect(report.details.some((one) => one.file.includes('billing-section'))).toBe(false);
  });

  it('flags the retired defaults in Code-Review-Agent, and the frontend picker', async () => {
    const report = await scanFixture('MFaizanali2__Code-Review-Agent');
    const types = 'backend/llm/llm_types.py';
    expect(classesOf(report, 'AN-1.claude-sonnet-4-20250514', types), explain(report)).toEqual([
      'live',
    ]);
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', types), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GR-1.llama-3.3-70b-versatile', types), explain(report)).toEqual([
      'live',
    ]);
    const picker = 'frontend/streamlit_app.py';
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', picker), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GE-2.gemini-1.5-*', picker), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', '.env.example')).toEqual(['live']);
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', 'frontend/test_ui.py')).toEqual([
      'test',
      'test',
    ]);
    const client = 'backend/llm/llm_client.py';
    const table = report.details.filter(
      (one) => one.file === client && /key in a table/.test(one.reason),
    );
    expect(table.length).toBe(3);
    expect(table.every((one) => one.matchClass === 'catalog' && one.withFix)).toBe(true);
    expect(report.details.some((one) => /comparison/.test(one.reason) && one.file === client)).toBe(
      true,
    );
  });

  it('reads temperature as unclear under an open SDK range, which a fresh install takes past the gate', async () => {
    const report = await scanFixture('MFaizanali2__Code-Review-Agent');
    expect(new Set(classesOf(report, 'AN-2')), explain(report)).toEqual(new Set(['unclear']));
    const hit = report.details.find((one) => one.entryId === 'AN-2');
    expect(hit?.reason).toMatch(/either side of the removal.*anthropic 0\.18\.0/);
  });

  it('flags the realtime beta header, which is not a quoted model', async () => {
    const report = await scanFixture('hachanimohamedsaid__backend_AgentAi');
    expect(classesOf(report, 'OA-3.realtime-beta'), explain(report)).toEqual(['live']);
  });
});

describe('regression fixtures: must stay quiet', () => {
  it('keeps branded quiet: its SDK is below the gate and it sets no version', async () => {
    const report = await scanFixture('alanagoyal__branded');
    expect(fixTargets(report), explain(report)).toEqual([]);
    expect(report.clean).toBe(true);
    const quiet = report.quiet.filter((one) => one.entryId === 'ST-1.current_period_end');
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((one) => one.version === '15.12.0')).toBe(true);
  });

  it('keeps lumen quiet: pinned before the removal, and the pin is the reason given', async () => {
    const report = await scanFixture('pretzelai__lumen');
    expect(fixTargets(report), explain(report)).toEqual([]);
    expect(report.clean).toBe(true);
    const quiet = report.quiet.filter((one) => one.entryId === 'ST-2.subscription');
    expect(quiet.length).toBeGreaterThan(0);
    const api = quiet.filter((one) => one.file.startsWith('api/'));
    expect(api.length, explain(report)).toBeGreaterThan(0);
    expect(api.every((one) => one.version === '2025-02-24.acacia')).toBe(true);
  });

  it("doesn't call lumen's own invoice rows live even past the removal", async () => {
    const dir = path.join(FIXTURES, 'pretzelai__lumen');
    const own = await readFile(path.join(dir, 'api/src/routes/public.ts'), 'utf8');
    const ui = await readFile(path.join(dir, 'ui/src/app/(dashboard)/invoices/page.tsx'), 'utf8');
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'api/src/routes/public.ts': own,
      'ui/src/app/invoices/page.tsx': ui,
    });
    const hits = report.details.filter((one) => one.entryId === 'ST-2.subscription');
    expect(hits.length, explain(report)).toBeGreaterThan(0);
    expect(
      hits.every((one) => one.matchClass === 'unclear'),
      explain(report),
    ).toBe(true);
  });

  it('finds no Stripe break in tinypivot, whose pin predates every removal it reads', async () => {
    const report = await scanFixture('Small-Web-Co__tinypivot');
    expect(
      fixTargets(report).filter((one) => one.provider === 'stripe'),
      explain(report),
    ).toEqual([]);
  });

  it("flags tinypivot's real Anthropic default: the brief's quiet row only covered Stripe", async () => {
    // claude-3-haiku-20240307 retired 2026-04-20 and api/ai-proxy.ts sends it to api.anthropic.com.
    // Logged in DECISIONS-PIERCE.md; staying quiet here would be a missed break, not a clean repo.
    const report = await scanFixture('Small-Web-Co__tinypivot');
    expect(classesOf(report, 'AN-1.claude-3-haiku-20240307', 'api/ai-proxy.ts')).toEqual(['live']);
  });

  it('keeps a vendored tool in a dot folder away from a fix', async () => {
    const report = await scanFixture('WeWake1__BSOMS');
    const file = '.agent/get-shit-done/bin/lib/core.cjs';
    const hit = report.details.find(
      (one) => one.file === file && one.entryId.includes('claude-opus-4'),
    );
    expect(hit?.matchClass, explain(report)).toBe('catalog');
    expect(hit?.reason).toMatch(/\.agent.*vendored/);
    expect(hit?.withFix).toBe(false);
    expect(report.clean).toBe(true);
  });
});

describe('match classes', () => {
  const model = 'gpt-4';
  const entry = 'OA-1.gpt-4';
  const classOf = async (file: string, text: string) => {
    const report = await scan({ ...OPENAI_PACKAGE, [file]: text });
    return { report, classes: classesOf(report, entry, file) };
  };

  it.each<[string, string, string, MatchClass]>([
    ['a call', 'a.ts', `call({ model: '${model}' });`, 'live'],
    ['a default parameter', 'a.py', `def f(model="${model}"): pass`, 'live'],
    ['a line comment', 'a.ts', `// was ${model}\ncall();`, 'comment'],
    ['a block comment', 'a.ts', `/* ${model} */\ncall();`, 'comment'],
    ['a Python comment', 'a.py', `# ${model}\ncall()`, 'comment'],
    ['a shell comment', 'a.sh', `# ${model}\ncurl x`, 'comment'],
    ['a YAML comment', 'a.yml', `# model: ${model}\nother: 1`, 'comment'],
    ['an HTML comment', 'a.html', `<!-- ${model} -->\n<p>x</p>`, 'comment'],
    [
      'an error message',
      'a.ts',
      `throw new Error('${model} is not supported any more');`,
      'comment',
    ],
    ['a docstring', 'a.py', `"""Uses ${model} for answers."""\ncall()`, 'comment'],
    ['markdown', 'README.md', `Set MODEL to ${model}.`, 'comment'],
    ['a test file', 'src/a.test.ts', `call('${model}');`, 'test'],
    ['a test folder', 'tests/a.py', `call("${model}")`, 'test'],
    ['a fixture', 'fixtures/a.ts', `call('${model}');`, 'test'],
    ['a story', 'src/a.stories.tsx', `call('${model}');`, 'test'],
    ['an example', 'examples/a.ts', `call('${model}');`, 'test'],
    ['a mock', 'src/__mocks__/a.ts', `call('${model}');`, 'test'],
    ['a list of three', 'a.ts', `const xs = ['${model}', 'gpt-3.5-turbo', 'o3'];`, 'catalog'],
    ['a price table key', 'a.ts', `const PRICES = {\n  '${model}': 30,\n};`, 'catalog'],
    ['a table index', 'a.ts', `const cost = PRICES['${model}'];`, 'catalog'],
    ['a model record', 'a.ts', `const m = { id: '${model}', contextWindow: 8192 };`, 'catalog'],
    ['a Set', 'a.ts', `const s = new Set(['${model}']);`, 'catalog'],
    ['a Map key', 'a.ts', `const s = new Map([['${model}', 1]]);`, 'catalog'],
    ['a union type', 'a.ts', `type M = '${model}' | 'other';`, 'catalog'],
    ['an interface field', 'a.ts', `interface A {\n  model: '${model}';\n}`, 'catalog'],
    ['an enum', 'a.ts', `enum M {\n  A = '${model}',\n}`, 'catalog'],
    ['a Literal type', 'a.py', `M = Literal["${model}"]`, 'catalog'],
    ['startsWith', 'a.ts', `if (m.startsWith('${model}')) go();`, 'catalog'],
    ['includes', 'a.ts', `if (m.includes('${model}')) go();`, 'catalog'],
    ['===', 'a.ts', `if (m === '${model}') go();`, 'catalog'],
    ['== in Python', 'a.py', `if m == "${model}":\n    go()`, 'catalog'],
    ['case', 'a.ts', `switch (m) {\n  case '${model}':\n    go();\n}`, 'catalog'],
    ['in', 'a.py', `if "${model}" in m:\n    go()`, 'catalog'],
    ['in a list', 'a.py', `if m in ["${model}", "x"]:\n    go()`, 'catalog'],
    ['a list includes', 'a.ts', `if (['${model}', 'x'].includes(m)) go();`, 'catalog'],
    ['encoding_for_model', 'a.py', `e = tiktoken.encoding_for_model("${model}")`, 'catalog'],
    ['encodingForModel', 'a.ts', `const e = encodingForModel('${model}');`, 'catalog'],
    ['an <option>', 'a.html', `<option value="${model}">GPT</option>`, 'live'],
    ['JSX option text', 'a.tsx', `const p = <option>${model}</option>;`, 'live'],
    ['a list after return', 'a.py', `def f():\n    return ["${model}"]`, 'live'],
    ['a list named models', 'a.ts', `const MODELS = ['${model}', 'x'];`, 'live'],
    ['an options record', 'a.ts', `const o = [{ value: '${model}', label: 'GPT' }];`, 'live'],
    ['a selectbox', 'a.py', `m = st.selectbox("Model", ["${model}", "x"])`, 'live'],
    ['a function returning models', 'a.py', `def list_models():\n    return ["${model}"]`, 'live'],
    ['config', 'a.yml', `model: ${model}`, 'live'],
    ['a YAML table key', 'a.yml', `${model}: 8192`, 'catalog'],
    ['a template', '.env.example', `MODEL=${model}`, 'live'],
    ['a shell flag', 'a.sh', `tool --model ${model}`, 'live'],
    ['Dockerfile', 'Dockerfile', `ENV MODEL=${model}`, 'live'],
    ['JSON', 'a.json', `{"model": "${model}"}`, 'live'],
    ['CI in .github', '.github/workflows/a.yml', `model: ${model}`, 'live'],
    ['a string setting a model key', 'a.ts', `const s = 'model: ${model} here';`, 'live'],
    ['JSON in a string', 'a.ts', `const s = '{"model": "${model}", "n": 1}';`, 'live'],
    ['a string joined to text', 'a.ts', `const s = 'use ${model} now' + x;`, 'comment'],
    ['a dot folder holding a tool', '.claude/a.ts', `call('${model}');`, 'catalog'],
  ])('%s', async (_name, file, text, expected) => {
    const { report, classes } = await classOf(file, text);
    expect(classes, explain(report)).toEqual([expected]);
  });

  it("doesn't read a string inside a template's ${} as prose around it", async () => {
    const { report, classes } = await classOf('a.ts', 'const s = `${pick("gpt-4")} is the model`;');
    expect(classes, explain(report)).toEqual(['live']);
  });

  it('survives a regex literal holding a quote, and a JSX apostrophe', async () => {
    const text = `const r = /it's/;\nconst t = <p>don't</p>;\ncall('${model}');`;
    const { report, classes } = await classOf('a.tsx', text);
    expect(classes, explain(report)).toEqual(['live']);
  });

  it('reads a <script> inside HTML as code, and a comment in it as a comment', async () => {
    const text = `<script>\n// ${model}\n</script>\n<script>call('gpt-3.5-turbo');</script>`;
    const report = await scan({ ...OPENAI_PACKAGE, 'a.html': text });
    expect(classesOf(report, entry, 'a.html'), explain(report)).toEqual(['comment']);
    expect(classesOf(report, 'OA-1.gpt-3.5-turbo', 'a.html'), explain(report)).toEqual(['live']);
  });

  it("reads a notebook's code cells at their file line, and not its markdown", async () => {
    const notebook = JSON.stringify(
      {
        cells: [
          { cell_type: 'markdown', source: ['Uses gpt-3.5-turbo\n'] },
          { cell_type: 'code', source: ['import openai\n', `openai.call(model="${model}")\n`] },
        ],
      },
      null,
      1,
    );
    const report = await scan({ ...OPENAI_PACKAGE, 'a.ipynb': notebook });
    const hit = report.details.find((one) => one.entryId === entry);
    expect(hit?.matchClass, explain(report)).toBe('live');
    expect(notebook.split('\n')[(hit?.line ?? 1) - 1]).toContain(model);
    expect(classesOf(report, 'OA-1.gpt-3.5-turbo')).toEqual([]);
  });

  it('sends the catalog hits of a provider with a live finding, and only then', async () => {
    const table = `const PRICES = {\n  '${model}': 30,\n};`;
    const alone = await scan({ ...OPENAI_PACKAGE, 'a.ts': table });
    expect(
      alone.details.map((one) => one.withFix),
      explain(alone),
    ).toEqual([false]);
    expect(alone.clean).toBe(true);
    const both = await scan({ ...OPENAI_PACKAGE, 'a.ts': table, 'b.ts': `call('${model}');` });
    expect(
      both.details.map((one) => [one.matchClass, one.withFix]),
      explain(both),
    ).toEqual([
      ['catalog', true],
      ['live', true],
    ]);
    expect(both.clean).toBe(false);
  });
});

describe('what the list says is dead today', () => {
  it("doesn't flag gpt-4o, or read gpt-4 inside it", async () => {
    const report = await scan({ ...OPENAI_PACKAGE, 'a.ts': "call({ model: 'gpt-4o' });" });
    expect(report.details, explain(report)).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('flags a future shutdown on its date, not before', async () => {
    const files = { ...OPENAI_PACKAGE, 'a.ts': "call({ model: 'gpt-4o' });" };
    const before = await scan(files, '2027-01-13');
    expect(before.details, explain(before)).toEqual([]);
    const on = await scan(files, '2027-01-14');
    expect(classesOf(on, 'OA-4.gpt-4o', 'a.ts'), explain(on)).toEqual(['live']);
    expect(on.clean).toBe(false);
  });

  it('flags realtime=v1 in a header', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': "const h = { 'OpenAI-Beta': 'realtime=v1' };",
    });
    expect(classesOf(report, 'OA-3.realtime-beta', 'a.ts'), explain(report)).toEqual(['live']);
  });

  it('reports a dead package from a nested manifest and from an import', async () => {
    const report = await scan({
      'apps/web/package.json': manifest({ 'react-ga': '^3.0.0' }),
      'apps/web/a.ts': "import ReactGA from 'react-ga';\nReactGA.initialize('x');",
    });
    expect(classesOf(report, 'GA-1.react-ga', 'apps/web/package.json'), explain(report)).toEqual([
      'live',
    ]);
    expect(classesOf(report, 'GA-1.react-ga', 'apps/web/a.ts'), explain(report)).toEqual(['live']);
  });
});

describe('provider context', () => {
  it('is unclear with no provider package or host anywhere in the repo', async () => {
    const report = await scan({ 'a.ts': "call({ model: 'gpt-4' });" });
    expect(classesOf(report, 'OA-1.gpt-4', 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details[0].reason).toMatch(/no package or host/);
    expect(report.clean).toBe(false);
  });

  it('counts a host in any file as the provider being in the repo', async () => {
    const report = await scan({
      'a.ts': "call({ model: 'gpt-4' });",
      'b.ts': "fetch('https://api.openai.com/v1/chat/completions');",
    });
    expect(classesOf(report, 'OA-1.gpt-4', 'a.ts'), explain(report)).toEqual(['live']);
  });

  it("doesn't count a host that only a vendored tool or a test names", async () => {
    const report = await scan({
      'a.ts': "call({ model: 'gpt-4' });",
      '.agent/b.ts': "fetch('https://api.openai.com/v1/x');",
      'tests/c.ts': "fetch('https://api.openai.com/v1/x');",
    });
    expect(classesOf(report, 'OA-1.gpt-4', 'a.ts'), explain(report)).toEqual(['unclear']);
  });

  it('keeps a common word with no provider around out of the check', async () => {
    const report = await scan({ 'a.ts': "export const person = { name: 'ada' };" });
    expect(classesOf(report, 'OA-1.base-ada'), explain(report)).toEqual([]);
    expect(report.quiet.find((one) => one.entryId === 'OA-1.base-ada')?.reason).toMatch(
      /no package or host/,
    );
    expect(report.clean).toBe(true);
  });

  it.each([
    ['Azure', "const c = new AzureOpenAI({ model: 'gpt-4' });", 'Azure'],
    ['Bedrock', "const c = bedrock.call({ model: 'gpt-4' });", 'Bedrock'],
    ['OpenRouter', "const c = openrouter.call({ model: 'gpt-4' });", 'OpenRouter'],
    ['a local URL', "call('http://localhost:11434', { model: 'gpt-4' });", 'Ollama|local'],
    ['NVIDIA', "const c = nvidia.call({ model: 'gpt-4' });", 'NVIDIA'],
  ])('is unclear on a line that targets %s', async (_name, line, reason) => {
    const report = await scan({ ...OPENAI_PACKAGE, 'a.ts': line });
    expect(classesOf(report, 'OA-1.gpt-4', 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details[0].reason).toMatch(new RegExp(reason));
  });

  it('is unclear in a file that targets another host and never names the provider', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': "const url = 'https://api.together.xyz/v1';\ncall({ model: 'gpt-4' });",
    });
    expect(report.details[0]?.reason, explain(report)).toMatch(/file targets Together/);
    expect(report.details[0]?.matchClass).toBe('unclear');
  });

  it("isn't thrown by a file with a local URL for the app's own backend", async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.py': 'API_BASE_URL = "http://localhost:8000"\nm = call("gpt-4")',
    });
    expect(classesOf(report, 'OA-1.gpt-4', 'a.py'), explain(report)).toEqual(['live']);
  });

  it('is unclear for an ambiguous name, and live for a URL with the host on its line', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': "fetch('/v1/edits');",
      'b.ts': "fetch('https://api.openai.com/v1/edits');",
      'c.ts': "const base_url = 'https://api.openai.com';\nfetch('/v1/edits');",
    });
    expect(classesOf(report, 'OA-3.v1-edits', 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(classesOf(report, 'OA-3.v1-edits', 'b.ts'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'OA-3.v1-edits', 'c.ts'), explain(report)).toEqual(['live']);
  });
});

describe('field reads', () => {
  const entry = 'ST-1.current_period_end';
  const withPin = "export const stripe = new Stripe(k, { apiVersion: '2025-03-31.basil' });\n";
  const read = async (text: string, file = 'a.ts') => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'lib/s.ts': STRIPE_IMPORT + withPin,
      [file]: text,
    });
    return { report, classes: classesOf(report, entry, file) };
  };

  const RETRIEVED = 'const subscription = await stripe.subscriptions.retrieve(id);\n';

  it.each([
    ['dotted', `${STRIPE_IMPORT}x.subscription.current_period_end;`],
    ['a cast to any', `${STRIPE_IMPORT}(sub as any).current_period_end;`],
    ['optional chain on nothing bound', `${STRIPE_IMPORT}subscription?.current_period_end;`],
    ['destructured from nothing bound', `${STRIPE_IMPORT}const { current_period_end } = sub;`],
    ['the webhook object itself', 'event.data.object.current_period_end;'],
  ])('is unclear, since no receiver is bound: %s', async (_name, text) => {
    const { report, classes } = await read(text);
    expect(classes, explain(report)).toEqual(['unclear']);
  });

  it.each([
    ['optional chain', `${RETRIEVED}subscription?.current_period_end;`],
    ['bracket access', `${RETRIEVED}subscription['current_period_end'];`],
    ['destructured', `${RETRIEVED}const { current_period_end } = subscription;`],
    ['destructured and renamed', `${RETRIEVED}const { current_period_end: end } = subscription;`],
    ['typed parameter', 'function f(s: Stripe.Subscription) { return s.current_period_end; }'],
    ['cast variable', 'const s = event.data.object as Stripe.Subscription;\ns.current_period_end;'],
    [
      'a provider call',
      'const s = await stripe.subscriptions.retrieve(id);\ns.current_period_end;',
    ],
    ['a for loop', 'for await (const s of stripe.subscriptions.list()) { s.current_period_end; }'],
    [
      'a webhook object named for its shape',
      'const subscription = event.data.object;\nsubscription.current_period_end;',
    ],
    ['an inline cast', '(thing as Stripe.Subscription).current_period_end;'],
    ['a call result', '(await stripe.subscriptions.retrieve(id)).current_period_end;'],
  ])('is live: %s', async (_name, text) => {
    const { report, classes } = await read(text);
    expect(classes, explain(report)).toEqual(['live']);
    expect(report.details.find((one) => one.entryId === entry)?.version).toBe('2025-03-31.basil');
  });

  it('reads Python dicts and .get', async () => {
    const report = await scan({
      'requirements.txt': 'stripe==12.1.0\n',
      'a.py': [
        'import stripe',
        'sub = stripe.Subscription.retrieve(i)',
        'sub["current_period_end"]',
        'sub.get("current_period_start")',
        'obj = event["data"]["object"]',
        'obj["current_period_end"]',
      ].join('\n'),
    });
    expect(classesOf(report, entry, 'a.py'), explain(report)).toEqual(['live', 'unclear']);
    expect(classesOf(report, 'ST-1.current_period_start', 'a.py'), explain(report)).toEqual([
      'live',
    ]);
    expect(report.details[0].version).toBe('12.1.0');
  });

  it.each([
    ['an object off no on word', `${STRIPE_IMPORT}profile.current_period_end;`],
    ['a key being written', `${STRIPE_IMPORT}const row = { current_period_end: 1 };`],
    ['a type field', `${STRIPE_IMPORT}type Row = { current_period_end: number };`],
    [
      'another of the provider’s shapes',
      'const s = await stripe.subscriptionItems.retrieve(i);\ns.current_period_end;',
    ],
  ])('is not a hit: %s', async (_name, text) => {
    const { report, classes } = await read(text);
    expect(classes, explain(report)).toEqual([]);
  });

  it("isn't live for an app's own object, with or without the provider's import", async () => {
    const owned = await read(
      'const subscription = await db.subscriptions.findFirst();\nsubscription.current_period_end;',
    );
    expect(owned.classes, explain(owned.report)).toEqual(['unclear']);
    expect(owned.report.details.find((one) => one.entryId === entry)?.reason).toMatch(
      /db\.subscriptions/,
    );
    const imported = await read(
      `${STRIPE_IMPORT}const subscription = await db.subscriptions.findFirst();\nsubscription.current_period_end;`,
    );
    expect(imported.classes, explain(imported.report)).toEqual(['unclear']);
    const bare = await read('subscription.current_period_end;');
    expect(bare.classes, explain(bare.report)).toEqual(['unclear']);
  });

  it('reports a read in a comment as a comment', async () => {
    const { report, classes } = await read(
      `${STRIPE_IMPORT}// subscription.current_period_end is gone`,
    );
    expect(classes, explain(report)).toEqual(['comment']);
  });

  it('finds an argument to a named call, as with temperature on messages.create', async () => {
    const report = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.ts':
        "import Anthropic from '@anthropic-ai/sdk';\nclient.messages.create({ model: m, temperature: 0.2 });\nother.create({ temperature: 0.2 });",
    });
    const hits = report.details.filter((one) => one.entryId === 'AN-2');
    expect(
      hits.map((one) => [one.matchClass, one.line]),
      explain(report),
    ).toEqual([['live', 2]]);
  });

  it('is unclear for an ambiguous field that matches', async () => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'a.ts': `${STRIPE_IMPORT}invoice.paid;`,
    });
    expect(classesOf(report, 'ST-3.paid', 'a.ts'), explain(report)).toEqual(['unclear']);
  });
});

describe('the version gate', () => {
  const entry = 'ST-1.current_period_end';
  const code = (pin = '') =>
    `${STRIPE_IMPORT}${pin}\nconst subscription = await stripe.subscriptions.retrieve(id);\nsubscription.current_period_end;`;
  const pinned = (version: string) => `const s = new Stripe(k, { apiVersion: '${version}' });`;

  it.each([
    ['exactly at the removal', '2025-03-31.basil', 'live'],
    ['a later name on a later date', '2026-02-25.clover', 'live'],
    ['a later date with an earlier-sorting name', '2026-09-30.endive', 'live'],
    ['the day before', '2025-03-30.acacia', 'quiet'],
    ['an earlier date with a later-sorting name', '2024-12-18.zebra', 'quiet'],
  ])('compares dated versions on the date: %s', async (_name, version, expected) => {
    const report = await scan({ ...STRIPE_AT('^20.0.0'), 'a.ts': code(pinned(version)) });
    if (expected === 'live') {
      expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual(['live']);
      expect(report.details.find((one) => one.entryId === entry)?.version).toBe(version);
    } else {
      expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual([]);
      const quiet = report.quiet.find((one) => one.entryId === entry);
      expect(quiet?.reason).toMatch(/pinned before the removal/);
      expect(quiet?.version).toBe(version);
    }
  });

  it('lets a pin outrank the SDK, in both directions', async () => {
    const old = await scan({ ...STRIPE_AT('^20.0.0'), 'a.ts': code(pinned('2024-12-18.acacia')) });
    expect(classesOf(old, entry), explain(old)).toEqual([]);
    const fresh = await scan({
      ...STRIPE_AT('^15.0.0'),
      'a.ts': code(pinned('2026-02-25.clover')),
    });
    expect(classesOf(fresh, entry), explain(fresh)).toEqual(['live']);
  });

  it.each([
    ['Stripe-Version header', "const h = { 'Stripe-Version': '2026-02-25.clover' };"],
    ['python-style api_version', "stripe.api_version = '2026-02-25.clover';"],
  ])('finds a pin set by %s', async (_name, pin) => {
    const report = await scan({ ...STRIPE_AT('^15.0.0'), 'a.ts': code(pin) });
    expect(classesOf(report, entry), explain(report)).toEqual(['live']);
  });

  it('finds the pin in another file of the package, but not in a test, comment or vendored tool', async () => {
    const elsewhere = await scan({
      ...STRIPE_AT('^15.0.0'),
      'lib/stripe.ts': STRIPE_IMPORT + pinned('2026-02-25.clover'),
      'a.ts': code(),
    });
    expect(classesOf(elsewhere, entry, 'a.ts'), explain(elsewhere)).toEqual(['live']);
    const notCounted = await scan({
      ...STRIPE_AT('^15.0.0'),
      'tests/stripe.ts': STRIPE_IMPORT + pinned('2026-02-25.clover'),
      '.claude/stripe.ts': STRIPE_IMPORT + pinned('2026-02-25.clover'),
      'lib/old.ts': `${STRIPE_IMPORT}// ${pinned('2026-02-25.clover')}`,
      'a.ts': code(),
    });
    expect(classesOf(notCounted, entry, 'a.ts'), explain(notCounted)).toEqual([]);
    expect(notCounted.quiet.find((one) => one.file === 'a.ts')?.version).toBe('15.0.0');
  });

  it("isn't taken in by another provider's apiVersion in a file that doesn't name Stripe", async () => {
    const report = await scan({
      ...STRIPE_AT('^15.0.0'),
      'shop.ts': "const c = shopifyApi({ apiVersion: '2026-04' });",
      'a.ts': code(),
    });
    expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual([]);
  });

  it('is unclear when pins disagree and nothing says which client this is', async () => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'lib/a.ts': STRIPE_IMPORT + pinned('2024-12-18.acacia'),
      'lib/b.ts': STRIPE_IMPORT + pinned('2026-02-25.clover'),
      'a.ts': code(),
    });
    expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details.find((one) => one.file === 'a.ts')?.reason).toMatch(/conflicting/);
  });

  it('prefers the package the read is in when two packages pin differently', async () => {
    const report = await scan({
      'one/package.json': manifest({ stripe: '^20.0.0' }),
      'one/s.ts': STRIPE_IMPORT + pinned('2026-02-25.clover'),
      'one/a.ts': code(),
      'two/package.json': manifest({ stripe: '^17.0.0' }),
      'two/s.ts': STRIPE_IMPORT + pinned('2024-12-18.acacia'),
      'two/a.ts': code(),
    });
    expect(classesOf(report, entry, 'one/a.ts'), explain(report)).toEqual(['live']);
    expect(classesOf(report, entry, 'two/a.ts'), explain(report)).toEqual([]);
  });

  it.each([
    ['at the gate', '18.0.0', 'live'],
    ['above', '18.0.1', 'live'],
    ['below', '17.7.0', 'quiet'],
  ])('uses the SDK default with no pin: a lockfile %s', async (_name, version, expected) => {
    const report = await scan({
      ...STRIPE_AT('*'),
      'package-lock.json': JSON.stringify(
        { lockfileVersion: 3, packages: { 'node_modules/stripe': { version } } },
        null,
        2,
      ),
      'a.ts': code(),
    });
    if (expected === 'live') {
      expect(report.details.find((one) => one.entryId === entry)?.version, explain(report)).toBe(
        version,
      );
      expect(classesOf(report, entry), explain(report)).toEqual(['live']);
    } else {
      expect(report.quiet.find((one) => one.entryId === entry)?.version, explain(report)).toBe(
        version,
      );
    }
  });

  it('prefers the lockfile to the range', async () => {
    const report = await scan({
      ...STRIPE_AT('^17.0.0'),
      'package-lock.json': JSON.stringify(
        { lockfileVersion: 3, packages: { 'node_modules/stripe': { version: '18.2.0' } } },
        null,
        2,
      ),
      'a.ts': code(),
    });
    expect(classesOf(report, entry), explain(report)).toEqual(['live']);
  });

  it.each<[string, MatchClass[]]>([
    ['^18.0.0', ['live']],
    ['>=18.0.0,<19', ['live']],
    ['^17.5.0', []],
    ['17.x', []],
    ['~17.5.0', []],
    ['<18.0.0', []],
    ['>=17.0.0,<18', []],
    // An unlocked range installs its newest match, so its floor says nothing on its own.
    ['>=17.0.0', ['unclear']],
    ['<20', ['unclear']],
    ['>=17.0.0,<20', ['unclear']],
    ['^17.0.0 || ^20.0.0', ['unclear']],
    ['17.0.0 - 20.0.0', ['unclear']],
    ['<=18.0.0', ['unclear']],
  ])('reads the range %s by what it could install', async (range, classes) => {
    const report = await scan({ ...STRIPE_AT(range), 'a.ts': code() });
    expect(classesOf(report, entry), explain(report)).toEqual(classes);
  });

  it.each([
    ['a range that says nothing', { ...STRIPE_AT('latest'), 'a.ts': code() }],
    [
      'no manifest, only an import',
      { 'a.ts': code(), 'b.ts': "fetch('https://api.stripe.com/v1/x');" },
    ],
  ])('is unclear, never clean, when the version cannot be found: %s', async (_name, files) => {
    const report = await scan(files);
    expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details.find((one) => one.file === 'a.ts')?.reason).toMatch(/no installed SDK/);
    expect(report.clean).toBe(false);
  });

  it('keeps a test hit below the gate out of the findings too', async () => {
    const report = await scan({ ...STRIPE_AT('^15.0.0'), 'tests/a.ts': code() });
    expect(report.details, explain(report)).toEqual([]);
    expect(report.quiet.map((one) => one.file)).toContain('tests/a.ts');
  });

  it('compares versions and range floors as numbers', () => {
    expect(compareVersions('18.10.0', '18.9.0')).toBeGreaterThan(0);
    expect(compareVersions('18.0', '18.0.0')).toBe(0);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(0);
    expect(lowestVersion('^15.1.0')).toBe('15.1.0');
    expect(lowestVersion('~=1.2')).toBe('1.2');
    expect(lowestVersion('v3')).toBe('3');
    expect(lowestVersion('1.x')).toBe('1.0');
    expect(lowestVersion('<3')).toBe('0.0.0');
    expect(rangeBounds('^0.2.3')).toEqual({ floor: '0.2.3', top: '0.3', topExcluded: true });
    expect(rangeBounds('~=1.2')).toEqual({ floor: '1.2', top: '2', topExcluded: true });
    expect(rangeBounds('~=1.2.3')).toEqual({ floor: '1.2.3', top: '1.3', topExcluded: true });
    expect(rangeBounds('==1.2.3')).toEqual({ floor: '1.2.3', top: '1.2.3' });
    expect(rangeBounds('>=1')?.top).toBeUndefined();
    expect(lowestVersion('*')).toBeUndefined();
    expect(lowestVersion('workspace:*')).toBeUndefined();
    expect(lowestVersion('git+https://github.com/a/b.git#v1')).toBeUndefined();
  });
});

describe('what the walk reads', () => {
  it("doesn't follow a symlink to a file or a folder, even to a dead name", async () => {
    const outside = await makeRepo({ 'secret.ts': "call({ model: 'gpt-4' });" });
    repos.push(outside);
    const repoDir = await makeRepo(OPENAI_PACKAGE);
    repos.push(repoDir);
    await symlink(path.join(outside, 'secret.ts'), path.join(repoDir, 'link.ts'));
    await symlink(outside, path.join(repoDir, 'linked'));
    await symlink(path.join(repoDir, 'gone.ts'), path.join(repoDir, 'dangling.ts'));
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    expect(report.details, explain(report)).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('never reads a real env file, and does read its template', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      '.env': 'MODEL=gpt-4',
      '.env.local': 'MODEL=gpt-4',
      'prod.env': 'MODEL=gpt-4',
      '.env.example': 'MODEL=gpt-4',
      '.env.template': 'MODEL=gpt-4',
    });
    expect(
      report.details.map((one) => one.file),
      explain(report),
    ).toEqual(['.env.example', '.env.template']);
  });

  it('skips lockfiles and minified bundles', async () => {
    const bundle = `${"call('gpt-4');".repeat(600)}`;
    const report = await scan({
      ...OPENAI_PACKAGE,
      'package-lock.json': '{"lockfileVersion":3,"note":"gpt-4"}',
      'yarn.lock': '"gpt-4":\n  version "1.0.0"',
      'a.min.js': "call('gpt-4');",
      'b.js': bundle,
    });
    expect(report.details, explain(report)).toEqual([]);
  });
});

describe('the lexer', () => {
  const kindAt = (text: string, mode: Parameters<typeof lex>[1], needle: string) => {
    const { spans } = lex(text, mode);
    return spanAt(spans, text.indexOf(needle))?.kind;
  };

  it.each<[string, Parameters<typeof lex>[1], string, 'string' | 'comment' | undefined]>([
    ['// x\ncode', 'js', 'x', 'comment'],
    ["const a = 'x';", 'js', 'x', 'string'],
    ['`a${b}c`', 'js', 'b', undefined],
    ['`a${"x"}c`', 'js', 'x', 'string'],
    ['`a${b}c`', 'js', 'c', 'string'],
    ['const a = b / 2; // x', 'js', 'x', 'comment'],
    ["const a = /'/; const b = 'x';", 'js', 'x', 'string'],
    ['const u = "https://x"; y', 'js', 'y', undefined],
    ['"""\nx\n"""', 'python', 'x', 'string'],
    ["'''x'''", 'python', 'x', 'string'],
    ['a = 1 # x', 'python', 'x', 'comment'],
    ['a#b x', 'hash', 'x', undefined],
    ['color: 1 # x', 'hash', 'x', 'comment'],
    ['`x`', 'clike', 'x', 'string'],
    ['# x\n', 'php', 'x', 'comment'],
    ['<!-- x -->', 'html', 'x', 'comment'],
    ['<a href="x">y</a>', 'html', 'x', 'string'],
    ['<a href="b">x</a>', 'html', 'x', undefined],
    ['<script>// x\n</script>', 'html', 'x', 'comment'],
    ['{"a": "x"}', 'json', 'x', 'string'],
    ['anything x', 'prose', 'x', 'comment'],
  ])('reads %s as %s', (text, mode, needle, expected) => {
    expect(kindAt(text, mode, needle)).toBe(expected);
  });

  it('keeps offsets and lines in the masked code', () => {
    const text = "a('x');\n// y\nb();";
    const { code } = lex(text, 'js');
    expect(code).toHaveLength(text.length);
    expect(code.split('\n')).toEqual(["a(' ');", '    ', 'b();']);
  });
});

describe('unlisted providers', () => {
  let store: string;
  beforeEach(async () => {
    store = await mkdtemp(path.join(os.tmpdir(), 'dead-scan-store-'));
  });
  afterEach(() => rm(store, { recursive: true, force: true }));

  it('reach the queue, without making the repo unclean', async () => {
    const repoDir = await makeRepo({
      'package.json': manifest({ resend: '^4.0.0', stripe: '^15.0.0' }),
      'a.ts': "import { Resend } from 'resend';\nnew Resend(k).emails.send({});",
    });
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY, storeDir: store });
    expect(report.unlistedProviders).toEqual(['resend']);
    expect(report.clean).toBe(true);
    const queue = await readQueue(store);
    expect(queue.map((one) => [one.provider, one.repos])).toEqual([['resend', ['test/repo']]]);
    expect(queue[0].hints.packages).toContain('resend');
  });

  it('are returned even with no store, and a listed provider never is', async () => {
    const report = await scan({
      'package.json': manifest({ resend: '^4.0.0', stripe: '^15.0.0' }),
    });
    expect(report.unlistedProviders).toEqual(['resend']);
  });
});

describe('the scan as the shared contract', () => {
  it('is a ScanRepo, with plain findings', async () => {
    const repoDir = await makeRepo({ ...OPENAI_PACKAGE, 'a.ts': "call({ model: 'gpt-4' });" });
    repos.push(repoDir);
    const shared: ScanRepo = scanRepoForDeadApis;
    const result = await shared(repoDir, 'test/repo');
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([
      { entryId: 'OA-1.gpt-4', file: 'a.ts', line: 1, matchClass: 'live' },
    ]);
  });

  it('never puts a secret on a report line', async () => {
    const key = `sk-ant-${'a'.repeat(30)}`;
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `call({ model: 'gpt-4', key: '${key}' });`,
    });
    expect(JSON.stringify(report), explain(report)).not.toContain(key);
  });
});

describe('the AI check', () => {
  const UNCLEAR_FILES = {
    ...OPENAI_PACKAGE,
    'a.ts': "fetch('/v1/edits');",
    'b.ts': "fetch('/v1/search');",
  };

  function fakeClient(
    answer: string,
    onCall?: (request: ModelRequest) => void,
  ): ModelClient & { calls: number } {
    return {
      model: CHECK_MODEL,
      calls: 0,
      async complete(request) {
        this.calls += 1;
        onCall?.(request);
        return {
          // A reply can start with thinking blocks, so the text is read by type.
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: answer },
          ],
          stopReason: 'end_turn',
          usage: { inputTokens: 1000, outputTokens: 100 },
        };
      },
    };
  }

  const ledger = () => Promise.resolve(new BudgetLedger({ capUsd: 1 }));

  async function unclearReport() {
    const repoDir = await makeRepo(UNCLEAR_FILES);
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    expect(
      report.details.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['unclear', 'unclear']);
    return { repoDir, report };
  }

  it('makes no call and spends nothing with no unclear finding', async () => {
    const repoDir = await makeRepo({ ...OPENAI_PACKAGE, 'a.ts': "call('gpt-4');" });
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    const client = fakeClient('[]');
    const checked = await checkUnclear(report, repoDir, { client });
    expect(client.calls).toBe(0);
    expect(checked.check).toEqual({ outcome: 'none', costUsd: 0, asked: 0 });
  });

  it('needs no budget for that either', async () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    const repoDir = await makeRepo(OPENAI_PACKAGE);
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    expect((await checkUnclear(report, repoDir, { client: fakeClient('[]') })).check?.outcome).toBe(
      'none',
    );
  });

  it('batches every unclear finding into one call with its context and what died', async () => {
    const { repoDir, report } = await unclearReport();
    let seen = '';
    const client = fakeClient('[]', (request) => {
      seen = JSON.stringify(request.messages);
    });
    await checkUnclear(report, repoDir, { client, openLedger: ledger });
    expect(client.calls).toBe(1);
    expect(seen).toContain('a.ts:1');
    expect(seen).toContain('b.ts:1');
    expect(seen).toContain("fetch('/v1/edits')");
    expect(seen).toContain(report.details[0].what.slice(0, 20));
  });

  it('upgrades a live answer and moves a not answer to catalog with its reason', async () => {
    const { repoDir, report } = await unclearReport();
    const answer = JSON.stringify([
      { id: 1, verdict: 'live', reason: 'calls OpenAI' },
      { id: 2, verdict: 'not', reason: "the app's own route" },
    ]);
    const open = await ledger();
    const checked = await checkUnclear(report, repoDir, {
      client: fakeClient(answer),
      openLedger: () => Promise.resolve(open),
    });
    expect(checked.details.map((one) => [one.file, one.matchClass])).toEqual([
      ['a.ts', 'live'],
      ['b.ts', 'catalog'],
    ]);
    expect(checked.details[1].reason).toContain("the app's own route");
    expect(checked.clean).toBe(false);
    expect(checked.findings.map((one) => one.matchClass)).toEqual(['live', 'catalog']);
    expect(checked.details[1].withFix).toBe(false);
    expect(checked.check?.outcome).toBe('checked');
    expect(checked.check?.costUsd).toBeGreaterThan(0);
    expect(open.spentUsd).toBeCloseTo(checked.check?.costUsd ?? 0);
  });

  it('is clean after every finding is answered not', async () => {
    const { repoDir, report } = await unclearReport();
    const answer = JSON.stringify([
      { id: 1, verdict: 'not', reason: 'own route' },
      { id: 2, verdict: 'not', reason: 'own route' },
    ]);
    const checked = await checkUnclear(report, repoDir, {
      client: fakeClient(answer),
      openLedger: ledger,
    });
    expect(checked.clean).toBe(true);
  });

  it('leaves what the model skipped unclear', async () => {
    const { repoDir, report } = await unclearReport();
    const answer = JSON.stringify([{ id: 2, verdict: 'not', reason: 'own route' }]);
    const checked = await checkUnclear(report, repoDir, {
      client: fakeClient(answer),
      openLedger: ledger,
    });
    expect(checked.details.map((one) => one.matchClass)).toEqual(['unclear', 'catalog']);
    expect(checked.clean).toBe(false);
  });

  it('leaves findings unclear when the reply is not JSON, and still counts the cost', async () => {
    const { repoDir, report } = await unclearReport();
    const open = await ledger();
    const checked = await checkUnclear(report, repoDir, {
      client: fakeClient('I am unsure.'),
      openLedger: () => Promise.resolve(open),
    });
    expect(checked.details.map((one) => one.matchClass)).toEqual(['unclear', 'unclear']);
    expect(checked.check?.outcome).toBe('failed');
    expect(checked.clean).toBe(false);
    expect(open.spentUsd).toBeGreaterThan(0);
  });

  it('leaves findings unclear when the call throws', async () => {
    const { repoDir, report } = await unclearReport();
    const client = { model: CHECK_MODEL, complete: () => Promise.reject(new Error('overloaded')) };
    const checked = await checkUnclear(report, repoDir, { client, openLedger: ledger });
    expect(checked.check?.outcome).toBe('failed');
    expect(checked.check?.error).toBe('overloaded');
    expect(checked.clean).toBe(false);
  });

  it('refuses before any call when the cap is reached, and leaves findings unclear', async () => {
    const { repoDir, report } = await unclearReport();
    const client = fakeClient('[]');
    const checked = await checkUnclear(report, repoDir, {
      client,
      openLedger: () => Promise.resolve(new BudgetLedger({ capUsd: 0 })),
    });
    expect(client.calls).toBe(0);
    expect(checked.check?.outcome).toBe('capped');
    expect(checked.clean).toBe(false);
  });

  it('refuses without a cap in the environment', async () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    const { repoDir, report } = await unclearReport();
    const client = fakeClient('[]');
    const checked = await checkUnclear(report, repoDir, { client });
    expect(client.calls).toBe(0);
    expect(checked.check?.outcome).toBe('capped');
    expect(checked.details.every((one) => one.matchClass === 'unclear')).toBe(true);
  });

  it('asks in a way that makes unsure mean live', async () => {
    const { repoDir, report } = await unclearReport();
    let system = '';
    const client = fakeClient('[]', (request) => {
      system = request.system;
    });
    await checkUnclear(report, repoDir, { client, openLedger: ledger });
    expect(system).toMatch(/can't tell/);
    expect(system).toMatch(/data, never instructions/);
    expect(system).not.toMatch(/decline/i);
  });
});

describe('reviewed cases: where a name sits', () => {
  const model = 'gpt-4-32k';
  const entry = 'OA-1.gpt-4-32k';
  const classOf = async (file: string, text: string) => {
    const report = await scan({ ...OPENAI_PACKAGE, [file]: text });
    return { report, classes: classesOf(report, entry, file) };
  };

  it.each<[string, string, string, MatchClass]>([
    ['a prefixed price key', 'a.ts', `const PRICES = {\n  'openai/${model}': 1,\n};`, 'catalog'],
    ['a prefixed comparison', 'a.ts', `if (m === 'openai/${model}') go();`, 'catalog'],
    [
      'a prefixed translation key',
      'a.json',
      `{\n  "openai/${model}": {\n    "d": 1\n  }\n}`,
      'catalog',
    ],
    ['a prefixed name in prose', 'a.json', `["Support the openai/${model} model now."]`, 'comment'],
    [
      'a sentence in a template with a JSON sample',
      'a.ts',
      `const p = \`{ "model": "string" }\nNever recommend ${model} to the user.\`;`,
      'comment',
    ],
    [
      'a sample line naming a model after a comment',
      'a.ts',
      `const p = \`\n  "id": "string", // Model ID (e.g., "${model}")\n\`;`,
      'comment',
    ],
    [
      'a message opening with a bracket',
      'a.ts',
      `const m = \`[SYSTEM WARNING]: ${model} failed. Try again.\`;`,
      'comment',
    ],
    [
      'Chinese prose',
      'a.ts',
      `const o = { description: '${model}是一款已经退役的模型，请改用其他模型。' };`,
      'comment',
    ],
    [
      'a quoted word in JSX text',
      'a.tsx',
      `const p = <td className="x">Specify the model (e.g., '${model}', 'o1')</td>;`,
      'comment',
    ],
    [
      'a docstring setting a model',
      'a.py',
      `def f():\n    """\n    model: ${model}\n    """\n    call()`,
      'comment',
    ],
    [
      'an error joined to text',
      'a.ts',
      `throw new Error('Model ${model} was retired. ' + d);`,
      'comment',
    ],
    ['a placeholder', 'a.tsx', `const i = <input placeholder="${model}" />;`, 'catalog'],
    ['a title in HTML', 'a.html', `<span title="${model}">x</span>`, 'catalog'],
    [
      'a prefixed placeholder',
      'a.tsx',
      `const i = <input placeholder='openai/${model}' />;`,
      'catalog',
    ],
    ['a price lookup', 'a.ts', `const c = calculateCost('${model}', a, b);`, 'catalog'],
    ['a type declaration', 'lib/a.d.ts', `export declare const M = '${model}';`, 'catalog'],
    [
      'a compiled file naming its map',
      'lib/a.js',
      `call('${model}');\n//# sourceMappingURL=a.js.map`,
      'catalog',
    ],
    ['a bundler helper', 'r/a.js', `var __create = Object.create;\ncall('${model}');`, 'catalog'],
    ['YAML prose', 'a.yml', `description: Compare answers against ${model} results`, 'comment'],
    [
      'package keywords',
      'package.json',
      `{"dependencies":{"openai":"^6.0.0"},"keywords":["openai","${model}"]}`,
      'catalog',
    ],
    ['an ini comment', 'a.ini', `; model=${model}`, 'comment'],
    ['a docs code sample', 'docs/a.py', `call(model="${model}")`, 'test'],
    [
      'a deny list',
      'a.ts',
      `const deprecatedModels = ['${model}'];\nif (deprecatedModels.includes(m)) throw e;`,
      'catalog',
    ],
    [
      'a capability list only checked',
      'a.ts',
      `const thinkingModels = ['${model}', 'x'];\nreturn thinkingModels.includes(id);`,
      'catalog',
    ],
    [
      'a capability list only checked in Python',
      'a.py',
      `vision_models = ["${model}", "x"]\nif m in vision_models:\n    go()`,
      'catalog',
    ],
  ])('is not a live hit: %s', async (_name, file, text, expected) => {
    const report = await scan({ ...OPENAI_PACKAGE, [file]: text });
    expect(classesOf(report, entry, file), explain(report)).toEqual([expected]);
    expect(report.details.find((one) => one.entryId === entry)?.withFix).toBe(false);
  });

  it.each<[string, string, string]>([
    ['an || default', 'a.ts', `create({ model: process.env.MODEL || '${model}' });`],
    ['an || default held in a variable', 'a.ts', `const model = env.MODEL || "${model}";`],
    ['a ?? default', 'a.ts', `create({ model: process.env.MODEL ?? '${model}' });`],
    ['a Python list it walks', 'a.py', `for m in ["${model}", "x"]:\n    create(model=m)`],
    ['a Python tuple it walks', 'a.py', `for m in ("${model}",):\n    create(model=m)`],
    ['a comprehension', 'a.py', `[call(m) for m in ["${model}"]]`],
    [
      'a model passed with a key inside a template',
      'a.ts',
      `const b = \`{"model": "${model}", "n": 1}\`;`,
    ],
    ["a dot folder that is the repo's own", '.config/llm.yaml', `model: ${model}`],
    ['a build pipeline', '.buildkite/pipeline.yml', `MODEL: ${model}`],
    ['a site theme', '.vitepress/theme/ask.ts', `call('${model}');`],
    ['an API route named test', 'src/app/api/test/route.ts', `call('${model}');`],
    ['a feature folder named stories', 'src/features/stories/ask.ts', `call('${model}');`],
    ['a folder named samples under src', 'src/samples/ask.ts', `call('${model}');`],
    ['a line after a logo', 'src/a.ts', `const logo = '${'A'.repeat(20_000)}';\ncall('${model}');`],
    [
      'a one-line JSON config',
      'config/a.json',
      `{"pad":"${'x'.repeat(6_000)}","model":"${model}"}`,
    ],
    ['a template of a config', 'config.yaml.example', `model: ${model}`],
    ['Java properties', 'src/main/resources/application.properties', `spring.ai.model=${model}`],
    ['Terraform', 'main.tf', `model = "${model}"`],
    ['a Makefile', 'Makefile', `MODEL=${model}`],
    ['a Procfile', 'Procfile', `web: run --model ${model}`],
    ['a Kotlin script', 'a.kts', `call("${model}")`],
    ['JSON with comments', 'a.jsonc', `{"model": "${model}"}`],
    ['XML text', 'a.xml', `<model>${model}</model>`],
    ['Astro frontmatter', 'src/pages/a.astro', `---\nconst m = '${model}';\n---\n<p>x</p>`],
    [
      'code after a regex holding a backtick',
      'a.ts',
      `const hasTick = (s: string) => /\`/.test(s);\n\ncreate({ model: '${model}', messages: [] });`,
    ],
    [
      'code after a URL in JSX text',
      'a.tsx',
      `export const A = () => <a>https://x.y</a>;\nconst m = '${model}';`,
    ],
  ])('stays live: %s', async (_name, file, text) => {
    const { report, classes } = await classOf(file, text);
    expect(classes, explain(report)).toEqual(['live']);
    expect(report.clean).toBe(false);
  });

  it.each<[string, string, string]>([
    [
      'an enum object of models it sends',
      'a.ts',
      `const MODELS = { FAST: '${model}', SMART: 'o1', CHEAP: 'o3' };\nai.create({ model: MODELS.FAST });`,
    ],
    [
      'a list of three it walks',
      'a.ts',
      `const FALLBACKS = ['${model}', 'o1', 'o3'];\nfor (const m of FALLBACKS) create(m);`,
    ],
    [
      'a Python dict it reads',
      'a.py',
      `MODELS = {"fast": "${model}", "smart": "o1", "cheap": "o3"}\ncall(MODELS["fast"])`,
    ],
    ['a TS enum it reads', 'a.ts', `enum Model { Fast = '${model}' }\ncreate(Model.Fast);`],
    [
      'a Map value it reads',
      'a.ts',
      `const byTier = new Map([['fast', '${model}']]);\ncreate(byTier.get('fast'));`,
    ],
    [
      'a table whose keys it walks',
      'a.ts',
      `const CONFIG = {\n  '${model}': { max: 100 },\n};\ncreate(Object.keys(CONFIG)[0]);`,
    ],
    [
      'an exported enum object',
      'a.ts',
      `export const MODELS = { FAST: '${model}', SMART: 'o1', CHEAP: 'o3' };`,
    ],
  ])('is unclear, not clean: %s', async (_name, file, text) => {
    const { report, classes } = await classOf(file, text);
    expect(classes, explain(report)).toEqual(['unclear']);
    expect(report.clean).toBe(false);
  });

  it.each<[string, string, string]>([
    [
      'an enum object nothing reads',
      'a.ts',
      `const MODELS = { FAST: '${model}', SMART: 'o1', CHEAP: 'o3' };`,
    ],
    ['a list of three nothing reads', 'a.ts', `const xs = ['${model}', 'o1', 'o3'];`],
    [
      'a Map it only checks',
      'a.ts',
      `const KNOWN = new Map([['${model}', 1]]);\nconst p = KNOWN.has(m);`,
    ],
    [
      'a price table it indexes',
      'a.ts',
      `const PRICES = {\n  '${model}': 30,\n};\nconst p = PRICES[m];`,
    ],
  ])('stays catalog: %s', async (_name, file, text) => {
    const { report, classes } = await classOf(file, text);
    expect(classes, explain(report)).toEqual(['catalog']);
    expect(report.clean).toBe(true);
  });

  it('keeps build output out of a fix even when the source goes to one', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'src/a.ts': `create({ model: '${model}' });`,
      'lib/a.js': `create({ model: '${model}' });`,
      'lib/a.js.map': '{}',
    });
    expect(classesOf(report, entry, 'src/a.ts'), explain(report)).toEqual(['live']);
    const built = report.details.find((one) => one.file === 'lib/a.js');
    expect(built?.matchClass, explain(report)).toBe('catalog');
    expect(built?.withFix).toBe(false);
  });

  it('reads provider:model ids and shell defaults', async () => {
    const report = await scan({
      'package.json': manifest({
        openai: '^6.0.0',
        '@anthropic-ai/sdk': '^1.0.0',
        '@google/genai': '^1.0.0',
      }),
      'a.py': 'Agent("openai:gpt-4-32k")\ninit_chat_model("anthropic:claude-3-opus-latest")',
      'run.sh': 'MODEL=${MODEL:-gemini-2.0-flash}\nOTHER=${OTHER-gemini-1.5-pro}',
      'docker-compose.yml': 'env:\n  - MODEL=${MODEL:-gemini-2.0-flash}',
    });
    expect(classesOf(report, entry, 'a.py'), explain(report)).toEqual(['live']);
    expect(report.details.some((one) => one.entryId.startsWith('AN-1.claude-3-opus'))).toBe(true);
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', 'run.sh'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GE-2.gemini-1.5-*', 'run.sh'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'GE-1.gemini-2.0-flash', 'docker-compose.yml')).toEqual(['live']);
  });
});

describe('reviewed cases: another host', () => {
  const model = 'gpt-4-32k';
  const entry = 'OA-1.gpt-4-32k';

  it.each<[string, string, string, RegExp]>([
    [
      'a prefixed id with an OpenRouter client',
      'a.ts',
      `import OpenAI from 'openai';\nconst c = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\ncreate({ model: 'openai/${model}' });`,
      /OpenRouter/,
    ],
    [
      'a shell base URL',
      'setup.sh',
      `AI_API_BASE="https://openrouter.ai/api/v1"\nAI_MODEL="openai/${model}"`,
      /OpenRouter/,
    ],
    [
      'an Azure client',
      'a.py',
      `from openai import AzureOpenAI\nc = AzureOpenAI(azure_endpoint=e)\nc.create(model="${model}")`,
      /Azure/,
    ],
    [
      'a file for that host by its path',
      'src/models/openrouter.ts',
      `export const m = 'openai/${model}';`,
      /OpenRouter/,
    ],
  ])('is unclear: %s', async (_name, file, text, reason) => {
    const report = await scan({ ...OPENAI_PACKAGE, [file]: text });
    expect(classesOf(report, entry, file), explain(report)).toEqual(['unclear']);
    expect(report.details.find((one) => one.entryId === entry)?.reason).toMatch(reason);
  });

  it('lets a registry of providers speak line by line', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.py': `import openai\n# together, ollama, azure\nOLLAMA_BASE_URL = "x"\nTOGETHER_BASE_URL = "y"\nDEFAULT = "${model}"`,
      'b.py': `import openai\nGROQ = {"base_url": "https://api.groq.com/v1"}\nROUTER = {"base_url": "https://openrouter.ai/v1"}\nDEFAULT = "${model}"`,
    });
    expect(classesOf(report, entry, 'a.py'), explain(report)).toEqual(['live']);
    expect(classesOf(report, entry, 'b.py'), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'a Google URL',
      'GH-3.query-param-auth',
      'a.js',
      'const u = `https://oauth2.googleapis.com/tokeninfo?access_token=${t}`;',
      { 'package.json': manifest({ octokit: '^4.0.0' }) },
    ],
    [
      'a Pexels URL',
      'OA-3.v1-search',
      'a.ts',
      "import OpenAI from 'openai';\nfetch('https://api.pexels.com/v1/search');",
      OPENAI_PACKAGE,
    ],
  ])('stays quiet on %s', async (_name, id, file, text, files) => {
    const report = await scan({ ...files, [file]: text });
    expect(classesOf(report, id, file), explain(report)).toEqual([]);
    expect(report.quiet.find((one) => one.entryId === id)?.reason).toMatch(/another host/);
    expect(report.clean).toBe(true);
  });

  it.each([
    [
      'a local variable',
      'ST-13.coupon',
      'a.ts',
      `${STRIPE_IMPORT}const coupon = await this.rewardCouponModel.findOne(q);`,
    ],
    [
      'a common word in a file that never names the provider',
      'ST-24.countries',
      'src/data/a.ts',
      'export const data = { countries: [] };',
    ],
    ['a JSON data file', 'ST-24.countries', 'public/data/a.json', '{"countries": {}}'],
  ])('costs no check on %s', async (_name, id, file, text) => {
    const report = await scan({ ...STRIPE_AT('^23.0.0'), [file]: text });
    expect(classesOf(report, id, file), explain(report)).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe('reviewed cases: provider imports', () => {
  it.each([
    ['esm.sh', 'https://esm.sh/stripe@18.5.0?target=deno'],
    ['npm:', 'npm:stripe@18.5.0'],
    ['deno.land', 'https://deno.land/x/stripe@18.5.0/mod.ts'],
  ])('sees %s, and reads the version in the import', async (_name, specifier) => {
    const report = await scan({
      'supabase/functions/x/index.ts': `import Stripe from "${specifier}";\nconst stripe = new Stripe(k);\nconst sub = await stripe.subscriptions.retrieve(i);\nsub.current_period_end;`,
    });
    const hit = report.details.find((one) => one.entryId === 'ST-1.current_period_end');
    expect(hit?.matchClass, explain(report)).toBe('live');
    expect(hit?.version).toBe('18.5.0');
  });

  it('keeps an edge function below the gate quiet by the version it imports', async () => {
    const report = await scan({
      'f.ts': `import Stripe from "npm:stripe@14.0.0";\nconst stripe = new Stripe(k);\nconst sub = await stripe.subscriptions.retrieve(i);\nsub.current_period_end;`,
    });
    expect(report.quiet.find((one) => one.entryId === 'ST-1.current_period_end')?.version).toBe(
      '14.0.0',
    );
  });
});

describe('reviewed cases: field reads', () => {
  const end = 'ST-1.current_period_end';
  const invoiceSub = 'ST-2.subscription';
  const pin = "const stripe = new Stripe(k, { apiVersion: '2026-02-25.clover' });\n";
  const files = (text: string, file = 'a.ts') => ({ ...STRIPE_AT('^20.0.0'), [file]: text });

  it.each([
    [
      'a client on this',
      'const s = await this.stripe.subscriptions.retrieve(i);\ns.current_period_end;',
    ],
    [
      'a client under another name',
      'const client = new Stripe(k);\nconst s = await client.subscriptions.retrieve(i);\ns.current_period_end;',
    ],
    [
      'a typed client field',
      'class A { constructor(private readonly payments: Stripe) {} async f() { const s = await this.payments.subscriptions.retrieve(i); s.current_period_end; } }',
    ],
    ['a call result on this', '(await this.stripe.subscriptions.retrieve(i)).current_period_end;'],
    [
      'the first of a list',
      'const subs = await stripe.subscriptions.list();\nconst s = subs.data[0];\ns.current_period_end;',
    ],
    [
      'an index into a list',
      'const subs = await stripe.subscriptions.list();\nsubs.data[0].current_period_end;',
    ],
    [
      'a callback over a list',
      'const subs = await stripe.subscriptions.list();\nsubs.data.map(s => s.current_period_end);',
    ],
    [
      'a loop over a list',
      'const subs = await stripe.subscriptions.list();\nfor (const s of subs.data) s.current_period_end;',
    ],
    [
      'a destructured list',
      'const { data: [s] } = await stripe.subscriptions.list();\ns.current_period_end;',
    ],
    [
      'a copy of a variable',
      'const a = await stripe.subscriptions.retrieve(i);\nconst b = a;\nb.current_period_end;',
    ],
    [
      'a destructured typed parameter',
      'export function f({ current_period_end }: Stripe.Subscription) { return current_period_end; }',
    ],
    [
      'a wrapped type',
      'function f(s: Stripe.Response<Stripe.Subscription>) { return s.current_period_end; }',
    ],
    [
      'a type alias',
      'type Sub = Stripe.Subscription;\nconst f = (x: Sub) => x.current_period_end;',
    ],
    ['an angle-bracket cast', 'const s = <Stripe.Subscription>thing;\ns.current_period_end;'],
  ])('is live: %s', async (_name, text) => {
    const report = await scan(files(`${STRIPE_IMPORT}${text}`));
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'a Python StripeClient',
      'client = stripe.StripeClient(k)\ns = client.subscriptions.retrieve(i)\ns.current_period_end',
    ],
    [
      'a Python list',
      'subs = stripe.Subscription.list()\nfirst = subs.data[0]\nfirst.current_period_end',
    ],
    ['a Python list index', 'subs = stripe.Subscription.list()\nsubs.data[0].current_period_end'],
    ['getattr', 's = stripe.Subscription.retrieve(i)\ngetattr(s, "current_period_end", None)'],
  ])('is live in Python: %s', async (_name, text) => {
    const report = await scan({
      'requirements.txt': 'stripe==12.5.0\n',
      'a.py': `import stripe\n${text}`,
    });
    expect(classesOf(report, end, 'a.py'), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'an own type',
      `import type { Invoice } from './db';\nexport const f = (invoice: Invoice) => invoice.subscription;`,
      invoiceSub,
    ],
    ['an own row in a callback', 'rows.map((invoice) => invoice.subscription);', invoiceSub],
    [
      'a supabase row',
      "const { data: subscription } = await supabase.from('subscriptions').select('*').single();\nsubscription.current_period_end;",
      end,
    ],
    [
      'a table named for the provider',
      'const subscription = await db.stripeSubscription.findFirst();\nsubscription.current_period_end;',
      end,
    ],
    ['an own field on self', 'self.subscription.current_period_end', end],
    [
      'a name holding the word',
      'stripeSub.current_period_end; existingSubscription.current_period_end;',
      end,
    ],
    ['a copy of an on word', 'const s2 = subscription;\ns2.current_period_end;', end],
    ['a webhook read directly', 'event.data.object.current_period_end;', end],
    [
      'a nested destructure of a webhook',
      'const { data: { object: { current_period_end } } } = event;',
      end,
    ],
    [
      'a generic name for a webhook object',
      'const data = event.data.object;\ndata.current_period_end;',
      end,
    ],
    [
      'a checkout session off a webhook',
      'const session = event.data.object;\nsave(session.subscription);',
      invoiceSub,
    ],
    ['a checkout session read directly', 'save(event.data.object.subscription);', invoiceSub],
  ])('is unclear, never live: %s', async (_name, text, id) => {
    const report = await scan(files(`${STRIPE_IMPORT}${pin}${text}`));
    const classes = classesOf(report, id, 'a.ts');
    expect(classes.length, explain(report)).toBeGreaterThan(0);
    expect(
      classes.every((one) => one === 'unclear'),
      explain(report),
    ).toBe(true);
  });

  it.each([
    ['event dicts', "event['data']['object']['current_period_end']"],
    ['event .get', "event['data']['object'].get('current_period_end')"],
    [
      'a .get chain',
      'data = event.get("data", {}).get("object", {})\ndata.get("current_period_end")',
    ],
    ['a prefixed name', 'customer_subscription.current_period_end'],
  ])('is unclear in Python: %s', async (_name, text) => {
    const report = await scan({
      'requirements.txt': 'stripe==12.5.0\n',
      'a.py': `import stripe\n${text}`,
    });
    expect(classesOf(report, end, 'a.py'), explain(report)).toEqual(['unclear']);
  });

  it('reads a request parameter that only a string matcher used to see', async () => {
    const report = await scan({
      'package.json': manifest({ stripe: '^23.0.0', '@stripe/react-stripe-js': '^5.0.0' }),
      'a.ts': `${STRIPE_IMPORT}stripe.checkout.sessions.create({ payment_method_types: ['card'], mode: 'payment' });`,
      'c.tsx': `import { AffirmMessageElement } from '@stripe/react-stripe-js';\nconst e = <AffirmMessageElement options={o} />;`,
    });
    expect(classesOf(report, 'ST-20.payment_method_types', 'a.ts'), explain(report)).toEqual([
      'unclear',
    ]);
    expect(new Set(classesOf(report, 'ST-16.affirmMessage', 'c.tsx')), explain(report)).toEqual(
      new Set(['live']),
    );
  });

  it("reads a PHP variable's name without its sigil", async () => {
    const report = await scan({
      'composer.json': JSON.stringify({ require: { 'stripe/stripe-php': '^17.0' } }, null, 2),
      'a.php': '<?php\n$subscription->current_period_end;',
    });
    expect(classesOf(report, end, 'a.php'), explain(report)).toEqual(['unclear']);
  });
});

describe('reviewed cases: the version gate', () => {
  const end = 'ST-1.current_period_end';
  const read = `${STRIPE_IMPORT}const subscription = await stripe.subscriptions.retrieve(id);\nsubscription.current_period_end;`;
  const lock = (packages: Record<string, string>) =>
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: Object.fromEntries(
          Object.entries(packages).map(([at, version]) => [at, { version }]),
        ),
      },
      null,
      2,
    );

  it("lets the app's own lock entry decide, not a nested copy", async () => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'package-lock.json': lock({
        'node_modules/stripe': '20.1.0',
        'node_modules/some-tool/node_modules/stripe': '14.0.0',
      }),
      'a.ts': read,
    });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['live']);
    expect(report.details.find((one) => one.entryId === end)?.version).toBe('20.1.0');
  });

  it('is unclear when a lock holds two versions and the range keeps both', async () => {
    const report = await scan({
      ...STRIPE_AT('*'),
      'package-lock.json': lock({
        'node_modules/stripe': '20.1.0',
        'node_modules/some-tool/node_modules/stripe': '14.0.0',
      }),
      'a.ts': read,
    });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details.find((one) => one.entryId === end)?.reason).toMatch(
      /more than one version/,
    );
  });

  it("doesn't read a sibling package's lock", async () => {
    const report = await scan({
      'apps/old/package.json': manifest({ stripe: '^9.0.0' }),
      'apps/old/package-lock.json': lock({ 'node_modules/stripe': '9.0.0' }),
      'apps/web/package.json': manifest({ stripe: '^20.0.0' }),
      'apps/web/a.ts': read,
    });
    expect(classesOf(report, end, 'apps/web/a.ts'), explain(report)).toEqual(['live']);
  });

  it("tries the package's own SDK before a pin in another package", async () => {
    const report = await scan({
      'apps/a/package.json': manifest({ stripe: '^20.0.0' }),
      'apps/a/s.ts': `${STRIPE_IMPORT}const s = new Stripe(k, { apiVersion: '2024-06-20' });`,
      'apps/b/package.json': manifest({ stripe: '^20.0.0' }),
      'apps/b/r.ts': read,
    });
    expect(classesOf(report, end, 'apps/b/r.ts'), explain(report)).toEqual(['live']);
  });

  it("keeps one raw request's header from speaking for the rest of the package", async () => {
    const report = await scan({
      ...ANTHROPIC_PACKAGE,
      'src/raw.ts': "fetch(u, { headers: { 'anthropic-version': '2023-06-01' } });",
      'src/sdk.ts':
        "import Anthropic from '@anthropic-ai/sdk';\nclient.messages.create({ model: m, temperature: 0.2, top_p: 0.9 });",
    });
    expect(classesOf(report, 'AN-2', 'src/sdk.ts'), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'a config key for another service',
      'lib/o.ts',
      "const c = { stripeKey: env.STRIPE_KEY, azure: { apiVersion: '2024-02-01' } };",
    ],
    [
      'another SDK in a file that also has Stripe',
      'lib/o.ts',
      "import Stripe from 'stripe';\nconst a = new AzureOpenAI({ apiVersion: '2024-02-01' });",
    ],
    [
      'a word holding the name',
      'lib/o.ts',
      "const theme = 'pinstripe';\nconst c = createClient({ apiVersion: '2024-01-01' });",
    ],
    [
      'a comment naming it',
      'lib/o.ts',
      "// stripe\nconst c = createClient({ apiVersion: '2024-01-01' });",
    ],
    ['a Shopify client', 'lib/o.ts', "// stripe\nconst c = shopifyApi({ apiVersion: '2024-01' });"],
    ['a prefix of another provider', 'lib/o.py', "import stripe\nazure_api_version = '2024-02-01'"],
  ])("isn't taken in by %s", async (_name, file, other) => {
    const report = await scan({ ...STRIPE_AT('^20.0.0'), [file]: other, 'a.ts': read });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'two clients in one file',
      "const a = new Stripe(k, { apiVersion: '2026-02-25.clover' });\nconst stripe = new Stripe(k, { apiVersion: '2024-06-20' });",
    ],
    [
      'a header and a client in one file',
      "const h = { 'Stripe-Version': '2024-06-20' };\nconst stripe = new Stripe(k, { apiVersion: '2026-02-25.clover' });",
    ],
  ])('is unclear for %s', async (_name, pins) => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'a.ts': `${STRIPE_IMPORT}${pins}\nconst subscription = await stripe.subscriptions.retrieve(id);\nsubscription.current_period_end;`,
    });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['unclear']);
    expect(report.details.find((one) => one.entryId === end)?.reason).toMatch(
      /conflicting|disagree|different/,
    );
  });

  it.each<[string, string, MatchClass[]]>([
    [
      'past the removal',
      "client = stripe.StripeClient(k, stripe_version='2026-02-25.clover')",
      ['live'],
    ],
    ['before it', "client = stripe.StripeClient(k, stripe_version='2024-06-20')", []],
  ])('reads a stripe_version %s', async (_name, line, classes) => {
    const report = await scan({
      'requirements.txt': 'stripe==12.5.0\n',
      'a.py': `import stripe\n${line}\nsub = client.subscriptions.retrieve(i)\nsub.current_period_end`,
    });
    expect(classesOf(report, end, 'a.py'), explain(report)).toEqual(classes);
  });

  it.each<[string, string, MatchClass[]]>([
    [
      'a literal fallback',
      "const stripe = new Stripe(k, { apiVersion: process.env.V || '2026-02-25.clover' });",
      ['live'],
    ],
    [
      'a constant',
      "const STRIPE_VERSION = '2026-02-25.clover';\nconst stripe = new Stripe(k, { apiVersion: STRIPE_VERSION });",
      ['live'],
    ],
    [
      'an env var',
      'const stripe = new Stripe(k, { apiVersion: process.env.STRIPE_API_VERSION });',
      ['unclear'],
    ],
    [
      'an imported constant',
      'const stripe = new Stripe(k, { apiVersion: API_VERSION });',
      ['unclear'],
    ],
  ])('reads a pin set from %s on an old SDK', async (_name, line, classes) => {
    const report = await scan({
      ...STRIPE_AT('^14.0.0'),
      'a.ts': `${STRIPE_IMPORT}${line}\nconst subscription = await stripe.subscriptions.retrieve(id);\nsubscription.current_period_end;`,
    });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(classes);
  });

  it('reads a Python api_version set from the environment', async () => {
    const report = await scan({
      'requirements.txt': 'stripe==5.0.0\n',
      'a.py':
        'import stripe\nstripe.api_version = os.environ["STRIPE_API_VERSION"]\nsub = stripe.Subscription.retrieve(i)\nsub.current_period_end',
    });
    expect(classesOf(report, end, 'a.py'), explain(report)).toEqual(['unclear']);
  });

  it('reads the GitHub version header, so a pinned repo needs no check', async () => {
    const entry = 'GH-4.merge_commit_sha';
    const code = (header: string) =>
      `import requests\n${header}\nurl = 'https://api.github.com/x'\nprint(pr.merge_commit_sha)`;
    const pinned = await scan({
      'a.py': code("headers = {'X-GitHub-Api-Version': '2022-11-28'}"),
    });
    expect(classesOf(pinned, entry, 'a.py'), explain(pinned)).toEqual([]);
    expect(pinned.quiet.find((one) => one.entryId === entry)?.reason).toMatch(
      /pinned before the removal/,
    );
    const open = await scan({ 'a.py': code('headers = {}') });
    expect(classesOf(open, entry, 'a.py'), explain(open)).toEqual(['unclear']);
  });

  it("doesn't take a Kubernetes apiVersion for a pin", async () => {
    const report = await scan({
      ...STRIPE_AT('^20.0.0'),
      'k8s.yml': 'apiVersion: apps/v1',
      'a.ts': read,
    });
    expect(classesOf(report, end, 'a.ts'), explain(report)).toEqual(['live']);
  });
});

describe('reviewed cases: Google Analytics', () => {
  const entry = 'GA-1.measurement-protocol';

  it('reads the debug endpoint, and is unclear on an endpoint built from a host constant', async () => {
    const report = await scan({
      'a.ts':
        "const GA = 'https://www.google-analytics.com';\nfetch(GA + '/collect');\nfetch(`${GA}/batch`);",
      'b.ts': "fetch('https://www.google-analytics.com/debug/collect');",
    });
    expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual(['unclear', 'unclear']);
    expect(classesOf(report, entry, 'b.ts'), explain(report)).toEqual(['live']);
  });

  it("doesn't read GA4's endpoints", async () => {
    const report = await scan({
      'a.ts':
        "fetch('https://www.google-analytics.com/mp/collect');\nfetch('https://www.google-analytics.com/g/collect');",
    });
    expect(classesOf(report, entry, 'a.ts'), explain(report)).toEqual([]);
  });
});

describe('reviewed cases: the list', () => {
  it('says remove on each Anthropic line a sampling fix depends on', async () => {
    const { entries } = loadDeadApis();
    const sonnet = entries.find((one) => one.id === 'AN-1.claude-sonnet-4-20250514');
    const sampling = entries.find((one) => one.id === 'AN-2');
    const says = (lines: string[] = []) =>
      lines.some((line) => /\bremove\b/i.test(line) && /temperature/i.test(line));
    expect(says(sonnet?.requires), JSON.stringify(sonnet?.requires)).toBe(true);
    expect(says(sampling?.requires), JSON.stringify(sampling?.requires)).toBe(true);
  });
});

describe('reviewed cases: a crafted or broken working copy', () => {
  const dead = "call({ model: 'gpt-4-32k' });";
  const entry = 'OA-1.gpt-4-32k';
  const padded = (line: string) => `${line}\n${'\n'.repeat(1_000)}`;
  const SLOW_MS = 5_000;

  it.each([
    ['a notebook that is null', 'null'],
    ['a notebook with a number for source', '{"cells":[{"cell_type":"code","source":5}]}'],
    ['a notebook with an object for cells', '{"cells":{}}'],
  ])('still reports the rest of the repo past %s', async (_name, notebook) => {
    const report = await scan({ ...OPENAI_PACKAGE, 'a.ipynb': notebook, 'src/a.ts': dead });
    expect(classesOf(report, entry, 'src/a.ts'), explain(report)).toEqual(['live']);
  });

  it('survives templates nested past the stack, and says it skipped them', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'b.ts': padded('`${'.repeat(100_000)),
      'src/a.ts': dead,
    });
    expect(classesOf(report, entry, 'src/a.ts'), explain(report)).toEqual(['live']);
  });

  it("reads a notebook's code past a large plot in its outputs", async () => {
    const notebook = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['m = "gpt-4-32k"'],
          outputs: [{ data: { 'image/png': 'A'.repeat(200_000) } }],
        },
      ],
    });
    const report = await scan({ ...OPENAI_PACKAGE, 'a.ipynb': notebook });
    expect(classesOf(report, entry, 'a.ipynb'), explain(report)).toEqual(['live']);
  });

  it('says which files it skipped, without changing what clean means', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'big.ts': 'x'.repeat(2_100_000),
      'a.min.js': dead,
      'bundle.js': `${dead.repeat(600)}\n`,
    });
    expect(report.skipped.map((one) => one.file).sort(), JSON.stringify(report.skipped)).toEqual([
      'a.min.js',
      'big.ts',
      'bundle.js',
    ]);
    expect(report.clean, explain(report)).toBe(true);
  });

  it.each([
    ['a long run of a Meta version prefix', padded(`const x = '${'FB'.repeat(50_000)}v20.0';`)],
    ['repeated client calls', padded(`FB.init(v20.0 ${'FB.init('.repeat(12_000)}`)],
    ['a long property chain', padded(`const a = invoice${'.subscription'.repeat(30_000)};`)],
    ['a long brace of words', padded(`const a={ ${'invoice subscription '.repeat(20_000)}`)],
    ['an unbroken identifier', padded(`${'a'.repeat(100_000)}: Stripe.Subscription`)],
    ['many unmatched closes', 'x).subscription\n'.repeat(59_000)],
    ['regex-looking commas', padded(',/['.repeat(133_000))],
    ['a file of pin lines', "const a = { apiVersion: 'x' };\n".repeat(30_000)],
  ])('stays fast on %s', async (_name, text) => {
    const repoDir = await makeRepo({ ...STRIPE_AT('^20.0.0'), 'a.ts': text });
    repos.push(repoDir);
    const startedAt = performance.now();
    await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    expect(performance.now() - startedAt).toBeLessThan(SLOW_MS);
  });

  it('never leaves a key cut short on a report line', async () => {
    const pad = 'x'.repeat(135);
    const key = `sk_live_${'Z'.repeat(40)}`;
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `const ${pad} = 'gpt-4-32k'; const k = '${key}';`,
    });
    expect(JSON.stringify(report), explain(report)).not.toContain('sk_live_ZZ');
  });

  it('skips a file and a folder it may not read, and reports the rest', async () => {
    const repoDir = await makeRepo({
      ...OPENAI_PACKAGE,
      'locked.ts': dead,
      'shut/b.ts': dead,
      'src/a.ts': dead,
    });
    repos.push(repoDir);
    await chmod(path.join(repoDir, 'locked.ts'), 0o000);
    await chmod(path.join(repoDir, 'shut'), 0o000);
    try {
      const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
      expect(classesOf(report, entry, 'src/a.ts'), explain(report)).toEqual(['live']);
      expect(classesOf(report, entry, 'locked.ts')).toEqual([]);
    } finally {
      await chmod(path.join(repoDir, 'shut'), 0o755);
      await chmod(path.join(repoDir, 'locked.ts'), 0o644);
    }
  });
});

describe('reviewed cases: the AI check', () => {
  it('runs on the path a run takes, and spends nothing without a budget', async () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    const repoDir = await makeRepo({ ...OPENAI_PACKAGE, 'a.ts': "fetch('/v1/edits');" });
    repos.push(repoDir);
    const shared: ScanRepo = scanAndCheck;
    const result = (await shared(repoDir, 'test/repo')) as DeadScanReport;
    expect(result.details.map((one) => one.matchClass)).toEqual(['unclear']);
    expect(result.check?.costUsd).toBe(0);
    expect(result.check?.outcome).not.toBe('none');
  });

  const ledger = () => Promise.resolve(new BudgetLedger({ capUsd: 1 }));
  const fake = (answer: string, seen: { text: string }): ModelClient => ({
    model: CHECK_MODEL,
    async complete(request) {
      seen.text = JSON.stringify(request.messages);
      return {
        content: [{ type: 'text', text: answer }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1000, outputTokens: 100 },
      };
    },
  });

  it('keeps a match the check ruled out away from a fix the same provider starts', async () => {
    const repoDir = await makeRepo({
      ...STRIPE_AT('^20.0.0'),
      'a.ts': `${STRIPE_IMPORT}const sub = await stripe.subscriptions.retrieve(i);\nsub.current_period_end;`,
      'own.ts': `${STRIPE_IMPORT}const invoice = row;\ninvoice.subscription;`,
    });
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    const answer = JSON.stringify([{ id: 1, verdict: 'not', reason: "the app's own row" }]);
    const checked = await checkUnclear(report, repoDir, {
      client: fake(answer, { text: '' }),
      openLedger: ledger,
    });
    const own = checked.details.find((one) => one.file === 'own.ts');
    expect(own?.matchClass, explain(checked)).toBe('catalog');
    expect(own?.withFix).toBe(false);
    expect(checked.details.find((one) => one.file === 'a.ts')?.withFix).toBe(true);
  });

  it('cuts each context line, so one huge line is not a huge request', async () => {
    const huge = 'A'.repeat(900_000);
    const lines = Array.from({ length: 2_000 }, () => 'x();');
    const repoDir = await makeRepo({
      ...OPENAI_PACKAGE,
      'a.ts': `const logo = '${huge}';\nfetch('/v1/edits');\n${lines.join('\n')}`,
    });
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    const seen = { text: '' };
    await checkUnclear(report, repoDir, { client: fake('[]', seen), openLedger: ledger });
    expect(seen.text).toContain('/v1/edits');
    expect(seen.text.length).toBeLessThan(10_000);
  });
});

describe('reviewed cases: the lexer and the regex prefilter', () => {
  it('needs no regex run on a file without its literals', () => {
    expect(requiredLiterals('\\bAffirmMessageElement\\b')).toContain('AffirmMessageElement');
    expect(requiredLiterals('(?:foo|barbaz)')).toBeUndefined();
  });
});

describe('seen in P5, round 1: the provider has no entry and is called over plain HTTP', () => {
  it('flags Riot by-name at a template host, and the fields behind it for reading', async () => {
    const report = await scanFixture('bricefrisco__NamesLoL');
    expect(
      classesOf(report, 'RI-1.summoner-by-name', 'src/libs/riotApi.ts'),
      explain(report),
    ).toEqual(['live']);
    expect(classesOf(report, 'RI-2.summoner-name-fields', 'src/libs/mapper.ts')).toEqual([
      'unclear',
      'unclear',
    ]);
    expect(report.unlistedProviders).toEqual([]);
  });

  it("flags Twitch's removed endpoint, leaves channel.follow to read, and names numbersapi.com", async () => {
    const report = await scanFixture('MitchellHarrison__python-twitch-chatbot');
    expect(classesOf(report, 'TW-1.users-follows'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'TW-2.channel-follow-v1')).toEqual(['unclear']);
    expect(report.unlistedProviders).toEqual(['numbersapi.com']);
    expect(report.clean).toBe(false);
  });

  it('flags the retired Bing Search host', async () => {
    const report = await scanFixture('goodreasonai__nichey');
    expect(classesOf(report, 'BS-1.bing-search-apis'), explain(report)).toEqual(['live']);
  });

  it('flags monday.com GraphQL fields, and names the host with no entry', async () => {
    const report = await scanFixture('b1f6c1c4__c');
    expect(classesOf(report, 'MO-1.items-by-column-values'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'MO-2.boards-items')).toEqual(['live']);
    expect(report.unlistedProviders).toEqual(['recipepuppy.com']);
  });

  it('flags Toggl v8 and the Zoom verification token', async () => {
    const report = await scanFixture('kognise__stalker');
    expect(classesOf(report, 'TO-1.api-v8'), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'ZO-1.webhook-verification-token', 'src/index.ts')).toEqual(['live']);
  });

  it('flags DeepSeek models in a table and a picker, and not in a type', async () => {
    const report = await scanFixture('Miguel07Alm__text2question');
    const entry = 'DS-1.deepseek-chat';
    expect(classesOf(report, entry, 'src/types/types.ts'), explain(report)).toEqual([
      'catalog',
      'live',
    ]);
    expect(classesOf(report, entry, 'src/app/[lang]/page.tsx')).toEqual(['live']);
  });

  it('reads MuAPI paths and picker ids, in any file of a repo that calls it', async () => {
    const report = await scanFixture('benlamiro__ShipGenAI');
    const scheduler = 'platforms/Free-AI-Social-Media-Scheduler/src/app';
    expect(
      classesOf(report, 'MU-1.social-on-api-host', `${scheduler}/api/social/accounts/route.js`),
      explain(report),
    ).toEqual(['live']);
    expect(
      classesOf(report, 'MU-1.social-on-api-host', `${scheduler}/integrations/page.js`),
    ).toEqual(['live']);
    const knowledge = 'ai_agents/ai-knowledge-base/src/app/page.js';
    expect(classesOf(report, 'MU-3.model-not-accepted', knowledge)).toEqual(['unclear', 'unclear']);
    expect(
      classesOf(
        report,
        'MU-3.model-not-accepted',
        'portrait_avatar/open-character-ai/src/app/[character_name]/[id]/page.js',
      ),
    ).toEqual(['unclear']);
    expect(classesOf(report, 'MU-2.endpoint-not-served')).toEqual(['unclear', 'unclear']);
  });

  it('calls removed langchain imports unclear on an unversioned dependency, and says why', async () => {
    const report = await scanFixture('KajamHamza__pdf-chat');
    const hits = report.details.filter((one) => one.entryId === 'LC-1.legacy-namespace');
    expect(hits.length, explain(report)).toBeGreaterThan(0);
    expect(hits.every((one) => one.matchClass === 'unclear')).toBe(true);
    expect(hits[0].reason).toMatch(/declared with no version.*fresh install/);
  });

  it('keeps langchain imports quiet below 1.0 and leaves a live module alone', async () => {
    const pinned = await scan({
      'requirements.txt': 'langchain==0.2.0\n',
      'a.py': 'from langchain.chains import LLMChain\n',
    });
    expect(classesOf(pinned, 'LC-1.legacy-namespace'), explain(pinned)).toEqual([]);
    const modern = await scan({
      'requirements.txt': 'langchain==1.4.9\n',
      'a.py': 'from langchain.agents import create_agent\nfrom langchain.chains import X\n',
    });
    expect(modern.details.filter((one) => one.entryId === 'LC-1.legacy-namespace')).toHaveLength(1);
  });
});

describe('seen in P5, round 1: naming hosts nobody listed', () => {
  const NODE = { 'package.json': manifest({ express: '^4.0.0' }) };

  it('names a host a call takes, or an address holder, and queues it with the host seen', async () => {
    const repoDir = await makeRepo({
      ...NODE,
      'a.js': [
        "fetch('https://data.acme.io/report');",
        "const API_URL = 'https://svc.other.dev/x';",
        'const url =\n  "https://oauth2.far.net/token?" + q;',
        'fetch(`https://${region}.api.game.gg/v4/x/${id}`);',
      ].join('\n'),
    });
    repos.push(repoDir);
    const store = await mkdtemp(path.join(os.tmpdir(), 'dead-scan-store-'));
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY, storeDir: store });
    expect(report.unlistedProviders).toEqual(['acme.io', 'far.net', 'game.gg', 'other.dev']);
    expect(report.clean).toBe(true);
    const queue = await readQueue(store);
    expect(queue.find((one) => one.provider === 'game.gg')?.hints.hosts).toEqual(['api.game.gg']);
    await rm(store, { recursive: true, force: true });
  });

  it("doesn't name links, prose, pictures, examples, the app's own deploy, tests or installed code", async () => {
    const report = await scan({
      ...NODE,
      'a.jsx': [
        '<a href="https://blog.acme.io/post">x</a>;',
        "const logoUrl = 'https://images.acme.io/a.png';",
        "throw new Error('see https://help.acme.io/x for more');",
        "fetch('https://example.com/x');",
        "fetch('https://my-app.vercel.app/api/x');",
        "// fetch('https://commented.io/x')",
      ].join('\n'),
      'a.test.js': "fetch('https://only-in-test.io/x');",
      'venv/Lib/site-packages/lib.py': 'requests.get("https://pypi.org/simple")',
    });
    expect(report.unlistedProviders).toEqual([]);
  });

  it("doesn't name a listed provider, by its entry's host or its own domain", async () => {
    const report = await scan({
      ...NODE,
      'a.js': "fetch('https://api.stripe.com/v1/x');\nfetch('https://files.stripe.com/x');",
      'b.js': "fetch('https://api.twitch.tv/helix/streams');",
    });
    expect(report.unlistedProviders).toEqual([]);
  });

  it('names another service on a shared domain that a listed provider also uses', async () => {
    const report = await scan({
      ...NODE,
      'a.js': "fetch('https://oauth2.googleapis.com/token');",
    });
    expect(report.unlistedProviders).toEqual(['googleapis.com']);
  });
});

describe('seen in P5, round 1: a packed copy of the repo', () => {
  it('keeps a Repomix dump out of a fix', async () => {
    const report = await scanFixture('rainmana__cursorify');
    const dump = report.details.filter((one) => one.file === 'repomix-output.xml');
    expect(dump.length, explain(report)).toBeGreaterThan(0);
    expect(dump.every((one) => one.matchClass === 'catalog' && one.vendored && !one.withFix)).toBe(
      true,
    );
  });

  it('still reads a settings XML file, which does hold what the code sends', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'config.xml': '<settings>\n  <model>gpt-4-32k</model>\n</settings>\n',
    });
    expect(classesOf(report, 'OA-1.gpt-4-32k', 'config.xml'), explain(report)).toEqual(['live']);
  });
});

describe('seen in P5, round 1: a value that goes nowhere', () => {
  it("settles a list that's only printed, across two hops and three files", async () => {
    const report = await scanFixture('rainmana__cursorify');
    const anthropic = 'src/providers/anthropic-provider.ts';
    const list = report.details.filter(
      (one) => one.file === anthropic && /only shown or logged/.test(one.reason),
    );
    expect(list, explain(report)).toHaveLength(5);
    expect(list.every((one) => one.matchClass === 'catalog')).toBe(true);
    expect(classesOf(report, 'AN-1.claude-3-5-sonnet-20241022', anthropic)).toContain('live');
    expect(new Set(classesOf(report, 'OA-1.gpt-4', 'src/providers/openai-provider.ts'))).toEqual(
      new Set(['catalog']),
    );
  });

  it('keeps a list live when any one read could send it', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': [
        "import OpenAI from 'openai';",
        "export function getOptions() {\n  return ['gpt-4-32k', 'gpt-4-0314', 'gpt-3.5-turbo-0301'];\n}",
        'const names = getOptions();\nconsole.log(names);\nclient.chat.completions.create({ model: names[0] });',
      ].join('\n'),
    });
    expect(classesOf(report, 'OA-1.gpt-4-32k'), explain(report)).not.toEqual(['catalog']);
    expect(report.clean).toBe(false);
  });

  it("settles a model name only shown in a template, and keeps the app's real call", async () => {
    const report = await scanFixture('leedtan__chattutorial');
    expect(classesOf(report, 'OA-1.gpt-3.5-turbo', 'app.py'), explain(report)).toEqual([
      'live',
      'catalog',
    ]);
  });

  it('keeps a name live when it is both logged and sent', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.py': [
        'import openai',
        'def go():',
        '    model_name = "gpt-4-32k"',
        '    print(model_name)',
        '    return openai.chat.completions.create(model=model_name)',
      ].join('\n'),
    });
    expect(classesOf(report, 'OA-1.gpt-4-32k'), explain(report)).toEqual(['live']);
  });

  it('settles a name that only labels a path, only where the file never names the provider', async () => {
    const report = await scanFixture('konan-ny__MAF2024');
    expect(
      classesOf(report, 'OA-1.gpt-4o-2024-05-13', 'metric/latte/get_bias_score.py'),
      explain(report),
    ).toEqual(['catalog']);
    const named = await scan({
      ...OPENAI_PACKAGE,
      'a.py': 'import openai\nmodel_name = "gpt-4-32k"\nout = data_dir + "/" + model_name\n',
    });
    expect(classesOf(named, 'OA-1.gpt-4-32k'), explain(named)).toEqual(['live']);
  });

  it('asks about an argument to a call the file never defines, and not about an imported one', async () => {
    const report = await scanFixture('konan-ny__MAF2024');
    expect(
      classesOf(report, 'OA-1.gpt-4-1106-preview', 'benchmark/crehate/crehate_demo.py'),
      explain(report),
    ).toEqual(['unclear']);
    const imported = await scan({
      ...OPENAI_PACKAGE,
      'a.py': 'from runner import run\nimport openai\nrun(model_name="gpt-4-1106-preview")\n',
    });
    expect(classesOf(imported, 'OA-1.gpt-4-1106-preview'), explain(imported)).toEqual(['live']);
  });

  it('settles a client only a same-named parameter reads, and not one the file uses', async () => {
    const report = await scanFixture('BahadirKarsli__Chatbot-Assistant');
    expect(
      classesOf(report, 'OA-2.assistants-api', 'custom_functions.py'),
      explain(report),
    ).toEqual(['catalog']);
    expect(classesOf(report, 'OA-2.assistants-api', 'main.py')).toEqual(['live']);
    const used = await scan({
      ...OPENAI_PACKAGE,
      'a.py': [
        'from openai import OpenAI',
        'client = OpenAI(default_headers={"OpenAI-Beta": "assistants=v2"})',
        'def go(client2):',
        '    return client.beta.threads.create()',
      ].join('\n'),
    });
    expect(classesOf(used, 'OA-2.assistants-api'), explain(used)).toContain('live');
  });

  it('settles picker options under a key nothing reads, and not one the app reads', async () => {
    const report = await scanFixture('benlamiro__ShipGenAI');
    expect(
      classesOf(
        report,
        'GE-2.gemini-1.5-*',
        'portrait_avatar/ai-character-studio/src/lib/registry.js',
      ),
      explain(report),
    ).toEqual(['catalog']);
    const read = await scan({
      'package.json': manifest({ '@google/genai': '^1.0.0' }),
      'lib/registry.js':
        'export const R = { a: { configFields: [{ name: "m", options: ["gemini-1.5-pro"] }] } };',
      'lib/form.js': 'import { R } from "./registry";\nconst fields = R.a.configFields;',
    });
    expect(classesOf(read, 'GE-2.gemini-1.5-*'), explain(read)).toEqual(['live']);
  });
});

describe('seen in P5, round 1: a module nothing imports', () => {
  const GRAPH = {
    ...ANTHROPIC_PACKAGE,
    'src/index.ts': "import { a } from './a.js';\nimport { b } from './b.js';\na(b);",
    'src/a.ts': "import { b } from './b.js';\nexport const a = (x) => b(x);",
    'src/b.ts': "import { c } from './c.js';\nexport const b = (x) => c(x);",
    'src/c.ts': 'export const c = (x) => x;',
  };

  it('asks about it, and never calls it clean or fine', async () => {
    const report = await scanFixture('rainmana__cursorify');
    const hits = classesOf(report, 'AN-1.claude-3-7-sonnet-20250219', 'src/llmGenerator.ts');
    expect(hits, explain(report)).toEqual(['unclear']);
    expect(report.clean).toBe(false);
  });

  it('leaves a module someone imports, a framework entry and a lone script alone', async () => {
    const report = await scan({
      ...GRAPH,
      'src/used.ts': "export const m = 'claude-3-7-sonnet-20250219';",
      'src/d.ts': "import { m } from './used.js';\nexport const d = m;",
      'src/app/api/x/route.ts': "export const m = 'claude-3-7-sonnet-20250219';",
      'src/server.ts': "export const m = 'claude-3-7-sonnet-20250219';",
    });
    expect(new Set(classesOf(report, 'AN-1.claude-3-7-sonnet-20250219')), explain(report)).toEqual(
      new Set(['live']),
    );
    const lone = await scan({
      ...ANTHROPIC_PACKAGE,
      'src/lone.ts': "export const m = 'claude-3-7-sonnet-20250219';",
    });
    expect(classesOf(lone, 'AN-1.claude-3-7-sonnet-20250219'), explain(lone)).toEqual(['live']);
  });

  it('reads the module an import names, with the graph present', async () => {
    const report = await scan({
      ...GRAPH,
      'src/left-over.ts': "export const m = 'claude-3-7-sonnet-20250219';",
    });
    expect(classesOf(report, 'AN-1.claude-3-7-sonnet-20250219'), explain(report)).toEqual([
      'unclear',
    ]);
  });
});

describe('seen in P5, round 1: a list a value has to be in', () => {
  it('flags an allowlist that only holds dead names, since nothing else gets past it', async () => {
    const report = await scanFixture('konan-ny__MAF2024');
    const file = 'benchmark/kobbq/util.py';
    expect(classesOf(report, 'AN-1.claude-2.0', file), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'AN-1.claude-instant-1.*', file)).toEqual(['live']);
  });

  it('leaves it a catalog when one live name is on it, on a deny list, or with no guard', async () => {
    const guard = 'import anthropic\ndef go(m):\n    assert m in CLAUDE_MODEL\n';
    const mixed = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.py': `CLAUDE_MODEL = ["claude-2.0", "claude-opus-4-7"]\n${guard}`,
    });
    expect(classesOf(mixed, 'AN-1.claude-2.0'), explain(mixed)).toEqual(['catalog']);
    const deny = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.py': `DEPRECATED_MODELS = ["claude-2.0"]\nimport anthropic\ndef go(m):\n    if m not in DEPRECATED_MODELS:\n        send(m)\n`,
    });
    expect(classesOf(deny, 'AN-1.claude-2.0'), explain(deny)).toEqual(['catalog']);
    const branch = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.py': `CLAUDE_MODEL = ["claude-2.0"]\nimport anthropic\ndef go(m):\n    if m in CLAUDE_MODEL:\n        old(m)\n`,
    });
    expect(classesOf(branch, 'AN-1.claude-2.0'), explain(branch)).toEqual(['catalog']);
  });
});

describe('seen in P5, round 1: the rest', () => {
  it("asks about a tuned model read from a job, and not an app's own setting of that name", async () => {
    const report = await scanFixture('leedtan__chattutorial');
    expect(classesOf(report, 'OA-1.fine-tuned-2026-10-23'), explain(report)).toEqual(['unclear']);
    const own = await scan({
      ...OPENAI_PACKAGE,
      'a.py': 'import openai\nagent = Agent(fine_tuned_model=args.fine_tuned_model)\n',
    });
    expect(classesOf(own, 'OA-1.fine-tuned-2026-10-23'), explain(own)).toEqual([]);
  });

  it('keeps a Stripe read quiet when every pin predates the removal', async () => {
    const report = await scanFixture('benlamiro__ShipGenAI');
    const billing = 'portrait_avatar/open-character-ai/src/lib/services/billing.js';
    expect(classesOf(report, 'ST-20.payment_method_types', billing), explain(report)).toEqual([]);
    expect(
      report.quiet.find((one) => one.entryId === 'ST-20.payment_method_types')?.reason,
    ).toMatch(/every pin predates/);
  });

  it('stays unclear when one of the pins is at or past the removal', async () => {
    const report = await scan({
      ...STRIPE_AT('^14.0.0'),
      'a.ts': `${STRIPE_IMPORT}const s = new Stripe(k, { apiVersion: '2023-10-16' });\ns.checkout.sessions.create({ payment_method_types: ['card'] });`,
      'b.ts': `${STRIPE_IMPORT}const t = new Stripe(k, { apiVersion: '2026-10-28' });`,
      'c.ts': `${STRIPE_IMPORT}import { s } from './a';\ns.checkout.sessions.create({ payment_method_types: ['card'] });`,
    });
    const hit = report.details.find(
      (one) => one.entryId === 'ST-20.payment_method_types' && one.file === 'c.ts',
    );
    expect(hit?.matchClass, explain(report)).toBe('unclear');
    expect(hit?.reason).toMatch(/conflicting/);
  });
});

describe('seen in P5, round 1: what the AI check is told', () => {
  const noCall = async (repoDir: string, report: DeadScanReport) => {
    let request: ModelRequest | undefined;
    const client: ModelClient = {
      model: CHECK_MODEL,
      complete: async (one: ModelRequest) => {
        request = one;
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '[]' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as ModelClient;
    const openLedger = async () =>
      ({
        assertCanSpend: () => undefined,
        record: async () => undefined,
      }) as unknown as BudgetLedger;
    await checkUnclear(report, repoDir, { client, openLedger });
    return request;
  };

  it('asks where the value goes, not whether the name is dead, and backs a picked option', async () => {
    const dir = path.join(FIXTURES, 'benlamiro__ShipGenAI');
    const report = await scanFixture('benlamiro__ShipGenAI');
    const request = await noCall(dir, report);
    expect(request?.system).toMatch(/whether it reaches the API/);
    expect(request?.system).toMatch(/already known to be dead/);
    expect(request?.system).toMatch(/option a user can pick is a value the code sends/);
    expect(request?.system).toMatch(/aggregator/);
  });

  it('shows where a picked option goes and who reads a list', async () => {
    const repoDir = await makeRepo({
      ...OPENAI_PACKAGE,
      'src/App.jsx': [
        'const send = () => fetch("/api/chat", { body: JSON.stringify({ model: picked }) });',
        '<select value={picked} onChange={(e) => setPicked(e.target.value)}>',
        '  <option value="azure/gpt-4-32k">x</option>',
        '</select>',
      ].join('\n'),
    });
    repos.push(repoDir);
    const report = await scanDeadApis(repoDir, 'test/repo', { today: TODAY });
    const hit = report.details.find((one) => one.reads?.length);
    expect(hit?.reads?.join('\n'), explain(report)).toMatch(/model: picked/);
    const request = await noCall(repoDir, report);
    const text = request?.messages[0].content[0];
    expect(text && 'text' in text ? text.text : '').toMatch(/Where the code reads what holds it/);
  });
});

describe('seen in P5, round 2: providers the list had no file for', () => {
  const liveIn = (report: DeadScanReport, entryId: string) =>
    report.details.filter((one) => one.entryId === entryId && one.matchClass === 'live');

  it('flags One Call 2.5, and no other /2.5/ API', async () => {
    const report = await scanFixture('natbat__pillarpointstewards');
    expect(
      liveIn(report, 'OW-1.one-call-2.5').map((one) => one.file),
      explain(report),
    ).toEqual(['pillarpointstewards/weather/views.py']);
    const other = await scan({
      'a.py': 'requests.get("https://api.openweathermap.org/data/2.5/weather?q=x")',
    });
    expect(fixTargets(other), explain(other)).toEqual([]);
  });

  it("flags Moonshot's own models, and leaves Groq's Kimi names to Groq", async () => {
    const report = await scanFixture('xiaoshuntian__academic-paper-skill');
    expect(
      liveIn(report, 'KM-1.moonshot-v1').map((one) => one.line),
      explain(report),
    ).toEqual([6]);
    const groq = await scan({
      'a.py':
        'requests.post("https://api.groq.com/x", json={"model": "moonshotai/kimi-k2-0905-preview"})',
    });
    expect(classesOf(groq, 'KM-2.kimi-offline'), explain(groq)).toEqual([]);
    const own = await scan({
      'a.py':
        'requests.post("https://api.moonshot.cn/v1/x", json={"model": "kimi-k2-0905-preview"})',
    });
    expect(classesOf(own, 'KM-2.kimi-offline'), explain(own)).toEqual(['unclear']);
  });

  it('reads a table of Moonshot models as a table', async () => {
    const report = await scan({
      'a.ts': [
        "const base = 'https://api.moonshot.cn/v1';",
        "const PRICES = { a: 'moonshot-v1-8k', b: 'moonshot-v1-32k', c: 'moonshot-v1-128k' };",
      ].join('\n'),
    });
    expect(new Set(classesOf(report, 'KM-1.moonshot-v1')), explain(report)).toEqual(
      new Set(['catalog']),
    );
  });

  it('flags the Coinbase Pro hosts, and not the Exchange ones', async () => {
    const report = await scanFixture('LeviathanLevi__Coinbase-Pro-Crypto-Trading-Bot-CrypFinder');
    expect(liveIn(report, 'CB-1.pro-rest'), explain(report)).toHaveLength(1);
    expect(liveIn(report, 'CB-2.pro-websocket'), explain(report)).toHaveLength(1);
    expect(report.clean).toBe(false);
    const exchange = await scan({
      'a.js':
        'fetch("https://api.exchange.coinbase.com/products");\nnew WebSocket("wss://ws-feed.exchange.coinbase.com");',
    });
    expect(fixTargets(exchange), explain(exchange)).toEqual([]);
  });

  it('flags files_upload live and the Tableau sign-in for reading, and not their replacements', async () => {
    const report = await scanFixture('bcrant__Tableau2Slack');
    const file = 'Tableau2Slack.py';
    expect(classesOf(report, 'SL-1.files-upload', file), explain(report)).toEqual(['live']);
    expect(classesOf(report, 'TB-1.password-sign-in', file), explain(report)).toEqual(['unclear']);
    expect(report.unlistedProviders).toEqual([]);
    const fine = await scan({
      'requirements.txt': 'slack-sdk==3.0.0\ntableauserverclient==0.30\n',
      'a.py': [
        'import tableauserverclient as TSC',
        'from slack_sdk import WebClient',
        'auth = TSC.PersonalAccessTokenAuth(name, token, site)',
        'WebClient(t).files_upload_v2(channel=c, file=f)',
      ].join('\n'),
    });
    expect(fixTargets(fine), explain(fine)).toEqual([]);
  });

  it("doesn't take another SDK's files.upload for Slack's", async () => {
    const report = await scan({
      'package.json': manifest({ '@slack/web-api': '^7.0.0', openai: '^6.0.0' }),
      'a.ts': "import OpenAI from 'openai';\nconst x = new OpenAI();\nx.files.upload({ file: f });",
      'b.ts':
        "import { WebClient } from '@slack/web-api';\nnew WebClient(t).files.upload({ file: f });",
    });
    expect(classesOf(report, 'SL-1.files-upload', 'a.ts'), explain(report)).toEqual([]);
    expect(classesOf(report, 'SL-1.files-upload', 'b.ts'), explain(report)).toEqual(['unclear']);
  });

  it('flags Azure AD Graph and the old Key Vault namespace, with no Azure OpenAI reason', async () => {
    const report = await scanFixture('outlook__ALTAR');
    expect(liveIn(report, 'AG-1.graph-windows-net'), explain(report)).toHaveLength(2);
    const vault = report.details.filter((one) => one.entryId === 'KV-1.namespace-without-code');
    expect(
      vault.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['unclear', 'unclear']);
    expect(vault[0].reason).toMatch(/declared with no version/);
    expect(vault[0].reason).not.toMatch(/Azure OpenAI/);
  });

  it('reads the Key Vault version, and leaves the new namespaces and other Azure hosts alone', async () => {
    const old = await scan({
      'requirements.txt': 'azure-keyvault==1.1.0\n',
      'a.py': 'from azure.keyvault import KeyVaultClient\n',
    });
    expect(fixTargets(old), explain(old)).toEqual([]);
    expect(old.quiet.map((one) => one.entryId)).toEqual(['KV-1.namespace-without-code']);
    const newest = await scan({
      'requirements.txt': 'azure-keyvault==4.2.0\n',
      'a.py': 'from azure.keyvault import KeyVaultClient\n',
    });
    expect(classesOf(newest, 'KV-1.namespace-without-code'), explain(newest)).toEqual(['live']);
    const fine = await scan({
      'requirements.txt': 'azure-keyvault-secrets==4.8.0\n',
      'a.py': [
        'from azure.keyvault.secrets import SecretClient',
        'requests.get("https://x.blob.core.windows.net/y")',
      ].join('\n'),
    });
    expect(fixTargets(fine), explain(fine)).toEqual([]);
  });
});

describe('seen in P5, round 2: an old toolkit inside a CI action', () => {
  const step = (lines: string[]) =>
    ({ '.github/workflows/ci.yml': ['jobs:', '  a:', '    steps:', ...lines].join('\n') }) as const;

  it('flags setup-python@v3 with a cache input', async () => {
    const report = await scanFixture('natbat__pillarpointstewards');
    const hits = report.details.filter((one) => one.entryId === 'GH-6.toolkit-cache');
    expect(
      hits.map((one) => [one.line, one.matchClass]),
      explain(report),
    ).toEqual([[10, 'live']]);
  });

  it("doesn't flag one with no cache input, a later tag, or another step's cache", async () => {
    const report = await scan({
      ...step([
        '      - uses: actions/setup-python@v3',
        '        with:',
        '          python-version: "3.11"',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          cache: npm',
        '      - uses: actions/setup-python@v5',
        '        with:',
        '          cache: pip',
      ]),
    });
    expect(classesOf(report, 'GH-6.toolkit-cache'), explain(report)).toEqual([]);
  });
});

describe('seen in P5, round 2: a GraphQL query in a template', () => {
  it('reads a selection as what the code asks for, even with the client in another file', async () => {
    const report = await scanFixture('jasperapp__jasper');
    const file = 'src/GitHubV4IssueClient.ts';
    expect(classesOf(report, 'GH-5.pushedDate', file), explain(report)).toEqual([
      'comment',
      'unclear',
      'unclear',
    ]);
    expect(report.clean).toBe(false);
  });

  it('still reads prose and f-strings as prose', async () => {
    const report = await scan({
      'requirements.txt': 'pygithub==2.0.0\n',
      'a.py': [
        'import requests',
        'requests.get("https://api.github.com/x")',
        'print(f"the field pushedDate is {value} on Commit {name}")',
        'print("pushedDate is gone, see nodes for more")',
      ].join('\n'),
    });
    expect(new Set(classesOf(report, 'GH-5.pushedDate')), explain(report)).toEqual(
      new Set(['comment']),
    );
  });
});

describe('seen in P5, round 2: a module nothing that runs imports', () => {
  const KEY = 'OA-1.gpt-4-0125-preview';
  const SEND = 'client.chat.completions.create(model="gpt-4-turbo-preview", messages=[])';
  const GRAPH = {
    'requirements.txt': 'openai\n',
    'src/__init__.py': '',
    'src/run.py': 'from pkg.one import one\nfrom pkg.two import two\nprint(one, two)\n',
    'src/pkg/__init__.py': '',
    'src/pkg/one.py': 'from pkg.two import two\none = two\n',
    'src/pkg/two.py': 'from pkg.three import three\ntwo = three\n',
    'src/pkg/three.py': 'three = 3\n',
  };

  it('asks about a whole package only its own modules import, and the debug block in it', async () => {
    const report = await scanFixture('UW-Madison-Lee-Lab__TAPE');
    const reasons = report.details.filter((one) => one.file.startsWith('src/llms/'));
    expect(
      reasons.filter((one) => one.entryId !== 'OA-1.o1').map((one) => one.matchClass),
      explain(report),
    ).toEqual(['unclear', 'unclear', 'unclear']);
    expect(reasons[0].reason).toMatch(/nothing that runs imports this module/);
  });

  it("doesn't let a same-named module in another folder hold it", async () => {
    const report = await scan({
      ...GRAPH,
      'src/other/llm.py': `from openai import OpenAI\nclient = OpenAI()\ndef go():\n    ${SEND}\n`,
      'src/used/llm.py': 'x = 1\n',
      'src/run2.py': 'from used.llm import x\nprint(x)\n',
    });
    expect(classesOf(report, KEY, 'src/other/llm.py'), explain(report)).toEqual(['unclear']);
  });

  it.each([
    ['from a file that runs', 'from pkg.left import go\nprint(go)\n'],
    ['by a relative import', 'from .pkg.left import go\nprint(go)\n'],
    ['from the package', 'from pkg import left\nprint(left)\n'],
    ['by a bare import', 'import left\nprint(left)\n'],
    ['by name in a loader', 'importlib.import_module("pkg.left")\n'],
    ['by a list of modules that loads the folder', 'importlib.import_module(f"pkg.{name}")\n'],
  ])('leaves a module imported %s as it was', async (_name, importer) => {
    const report = await scan({
      ...GRAPH,
      'src/pkg/left.py': `from openai import OpenAI\nclient = OpenAI()\ndef go():\n    ${SEND}\n`,
      'src/start.py': importer,
    });
    expect(classesOf(report, KEY), explain(report)).toEqual(['live']);
  });

  it('leaves a script alone: a main guard outside a library, a top-level call, a package __init__', async () => {
    const script = `from openai import OpenAI\nclient = OpenAI()\nif __name__ == "__main__":\n    ${SEND}\n`;
    const report = await scan({
      'requirements.txt': 'openai\n',
      'src/run.py':
        'from lib.a import a\nfrom lib.b import b\nfrom lib.c import c\nprint(a, b, c)\n',
      'src/lib/a.py': 'a = 1\n',
      'src/lib/b.py': 'b = 1\n',
      'src/lib/c.py': 'c = 1\n',
      'src/a1.py': 'from lib.a import a\nprint(a)\n',
      'src/a2.py': 'from lib.b import b\nprint(b)\n',
      'other/script.py': script,
      'other/toplevel.py': `from openai import OpenAI\nclient = OpenAI()\n${SEND}\n`,
      'pack/__init__.py': `from openai import OpenAI\nclient = OpenAI()\ndef go():\n    ${SEND}\n`,
    });
    expect(classesOf(report, KEY), explain(report)).toEqual(['live', 'live', 'live']);
  });

  it('asks about a JS module only a module that cannot load imports', async () => {
    const report = await scanFixture('Jmk125__ConstructionDocuments');
    expect(classesOf(report, KEY, 'services/openai.js'), explain(report)).toEqual(['unclear']);
  });

  it("doesn't count a package of the same name as an import of the module", async () => {
    const graph = {
      ...OPENAI_PACKAGE,
      'src/index.ts':
        "import { a } from './a.js';\nimport { b } from './b.js';\nimport OpenAI from 'openai';\na(b, OpenAI);",
      'src/a.ts': "import { b } from './b.js';\nexport const a = (x) => b(x);",
      'src/b.ts': "import { c } from './c.js';\nexport const b = (x) => c(x);",
      'src/c.ts': 'export const c = (x) => x;',
      'src/openai.ts': "export const m = 'gpt-4-turbo-preview';",
    };
    const report = await scan(graph);
    expect(classesOf(report, KEY, 'src/openai.ts'), explain(report)).toEqual(['unclear']);
    const used = await scan({
      ...graph,
      'src/d.ts': "import { m } from './openai.js';\nexport const d = m;",
    });
    expect(classesOf(used, KEY, 'src/openai.ts'), explain(used)).toEqual(['live']);
    const convex = await scan({
      ...graph,
      'convex/seed.ts': "export const m = 'gpt-4-turbo-preview';",
    });
    expect(classesOf(convex, KEY, 'convex/seed.ts'), explain(convex)).toEqual(['live']);
  });
});

describe('seen in P5, round 2: a name that is only tested', () => {
  const KEY = 'OA-1.o1';
  const PY = 'from openai import OpenAI\nclient = OpenAI()\n';

  it('calls a substring test a check, with no AI call to get it wrong', async () => {
    const report = await scanFixture('UW-Madison-Lee-Lab__TAPE');
    const hits = report.details.filter((one) => one.entryId === KEY);
    expect(
      hits.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['catalog', 'catalog']);
  });

  it.each([
    ['any with in', 'any(x in name for x in ("o1", "o3", "o4"))'],
    ['all with not in', 'all(x not in name for x in ("o1", "o3", "o4"))'],
    ['any with startswith', 'any(name.startswith(x) for x in ("o1", "o3", "o4"))'],
    ['any with equals', 'any(name == x for x in ["o1", "o3", "o4"])'],
  ])('reads %s as a test', async (_name, line) => {
    const report = await scan({ 'requirements.txt': 'openai\n', 'a.py': `${PY}ok = ${line}\n` });
    expect(classesOf(report, KEY), explain(report)).toEqual(['catalog']);
  });

  it.each([
    [
      'a loop that sends each',
      'for x in ("o1", "o3", "o4"):\n    client.responses.create(model=x)',
    ],
    [
      'a comprehension that sends each',
      '[client.responses.create(model=x) for x in ("o1", "o3", "o4")]',
    ],
    ['a test mixed into a send', 'any(send(x) in name for x in ("o1", "o3", "o4"))'],
  ])("doesn't read %s as a test", async (_name, line) => {
    const report = await scan({ 'requirements.txt': 'openai\n', 'a.py': `${PY}${line}\n` });
    expect(classesOf(report, KEY), explain(report)).not.toEqual(['catalog']);
  });

  it('reads the same shape in JS, and not a callback that sends', async () => {
    const js = (line: string) => ({
      ...OPENAI_PACKAGE,
      'a.ts': `import OpenAI from 'openai';\nconst client = new OpenAI();\n${line}`,
    });
    const test = await scan(js(`const ok = ['o1', 'o3', 'o4'].some((x) => name.startsWith(x));`));
    expect(classesOf(test, KEY), explain(test)).toEqual(['catalog']);
    const send = await scan(js(`['o1', 'o3', 'o4'].some((x) => client.send(x));`));
    expect(classesOf(send, KEY), explain(send)).not.toEqual(['catalog']);
  });
});

describe('seen in P5, round 2: a default every caller overrides', () => {
  const KEY = 'OA-1.gpt-3.5-turbo-0613';
  const DEF = `from openai import OpenAI\nclient = OpenAI()\ndef send(messages, model="gpt-3.5-turbo-0613", **kw):\n    return client.chat.completions.create(model=model, messages=messages, **kw)\n`;
  const withCall = (call: string, extra: Record<string, string> = {}) =>
    scan({ 'requirements.txt': 'openai\n', 'a.py': `${DEF}${call}\n`, ...extra });

  it('calls it never sent, on a function and on a class', async () => {
    const report = await scanFixture('UW-Madison-Lee-Lab__TAPE');
    expect(classesOf(report, KEY, 'src/utils/llm.py'), explain(report)).toEqual([
      'catalog',
      'catalog',
      'catalog',
    ]);
  });

  it.each([
    ['by keyword', 'send([], model=picked)'],
    ['by keyword beside **kwargs', 'send([], model=picked, **options)'],
    ['by position', 'send([], picked)'],
  ])('reads a call that passes it %s', async (_name, call) => {
    const report = await withCall(call);
    expect(classesOf(report, KEY), explain(report)).toEqual(['catalog']);
  });

  it.each([
    ['a call that leaves it out', 'send([], model=picked)\nsend([])'],
    ['*args, which may not reach it', 'send(*args)'],
    ['**kwargs alone, which may not hold it', 'send([], **options)'],
    ['a reference, which can be called any way', 'send([], model=picked)\nhandlers = [send]'],
  ])('keeps it live with %s', async (_name, call) => {
    const report = await withCall(call);
    expect(classesOf(report, KEY), explain(report)).toEqual(['live']);
  });

  it('keeps it live with no caller, one in another file, or a package exporting it', async () => {
    const none = await withCall('');
    expect(classesOf(none, KEY), explain(none)).toEqual(['live']);
    const other = await withCall('send([], model=picked)', {
      'b.py': 'from a import send\nsend([])\n',
    });
    expect(classesOf(other, KEY, 'a.py'), explain(other)).toEqual(['live']);
    const exported = await scan({
      'requirements.txt': 'openai\n',
      'pack/__init__.py': 'from pack.a import send\n',
      'pack/a.py': `${DEF}send([], model=picked)\n`,
    });
    expect(classesOf(exported, KEY, 'pack/a.py'), explain(exported)).toEqual(['live']);
  });

  it('reads a JS default the same way, and never an exported one', async () => {
    const js = (keyword: string, call: string) => ({
      ...OPENAI_PACKAGE,
      'a.ts': `import OpenAI from 'openai';\nconst client = new OpenAI();\n${keyword} send(m, model = 'gpt-3.5-turbo-0613') {\n  return client.chat.completions.create({ model, messages: m });\n}\n${call}`,
    });
    const passed = await scan(js('function', 'send([], picked);'));
    expect(classesOf(passed, KEY), explain(passed)).toEqual(['catalog']);
    const omitted = await scan(js('function', 'send([]);'));
    expect(classesOf(omitted, KEY), explain(omitted)).toEqual(['live']);
    const exported = await scan(js('export function', 'send([], picked);'));
    expect(classesOf(exported, KEY), explain(exported)).toEqual(['live']);
  });
});

describe('seen in P5, round 2: a function nothing calls', () => {
  const KEY = 'OA-1.gpt-3.5-turbo';

  it('asks about the one a script never starts, and keeps the one it does', async () => {
    const report = await scanFixture('AyeletHillel__fine-tune');
    expect(classesOf(report, KEY, 'src/index.ts'), explain(report)).toEqual(['unclear', 'live']);
    expect(report.details[0].reason).toMatch(/inside mainShort, which nothing calls/);
  });

  const script = (body: string, extra: Record<string, string> = {}) =>
    scan({
      ...OPENAI_PACKAGE,
      'a.js': `async function short() {\n  send({ model: 'gpt-3.5-turbo' });\n}\nasync function main() {}\n${body}`,
      ...extra,
    });

  it.each([
    ['the script calls it', 'short();\nmain();'],
    ['it goes to a call by name', 'main(short);'],
    ['the file has no start of its own', 'module.exports = { main, short };'],
  ])('leaves it when %s', async (_name, body) => {
    const report = await script(body);
    expect(classesOf(report, KEY), explain(report)).toEqual(['live']);
  });

  it('leaves it when another file names it, or a decorator registers it', async () => {
    const other = await script('main();', {
      'b.js': "const { short } = require('./a');\nshort();",
    });
    expect(classesOf(other, KEY, 'a.js'), explain(other)).toEqual(['live']);
    const decorated = await scan({
      'requirements.txt': 'openai\n',
      'a.py': [
        'import openai',
        '@app.route("/x")',
        'def handler():',
        '    openai.chat.completions.create(model="gpt-3.5-turbo")',
        'def main():',
        '    pass',
        'main()',
      ].join('\n'),
    });
    expect(classesOf(decorated, KEY), explain(decorated)).toEqual(['live']);
  });
});

describe("seen in P5, round 2: the app's own stand-in for an SDK", () => {
  it('asks about a local module imported under the SDK name, and shows what it does', async () => {
    const report = await scanFixture('nfindler__playbook-pipeline');
    const hit = report.details.find((one) => one.entryId === 'AN-1.claude-opus-4-20250514');
    expect(hit?.matchClass, explain(report)).toBe('unclear');
    expect(hit?.reason).toMatch(
      /imports its own scripts\/cc_anthropic\.py under the name anthropic/,
    );
    expect(hit?.reads?.join('\n')).toMatch(/_model_alias/);
  });

  it('leaves the real SDK, a local module under another name, and an alias of the SDK', async () => {
    const send = 'client.messages.create(model="claude-opus-4-20250514")';
    const files = (head: string) => ({
      'requirements.txt': 'anthropic\n',
      'helpers.py': 'x = 1\n',
      'a.py': `${head}\nclient = sdk.Anthropic()\n${send}\n`,
    });
    for (const head of ['import anthropic as sdk', 'import helpers as sdk\nimport anthropic']) {
      const report = await scan(files(head));
      expect(classesOf(report, 'AN-1.claude-opus-4-20250514'), explain(report)).toEqual(['live']);
    }
  });

  it('asks about a method a wrapper never offers', async () => {
    const report = await scanFixture('djnightmare9909__Dungeon-master-OS-WFGY');
    const hit = report.details.find((one) => one.entryId === 'GE-1.imagen-4.0-generate-001');
    expect(hit?.matchClass, explain(report)).toBe('unclear');
    expect(hit?.reason).toMatch(/never names generateImages/);
  });

  it('leaves a real client, a wrapper with the method, and a package client', async () => {
    const call =
      "import { ai } from './gemini';\nai.models.generateImages({ model: 'imagen-4.0-generate-001' });";
    const files = (gemini: string, a = call) => ({
      'package.json': manifest({ '@google/genai': '^1.0.0' }),
      'gemini.ts': gemini,
      'a.ts': a,
    });
    const real = await scan(files('export const ai = new GoogleGenAI({ apiKey });'));
    const wrapper = await scan(
      files('export const ai = new Proxy({}, { get: () => ({ generateImages: f }) });'),
    );
    const sdk = await scan(
      files(
        'export const x = 1;',
        "import { ai } from '@google/genai';\nai.models.generateImages({ model: 'imagen-4.0-generate-001' });",
      ),
    );
    for (const report of [real, wrapper, sdk]) {
      expect(classesOf(report, 'GE-1.imagen-4.0-generate-001', 'a.ts'), explain(report)).toEqual([
        'live',
      ]);
    }
  });
});

describe('seen in P5, round 2: a table key the code translates', () => {
  const KEY = 'AN-1.claude-sonnet-4-20250514';

  it('leaves the key out and keeps the request line', async () => {
    const report = await scanFixture('Jmk125__ConstructionDocuments');
    const file = 'lib/aiHandler.js';
    const hits = report.details.filter((one) => one.entryId === KEY && one.file === file);
    expect(
      hits.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['catalog', 'unclear']);
    expect(hits[0].reason).toMatch(/sends claude-sonnet-4-20250514/);
  });

  it('keeps asking when no other name stands in for it, or the other name is only a key too', async () => {
    const table = (extra: string) => ({
      ...ANTHROPIC_PACKAGE,
      'a.ts': `import Anthropic from '@anthropic-ai/sdk';\nconst MODELS = {\n  'claude-sonnet-4': { name: 'x' },\n  ${extra}\n};\nexport const ids = Object.keys(MODELS);`,
    });
    const alone = await scan(table("'other': { name: 'y' },"));
    expect(classesOf(alone, KEY), explain(alone)).toEqual(['unclear']);
    const keys = await scan(table("'claude-sonnet-4-20250514': { name: 'y' },"));
    expect(new Set(classesOf(keys, KEY)), explain(keys)).toEqual(new Set(['unclear']));
  });
});

describe('seen in P5, round 2: naming providers with no list file', () => {
  const NODE = { 'package.json': manifest({ express: '^4.0.0' }) };

  it('names a catalog provider by an environment key in code, and not by one in an example', async () => {
    const report = await scan({
      ...NODE,
      'a.js': 'const url = process.env.SUPABASE_URL;\nconst other = process.env.ACME_URL;',
      '.env.example': 'CLERK_API_KEY=\n',
      'README.md': 'Set SENTRY_API_KEY first.\n',
    });
    expect(report.unlistedProviders).toEqual(['supabase']);
  });

  it("names a domain behind S3's path style, and not a bucket with no domain", async () => {
    const report = await scan({
      ...NODE,
      'a.ts': [
        "const ZIP_URL = 'https://s3.us-east-1.amazonaws.com/download.acme.gov/data.zip';",
        "const OTHER_URL = 'https://s3.amazonaws.com/my-bucket/data.zip';",
      ].join('\n'),
    });
    expect(report.unlistedProviders).toEqual(['acme.gov']);
  });

  it('names a catalog host a script tag loads, and no other script host', async () => {
    const report = await scan({
      ...NODE,
      'a.html': [
        '<script src="https://accounts.google.com/gsi/client" async></script>',
        '<script src="https://cdn.acme.io/lib"></script>',
      ].join('\n'),
    });
    expect(report.unlistedProviders).toEqual(['google-identity']);
  });

  it('names packages the catalog was missing', async () => {
    const report = await scan({
      'package.json': manifest({ inngest: '^3.0.0', 'google-auth-library': '^10.0.0' }),
      'requirements.txt': 'gTTS\nSpeechRecognition\n',
      'a.py': 'from gtts import gTTS\nimport speech_recognition as sr\n',
    });
    expect(report.unlistedProviders).toEqual([
      'google-identity',
      'google-translate-tts',
      'google-web-speech',
      'inngest',
    ]);
  });

  it('names fly from a workflow action', async () => {
    const report = await scanFixture('natbat__pillarpointstewards');
    expect(report.unlistedProviders).toContain('fly');
  });
});

describe('seen in P5, round 2: what the AI check is told', () => {
  it('says a test sends nothing, a translated key is not sent, and to name its own id', async () => {
    const report = await scanFixture('nfindler__playbook-pipeline');
    let request: ModelRequest | undefined;
    const client = {
      model: CHECK_MODEL,
      complete: async (one: ModelRequest) => {
        request = one;
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '[]' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as ModelClient;
    const openLedger = async () =>
      ({
        assertCanSpend: () => undefined,
        record: async () => undefined,
      }) as unknown as BudgetLedger;
    await checkUnclear(report, path.join(FIXTURES, 'nfindler__playbook-pipeline'), {
      client,
      openLedger,
    });
    expect(request?.system).toMatch(/only picks a branch and sends nothing/);
    expect(request?.system).toMatch(/table key the code turns into another id/);
    expect(request?.system).toMatch(/item's own id/);
    const text = request?.messages[0].content[0];
    expect(text && 'text' in text ? text.text : '').toMatch(/_model_alias/);
  });
});

describe('P5 round 3: code that is not the repo running', () => {
  it('never reads a committed virtualenv, and keeps the app beside it', async () => {
    const report = await scanFixture('bicalhobim__ia.rt_bim');
    expect(report.details.filter((one) => one.file.includes('site-packages'))).toEqual([]);
    expect(report.filesRead).toBeLessThan(6);
    expect(classesOf(report, 'OA-2.assistants-api', 'app.py'), explain(report)).toEqual([
      'unclear',
      'unclear',
    ]);
  });

  it('classes a backup copy of an entry point as catalog, and only when it is one', async () => {
    const report = await scanFixture('bicalhobim__ia.rt_bim');
    const backup = report.details.filter((one) => one.file === 'app bkp1.py');
    expect(
      backup.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['catalog', 'catalog']);
    expect(backup[0].reason).toMatch(/backup copy of app\.py/);

    const call = (client: string) =>
      `${client}.chat.completions.create({ model: 'gpt-3.5-turbo-0613' });\n`;
    const body = `import OpenAI from 'openai';\nconst openai = new OpenAI();\n${call('openai')}`;
    const imported = await scan({
      ...OPENAI_PACKAGE,
      'a.js': body,
      'a_old.js': body,
      'b.js': "import './a_old.js';\n",
    });
    expect(classesOf(imported, 'OA-1.gpt-3.5-turbo-0613', 'a_old.js'), explain(imported)).toEqual([
      'live',
    ]);
    const noOriginal = await scan({ ...OPENAI_PACKAGE, 'server_old.js': body });
    expect(classesOf(noOriginal, 'OA-1.gpt-3.5-turbo-0613'), explain(noOriginal)).toEqual(['live']);
    const notAMark = await scan({ ...OPENAI_PACKAGE, 'gold.js': body, 'g.js': body });
    expect(classesOf(notAMark, 'OA-1.gpt-3.5-turbo-0613', 'gold.js'), explain(notAMark)).toEqual([
      'live',
    ]);
  });
});

describe('P5 round 3: providers the list had no file for', () => {
  it('flags @whop/api GraphQL calls where they run, and not its local token check', async () => {
    const report = await scanFixture('Jeffansah__whop-ai-chat');
    const id = 'WH-1.public-graphql';
    expect(classesOf(report, id, 'convex/onboarding/actions.ts'), explain(report)).toEqual([
      'live',
      'live',
      'live',
      'live',
    ]);
    expect(classesOf(report, id, 'convex/billing/actions.ts'), explain(report)).toEqual(['live']);
    expect(classesOf(report, id, 'components/server/whop-sdk.ts'), explain(report)).toEqual([
      'live',
    ]);
    const lines = report.details
      .filter((one) => one.file === 'components/server/whop-sdk.ts')
      .map((one) => one.text);
    expect(lines.some((one) => one.includes('verifyUserToken'))).toBe(false);
    expect(report.unlistedProviders).not.toContain('whop');
    expect(report.unlistedProviders).not.toContain('whop.com');
    expect(report.unlistedProviders).toContain('convex');
  });

  it('sends a Convex function nothing calls to unclear, and keeps a called one live', async () => {
    const report = await scanFixture('Jeffansah__whop-ai-chat');
    const file = 'convex/notifications/whop.ts';
    const found = report.details.filter((one) => one.file === file);
    expect(
      found.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['unclear', 'live']);
    expect(found[0].reason).toMatch(/sendHandoffNotification/);
  });

  it('leaves @whop/sdk alone and flags the old address, and v2 only from its date', async () => {
    const sdk = await scan({
      'package.json': manifest({ '@whop/sdk': '^1.0.0' }),
      'a.ts':
        "import Whop from '@whop/sdk';\nconst whop = new Whop();\nawait whop.users.retrieve('u');\nawait whop.users.checkAccess('u', { resource_id: 'e' });\n",
    });
    expect(fixTargets(sdk), explain(sdk)).toEqual([]);
    const raw = {
      'a.js':
        "fetch('https://api.whop.com/public-graphql', { method: 'POST' });\nfetch('https://api.whop.com/api/v2/memberships');\n",
    };
    const today = await scan(raw);
    expect(classesOf(today, 'WH-1.public-graphql'), explain(today)).toEqual(['live']);
    expect(classesOf(today, 'WH-2.api-v2')).toEqual([]);
    const later = await scan(raw, '2026-11-13');
    expect(classesOf(later, 'WH-2.api-v2'), explain(later)).toEqual(['live']);
  });

  it("flags OpenRouter's retired routes, in code and in a docs folder a deploy serves", async () => {
    const report = await scanFixture('William-franklyn__data-visualization-library');
    const id = 'OR-1.nvidia-nemotron-3-super-120b-a12b-free';
    expect(classesOf(report, id, 'mcp/insights.js'), explain(report)).toEqual(['live']);
    expect(classesOf(report, id, 'docs/script.js'), explain(report)).toEqual(['live']);
    expect(report.clean).toBe(false);
    expect(report.unlistedProviders).not.toContain('openrouter.ai');
  });

  it('keeps a docs folder a sample when no deploy config serves it', async () => {
    const report = await scan({
      'a.js': "fetch('https://openrouter.ai/api/v1/chat/completions');\n",
      'vercel.json': '{ "outputDirectory": "site" }\n',
      'docs/script.js': "const AI_MODEL = 'mistralai/mistral-7b-instruct';\n",
    });
    expect(classesOf(report, 'OR-1.mistralai-mistral-7b-instruct'), explain(report)).toEqual([
      'test',
    ]);
  });

  it('flags a retired route in a router table, and not one the code never picks', async () => {
    const report = await scanFixture('nicuk__docsflow');
    const id = 'OR-1.mistralai-mistral-7b-instruct';
    expect(classesOf(report, id, 'lib/openrouter-client.ts'), explain(report)).toEqual([
      'live',
      'live',
      'live',
      'catalog',
    ]);
    const unused = report.details.find((one) => one.entryId === id && one.matchClass === 'catalog');
    expect(unused?.reason).toMatch(/DOCUMENT_PROCESSING/);
  });

  it('keeps a table key live when the code walks the table or passes it whole', async () => {
    const table =
      "export const T = {\n  USED: ['mistralai/mistral-7b-instruct'],\n  OTHER: ['mistralai/mistral-7b-instruct'],\n};\n";
    const files = (use: string) => ({
      'a.ts': `${table}fetch('https://openrouter.ai/api/v1/chat', { body: ${use} });\n`,
    });
    const id = 'OR-1.mistralai-mistral-7b-instruct';
    const byKey = await scan(files('T.USED'));
    expect(classesOf(byKey, id), explain(byKey)).toEqual(['live', 'catalog']);
    for (const use of ['Object.values(T)', 'T[pick]', 'send(T)']) {
      const walked = await scan(files(use));
      expect(classesOf(walked, id), `${use}\n${explain(walked)}`).toEqual(['live', 'live']);
    }
  });
});

describe('P5 round 3: undated family names', () => {
  it('sends a picker of undated Claude 3 names to the check, by entry', async () => {
    const report = await scanFixture('kousalyaChintha__InfiniteCode');
    const file = 'src/pages/Settings.jsx';
    for (const id of [
      'AN-1.claude-3-opus-20240229',
      'AN-1.claude-3-sonnet-20240229',
      'AN-1.claude-3-haiku-20240307',
    ]) {
      expect(classesOf(report, id, file), `${id}\n${explain(report)}`).toEqual(['unclear']);
    }
  });

  it("doesn't take a router's prefixed id or a provider-free file for Anthropic's undated name", async () => {
    const prefixed = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.js':
        "import Anthropic from '@anthropic-ai/sdk';\nconst model = 'anthropic/claude-3-haiku';\nsend(model);\n",
    });
    expect(classesOf(prefixed, 'AN-1.claude-3-haiku-20240307')).toEqual([]);
    const quiet = await scan({
      ...ANTHROPIC_PACKAGE,
      'types.py': 'claude_3_haiku = "claude-3-haiku"\n',
    });
    expect(classesOf(quiet, 'AN-1.claude-3-haiku-20240307')).toEqual([]);
    const dated = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.js':
        "import Anthropic from '@anthropic-ai/sdk';\nsend({ model: 'claude-3-haiku-20240307' });\n",
    });
    expect(classesOf(dated, 'AN-1.claude-3-haiku-20240307'), explain(dated)).toEqual(['live']);
  });
});

describe('P5 round 3: fallbacks, labels and local copies', () => {
  const GROQ = { 'package.json': manifest({ 'groq-sdk': '^1.0.0' }) };
  const KEY = 'GR-1.llama-3.3-70b-versatile';

  it('sends a fallback whose left side has its own default to unclear, and shows where', async () => {
    const kousalya = await scanFixture('kousalyaChintha__InfiniteCode');
    const [left] = kousalya.details.filter((one) => one.entryId === 'GE-1.gemini-2.0-flash');
    expect(left?.matchClass, explain(kousalya)).toBe('unclear');
    expect(left?.reads?.[0]).toMatch(/src\/pages\/Index\.jsx:\d+: model: localStorage/);
    const lamp = await scanFixture('liamstamper__lamp-bot');
    const config = 'app/(content)/dashboard/ai-configuration/components/AIConfigurationClient.tsx';
    const fallback = lamp.details.find(
      (one) => one.file === config && one.reason.includes('fallback'),
    );
    expect(fallback?.matchClass, explain(lamp)).toBe('unclear');
  });

  it('keeps a fallback live when the left side is the environment, or has no default', async () => {
    const send = (left: string, more = '') =>
      `import Groq from 'groq-sdk';\nnew Groq().chat.completions.create({ model: ${left} || 'llama-3.3-70b-versatile' });\n${more}`;
    const env = await scan({
      ...GROQ,
      'a.js': send('process.env.MODEL', "const conf = { MODEL: other || 'x-1' };\n"),
    });
    expect(classesOf(env, KEY), explain(env)).toEqual(['live']);
    const meta = await scan({
      ...GROQ,
      'a.js': send('import.meta.env.MODEL', "const conf = { MODEL: other || 'x-1' };\n"),
    });
    expect(classesOf(meta, KEY), explain(meta)).toEqual(['live']);
    const none = await scan({ ...GROQ, 'a.js': send('options.model') });
    expect(classesOf(none, KEY), explain(none)).toEqual(['live']);
  });

  it('counts an option record once, on its value and not its label', async () => {
    const report = await scanFixture('liamstamper__lamp-bot');
    const found = report.details.filter((one) => one.file === 'lib/ai/modelChoices.ts');
    expect(
      found.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['live', 'catalog', 'live', 'catalog']);
  });

  it("classes a copy saved to the app's own usage record as catalog, and keeps the call live", async () => {
    const report = await scanFixture('liamstamper__lamp-bot');
    const found = report.details.filter((one) => one.file === 'lib/webhook/promptModel.ts');
    expect(
      found.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['live', 'catalog']);
    const notARecord = await scan({
      ...GROQ,
      'a.js':
        "import Groq from 'groq-sdk';\nawait trackedChat({ model: 'llama-3.3-70b-versatile' });\nawait new Groq().x;\n",
    });
    expect(classesOf(notARecord, KEY), explain(notARecord)).toEqual(['live']);
  });

  it('sends a request to an /api path no route serves to unclear, and keeps the rest live', async () => {
    const report = await scanFixture('liamstamper__lamp-bot');
    const missing = report.details.find((one) => one.reason.includes('/api/prompts/testPrompt'));
    expect(missing?.matchClass, explain(report)).toBe('unclear');
    const request = (url: string) => ({
      ...GROQ,
      'app/api/items/[id]/route.ts':
        "import Groq from 'groq-sdk';\nexport async function POST() { return new Groq(); }\n",
      'app/api/all/[...rest]/route.ts': 'export async function GET() { return 1; }\n',
      'b.tsx': `export const go = () => fetch(${url}, { method: 'POST', body: JSON.stringify({ model: 'llama-3.3-70b-versatile' }) });\n`,
    });
    for (const url of [
      "'/api/items/1'",
      '`/api/items/${id}`',
      "'/api/all/a/b'",
      "'https://x.io/api/none'",
    ]) {
      const served = await scan(request(url));
      expect(classesOf(served, KEY, 'b.tsx'), `${url}\n${explain(served)}`).toEqual(['live']);
    }
    const gone = await scan(request("'/api/nope'"));
    expect(classesOf(gone, KEY, 'b.tsx'), explain(gone)).toEqual(['unclear']);
    const rewritten = await scan({
      ...request("'/api/nope'"),
      'next.config.js': 'module.exports = { rewrites: async () => [] };\n',
    });
    expect(classesOf(rewritten, KEY, 'b.tsx'), explain(rewritten)).toEqual(['live']);
  });
});

describe('P5 round 3: code that may never run', () => {
  it('sends a file importing a name its module never mentions to unclear', async () => {
    const report = await scanFixture('adeojoemmanuel__EDD-Kafka-Rest-Api');
    expect(classesOf(report, 'OA-1.text-davinci-003'), explain(report)).toEqual(['unclear']);
    expect(report.details[0].reason).toMatch(/creatServiceCustomer/);
    const file = (lib: string, spec = 'run') => ({
      ...OPENAI_PACKAGE,
      'lib.ts': lib,
      'a.ts': `import { ${spec} } from './lib';\nimport OpenAI from 'openai';\nrun();\nnew OpenAI().completions.create({ model: 'text-davinci-003' });\n`,
    });
    for (const [lib, spec] of [
      ['export const run = () => 1;\n', 'run'],
      ["export * from './other';\n", 'run'],
      ['export type Run = () => void;\nexport const run = 1;\n', 'type Run, run'],
      ['export const go = 1;\nexport { go as run };\n', 'run'],
    ]) {
      const fine = await scan(file(lib, spec));
      expect(classesOf(fine, 'OA-1.text-davinci-003', 'a.ts'), `${lib}\n${explain(fine)}`).toEqual([
        'live',
      ]);
    }
  });

  it("reads a default through an app's own re-export, and not a published package's", async () => {
    const report = await scanFixture('adri14gl__Chatbot-multiproveedor-con-fallback-y-streaming');
    const id = 'AN-1.claude-3-7-sonnet-20250219';
    expect(classesOf(report, id, 'providers/anthropic_provider.py'), explain(report)).toEqual([
      'catalog',
    ]);
    expect(classesOf(report, id, 'main.py'), explain(report)).toEqual(['live']);
    const published = await scan({
      'requirements.txt': 'anthropic\n',
      'pyproject.toml': '[project]\nname = "x"\n',
      'providers/__init__.py': 'from .p import P\n__all__ = ["P"]\n',
      'providers/p.py':
        'import anthropic\nclass P:\n    def __init__(self, model: str = "claude-3-7-sonnet-latest"):\n        self.model = model\n',
      'main.py': 'from providers import P\nP(model="claude-opus-5")\n',
    });
    expect(classesOf(published, id, 'providers/p.py'), explain(published)).toEqual(['live']);
  });

  it('tells two modules of one name apart, so importing one leaves the other an orphan', async () => {
    const report = await scanFixture('nicuk__docsflow');
    expect(
      classesOf(report, 'GE-1.gemini-2.0-flash', 'lib-frontend/ai/providers.ts'),
      explain(report),
    ).toEqual(['unclear']);
    const twins = (importer: string) => ({
      'package.json': manifest({ '@ai-sdk/google': '^1.0.0' }),
      'lib/x/providers.ts': "export const a = 'gemini-2.0-flash';\n",
      'web/x/providers.ts': "export const b = 'gemini-2.0-flash';\n",
      'lib/u.ts': 'export const u = 1;\n',
      'web/v.ts': 'export const v = 1;\n',
      'app/page.tsx': `import { u } from '@/lib/u';\nimport { v } from '@/web/v';\n${importer}\nexport default () => [u, v];\n`,
      'app/one.tsx': "import { u } from '../lib/u';\nexport const one = u;\n",
      'app/two.tsx': "import { v } from '../web/v';\nexport const two = v;\n",
    });
    const id = 'GE-1.gemini-2.0-flash';
    const alias = await scan(twins("import { a } from '@/lib/x/providers';"));
    expect(classesOf(alias, id, 'lib/x/providers.ts'), explain(alias)).toEqual(['live']);
    expect(classesOf(alias, id, 'web/x/providers.ts'), explain(alias)).toEqual(['unclear']);
    const relative = await scan(twins("import { b } from '../web/x/providers';"));
    expect(classesOf(relative, id, 'web/x/providers.ts'), explain(relative)).toEqual(['live']);
    expect(classesOf(relative, id, 'lib/x/providers.ts'), explain(relative)).toEqual(['unclear']);
  });

  it('sends an object member or plain method nothing names to unclear', async () => {
    const report = await scanFixture('nicuk__docsflow');
    expect(
      classesOf(report, 'GE-1.text-embedding-004', 'lib/ai/providers.ts'),
      explain(report),
    ).toEqual(['unclear']);
    const id = 'OA-1.gpt-3.5-turbo-0613';
    const call = "client.chat.completions.create({ model: 'gpt-3.5-turbo-0613' })";
    const head = "import OpenAI from 'openai';\nconst client = new OpenAI();\n";
    const unused = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `${head}class Plain {\n  ask() {\n    return ${call};\n  }\n}\nexport const p = new Plain();\n`,
    });
    expect(classesOf(unused, id), explain(unused)).toEqual(['unclear']);
    const live = [
      `${head}const o = {\n  ask: () => ${call},\n};\no.ask();\n`,
      `${head}class Sub extends Base {\n  ask() {\n    return ${call};\n  }\n}\n`,
      `${head}export function plugin() {\n  return {\n    configureServer() {\n      return ${call};\n    },\n  };\n}\n`,
      `${head}export const tool = action({\n  handler: async () => ${call},\n});\n`,
    ];
    for (const code of live) {
      const report = await scan({ ...OPENAI_PACKAGE, 'a.ts': code });
      expect(classesOf(report, id), `${code}\n${explain(report)}`).toEqual(['live']);
    }
  });

  it('classes a list only read behind a constant false as catalog, and nothing weaker', async () => {
    const report = await scanFixture('nicuk__docsflow');
    expect(
      classesOf(report, 'OA-1.gpt-4-turbo', 'lib/openrouter-client.ts'),
      explain(report),
    ).toEqual(['catalog']);
    const id = 'OA-1.gpt-3.5-turbo-0613';
    const files = (guard: string, read = 'if (on) { use(BIG); }') => ({
      ...OPENAI_PACKAGE,
      'a.ts': `import OpenAI from 'openai';\nconst BIG = ['gpt-3.5-turbo-0613'];\n${guard}\n${read}\nnew OpenAI();\n`,
    });
    const off = await scan(files('const on = false;'));
    expect(classesOf(off, id), explain(off)).toEqual(['catalog']);
    for (const [guard, read] of [
      ['const on = true;', undefined],
      ['let on = false;', undefined],
      ['const on = flags.premium;', undefined],
      ['const on = false;', 'if (on) { use(BIG); }\nuse(BIG);'],
    ] as const) {
      const kept = await scan(files(guard, read));
      expect(classesOf(kept, id), `${guard}\n${explain(kept)}`).toEqual(['live']);
    }
    const inside = await scan({
      ...OPENAI_PACKAGE,
      'a.ts':
        "import OpenAI from 'openai';\nconst on = false;\nif (on) {\n  new OpenAI().chat.completions.create({ model: 'gpt-3.5-turbo-0613' });\n}\n",
    });
    expect(classesOf(inside, id), explain(inside)).toEqual(['catalog']);
  });
});

describe('P5 round 3: providers the report should name', () => {
  it('names what a repo uses by package, env key or client, with nothing on the list for it', async () => {
    const report = await scan({
      'package.json': manifest({
        '@neondatabase/serverless': '^1.0.0',
        mongodb: '^7.0.0',
        convex: '^1.0.0',
        langsmith: '^0.3.0',
      }),
      'a.ts':
        'export const url = process.env.STRAPI_API_URL;\nexport const id = process.env.KAKAO_CLIENT_ID;\n',
      'b.py': 'from openai import AzureOpenAI\nclient = AzureOpenAI()\n',
    });
    expect(report.unlistedProviders).toEqual(
      expect.arrayContaining([
        'azure-openai',
        'convex',
        'kakao',
        'langsmith',
        'mongodb',
        'neon',
        'strapi',
      ]),
    );
  });
});

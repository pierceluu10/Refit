// Rules that once hid live code. Each case pairs what must flag with the false alarm the rule exists for.
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchClass } from '../shared/types.ts';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';
const OPENAI = { 'package.json': JSON.stringify({ dependencies: { openai: '^6.0.0' } }) };
const STRIPE = { 'package.json': JSON.stringify({ dependencies: { stripe: '^20.0.0' } }) };
const CLIENT = "import OpenAI from 'openai';\nconst client = new OpenAI();\n";
const STRIPE_HEAD =
  "import Stripe from 'stripe';\nnew Stripe('k', { apiVersion: '2026-02-25.clover' });\n";
const MODEL = 'OA-1.gpt-4';

const repos: string[] = [];
async function scan(files: Record<string, string>): Promise<DeadScanReport> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return scanDeadApis(repoDir, 'test/repo', { today: TODAY });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

function explain(report: DeadScanReport): string {
  return report.details
    .map((one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`)
    .join('\n');
}

const classes = (report: DeadScanReport, entryId: string, file?: string): MatchClass[] =>
  report.details
    .filter((one) => one.entryId === entryId && (!file || one.file === file))
    .map((one) => one.matchClass);

describe('a request is not a strip', () => {
  it('keeps a DELETE through a path-style client', async () => {
    const report = await scan({
      'requirements.txt': 'stripe==12.0.0\n',
      'app.py': "import requests\ns = requests.Session()\ns.delete('/v1/invoices/upcoming')\n",
    });
    expect(classes(report, 'ST-5.upcoming'), explain(report)).toEqual(['live']);
  });

  it('keeps the same call on a path the list marks ambiguous in play', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}client.delete('/v1/assistants/' + id);\n`,
    });
    expect(classes(report, 'OA-2.assistants-api'), explain(report)).toEqual(['unclear']);
  });

  it('still reads a delete of a field as a strip', async () => {
    const report = await scan({
      'package.json': JSON.stringify({
        dependencies: { 'facebook-nodejs-business-sdk': '^20.0.0' },
      }),
      'a.rb': 'spec.delete("instagram_actor_id")\n',
    });
    expect(classes(report, 'MG-6.instagram_actor_id'), explain(report)).toEqual(['catalog']);
  });
});

describe('a replacement read clears only the same object', () => {
  const end = 'ST-1.current_period_end';
  const fn = (body: string) =>
    `${STRIPE_HEAD}export async function go(subscription: Stripe.Subscription, oldSub: Stripe.Subscription) {\n${body}\n}\n`;

  it.each([
    [
      'off another object',
      'const a = subscription.items.data[0].current_period_end;\n  return [a, oldSub.current_period_end];',
      'oldSub',
    ],
    [
      'on an unrelated object beside it',
      'return [subscription.current_period_end, cart.items.data[0].current_period_end];',
      'subscription.current',
    ],
    [
      'when the old value is what the code uses',
      'const end = subscription.current_period_end;\n  log(subscription.items.data[0].current_period_end);\n  return end * 1000;',
      'const end',
    ],
    [
      'through a holder bound off another object',
      'const item = cart.items.data[0];\n  return [item.current_period_end, subscription.current_period_end];',
      'subscription.current',
    ],
  ])('keeps a dead read %s', async (_, body, text) => {
    const report = await scan({ ...STRIPE, 'a.ts': fn(body) });
    const dead = report.details.filter((one) => one.entryId === end && one.text.includes(text));
    expect(
      dead.map((one) => one.matchClass),
      explain(report),
    ).toEqual(['live']);
  });

  it.each([
    [
      'a fallback',
      'return subscription.items.data[0].current_period_end ?? subscription.current_period_end;',
    ],
    [
      'a fallback over two statements',
      'const old = subscription.current_period_end;\n  const fresh = subscription.items.data[0].current_period_end;\n  return fresh ?? old;',
    ],
    [
      'a cast copy of the same object',
      'const copy = subscription as Stripe.Subscription & { current_period_end?: number };\n  const first = subscription.items.data[0];\n  return copy.current_period_end ?? first.current_period_end;',
    ],
  ])('still clears %s', async (_, body) => {
    const report = await scan({ ...STRIPE, 'a.ts': fn(body) });
    expect(report.clean, explain(report)).toBe(true);
  });
});

describe('what is shown is the value itself', () => {
  const held = 'MODEL = "gpt-4"\n';

  it.each([
    [
      'a request inside print',
      'a.py',
      `${held}print(client.chat.completions.create(model=MODEL, messages=[]).choices[0].message.content)\n`,
    ],
    [
      'a request inside console.log',
      'a.ts',
      `const MODEL = 'gpt-4';\nconsole.log(await client.chat.completions.create({ model: MODEL, messages: [] }));\n`,
    ],
    [
      'a response printed on the next line',
      'a.py',
      `${held}r = client.chat.completions.create(model=MODEL, messages=[])\nprint(r.choices[0].message.content)\n`,
    ],
  ])('keeps %s', async (_, file, code) => {
    const report = await scan({ ...OPENAI, [file]: code });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it.each([
    ['print', 'a.py', `${held}print(MODEL)\n`],
    ['a formatted print', 'a.py', `${held}print("using " + str(MODEL))\n`],
    ['a logged object', 'a.ts', `export const MODEL = 'gpt-4';\nconsole.log({ model: MODEL });\n`],
  ])('still settles %s as display', async (_, file, code) => {
    const report = await scan({ ...OPENAI, [file]: code, 'other.py': 'import openai\n' });
    expect(report.clean, explain(report)).toBe(true);
  });
});

describe('a local path is in a string', () => {
  const others = { 'requirements.txt': 'openai\n', 'llm.py': 'def post(body):\n    return body\n' };

  it.each([
    ['.json() on the result', 'out = post({"model": MODEL}).json()\n'],
    ['.json() on a response held first', 'resp = post({"model": MODEL})\nout = resp.json()\n'],
  ])('keeps a body sent, with %s', async (_, code) => {
    const report = await scan({
      ...others,
      'app.py': `from llm import post\nMODEL = "gpt-4"\n${code}`,
    });
    expect(classes(report, MODEL, 'app.py'), explain(report)).toEqual(['live']);
  });

  it('still reads a file name as a path', async () => {
    const report = await scan({
      ...others,
      'app.py': `from llm import post\nMODEL = "gpt-4"\nout = MODEL + ".json"\nopen(out)\n`,
    });
    expect(classes(report, MODEL, 'app.py'), explain(report)).toEqual(['catalog']);
  });
});

describe('a model record the code reads', () => {
  const record = "const DEFAULT = { id: 'gpt-4', contextWindow: 8192 };\n";

  it.each([
    [
      'its id',
      `${record}export const go = () => client.chat.completions.create({ model: DEFAULT.id, messages: [] });\n`,
    ],
    [
      'its id by destructuring',
      `${record}const { id } = DEFAULT;\nexport const go = () => client.chat.completions.create({ model: id, messages: [] });\n`,
    ],
    [
      'a row of a list',
      "const MODELS = [{ id: 'gpt-4', contextWindow: 8192 }];\nexport const go = () => client.chat.completions.create({ model: MODELS[0].id, messages: [] });\n",
    ],
  ])('is unclear when it sends %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.ts': `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['unclear']);
  });

  it('is unclear when another file imports and sends its id', async () => {
    const report = await scan({
      ...OPENAI,
      'models.ts': "export const DEFAULT = { id: 'gpt-4', contextWindow: 8192 };\n",
      'a.ts': `${CLIENT}import { DEFAULT } from './models';\nexport const go = () => client.chat.completions.create({ model: DEFAULT.id, messages: [] });\n`,
    });
    expect(classes(report, MODEL, 'models.ts'), explain(report)).toEqual(['unclear']);
  });

  it.each([
    ['nothing reading it', record],
    ['a read of another key', `${record}export const size = DEFAULT.contextWindow;\n`],
    [
      'a lookup of another key',
      "const MODELS = [{ id: 'gpt-4', contextWindow: 8192 }];\nexport const size = (id) => MODELS.find((one) => one.id === id)?.contextWindow;\n",
    ],
  ])('stays catalog with %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.ts': `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
  });
});

describe('a type position', () => {
  const body =
    "const opts = { model: 'gpt-4', messages: [] };\nexport const go = () => client.chat.completions.create(opts);\n";

  it('is not reached across a line from an import type', async () => {
    for (const head of ["import type Foo from './foo';\n", "import type Foo from './foo'\n"]) {
      const report = await scan({ ...OPENAI, 'a.ts': `${CLIENT}${head}${body}` });
      expect(classes(report, MODEL), explain(report)).toEqual(['live']);
    }
  });

  it('is still one in an object type', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}export type Options = { model: 'gpt-4' };\n`,
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
  });
});

describe('a list named for what it denies', () => {
  it.each([
    [
      'indexed',
      "const legacy_model_options = ['gpt-4'];\nexport const go = () => client.chat.completions.create({ model: legacy_model_options[0], messages: [] });\n",
    ],
    [
      'walked',
      "const deprecatedModels = ['gpt-4'];\nfor (const m of deprecatedModels) client.chat.completions.create({ model: m, messages: [] });\n",
    ],
  ])('is unclear when the code reads it: %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.ts': `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['unclear']);
  });

  it('reads a Python loop over a picker list as a read, not a check', async () => {
    const report = await scan({
      ...OPENAI,
      'a.py':
        "import openai\nmodel_options = ['gpt-4']\nfor m in model_options:\n    openai.chat.completions.create(model=m)\n",
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it('stays catalog when the code only checks against it', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}const deprecatedModels = ['gpt-4'];\nexport const old = (m) => deprecatedModels.includes(m);\n`,
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
  });
});

describe('JSX text', () => {
  it.each([
    ['a.ts', "export const go = (r) => send(r as Req<Body>, 'gpt-4');\n"],
    [
      'a.tsx',
      "export const go = (r) => client.chat.completions.create({ ...(r as Req<Body>), model: 'gpt-4' });\n",
    ],
  ])('is not what follows a generic in %s', async (file, code) => {
    const report = await scan({ ...OPENAI, [file]: `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'after an opening tag',
      "const p = <td className=\"x\">the model (e.g., 'gpt-4', 'o1')</td>;\n",
    ],
    ['after a closing tag', "const p = <p><b>Model</b>, such as 'gpt-4', is fine</p>;\n"],
  ])('is still prose %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.tsx': code });
    expect(classes(report, MODEL), explain(report)).toEqual(['comment']);
  });
});

describe('a usage record', () => {
  it('does not cover the request inside it', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}export const go = async () => recordUsage(await client.chat.completions.create({ model: 'gpt-4', messages: [] }));\n`,
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it('still covers what it is handed directly', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}export const go = () => recordUsage({ model: 'gpt-4', tokens: 3 });\n`,
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
  });
});

describe('a function named for cost', () => {
  it('is unclear when its name is not a lookup', async () => {
    const report = await scan({
      ...OPENAI,
      'a.ts': `${CLIENT}export const go = () => withCostLimit('gpt-4', [], client);\n`,
    });
    expect(classes(report, MODEL), explain(report)).toEqual(['unclear']);
  });

  it.each(['calculateCost', 'getModelPricing', 'estimate_tokens_cost', 'priceFor', 'cost'])(
    'stays a lookup for %s',
    async (name) => {
      const report = await scan({
        ...OPENAI,
        'a.ts': `${CLIENT}export const c = ${name}('gpt-4', 3);\n`,
      });
      expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
    },
  );
});

describe('a constant that turns a branch off', () => {
  const call = "return client.chat.completions.create({ model: 'gpt-4', messages: [] });";

  it.each([
    [
      'in a sibling function',
      `function a() {\n  const enabled = false;\n  return enabled;\n}\nexport function b() {\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
    [
      'shadowed by a parameter',
      `const enabled = false;\nexport function b(enabled) {\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
    [
      'shadowed by a local',
      `const enabled = false;\nexport function b() {\n  const enabled = process.env.ON === '1';\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
    [
      'shadowed by an arrow parameter',
      `const enabled = false;\nexport const b = (enabled) => {\n  if (enabled) {\n    ${call}\n  }\n};\n`,
    ],
  ])('does not reach a guard when it is %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.js': `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it.each([
    [
      'at the top of the file',
      `const enabled = false;\nexport function b() {\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
    [
      'in the same function',
      `export function b() {\n  const enabled = false;\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
    [
      'with a guard before this one',
      `const enabled = false;\nexport function b() {\n  if (enabled) {\n    log();\n  }\n  if (enabled) {\n    ${call}\n  }\n}\n`,
    ],
  ])('still turns it off when it is %s', async (_, code) => {
    const report = await scan({ ...OPENAI, 'a.js': `${CLIENT}${code}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['catalog']);
  });
});

describe('build output', () => {
  const call = `${CLIENT}client.chat.completions.create({ model: 'gpt-4', messages: [] });\n`;

  it.each([
    ['// DO NOT EDIT the prompt below without asking Sam\n', ''],
    ['// see @generated files in dist for details\n', ''],
    ['// we used to hit a __commonJS bug here\n', ''],
    ['', '// the build appends # sourceMappingURL= here\n'],
  ])('is not a hand-written file using the words: %s%s', async (head, tail) => {
    const report = await scan({ ...OPENAI, 'src/index.ts': `${head}${call}${tail}` });
    expect(classes(report, MODEL), explain(report)).toEqual(['live']);
  });

  it('is not a source file with a map beside it', async () => {
    const report = await scan({ ...OPENAI, 'src/index.ts': call, 'src/index.ts.map': '{}' });
    expect(classes(report, MODEL, 'src/index.ts'), explain(report)).toEqual(['live']);
  });

  it.each([
    ['// Code generated by protoc-gen-go. DO NOT EDIT.\n', ''],
    ['// @generated by supabase\n', ''],
    ['/**\n * @generated SignedSource<<abc>>\n */\n', ''],
    ['// This file is @generated by Prisma\n', ''],
    ['// DO NOT EDIT\n', ''],
    ['# DO NOT EDIT THIS FILE!\n', ''],
    ['/* AUTO-GENERATED FILE. DO NOT EDIT. */\n', ''],
    ['// DO NOT EDIT: changes here are overwritten by the build\n', ''],
    ['var __commonJS = (cb) => cb;\n', ''],
    ['', '//# sourceMappingURL=index.js.map\n'],
  ])('still is one with a real marker: %s%s', async (head, tail) => {
    const report = await scan({ ...OPENAI, 'src/index.ts': `${head}${call}${tail}` });
    const found = report.details.filter((one) => one.file === 'src/index.ts');
    expect(found.length, explain(report)).toBeGreaterThan(0);
    expect(found.every((one) => one.vendored && !one.withFix)).toBe(true);
  });
});

describe('a path that looks like a test', () => {
  const code =
    "export const go = () => client.chat.completions.create({ model: 'gpt-4', messages: [] });\n";

  it.each([
    ['src/ab_test.ts', "import { go } from './ab_test';\n"],
    ['src/specs/run.ts', "import { go } from './specs/run';\n"],
    ['src/specs/index.ts', "import { go } from './specs';\n"],
    ['tests/helper.ts', "import { go } from '../tests/helper';\n"],
    ['src/specs/alias.ts', "import { go } from '@/specs/alias';\n"],
  ])('runs when running code imports it: %s', async (file, line) => {
    const report = await scan({
      ...OPENAI,
      [file]: `${CLIENT}${code}`,
      'src/index.ts': `${line}go();\n`,
      'src/a.ts': "import './b';\n",
      'src/b.ts': "import './c';\n",
      'src/c.ts': "import './index';\n",
    });
    expect(classes(report, MODEL, file), explain(report)).toEqual(['live']);
  });

  it('runs when running Python imports it', async () => {
    const report = await scan({
      'requirements.txt': 'openai\n',
      'tests/helper.py': 'import openai\nopenai.chat.completions.create(model="gpt-4")\n',
      'app.py': 'from tests.helper import go\ngo()\n',
    });
    expect(classes(report, MODEL, 'tests/helper.py'), explain(report)).toEqual(['live']);
  });

  it.each([
    ['nothing importing it', {}],
    ['only a test importing it', { 'tests/a.test.ts': "import { go } from './helper';\ngo();\n" }],
    ['a package of the same name', { 'src/index.ts': "import helper from 'helper';\nhelper();\n" }],
    ['a comment naming it', { 'src/index.ts': "// import { go } from '../tests/helper';\n" }],
    [
      "a test runner's config",
      { 'playwright.config.ts': "import { go } from './tests/helper';\n" },
    ],
  ])('stays a test with %s', async (_, others) => {
    const report = await scan({ ...OPENAI, 'tests/helper.ts': `${CLIENT}${code}`, ...others });
    expect(classes(report, MODEL, 'tests/helper.ts'), explain(report)).toEqual(['test']);
  });

  it('stays a test when a running script only names its path', async () => {
    const report = await scan({
      'requirements.txt': 'openai\n',
      'tests/helper.py': 'import openai\nopenai.chat.completions.create(model="gpt-4")\n',
      'run.py': 'import subprocess\nsubprocess.run(["pytest", "tests/helper.py"])\n',
    });
    expect(classes(report, MODEL, 'tests/helper.py'), explain(report)).toEqual(['test']);
  });

  it('stays a test when running Python has its own module of that name', async () => {
    const report = await scan({
      'requirements.txt': 'openai\n',
      'tests/utils.py': 'import openai\nopenai.chat.completions.create(model="gpt-4")\n',
      'utils.py': 'x = 1\n',
      'app.py': 'import utils\n',
    });
    expect(classes(report, MODEL, 'tests/utils.py'), explain(report)).toEqual(['test']);
  });

  it('is unclear in a docs app, and a test in a docs folder', async () => {
    const report = await scan({
      ...OPENAI,
      'apps/docs/lib/ask.ts': `${CLIENT}${code}`,
      'apps/docs/app/page.tsx': "import { go } from '../lib/ask';\nexport default go;\n",
      'docs/ask.ts': `${CLIENT}${code}`,
    });
    expect(classes(report, MODEL, 'apps/docs/lib/ask.ts'), explain(report)).toEqual(['unclear']);
    expect(classes(report, MODEL, 'docs/ask.ts'), explain(report)).toEqual(['test']);
  });

  it("reads a repo's own action as CI, whatever it's called", async () => {
    const report = await scan({
      '.github/actions/test/action.yml': 'runs:\n  steps:\n    - uses: actions/cache@v3.0.0\n',
    });
    expect(
      classes(report, 'GH-6.cache-old-pins', '.github/actions/test/action.yml'),
      explain(report),
    ).toEqual(['live']);
  });
});

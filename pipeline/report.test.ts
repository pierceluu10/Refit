import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import type { Inventory } from './inventory.ts';
import {
  buildReport,
  renderReport,
  REPORT_CHARACTER_BUDGET,
  REPORT_MARKER,
  reportDigest,
} from './report.ts';

const execute = promisify(execFile);
// The day the fixtures were scanned: OpenAI's 2026-10-23 shutdowns are one day away.
const NOW = new Date('2026-10-22T12:00:00Z');
// Inventories of frozen benchmark repositories at their pinned commits; each names its source.
const SHAPES = [
  'stripe-affected',
  'openai-near-shutdown',
  'anthropic-app',
  'shopify-app',
  'monorepo',
  'nothing-found',
];
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(name: string, now = NOW) {
  const { source, inventory } = JSON.parse(
    await readFile(new URL(`./fixtures/report/${name}.json`, import.meta.url), 'utf8'),
  ) as { source: { repository: string; commit: string }; inventory: Inventory };
  // A pinned copy of the registry, so registry edits do not change the recorded reports.
  const registry = await loadDeadlineRegistry(
    new URL('./fixtures/report/registry.json', import.meta.url),
    NOW,
  );
  const build = (changed = inventory, at = now) =>
    buildReport({
      inventory: changed,
      registry,
      repository: source.repository,
      revision: source.commit,
      now: at,
    });
  return { inventory, registry, build, report: build() };
}

it.each(SHAPES)('renders the %s report as recorded', async (name) => {
  const { report } = await fixture(name);
  const markdown = renderReport(report);
  expect(markdown.startsWith(`${REPORT_MARKER}\n`)).toBe(true);
  expect(markdown.length).toBeLessThanOrEqual(REPORT_CHARACTER_BUDGET);
  await expect(markdown).toMatchFileSnapshot(`./fixtures/report/${name}.md`);
  await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
    `./fixtures/report/${name}.report.json`,
  );
});

it('reports what each real shape depends on and what Refit can do for it', async () => {
  const stripe = (await fixture('stripe-affected')).report;
  expect(stripe.integrations.map((item) => [item.provider, item.capability])).toEqual([
    ['stripe', 'migrate'],
    ['openai', 'migrate'],
    ['gemini', 'report-only'],
  ]);
  expect(stripe.integrations[0]).toMatchObject({
    configured: false,
    packages: [{ file: 'package.json', name: 'stripe', declared: '^18.2.1', locked: '18.2.1' }],
    apiVersions: [{ file: 'server/index.js', value: '2023-10-16' }],
  });

  const openai = (await fixture('openai-near-shutdown')).report;
  const nano = openai.deadlines.find((deadline) => deadline.versions.includes('gpt-4.1-nano'))!;
  expect(nano).toMatchObject({ date: '2026-10-23', days: 1, ignored: false });
  expect(nano.evidence).toHaveLength(8);
  // A retired model comes before the SDK's end of support; the others are counted.
  expect(openai.next).toMatch(
    /^Move off `claude-sonnet-4-20250514` now: its sunset was 2026-06-15 \(passed 129 days ago\)\. Replacement: `claude-sonnet-5-5`; `refit deadlines --propose-model-fixes` proposes it/,
  );
  expect(openai.next).toContain('2 more deadlines are past due or within 30 days');
  // Every call passes a computed model, so each provider gets one group.
  expect(openai.models.map((group) => [group.model, group.provider, group.calls.length])).toEqual([
    [null, 'anthropic', 3],
    [null, 'openai', 6],
  ]);

  const anthropic = (await fixture('anthropic-app')).report;
  expect(anthropic.integrations.find((item) => item.provider === 'anthropic')?.capability).toBe(
    'model-fixes',
  );
  expect(anthropic.models).toEqual([
    {
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      calls: [expect.objectContaining({ file: 'src/agent/core/title.ts', test: false })],
    },
  ]);

  const shopify = (await fixture('shopify-app')).report;
  expect(shopify.integrations).toEqual([
    expect.objectContaining({ provider: 'shopify', capability: 'migrate', configured: false }),
  ]);
  expect(shopify.deadlines.map((deadline) => deadline.id)).toEqual(['shopify-admin-2026-01']);

  const monorepo = (await fixture('monorepo')).report;
  expect(
    monorepo.integrations.map((item) => [item.provider, item.packages.map((pkg) => pkg.file)]),
  ).toEqual([
    ['stripe', ['packages/stripe/package.json']],
    ['resend', ['apps/web/package.json', 'packages/emails/package.json']],
  ]);
  expect(monorepo.deadlines).toEqual([]);
  expect(monorepo.mentions).toEqual(['openai-2027-04-01-gpt-5-1']);
  expect(monorepo.next).toBe(
    'Add the Stripe agent with `refit agents --add stripe` and approve the repository, so Refit can propose migrations for its breaking changes.',
  );

  const nothing = (await fixture('nothing-found')).report;
  expect(nothing).toMatchObject({ integrations: [], deadlines: [], models: [], untracked: [] });
  expect(nothing.next).toBe(
    'Nothing to do. Refit found no provider SDK or API it knows in this repository.',
  );
});

it('names the configured integration and lists hosts of providers Refit does not track', async () => {
  const { inventory, build } = await fixture('monorepo');
  const report = build({
    ...inventory,
    providers: [
      ...inventory.providers,
      {
        id: 'twilio',
        name: 'Twilio',
        agent: false,
        packages: [],
        hostnames: [{ file: 'src/sms.ts', line: 4, hostname: 'api.twilio.com' }],
      },
    ],
    integrations: [{ agent: 'stripe', integration: 'billing', apiVersion: null }],
  });
  expect(report.integrations[0]).toMatchObject({ configured: true, integration: 'billing' });
  expect(report.untracked).toEqual([
    {
      provider: 'twilio',
      name: 'Twilio',
      hosts: [{ hostname: 'api.twilio.com', file: 'src/sms.ts', line: 4 }],
    },
  ]);
  const markdown = renderReport(report);
  expect(markdown).toContain('Migrates breaking changes, configured as `billing`');
  expect(markdown).toContain('| Twilio | API hosts only |  |  | Reports only |');
  expect(markdown).toContain('- Twilio: `api.twilio.com` at `src/sms.ts:4`');
  expect(report.next).toMatch(/^Nothing to do now\. Configured integrations/);
});

it('honours an active ignore in the next step but not an expired one or a broken file', async () => {
  const { inventory, build } = await fixture('anthropic-app');
  const ignore = (until: string, error: string | null = null) =>
    build({
      ...inventory,
      ignores: {
        file: '.refit-deadlines-ignore.json',
        entries: [
          {
            deadline: 'anthropic-2026-06-15-claude-sonnet-4',
            reason: 'Fallback path only.',
            until,
            paths: null,
          },
        ],
        error,
      },
    });
  const ignored = ignore('2027-01-01');
  expect(ignored.deadlines.map((deadline) => [deadline.id, deadline.ignored])).toEqual([
    ['anthropic-2026-06-15-claude-sonnet-4', true],
    ['anthropic-2026-11-30-claude-sonnet-4-5', false],
  ]);
  expect(ignored.next).toMatch(/^Plan to move off `claude-sonnet-4-5` before 2026-11-30/);
  expect(renderReport(ignored)).toContain('Accepted by the committed ignore file.');
  expect(ignore('2026-10-01').deadlines[0].ignored).toBe(false);
  expect(ignore('2027-01-01', 'Invalid ignore file.').deadlines[0].ignored).toBe(false);
});

it('keeps the markdown within the issue budget and says what it left out', async () => {
  const { inventory, build } = await fixture('openai-near-shutdown');
  const [exposure] = inventory.deadlines.exposures;
  const long = `src/${'x'.repeat(500)}.ts`;
  const report = build({
    ...inventory,
    deadlines: {
      ...inventory.deadlines,
      exposures: Array.from({ length: 70 }, (_, index) => ({
        ...exposure,
        deadline: { ...exposure.deadline, id: `deadline-${index}` },
        evidence: Array.from({ length: 7 }, (__, line) => ({
          ...exposure.evidence[0],
          file: long,
          line: line + 1,
        })),
        more: 3,
      })),
    },
    models: Array.from({ length: 60 }, (_, model) =>
      Array.from({ length: 12 }, (__, call) => ({
        provider: 'openai' as const,
        file: `src/model-${model}.ts`,
        line: call + 1,
        call: 'chat.completions.create',
        model: `model-${String(model).padStart(2, '0')}`,
        test: false,
      })),
    ).flat(),
  });
  const markdown = renderReport(report);
  console.log(`Truncated markdown: ${markdown.length} characters`);
  expect(markdown.length).toBeLessThanOrEqual(REPORT_CHARACTER_BUDGET);
  expect(markdown).toMatch(
    /\n\n_Truncated to 60,000 characters\. Run `refit report --format json` for everything\._$/,
  );
  expect(markdown).toContain('  - …and 2 more lines.');
  expect(markdown).toContain('  - …and 3 more matches.');

  const models = renderReport({ ...report, deadlines: [] });
  expect(models.length).toBeLessThan(REPORT_CHARACTER_BUDGET);
  expect(models).toContain('- `model-00` (openai, 12 calls)');
  expect(models).toContain('  - …and 2 more calls.');
  expect(models).toContain('- …and 10 more models.');
  expect(models).not.toContain('_Truncated');
});

it('shows code exactly, even when it contains backticks or pipes', async () => {
  const { inventory, build } = await fixture('anthropic-app');
  const [exposure] = inventory.deadlines.exposures;
  const report = build({
    ...inventory,
    deadlines: {
      ...inventory.deadlines,
      exposures: [
        { ...exposure, evidence: [{ ...exposure.evidence[0], file: 'src/a`x`+``y``.ts' }] },
      ],
    },
    providers: [
      {
        ...inventory.providers[0],
        packages: [{ ...inventory.providers[0].packages[0], version: '^4 || ^5' }],
      },
    ],
  });
  const markdown = renderReport(report);
  expect(markdown).toContain('``` src/a`x`+``y``.ts:');
  expect(markdown).toContain('`^4 \\|\\| ^5`');
});

it('changes its digest when the report changes, not every day', async () => {
  const { inventory, build } = await fixture('anthropic-app');
  const at = (date: string) => reportDigest(build(inventory, new Date(`${date}T12:00:00Z`)));
  // claude-sonnet-4-5 retires on 2026-11-30: 39 and 36 days away share the 90-day stage.
  expect(at('2026-10-25')).toBe(at('2026-10-22'));
  expect(at('2026-11-01')).not.toBe(at('2026-10-22'));
  // A push that only moves code (new revision, other line numbers) keeps the digest; a new call
  // changes it.
  const [model] = inventory.models;
  expect(
    reportDigest({
      ...build({ ...inventory, models: [{ ...model, line: model.line + 40 }] }),
      revision: 'f'.repeat(40),
    }),
  ).toBe(reportDigest(build({ ...inventory, models: [model] })));
  expect(
    reportDigest(
      build({
        ...inventory,
        models: [...inventory.models, { ...model, file: 'src/added.ts' }],
      }),
    ),
  ).not.toBe(at('2026-10-22'));
});

it('prints the report of a local repository from the command line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-report-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ dependencies: { openai: '^4.20.0' } }),
    'src/chat.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "export const reply = () => openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
    ].join('\n'),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const run = (...args: string[]) =>
    execute(process.execPath, ['bin/refit.mjs', 'report', '--repository', root, ...args]);
  const json = JSON.parse((await run('--format', 'json')).stdout);
  expect(json).toMatchObject({
    formatVersion: 1,
    revision: null,
    integrations: [{ provider: 'openai', capability: 'migrate' }],
    models: [{ model: 'gpt-4', provider: 'openai', calls: [{ file: 'src/chat.ts', line: 3 }] }],
  });
  const markdown = (await run()).stdout;
  expect(markdown.startsWith(REPORT_MARKER)).toBe(true);
  expect(markdown).toContain('- `gpt-4` (openai, 1 call)');
  await expect(run('--format', 'yaml')).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--format must be markdown or json.'),
  });
});

it('lists matches outside application code apart, as not counted', async () => {
  const { report } = await fixture('nothing-found');
  const markdown = renderReport({
    ...report,
    outside: [
      {
        id: 'openai-2026-07-14-gpt-4-5-preview',
        file: 'examples/chat.ts',
        line: 3,
        version: 'gpt-4.5-preview',
        reason: 'example',
      },
    ],
  });
  expect(markdown).toContain(
    'Also found outside application code (not counted):\n\n- `examples/chat.ts:3` (example): `gpt-4.5-preview` for `openai-2026-07-14-gpt-4-5-preview`',
  );
});

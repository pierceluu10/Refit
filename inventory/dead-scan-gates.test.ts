// Version gates and list matchers that once hid live code or flagged the wrong code. Each case pairs
// what must flag with the false alarm or the safe result the rule exists for.
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchClass } from '../shared/types.ts';
import { entriesInForce, loadDeadApis } from '../dead-apis/list.ts';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';
const PERIOD_END = 'ST-1.current_period_end';
const stripeManifest = (range: string) => JSON.stringify({ dependencies: { stripe: range } });
const READ =
  'const subscription = await client.subscriptions.retrieve(id);\nconsole.log(subscription.current_period_end);\n';
const pinned = (name: string) =>
  `import Stripe from 'stripe';\nexport const ${name} = new Stripe('k', { apiVersion: '2024-06-20' });\n`;

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
  return [
    ...report.details.map(
      (one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`,
    ),
    ...report.quiet.map((one) => `quiet ${one.entryId} ${one.file}:${one.line} ${one.reason}`),
  ].join('\n');
}

const classes = (report: DeadScanReport, entryId: string, file: string): MatchClass[] =>
  report.details
    .filter((one) => one.entryId === entryId && one.file === file)
    .map((one) => one.matchClass);

const quietIn = (report: DeadScanReport, entryId: string, file: string) =>
  report.quiet.filter((one) => one.entryId === entryId && one.file === file).length;

describe('a pin only speaks for its own client', () => {
  const unpinned = (options = '') =>
    `import Stripe from 'stripe';\nconst client = new Stripe('x'${options});\n${READ}`;

  it.each([
    ['no options', ''],
    ['options with no version', ', { maxNetworkRetries: 2 }'],
  ])("flags a file's unpinned client on the SDK past the removal: %s", async (_name, options) => {
    const report = await scan({
      'package.json': stripeManifest('18.0.0'),
      'src/a.ts': pinned('a'),
      'src/index.ts': unpinned(options),
    });
    expect(classes(report, PERIOD_END, 'src/index.ts'), explain(report)).not.toEqual([]);
    expect(report.clean, explain(report)).toBe(false);
    expect(quietIn(report, PERIOD_END, 'src/index.ts'), explain(report)).toBe(0);
  });

  it("clears a file's unpinned client on an SDK below the removal, whatever another file pins", async () => {
    const report = await scan({
      'package.json': stripeManifest('17.0.0'),
      'src/a.ts':
        "import Stripe from 'stripe';\nexport const a = new Stripe('k', { apiVersion: '2025-03-31.basil' });\n",
      'src/index.ts': unpinned(),
    });
    expect(quietIn(report, PERIOD_END, 'src/index.ts'), explain(report)).toBe(1);
  });

  it('leaves a pinned and an unpinned client in one file unclear when they disagree', async () => {
    const report = await scan({
      'package.json': stripeManifest('18.0.0'),
      'src/index.ts': `${pinned('a')}const client = new Stripe('x');\n${READ}`,
    });
    expect(classes(report, PERIOD_END, 'src/index.ts'), explain(report)).toEqual(['unclear']);
  });

  it('stays quiet on a read through a pinned client, the only one in the package', async () => {
    const report = await scan({
      'package.json': stripeManifest('18.0.0'),
      'src/a.ts': pinned('client'),
      'src/index.ts': `import { client } from './a';\n${READ}`,
    });
    expect(quietIn(report, PERIOD_END, 'src/index.ts'), explain(report)).toBe(1);
    expect(report.clean, explain(report)).toBe(true);
  });

  it('takes options held in a variable as maybe pinning, so the pin beside them still counts', async () => {
    const report = await scan({
      'package.json': stripeManifest('18.0.0'),
      'src/index.ts': `import Stripe from 'stripe';\nconst options = { apiVersion: '2024-06-20' };\nconst client = new Stripe('x', options);\n${READ}`,
    });
    expect(quietIn(report, PERIOD_END, 'src/index.ts'), explain(report)).toBe(1);
  });
});

describe('an SDK version speaks for its own language', () => {
  const python =
    'import stripe\nsubscription = stripe.Subscription.retrieve(id)\nprint(subscription.current_period_end)\n';
  const notebook = JSON.stringify({
    cells: [{ cell_type: 'code', source: python.split(/(?<=\n)/) }],
    metadata: { kernelspec: { language: 'python' } },
  });

  it.each([
    [
      'Ruby',
      'app.rb',
      "require 'stripe'\nsubscription = Stripe::Subscription.retrieve(id)\nputs subscription.current_period_end\n",
    ],
    ['Go', 'app.go', 'package main\nfunc f() { _ = subscription.current_period_end }\n'],
  ])('leaves %s unclear beside an npm SDK below the removal', async (_name, file, code) => {
    const report = await scan({ 'package.json': stripeManifest('^17.0.0'), [file]: code });
    expect(quietIn(report, PERIOD_END, file), explain(report)).toBe(0);
    expect(
      report.details.some((one) => one.file === file),
      explain(report),
    ).toBe(true);
  });

  it("reads a notebook on the Python SDK, not the frontend's", async () => {
    const report = await scan({
      'package.json': stripeManifest('^17.0.0'),
      'requirements.txt': 'stripe==12.0.0\n',
      'n.ipynb': notebook,
    });
    expect(quietIn(report, PERIOD_END, 'n.ipynb'), explain(report)).toBe(0);
    expect(report.clean, explain(report)).toBe(false);
  });

  it('still clears JavaScript on the npm SDK below the removal', async () => {
    const report = await scan({
      'package.json': stripeManifest('^17.0.0'),
      'a.ts': `import Stripe from 'stripe';\nconst client = new Stripe('x');\n${READ}`,
    });
    expect(quietIn(report, PERIOD_END, 'a.ts'), explain(report)).toBe(1);
  });
});

describe('a prerelease tag in a range', () => {
  const code = `import Stripe from 'stripe';\nconst client = new Stripe('x');\n${READ}`;

  it.each([
    '>=17.0.0-beta.1',
    '>=17.0.0-rc.2',
    '>=17.0.0rc1',
    '>=17.0.0-beta.1 <20',
    '<20.0.0-rc.1',
  ])("doesn't close the range %s", async (range) => {
    const report = await scan({ 'package.json': stripeManifest(range), 'a.ts': code });
    expect(classes(report, PERIOD_END, 'a.ts'), explain(report)).toEqual(['unclear']);
  });

  it('still clears a tagged range that ends below the removal', async () => {
    const report = await scan({ 'package.json': stripeManifest('^17.0.0-beta.1'), 'a.ts': code });
    expect(quietIn(report, PERIOD_END, 'a.ts'), explain(report)).toBe(1);
  });
});

describe('list matchers', () => {
  const dropboxUpload =
    "import dropbox\ndbx = dropbox.Dropbox(TOKEN)\ndbx.files_upload(data, '/a.txt')\n";

  it("sends Dropbox's files_upload to the check, and keeps Slack's live", async () => {
    const report = await scan({
      'requirements.txt': 'dropbox==12.0.2\nslack_sdk==3.33.0\n',
      'up.py': dropboxUpload,
      'slack.py':
        'from slack_sdk import WebClient\nclient = WebClient(t)\nclient.files_upload(file=f)\n',
    });
    expect(classes(report, 'SL-1.files-upload', 'up.py'), explain(report)).toEqual(['unclear']);
    expect(classes(report, 'SL-1.files-upload', 'slack.py'), explain(report)).toEqual(['live']);
  });

  it("flags a monday query's items, and not an app's own boards object", async () => {
    const report = await scan({
      'm.js': "fetch('https://api.monday.com/v2', { method: 'POST' });\n",
      'board.js':
        'export const boards = { items: [] };\nexport const groups = { items: [1, 2] };\nconst state = { boards: { items, loading: false } };\n',
      'query.js': 'export const query = `query { boards(limit: 1) { items { id } } }`;\n',
    });
    expect(classes(report, 'MO-2.boards-items', 'board.js'), explain(report)).toEqual([]);
    expect(classes(report, 'MO-2.boards-items', 'query.js'), explain(report)).toEqual(['live']);
  });

  it("sees Perplexity's name behind LiteLLM's prefix, and not a live name beside it", async () => {
    const report = await scan({
      'requirements.txt': 'litellm==1.50.0\n',
      'a.py':
        "import litellm\nlitellm.completion(model='perplexity/sonar-reasoning', messages=m)\n",
      'b.py':
        "import litellm\nlitellm.completion(model='perplexity/sonar-reasoning-pro', messages=m)\n",
    });
    expect(classes(report, 'PX-4.sonar-reasoning', 'a.py'), explain(report)).toEqual(['unclear']);
    expect(classes(report, 'PX-4.sonar-reasoning', 'b.py'), explain(report)).toEqual([]);
  });

  it('treats a dependency a read named as unclear, and a hand-written one as live', async () => {
    const list = (ambiguous: boolean) => ({
      version: 'test',
      future: [],
      entries: [
        {
          id: 'AC-100.shutdown',
          provider: 'acme',
          what: 'Acme SDK shut down',
          diedOn: '2026-01-15',
          source: {
            url: 'https://docs.acme.dev/x',
            checkedOn: TODAY,
            quote: 'acme-sdk was shut down',
          },
          lookFor: ['acme-sdk'],
          matchers: [
            { kind: 'package' as const, value: 'acme-sdk', ...(ambiguous ? { ambiguous } : {}) },
          ],
          replacement: 'none',
          requires: [],
        },
      ],
    });
    const repoDir = await makeRepo({
      'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.0.0' } }),
      'a.js': "import x from 'acme-sdk';\n",
    });
    repos.push(repoDir);
    const fromRead = await scanDeadApis(repoDir, 'test/repo', { today: TODAY, list: list(true) });
    expect(
      fromRead.details.map((one) => one.matchClass),
      explain(fromRead),
    ).toEqual(['unclear', 'unclear']);
    expect(fromRead.details.some((one) => one.withFix)).toBe(false);
    const written = await scanDeadApis(repoDir, 'test/repo', { today: TODAY, list: list(false) });
    expect(
      written.details.map((one) => one.matchClass),
      explain(written),
    ).toEqual(['live', 'live']);
  });
});

describe('the list on what it holds', () => {
  it("flags OpenRouter's claude-sonnet-4, which has no endpoints, and not what replaces it", async () => {
    const client =
      "import OpenAI from 'openai';\nconst c = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\n";
    const report = await scan({
      'package.json': JSON.stringify({ dependencies: { openai: '^6.0.0' } }),
      'a.ts': `${client}c.chat.completions.create({ model: 'anthropic/claude-sonnet-4' });\n`,
      'b.ts': `${client}c.chat.completions.create({ model: 'anthropic/claude-sonnet-4.6' });\n`,
    });
    expect(classes(report, 'OR-1.anthropic-claude-sonnet-4', 'a.ts'), explain(report)).toEqual([
      'live',
    ]);
    expect(
      report.details.filter((one) => one.file === 'b.ts'),
      explain(report),
    ).toEqual([]);
    const moved = loadDeadApis().entries.find((one) => one.id === 'OR-2.anthropic-claude-4-sonnet');
    expect(moved?.replacementIds).toEqual(['anthropic/claude-sonnet-4.6']);
  });

  it('holds the Kimi models the page dates to the end of 2026, and waits for a read to flag them', () => {
    const list = loadDeadApis();
    const held = list.future.find((one) =>
      one.matchers.some((matcher) => matcher.value === 'kimi-k2.6'),
    );
    expect(held?.earliest).toBe(true);
    expect(held?.diesOn).toBe('2026-12-31');
    const after = entriesInForce(list, '2027-02-01');
    expect(after.some((one) => one.id === held?.id)).toBe(false);
  });
});

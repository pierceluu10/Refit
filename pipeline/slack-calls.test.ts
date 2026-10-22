import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { deadlineTitle } from './deadline-alerts.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { checkDeadlineRegistry, loadDeadlineRegistry } from './deadline-registry.ts';
import { detectProviders } from './agent-catalog.ts';
import { loadSlackMethods, scanSlackCalls, type SlackCall } from './slack-calls.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const NOW = new Date('2026-10-22T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, manifest: object = { name: 'app' }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-slack-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(manifest, null, 2),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function calls(files: Record<string, string>, manifest?: object) {
  return (await scanSlackCalls(await repository(files, manifest))).calls;
}

function at(found: SlackCall[], file: string, line: number) {
  const call = found.find((item) => item.file === file && item.line === line);
  expect(call, `${file}:${line}`).toBeDefined();
  return call!;
}

function summary(found: SlackCall[]) {
  return found.map((call) => `${call.file}:${call.line} ${call.kind} ${call.methods.join('+')}`);
}

describe('recorded methods', () => {
  it('pins the releases, removals and deprecations read from Slack SDK sources', async () => {
    const data = await loadSlackMethods();
    expect(data.releases).toEqual(['5.15.0', '6.13.0', '7.19.0', '8.2.0']);
    expect(data.properties.get('chat.postMessage')?.methods).toEqual(['chat.postMessage']);
    expect(data.properties.get('files.uploadV2')?.methods).toEqual([
      'files.getUploadURLExternal',
      'files.completeUploadExternal',
    ]);
    expect([...data.removed.keys()]).toEqual([
      'files.upload',
      'rtm.start',
      'workflows.stepCompleted',
      'workflows.stepFailed',
      'workflows.updateStep',
    ]);
    expect(data.deprecations.map((item) => item.prefixes)).toEqual([
      ['channels.', 'groups.', 'im.', 'mpim.', 'admin.conversations.whitelist.'],
      ['stars.'],
      ['workflows.stepCompleted', 'workflows.updateStep', 'workflows.stepFailed'],
    ]);
    // The conversations antecedents left the SDK after 6.x.
    expect(data.properties.get('channels.list')?.releases).toEqual(['5.15.0', '6.13.0']);
  });
});

describe('@slack/web-api', () => {
  it('reads WebClient calls through variables, class properties and namespaces', async () => {
    const found = await calls({
      'src/web.ts': `import { WebClient } from '@slack/web-api';
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
export const post = () => client.chat.postMessage({ channel: 'C1', text: 'hi' });
export class Notifier {
  private web = new WebClient();
  other: WebClient;
  constructor() { this.other = new WebClient(); }
  send() { return this.web.conversations.history({ channel: 'C1' }); }
  invite() { return this.other.admin.users.invite({}); }
}
`,
      'src/require.js': `const slack = require('@slack/web-api');
const web = new slack.WebClient(token);
web.users.lookupByEmail({ email });
const { WebClient: Client } = require('@slack/web-api');
new Client(token).reactions.add({});
`,
    });
    expect(summary(found)).toEqual([
      'src/require.js:3 web-api users.lookupByEmail',
      'src/require.js:5 web-api reactions.add',
      'src/web.ts:3 web-api chat.postMessage',
      'src/web.ts:8 web-api conversations.history',
      'src/web.ts:9 web-api admin.users.invite',
    ]);
    expect(found.every((call) => !call.deprecation && !call.notes.length)).toBe(true);
    expect(at(found, 'src/web.ts', 3).client).toBe('client.chat.postMessage');
  });

  it('reads apiCall, paginate and filesUploadV2, and marks runtime method names unknown', async () => {
    const found = await calls({
      'app.js': `import { WebClient } from '@slack/web-api';
const client = new WebClient();
const METHOD = 'users.list';
client.apiCall('stars.add', {});
client.paginate(METHOD, {});
client.apiCall(name, {});
client.filesUploadV2({ file: 'a.png' });
client.on('rate_limited', () => {});
`,
    });
    expect(summary(found)).toEqual([
      'app.js:4 web-api stars.add',
      'app.js:5 web-api users.list',
      'app.js:6 web-api ',
      'app.js:7 web-api files.getUploadURLExternal+files.completeUploadExternal',
    ]);
    expect(at(found, 'app.js', 6).unknown).toEqual(['the method is chosen at runtime from `name`']);
    expect(at(found, 'app.js', 4).deprecation).toEqual({
      method: 'stars.add',
      reason:
        'Stars can still be added but they can no longer be viewed or interacted with by end-users. See our post on stars and the Later list.',
      announcement:
        'https://docs.slack.dev/changelog/2023-07-its-later-already-for-stars-and-reminders/',
    });
  });

  it('reports deprecated, removed and unrecorded methods with their sources', async () => {
    const found = await calls({
      'bot.js': `const { WebClient } = require('@slack/client');
const web = new WebClient(token);
web.channels.list();
web.files.upload({ channels: 'C1', file });
web.rtm.start();
web.oauth.access({ code });
web.chat.inventMessage({});
`,
    });
    expect(at(found, 'bot.js', 3).deprecation).toEqual({
      method: 'channels.list',
      reason: "Slack's SDKs warn that this method is deprecated",
      announcement:
        'https://docs.slack.dev/changelog/2020-01-deprecating-antecedents-to-the-conversations-api/',
    });
    expect(at(found, 'bot.js', 3).notes).toEqual([
      '`channels.list` is not in @slack/web-api 8.2.0; the last recorded release with it is 6.13.0',
    ]);
    expect(at(found, 'bot.js', 4).deprecation?.announcement).toBe(
      'https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay',
    );
    expect(at(found, 'bot.js', 4).notes).toEqual([
      '`files.upload` is removed from @slack/web-api 8; Slack names `filesUploadV2` as its replacement',
    ]);
    expect(at(found, 'bot.js', 5).notes).toEqual([
      '`rtm.start` is removed from @slack/web-api 8; Slack names `rtm.connect` as its replacement',
    ]);
    expect(at(found, 'bot.js', 6).deprecation?.reason).toBe(
      'This is a legacy method only used by classic Slack apps. Use `oauth.v2.access` for new Slack apps.',
    );
    expect(at(found, 'bot.js', 7).notes).toEqual([
      '`chat.inventMessage` is not a method of any recorded @slack/web-api release (5.15.0 to 8.2.0)',
    ]);
  });

  it('ignores clients from other modules, shadowed names and comments', async () => {
    const found = await calls({
      'src/other.ts': `import { WebClient } from './my-slack';
const client = new WebClient();
client.chat.postMessage({});
`,
      'src/shadow.ts': `import { WebClient } from '@slack/web-api';
const client = new WebClient();
function send(client) { return client.chat.postMessage({}); }
// client.chat.postMessage({ text: 'in a comment' });
`,
    });
    expect(found).toEqual([]);
  });
});

describe('@slack/bolt', () => {
  it('reads app.client and the client handlers receive', async () => {
    const found = await calls({
      'src/app.ts': `import { App } from '@slack/bolt';
const app = new App({ token, signingSecret });
app.command('/ticket', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({ trigger_id: body.trigger_id, view });
});
app.event('app_home_opened', async ({ event, client: web }) => {
  await web.views.publish({ user_id: event.user, view });
});
export const handler = async ({ client, logger }) => client.chat.update({});
(async () => { await app.client.chat.postMessage({ channel, text }); })();
app.step(workflowStep);
`,
    });
    expect(summary(found)).toEqual([
      'src/app.ts:5 bolt views.open',
      'src/app.ts:8 bolt views.publish',
      'src/app.ts:10 bolt chat.update',
      'src/app.ts:11 bolt chat.postMessage',
    ]);
    expect(at(found, 'src/app.ts', 11).client).toBe('app.client.chat.postMessage');
  });

  it('reads parameters typed WebClient', async () => {
    const found = await calls({
      'src/send.ts': `import type { WebClient } from '@slack/web-api';
export async function send(web: WebClient, other: Other) {
  await web.chat.postEphemeral({});
  await other.chat.postMessage({});
}
`,
    });
    expect(summary(found)).toEqual(['src/send.ts:3 web-api chat.postEphemeral']);
  });

  it('does not treat a destructured client as Slack outside Bolt files', async () => {
    expect(
      await calls({ 'src/db.ts': 'export const run = ({ client }) => client.query.raw();\n' }),
    ).toEqual([]);
  });
});

describe('raw Web API requests', () => {
  it('reads the method from literal, constant and template URLs', async () => {
    const found = await calls({
      'src/raw.js': `import axios from 'axios';
const SLACK_API = 'https://slack.com/api';
const POST = \`\${SLACK_API}/chat.postMessage\`;
export async function run(method) {
  await fetch('https://slack.com/api/conversations.history?channel=C1');
  await fetch(\`\${SLACK_API}/users.info\`, { method: 'POST' });
  await axios.post(POST, body);
  await axios.post('https://slack.com/api/' + method, body);
  await fetch(\`https://acme.slack.com/api/\${method}\`);
  await got.post('https://hooks.slack.com/services/T0/B0/X');
  await slackGet(SLACK_API);
}
`,
    });
    expect(summary(found)).toEqual([
      'src/raw.js:5 url conversations.history',
      'src/raw.js:6 url users.info',
      'src/raw.js:7 url chat.postMessage',
      'src/raw.js:8 url ',
      'src/raw.js:9 url ',
      'src/raw.js:11 url ',
    ]);
    expect(at(found, 'src/raw.js', 8).unknown).toEqual([
      'the method is chosen at runtime from `method`',
    ]);
    expect(at(found, 'src/raw.js', 11).unknown).toEqual([
      'the base URL is passed to `slackGet`; the methods called through it are not traced',
    ]);
    expect(at(found, 'src/raw.js', 7).client).toBe('axios.post');
  });

  it('separates tests from live code', async () => {
    const found = await calls({
      'test/api.test.js': "fetch('https://slack.com/api/auth.test');\n",
      'src/api.js': "fetch('https://slack.com/api/im.list');\n",
    });
    expect(found.map((call) => [call.file, call.use])).toEqual([
      ['src/api.js', 'live'],
      ['test/api.test.js', 'test'],
    ]);
    expect(at(found, 'src/api.js', 1).deprecation?.announcement).toContain(
      '2020-01-deprecating-antecedents-to-the-conversations-api',
    );
  });
});

describe('inventory and deadlines', () => {
  it('lists package declarations and the catalog detects Slack', async () => {
    const manifest = {
      name: 'app',
      dependencies: { '@slack/bolt': '^4.1.0', '@slack/client': '4.12.0' },
    };
    const root = await repository(
      { 'src/a.js': "fetch('https://slack.com/api/auth.test');\n" },
      manifest,
    );
    const scan = await scanSlackCalls(root);
    expect(scan.packages.map((item) => `${item.name}@${item.declared}`)).toEqual([
      '@slack/bolt@^4.1.0',
      '@slack/client@4.12.0',
    ]);
    const slack = (await detectProviders(root)).find((item) => item.agent.id === 'slack');
    expect(slack?.packages.map((item) => item.name)).toEqual(['@slack/bolt', '@slack/client']);
    expect(slack?.hostnames).toEqual([{ file: 'src/a.js', line: 1, hostname: 'slack.com/api' }]);
  });

  it('matches retired methods in the registry with file and line', async () => {
    const root = await repository({
      'src/upload.js': `const { WebClient } = require('@slack/web-api');
const web = new WebClient(token);
web.files.upload({ file });
web.workflows.updateStep({});
`,
      'test/upload.test.js': "fetch('https://slack.com/api/files.upload');\n",
    });
    const scan = await scanDeadlines(root, await loadDeadlineRegistry(), NOW);
    expect(
      scan.exposures.map((exposure) => [
        exposure.deadline.id,
        exposure.days,
        exposure.evidence.map((item) => `${item.file}:${item.line} ${item.version}`),
        exposure.nonLive.map((item) => `${item.file}:${item.line} ${item.use}`),
      ]),
    ).toEqual([
      ['slack-workflow-steps-from-apps', -770, ['src/upload.js:4 workflows.updateStep'], []],
      [
        'slack-files-upload',
        -344,
        ['src/upload.js:3 files.upload'],
        ['test/upload.test.js:1 test'],
      ],
    ]);
    expect(deadlineTitle(scan.exposures[1])).toBe(
      'Slack method files.upload passed its sunset on 2025-11-12',
    );
  });

  it('accepts method entries and rejects unknown kinds', () => {
    const entry = {
      id: 'slack-x',
      provider: 'slack',
      kind: 'method',
      versions: ['x.y'],
      date: '2027-01-01',
      summary: 'x',
      replacement: null,
      source: 'https://example.com',
      checkedAt: '2026-10-22',
    };
    expect(checkDeadlineRegistry({ formatVersion: 1, deadlines: [entry] }, NOW).errors).toEqual([]);
    expect(
      checkDeadlineRegistry({ formatVersion: 1, deadlines: [{ ...entry, kind: 'endpoint' }] }, NOW)
        .errors,
    ).toEqual(['slack-x: kind must be api-version, model, sdk or method.']);
  });
});

it('prints calls and JSON from the CLI', async () => {
  const root = await repository({
    'src/a.js': `const { WebClient } = require('@slack/web-api');
new WebClient().files.upload({});
`,
  });
  const text = (await execute(process.execPath, [CLI, 'slack', '--repository', root])).stdout;
  expect(text).toContain('1 call in live code, 1 to a deprecated or removed method.');
  expect(text).toContain('src/a.js:2  files.upload');
  expect(text).toContain(
    'Note       `files.upload` is removed from @slack/web-api 8; Slack names `filesUploadV2` as its replacement',
  );
  const json = JSON.parse(
    (await execute(process.execPath, [CLI, 'slack', '--repository', root, '--json'])).stdout,
  );
  expect(json.calls).toHaveLength(1);
  expect(json.methodsCheckedAt).toBe('2026-10-22');
});

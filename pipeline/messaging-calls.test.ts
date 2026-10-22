import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from './agent-catalog.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { scanMessagingCalls, type MessagingCall } from './messaging-calls.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const NOW = new Date('2026-10-22T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, manifest: object = { name: 'app' }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-messaging-'));
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

function summary(calls: MessagingCall[]) {
  return calls.map((call) => `${call.file}:${call.line} ${call.call} ${call.use}`);
}

describe('provider detection', () => {
  it.each([
    ['twilio', 'twilio', 'https://verify.twilio.com/v2/Services'],
    ['sendgrid', '@sendgrid/mail', 'https://api.sendgrid.com/v3/mail/send'],
    ['resend', 'resend', 'https://api.resend.com/emails'],
    ['postmark', 'postmark', 'https://api.postmarkapp.com/email'],
    ['mailgun', 'mailgun.js', 'https://api.eu.mailgun.net/v3/example.com/messages'],
  ])('detects %s from its package and from a raw API host', async (id, name, url) => {
    const fromPackage = await scanMessagingCalls(
      await repository({}, { name: 'app', dependencies: { [name]: '1.0.0' } }),
    );
    expect(fromPackage.providers.map((item) => item.agent.id)).toEqual([id]);
    const fromHost = await scanMessagingCalls(
      await repository({ 'src/send.js': `await fetch('${url}', { method: 'POST' });\n` }),
    );
    expect(fromHost.providers.map((item) => [item.agent.id, item.hostnames[0]?.line])).toEqual([
      [id, 1],
    ]);
  });

  it('keeps every messaging catalog entry review only', () => {
    for (const id of ['twilio', 'sendgrid', 'resend', 'postmark', 'mailgun'])
      expect(AGENT_CATALOG.find((agent) => agent.id === id)?.adapter).toBeNull();
  });
});

describe('deprecated twilio members', () => {
  it('reports version-less accessors on a client created in any style', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'src/verify.js': `const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
async function start(to) {
  return client.verify.services(process.env.VERIFY_SID).verifications.create({ to, channel: 'sms' });
}
async function check(to, code) {
  return client.verify.v2.services(process.env.VERIFY_SID).verificationChecks.create({ to, code });
}
`,
        'src/class.ts': `import { Twilio } from 'twilio';
const twilio = new Twilio(sid, token);
export const rooms = () => twilio.video.rooms.list({ limit: 20 });
export const calls = () => twilio.api.calls.list();
export const current = () => twilio.api.account.calls.list();
export const top = () => twilio.calls.list();
`,
        'src/service.ts': `export class Sms {
  constructor(private readonly twilioClient: any) {}
  lookup(phone: string) {
    return this.twilioClient.lookups.phoneNumbers(phone).fetch();
  }
}
`,
      }),
    );
    expect(summary(calls)).toEqual([
      'src/class.ts:3 twilio.video.rooms live',
      'src/class.ts:4 twilio.api.calls live',
      'src/service.ts:4 this.twilioClient.lookups.phoneNumbers live',
      'src/verify.js:3 client.verify.services live',
    ]);
    const verify = calls.find((call) => call.member === 'verify.services')!;
    expect(verify).toMatchObject({
      provider: 'twilio',
      kind: 'deprecated-member',
      message: 'Use v2.services instead',
      replacement: 'verify.v2.services',
      source: 'twilio@6.2.0 type declarations',
      date: null,
    });
    expect(calls.find((call) => call.member === 'api.calls')!.replacement).toBe(
      'api.account.calls',
    );
  });

  it('ignores the same chains on objects that are not a Twilio client', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'src/other.js': `const api = require('./api');
const video = { rooms: [] };
export const list = () => this.api.calls.list();
export const sync = (store) => store.sync.services;
`,
      }),
    );
    expect(calls).toEqual([]);
  });

  it('follows clients from a factory and rejects the client itself and the Twilio global', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'src/serverless.ts': `import { getTwilioClient } from '../utils';
export const environments = async (sid: string) => {
  const client: any = getTwilioClient();
  return client.serverless.services(sid).environments.list({ limit: 20 });
};
`,
        'src/function.js': `exports.handler = async (context, event, callback) => {
  const twilioClient = context.getTwilioClient();
  await twilioClient.sync.services('default').fetch();
  callback(null, await twilioClient.messages.create({ to: event.to, body: 'hi' }));
};
`,
        'src/adapter.ts': `import * as Twilio from 'twilio';
export class Adapter {
  private api: Twilio.Twilio;
  constructor(sid: string, token: string) {
    this.api = Twilio(sid, token);
  }
  send(message: any) {
    return this.api.messages.create(message);
  }
}
`,
        'src/mock.ts': `const service = (global as any).Twilio?.sync?.services?.('default');
`,
      }),
    );
    expect(summary(calls)).toEqual([
      'src/function.js:3 twilioClient.sync.services live',
      'src/serverless.ts:4 client.serverless.services live',
    ]);
  });

  it('marks tests', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'test/verify.test.js': `const twilio = require('twilio');
const client = twilio('AC', 'token');
client.verify.services('VA').verifications.create({ to: '+1', channel: 'sms' });
`,
      }),
    );
    expect(summary(calls)).toEqual(['test/verify.test.js:3 client.verify.services test']);
  });
});

describe('deprecated mailgun.js members', () => {
  it('reports deprecated domain methods, including nested clients', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'src/mail.ts': `import Mailgun from 'mailgun.js';
import FormData from 'form-data';
const mg = new Mailgun(FormData).client({ username: 'api', key: process.env.MAILGUN_KEY! });
export const tracking = (domain: string) => mg.domains.getTracking(domain);
export const tags = (domain: string) => mg.domains.domainTags.list(domain);
export const fresh = (domain: string) => mg.domains.domainTracking.getTracking(domain);
export const send = (domain: string) => mg.messages.create(domain, { to: 'a@b.c' });
`,
      }),
    );
    expect(summary(calls)).toEqual([
      'src/mail.ts:4 mg.domains.getTracking live',
      'src/mail.ts:5 mg.domains.domainTags.list live',
    ]);
    expect(calls[0]).toMatchObject({
      provider: 'mailgun',
      replacement: 'domains.domainTracking.getTracking',
    });
    expect(calls[1].message).toMatch(/new Tags Client/);
  });
});

describe('removed endpoints', () => {
  it('reports raw calls to an endpoint the changelog lists as removed, with its date', async () => {
    const { calls } = await scanMessagingCalls(
      await repository({
        'src/whatsapp.js': `const base = 'https://messaging.twilio.com/v1/Channels/WhatsApp/Senders';
await fetch(\`https://messaging.twilio.com/v1/Channels/WhatsApp/Senders/\${sid}\`);
await fetch('https://messaging.twilio.com/v2/Channels/Senders');
await fetch('https://messaging.twilio.com/v1/Channels/WhatsApp/SendersExtra');
`,
      }),
    );
    expect(summary(calls)).toEqual([
      'src/whatsapp.js:1 messaging.twilio.com/v1/Channels/WhatsApp/Senders live',
      'src/whatsapp.js:2 messaging.twilio.com/v1/Channels/WhatsApp/Senders live',
    ]);
    expect(calls[0]).toMatchObject({
      kind: 'removed-endpoint',
      date: '2026-09-09',
      replacement: '/v2/Channels/Senders',
      source: 'https://github.com/twilio/twilio-node/blob/main/CHANGES.md',
    });
  });
});

describe('packages and registry', () => {
  it('flags retired packages and twilio below 6.0.0, from the declaration or the lock', async () => {
    const scan = await scanMessagingCalls(
      await repository(
        {
          'package-lock.json': JSON.stringify({
            name: 'app',
            lockfileVersion: 3,
            packages: {
              '': { name: 'app', dependencies: { twilio: '*' } },
              'node_modules/twilio': { version: '5.10.2' },
            },
          }),
        },
        {
          name: 'app',
          dependencies: { twilio: '*', sendgrid: '^5.2.3', 'mailgun-js': '^0.22.0' },
        },
      ),
    );
    expect(
      scan.packages.map((item) => [
        item.name,
        item.locked,
        item.deadline?.id ?? null,
        item.deprecated !== null,
      ]),
    ).toEqual([
      ['twilio', '5.10.2', 'twilio-node-below-6-2026-04-20', false],
      ['sendgrid', null, null, true],
      ['mailgun-js', null, null, true],
    ]);
  });

  it('matches twilio below 6.0.0 in scanDeadlines and leaves 6.x and unknown ranges alone', async () => {
    const registry = await loadDeadlineRegistry();
    const exposed = async (range: string) =>
      (
        await scanDeadlines(
          await repository(
            { 'src/index.js': "require('twilio');\n" },
            { name: 'app', dependencies: { twilio: range } },
          ),
          registry,
          NOW,
        )
      ).exposures.filter((item) => item.deadline.provider === 'twilio');
    const old = await exposed('^5.3.1');
    expect(old.map((item) => item.deadline.id)).toEqual(['twilio-node-below-6-2026-04-20']);
    expect(old[0].evidence[0].text).toBe(
      'twilio ^5.3.1 is declared in dependencies, inside <6.0.0',
    );
    expect(await exposed('^6.0.0')).toEqual([]);
    expect(await exposed('latest')).toEqual([]);
    expect(await exposed('^4.0.0 || ^6.0.0')).toEqual([]);
  });

  it('keeps the generated deprecation list and endpoint list sourced', async () => {
    const deprecations = JSON.parse(
      await readFile(new URL('../data/messaging-deprecations.json', import.meta.url), 'utf8'),
    );
    expect(deprecations.sdks.twilio.members.length).toBe(134);
    expect(deprecations.sdks['mailgun.js'].members.length).toBe(18);
    for (const sdk of Object.values(deprecations.sdks) as { members: { message: string }[] }[])
      for (const member of sdk.members) expect(member.message).not.toBe('');
    const endpoints = JSON.parse(
      await readFile(new URL('../data/messaging-endpoints.json', import.meta.url), 'utf8'),
    );
    for (const endpoint of endpoints.endpoints) {
      expect(endpoint.source).toMatch(/^https:\/\//);
      expect(endpoint.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(endpoint.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('refit messaging', () => {
  it('prints providers, packages and each live call, and the same scan as JSON', async () => {
    const root = await repository(
      {
        'src/verify.js':
          "const client = require('twilio')('AC', 'token');\nclient.verify.services('VA');\n",
      },
      { name: 'app', dependencies: { twilio: '5.0.0' } },
    );
    const { stdout } = await execute(process.execPath, [CLI, 'messaging', '--repository', root]);
    expect(stdout).toContain('Providers    Twilio');
    expect(stdout).toContain(
      'twilio 5.0.0 in package.json  unsupported since 2026-04-20 (twilio-node-below-6-2026-04-20)',
    );
    expect(stdout).toContain('src/verify.js:2  client.verify.services');
    expect(stdout).toContain('Use        verify.v2.services');
    const json = JSON.parse(
      (await execute(process.execPath, [CLI, 'messaging', '--repository', root, '--json'])).stdout,
    );
    expect(json.calls.map((call: MessagingCall) => call.member)).toEqual(['verify.services']);
  });
});

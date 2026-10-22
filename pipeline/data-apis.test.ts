import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, detectProviders } from './agent-catalog.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-data-apis-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ name: 'app', dependencies });

// The list-B providers, one fixture each: a declared package and a request to the API host.
const PROVIDERS: [id: string, packageName: string, hostname: string][] = [
  ['google-maps', '@googlemaps/google-maps-services-js', 'maps.googleapis.com'],
  ['mapbox', 'mapbox-gl', 'api.mapbox.com'],
  ['algolia', 'algoliasearch', '.algolia.net'],
  ['hubspot', '@hubspot/api-client', 'api.hubapi.com'],
  ['intercom', 'intercom-client', 'api.intercom.io'],
  ['mailchimp', '@mailchimp/mailchimp_marketing', 'api.mailchimp.com'],
  ['zoom', '@zoom/meetingsdk', 'api.zoom.us'],
  ['dropbox', 'dropbox', 'api.dropboxapi.com'],
  ['notion', '@notionhq/client', 'api.notion.com'],
  ['airtable', 'airtable', 'api.airtable.com'],
  ['segment', '@segment/analytics-node', 'api.segment.io'],
  ['sentry', '@sentry/node', 'sentry.io/api/0/'],
  ['discord', 'discord.js', 'discord.com/api'],
  ['contentful', 'contentful', 'cdn.contentful.com'],
  ['cloudinary', 'cloudinary', 'api.cloudinary.com'],
];

describe('list-B catalog entries', () => {
  it('has an entry with no adapter for every provider', () => {
    for (const [id] of PROVIDERS) {
      const agent = AGENT_CATALOG.find((entry) => entry.id === id);
      expect(agent, id).toBeDefined();
      expect(agent!.adapter, id).toBeNull();
    }
  });

  it.each(PROVIDERS)(
    'detects %s from its package and from its API host',
    async (id, name, host) => {
      const byPackage = await repository({ 'package.json': manifest({ [name]: '^1.0.0' }) });
      const found = (await detectProviders(byPackage)).find((item) => item.agent.id === id);
      expect(found?.packages.map((item) => item.name)).toContain(name);

      const byHost = await repository({
        'package.json': JSON.stringify({ name: 'app' }),
        'src/a.ts': `const r = await fetch('https://${host.startsWith('.') ? `abc-dsn${host}` : host}/v1/things');\n`,
      });
      const hostFound = (await detectProviders(byHost)).find((item) => item.agent.id === id);
      expect(hostFound?.hostnames[0]).toMatchObject({ file: 'src/a.ts', line: 1, hostname: host });
      expect(hostFound?.packages).toEqual([]);
    },
  );

  it('reports requests sent to the host through an HTTP client, but not other mentions', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.ts': `await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/x.json');\n`,
      'src/b.ts': `const csp = ['api.mapbox.com'];\nconst css = 'https://api.mapbox.com/mapbox-gl-js/v3/mapbox-gl.css';\n`,
      'test/c.test.ts': `fetch('https://api.mapbox.com/x');\n`,
      'src/d.ts': `await fetch('https://abc-dsn.algolia.net/1/indexes/x/query');\n`,
    });
    const found = await detectProviders(root);
    const mapbox = found.find((item) => item.agent.id === 'mapbox')!;
    expect(mapbox.requests).toEqual([
      { host: 'api.mapbox.com', file: 'src/a.ts', line: 1, client: 'fetch' },
    ]);
    expect(mapbox.hostnames.map((item) => item.file)).toContain('test/c.test.ts');
    expect(found.find((item) => item.agent.id === 'algolia')!.requests).toHaveLength(1);
  });

  it('does not take Sentry ingest URLs or the bare Algolia domain for API requests', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.ts': `const tunnel = 'https://o1.ingest.sentry.io/api/123/envelope/';\nconst site = 'https://algolia.net';\n`,
    });
    const ids = (await detectProviders(root)).map((item) => item.agent.id);
    expect(ids).not.toContain('sentry');
    expect(ids).not.toContain('algolia');
  });

  it('does not detect a provider from an unrelated package', async () => {
    const root = await repository({ 'package.json': manifest({ express: '^4.0.0' }) });
    expect(await detectProviders(root)).toEqual([]);
  });
});

async function exposures(files: Record<string, string>) {
  const root = await repository({ 'package.json': JSON.stringify({ name: 'app' }), ...files });
  const scan = await scanDeadlines(root, await loadDeadlineRegistry(), new Date('2026-10-22'));
  return scan.exposures.map((item) => ({
    id: item.deadline.id,
    lines: item.evidence.map((evidence) => `${evidence.file}:${evidence.line}`),
  }));
}

describe('algolia-javascript-client-v4', () => {
  it('matches algoliasearch below 5, by locked version before declared range', async () => {
    expect(
      await exposures({
        'package.json': manifest({ algoliasearch: '^4.24.0' }),
        'src/a.ts': `import algoliasearch from 'algoliasearch';\n`,
      }),
    ).toEqual([{ id: 'algolia-javascript-client-v4', lines: ['package.json:1'] }]);
  });

  it('does not match algoliasearch 5', async () => {
    expect(
      await exposures({
        'package.json': manifest({ algoliasearch: '^5.0.0' }),
        'src/a.ts': `import { algoliasearch } from 'algoliasearch';\n`,
      }),
    ).toEqual([]);
  });

  it('does not match a repository that does not declare it', async () => {
    expect(
      await exposures({ 'package.json': manifest({ 'algoliasearch-helper': '^3.0.0' }) }),
    ).toEqual([]);
  });
});

describe('zoom-meeting-sdk-key', () => {
  it('matches the legacy sdkKey in a Meeting SDK file', async () => {
    expect(
      await exposures({
        'src/join.ts': `import { ZoomMtg } from '@zoom/meetingsdk';\nZoomMtg.join({ sdkKey: key, signature, meetingNumber });\nconst payload = { appKey: id, sdkKey: id };\n`,
      }),
    ).toEqual([{ id: 'zoom-meeting-sdk-key', lines: ['src/join.ts:2', 'src/join.ts:3'] }]);
  });

  it('ignores sdkKey outside a Zoom Meeting SDK file, and a Client ID join', async () => {
    expect(
      await exposures({
        'src/other.ts': `const config = { sdkKey: 'abc' };\n`,
        'src/join.ts': `import { ZoomMtg } from '@zoom/meetingsdk';\nZoomMtg.join({ signature, meetingNumber });\nlet sdkKey = process.env.ID;\nprivate sdkKey: string;\nif (!sdkKey) throw new Error('x');\n`,
      }),
    ).toEqual([]);
  });
});

describe('mailchimp-export-api', () => {
  it('matches the Export API 1.0 and 2.0 paths on any data center', async () => {
    expect(
      await exposures({
        'src/a.js': `fetch('https://us19.api.mailchimp.com/export/1.0/list/?apikey=k&id=1');\naxios.get(\`https://\${dc}.api.mailchimp.com/export/2.0/campaigns\`);\n`,
      }),
    ).toEqual([{ id: 'mailchimp-export-api', lines: ['src/a.js:1', 'src/a.js:2'] }]);
  });

  it('matches the retired API 2.0 path', async () => {
    expect(
      await exposures({ 'src/a.js': `fetch('https://us19.api.mailchimp.com/2.0/lists/list');\n` }),
    ).toEqual([{ id: 'mailchimp-export-api', lines: ['src/a.js:1'] }]);
  });

  it('does not match Marketing API 3.0', async () => {
    expect(
      await exposures({ 'src/a.js': `fetch('https://us19.api.mailchimp.com/3.0/lists');\n` }),
    ).toEqual([]);
  });
});

describe('airtable-user-api-keys', () => {
  it('matches a legacy key written in a file that uses the airtable package', async () => {
    expect(
      await exposures({
        'src/a.js': `const Airtable = require('airtable');\nconst base = new Airtable({ apiKey: 'keyAbC123dEf456gH' }).base('app');\n`,
      }),
    ).toEqual([{ id: 'airtable-user-api-keys', lines: ['src/a.js:2'] }]);
  });

  it('reports where a legacy key is without copying its value', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.js': `const Airtable = require('airtable');\nnew Airtable({ apiKey: 'keyAbC123dEf456gH' });\n`,
    });
    const scan = await scanDeadlines(root, await loadDeadlineRegistry(), new Date('2026-10-22'));
    const text = JSON.stringify(scan);
    expect(text).toContain('src/a.js');
    expect(text).not.toContain('keyAbC123dEf456gH');
  });

  it('does not match a personal access token, or apiKey in a file without the package', async () => {
    expect(
      await exposures({
        'src/a.js':
          `const Airtable = require('airtable');\nnew Airtable({ apiKey: process.env.PAT });\n`.replace(
            'apiKey',
            'personalAccessToken',
          ),
        'src/b.js': `const client = new Other({ apiKey: 'x' });\n`,
      }),
    ).toEqual([]);
  });
});

describe('hubspot-api-v4', () => {
  it('matches numbered v4 paths on api.hubapi.com', async () => {
    expect(
      await exposures({
        'src/a.ts': `await fetch('https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read');\nconst url = \`https://api.hubapi.com/marketing/v4/email/\${id}\`;\n`,
      }),
    ).toEqual([{ id: 'hubspot-api-v4', lines: ['src/a.ts:1', 'src/a.ts:2'] }]);
  });

  it('does not match v3 paths, other hosts, or a v4 inside a name', async () => {
    expect(
      await exposures({
        'src/a.ts': `fetch('https://api.hubapi.com/crm/v3/objects/contacts');\nfetch('https://example.org/crm/v4/x');\nfetch('https://api.hubapi.com/crm/v4beta/x');\n`,
      }),
    ).toEqual([]);
  });
});

describe('the shipped registry', () => {
  it('has the list-B entries with a source and a check date', async () => {
    const registry = await loadDeadlineRegistry();
    for (const id of [
      'algolia-javascript-client-v4',
      'zoom-meeting-sdk-key',
      'mailchimp-export-api',
      'airtable-user-api-keys',
      'hubspot-api-v4',
    ]) {
      const entry = registry.deadlines.find((item) => item.id === id);
      expect(entry?.source, id).toMatch(/^https:\/\//);
      expect(entry?.checkedAt, id).toBe('2026-10-22');
    }
  });
});

describe('the committed sample and labels', () => {
  it('has at least ten repositories for each provider and 40 hand-read hostname lines', async () => {
    const { readFile } = await import('node:fs/promises');
    const sample = JSON.parse(
      await readFile(
        new URL('../docs/benchmarks/2026-10-22-data-apis-repos.json', import.meta.url),
        'utf8',
      ),
    );
    const counts = new Map<string, number>();
    for (const entry of sample.repos)
      counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
    expect(counts.size).toBe(15);
    for (const [provider, count] of counts) expect(count, provider).toBeGreaterThanOrEqual(10);
    expect(sample.repos.length).toBeGreaterThanOrEqual(150);
    const labels = JSON.parse(
      await readFile(
        new URL('../docs/benchmarks/2026-10-22-data-apis-labels.json', import.meta.url),
        'utf8',
      ),
    );
    expect(labels.hostnameLines).toHaveLength(40);
    expect(
      labels.hostnameLines.filter((item: { label: string }) => item.label === 'correct'),
    ).toHaveLength(22);
  });
});

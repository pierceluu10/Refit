import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import type { GraphCall } from './meta-graph-calls.ts';
import {
  DEFAULT_META_GRAPH_CHANGES,
  loadMetaGraphChanges,
  type MetaGraphChange,
  type MetaGraphChanges,
} from './meta-graph-changes.ts';
import { changesUsedBy, fieldNames, proposeVersionMoves } from './meta-graph-moves.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/meta-graph', import.meta.url));
const NOW = new Date('2026-10-20T12:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-moves-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app' }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const source = (version: string) =>
  `https://developers.facebook.com/docs/graph-api/changelog/version${version.slice(1)}`;

function change(
  overrides: Partial<MetaGraphChange> & Pick<MetaGraphChange, 'id' | 'version' | 'kind'>,
): MetaGraphChange {
  return {
    node: null,
    edge: null,
    path: null,
    name: null,
    summary: `${overrides.id} changes.`,
    source: source(overrides.version),
    checkedAt: '2026-10-20',
    ...overrides,
  };
}

// A hypothetical change list with v18.0 to v25.0 reviewed; tests add the changes they need.
function changes(
  entries: MetaGraphChange[] = [],
  unread: string[] = [],
  omit: string[] = [],
): MetaGraphChanges {
  return {
    formatVersion: 1,
    provider: 'meta-graph',
    versions: Array.from({ length: 8 }, (_, index) => `v${18 + index}.0`)
      .filter((version) => !omit.includes(version))
      .map((version) => ({
        version,
        status: unread.includes(version) ? ('unread' as const) : ('reviewed' as const),
        source: source(version),
        checkedAt: '2026-10-20',
        note: unread.includes(version) ? 'Not read.' : null,
      })),
    changes: entries,
  };
}

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    {
      id: 'meta-graph-v19-0',
      provider: 'meta-graph',
      kind: 'api-version',
      versions: ['v19.0'],
      date: '2026-05-21',
      summary: 'Graph API v19.0 retires.',
      replacement: 'v25.0',
      source: 'https://developers.facebook.com/docs/graph-api/changelog',
      checkedAt: '2026-10-15',
    },
  ],
};

async function propose(files: Record<string, string>, list = changes(), target = 'v25.0') {
  return proposeVersionMoves(await repository(files), target, list, registry, NOW);
}

const SEND = `export const send = (url) =>
  fetch('https://graph.facebook.com/v18.0/123/photos', {
    method: 'POST',
    body: JSON.stringify({ url, published: true }),
  });
`;

// A WhatsApp Cloud API send: WhatsApp publishes its own changelog, which the list does not cover.
const WHATSAPP = `export const send = (to) =>
  fetch('https://graph.facebook.com/v18.0/123/messages', {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to }),
  });
`;

describe('version moves', () => {
  it('proposes a move when every request is known and no reviewed changelog touches it', async () => {
    const proposal = await propose({ 'a.js': SEND });
    expect(proposal.stops).toEqual([]);
    expect(proposal.moves).toEqual([
      {
        file: 'a.js',
        line: 2,
        from: 'v18.0',
        to: 'v25.0',
        crossed: ['v19.0', 'v20.0', 'v21.0', 'v22.0', 'v23.0', 'v24.0', 'v25.0'],
        requests: [{ file: 'a.js', line: 2, method: 'POST', path: '/123/photos' }],
      },
    ]);
    expect(proposal.patch).toContain("-  fetch('https://graph.facebook.com/v18.0/123/photos', {");
    expect(proposal.patch).toContain("+  fetch('https://graph.facebook.com/v25.0/123/photos', {");
  });

  it('stops on every change a request uses between the two versions, and only those', async () => {
    const list = changes([
      change({ id: 'field', version: 'v20.0', kind: 'field-removed', name: 'username' }),
      change({ id: 'metric', version: 'v22.0', kind: 'metric-removed', name: 'impressions' }),
      change({ id: 'param', version: 'v21.0', kind: 'parameter-changed', name: 'period' }),
      change({ id: 'edge', version: 'v23.0', kind: 'edge-removed', edge: 'feed' }),
      change({ id: 'endpoint', version: 'v24.0', kind: 'endpoint-removed', path: '/{id}/live' }),
      // Not crossed: introduced by the version the code already uses, or after the target.
      change({ id: 'old', version: 'v18.0', kind: 'field-removed', name: 'username' }),
      // Not used by any of these requests.
      change({ id: 'other', version: 'v20.0', kind: 'field-removed', name: 'unrelated' }),
    ]);
    const proposal = await propose(
      {
        'a.js': `fetch('https://graph.facebook.com/v18.0/me?fields=id,instagram_business_account{username}');
fetch('https://graph.facebook.com/v18.0/1/insights?fields=values&metric=impressions,reach&period=day');
fetch('https://graph.facebook.com/v18.0/1/feed', { method: 'POST', body: JSON.stringify({ message: 'x' }) });
fetch('https://graph.facebook.com/v18.0/1/live/comments?fields=id');
fetch('https://graph.facebook.com/v18.0/1/photos?fields=id');`,
      },
      list,
    );
    expect(proposal.stops.map((stop) => [stop.line, stop.reasons])).toEqual([
      [1, ['a.js:1: v20.0 field-removed field: field changes.']],
      [
        2,
        [
          'a.js:2: v22.0 metric-removed metric: metric changes.',
          'a.js:2: v21.0 parameter-changed param: param changes.',
        ],
      ],
      [3, ['a.js:3: v23.0 edge-removed edge: edge changes.']],
      [4, ['a.js:4: v24.0 endpoint-removed endpoint: endpoint changes.']],
    ]);
    expect(proposal.moves.map((move) => move.line)).toEqual([5]);
  });

  it('treats a GET with no fields as using every default field', async () => {
    const list = changes([
      change({ id: 'field', version: 'v21.0', kind: 'field-removed', node: 'Page', name: 'x' }),
    ]);
    const proposal = await propose(
      {
        'a.js': `fetch('https://graph.facebook.com/v18.0/123');
fetch('https://graph.facebook.com/v18.0/123?fields=id');`,
      },
      list,
    );
    expect(proposal.stops.map((stop) => [stop.line, stop.reasons])).toEqual([
      [1, ['a.js:1: v21.0 field-removed field: field changes.']],
    ]);
    expect(proposal.moves.map((move) => move.line)).toEqual([2]);
  });

  it('stops when a crossed changelog is unread or has no record at all', async () => {
    const proposal = await propose({ 'a.js': SEND }, changes([], ['v21.0', 'v23.0'], ['v20.0']));
    expect(proposal.moves).toEqual([]);
    expect(proposal.stops[0].reasons).toEqual([
      'v20.0, v21.0, v23.0: these changelogs are not reviewed in the Meta Graph API change list',
    ]);
  });

  it('stops at every unknown part of a request', async () => {
    const proposal = await propose({
      'a.js': `metaFetch('https://graph.facebook.com/v18.0/me?fields=id');
fetch(\`https://graph.facebook.com/v18.0/me?fields=\${fields}\`);
fetch(\`https://graph.facebook.com/v18.0/\${id}/\${edge}\`);
const tokenUrl = 'https://graph.facebook.com/v18.0/oauth/access_token';
export default { tokenUrl };`,
    });
    expect(proposal.moves).toEqual([]);
    expect(proposal.stops.map((stop) => stop.reasons)).toEqual([
      [
        'a.js:1: the HTTP method is not known',
        'a.js:1: the requested metrics are not known',
        'a.js:1: the request parameters are not known',
      ],
      ['a.js:2: the requested fields are not known'],
      ['a.js:3: the path is not known'],
      [
        'a.js:4: no request call was traced for this URL',
        'a.js:4: the HTTP method is not known',
        'a.js:4: the requested fields are not known',
        'a.js:4: the requested metrics are not known',
        'a.js:4: the request parameters are not known',
        'a.js:5: `tokenUrl` is used in a way the request scan does not follow',
      ],
    ]);
  });

  it('moves a file-local base constant once for every request built from it', async () => {
    const proposal = await propose({
      'a.ts': `const GRAPH = 'https://graph.facebook.com/v18.0';
const API = GRAPH;
export const me = () => fetch(\`\${API}/me?fields=id,name\`);
export const pages = () => fetch(\`\${GRAPH}/me/accounts?fields=id\`);`,
    });
    expect(proposal.stops).toEqual([]);
    expect(proposal.moves).toMatchObject([
      { file: 'a.ts', line: 1, from: 'v18.0', requests: [{ line: 3 }, { line: 4 }] },
    ]);
    expect(proposal.patch).toContain("+const GRAPH = 'https://graph.facebook.com/v25.0';");
  });

  it('moves a version constant used in URLs, and stops when it is used anywhere else', async () => {
    const clean = await propose({
      'a.ts': `const VERSION = 'v18.0';
export const me = () => fetch(\`https://graph.facebook.com/\${VERSION}/me?fields=id\`);`,
    });
    expect(clean.moves).toMatchObject([{ file: 'a.ts', line: 1, from: 'v18.0' }]);
    expect(clean.patch).toContain("+const VERSION = 'v25.0';");
    const shared = await propose({
      'a.ts': `const VERSION = 'v18.0';
FB.init({ appId, version: VERSION });
export const me = () => fetch(\`https://graph.facebook.com/\${VERSION}/me?fields=id\`);`,
    });
    expect(shared.moves).toEqual([]);
    expect(shared.stops[0].reasons).toEqual([
      'a.ts:2: `VERSION` is used in a way the request scan does not follow',
    ]);
  });

  it('stops for a base an axios instance or another file may use, and never follows a let', async () => {
    const proposal = await propose({
      'a.ts': `const GRAPH = 'https://graph.facebook.com/v18.0';
const api = axios.create({ baseURL: GRAPH });
export const me = () => fetch(\`\${GRAPH}/me?fields=id\`);`,
      'b.ts': `export const BASE = 'https://graph.facebook.com/v18.0';
export const me = () => fetch(\`\${BASE}/me?fields=id\`);`,
      'c.ts': `let base = 'https://graph.facebook.com/v18.0';
export const me = () => fetch(\`\${base}/me?fields=id\`);`,
    });
    expect(proposal.moves).toEqual([]);
    expect(proposal.stops.map((stop) => stop.reasons)).toEqual([
      ['a.ts:2: `GRAPH` is used in a way the request scan does not follow'],
      [
        'b.ts:1: the version is in the exported `BASE`; other files may use it in ways this check does not follow',
      ],
    ]);
    // The scan follows only const bases, so a request built from a `let` is not found at all and
    // nothing moves it.
    expect(proposal.stops.some((stop) => stop.file === 'c.ts')).toBe(false);
  });

  it('does not count a property with the same name as a use of the pin', async () => {
    const proposal = await propose({
      'a.js': `export async function media(id) {
  const url = \`https://graph.facebook.com/v18.0/\${id}\`;
  const data = await (await fetch(url)).json();
  return fetch(data.url, { headers: { url: 'x' } });
}`,
    });
    expect(proposal.stops).toEqual([]);
    expect(proposal.moves).toMatchObject([{ file: 'a.js', line: 2 }]);
  });

  it('stops when the version is written more than once on its line', async () => {
    const proposal = await propose({
      'a.js': `fetch('https://graph.facebook.com/v18.0/me?fields=id'); // was https://graph.facebook.com/v18.0/me`,
    });
    expect(proposal.stops[0].reasons).toEqual(['a.js:1: v18.0 is written 2 times on this line']);
  });

  it('never moves business SDK requests or test-only pins', async () => {
    const proposal = await propose({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { 'facebook-nodejs-business-sdk': '20.0.0' },
      }),
      'a.js': `const { AdAccount } = require('facebook-nodejs-business-sdk');
new AdAccount('act_1').getCampaigns(['name']);`,
      'test/send.test.js': SEND,
    });
    expect(proposal.moves).toEqual([]);
    expect(proposal.stops.map((stop) => [stop.file, stop.reasons])).toEqual([
      [
        'package.json',
        [
          "facebook-nodejs-business-sdk requests follow the package's version; a package upgrade is not proposed",
        ],
      ],
      ['test/send.test.js', ['test/send.test.js:2: only tests and examples use this version']],
    ]);
  });

  it('lists requests without a pinned version, at the target, or past it', async () => {
    const proposal = await propose(
      {
        'a.js': `fetch('https://graph.facebook.com/me?fields=id');
fetch(\`https://graph.facebook.com/\${version}/me?fields=id\`);
fetch('https://graph.facebook.com/v22.0/me?fields=id');
fetch('https://graph.facebook.com/v24.0/me?fields=id');`,
      },
      changes(),
      'v22.0',
    );
    expect(proposal.moves).toEqual([]);
    expect(proposal.current).toEqual([{ file: 'a.js', line: 3, method: 'GET', path: '/me' }]);
    expect(proposal.stops.map((stop) => stop.reasons)).toEqual([
      ['a.js:1: the URL names no version'],
      ['a.js:2: the version is built at runtime'],
      ['a.js:4: v24.0 is newer than the target v22.0'],
    ]);
  });

  it('refuses a malformed, unlisted or retired target', async () => {
    const root = await repository({ 'a.js': SEND });
    await expect(proposeVersionMoves(root, '25', changes(), registry, NOW)).rejects.toThrow(
      '--target must look like v24.0.',
    );
    await expect(proposeVersionMoves(root, 'v26.0', changes(), registry, NOW)).rejects.toThrow(
      'v26.0 has no record in the Meta Graph API change list',
    );
    await expect(proposeVersionMoves(root, 'v19.0', changes(), registry, NOW)).rejects.toThrow(
      'v19.0 was retired on 2026-05-21; choose a newer target.',
    );
  });

  it('stops WhatsApp and Messenger requests, whose changelogs the list does not cover', async () => {
    const reason = (line: number) =>
      `a.js:${line}: WhatsApp Business Platform and Messenger Platform requests follow their own changelogs, which the change list does not cover`;
    const whatsapp = await propose({ 'a.js': WHATSAPP });
    expect(whatsapp.moves).toEqual([]);
    expect(whatsapp.stops.map((stop) => stop.reasons)).toEqual([[reason(2)]]);
    // By edge alone, and by a send parameter on an edge both share with other products.
    const proposal = await propose({
      'a.js': `fetch('https://graph.facebook.com/v18.0/1/message_templates?fields=id');
fetch('https://graph.facebook.com/v18.0/1/media', { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', file }) });
fetch('https://graph.facebook.com/v18.0/me/messages', { method: 'POST', body: JSON.stringify({ recipient, message }) });
fetch('https://graph.facebook.com/v18.0/1/media', { method: 'POST', body: JSON.stringify({ image_url, caption }) });`,
    });
    expect(proposal.stops.map((stop) => [stop.line, stop.reasons])).toEqual([
      [1, [reason(1)]],
      [2, [reason(2)]],
      [3, [reason(3)]],
    ]);
    // An Instagram container creation on the same edge moves.
    expect(proposal.moves.map((move) => move.line)).toEqual([4]);
  });

  it('stops the WhatsApp and Messenger edges and parameters found in the platform sample', async () => {
    const reason = (line: number) =>
      `a.js:${line}: WhatsApp Business Platform and Messenger Platform requests follow their own changelogs, which the change list does not cover`;
    // Request shapes from docs/benchmarks/2026-10-22-meta-platform-labels.json, with literal versions.
    const proposal = await propose({
      'a.js': `fetch('https://graph.facebook.com/v18.0/1/calls', { method: 'POST', body: JSON.stringify({ to, action: 'connect' }) });
fetch('https://graph.facebook.com/v18.0/1/smb_app_data', { method: 'POST', body: JSON.stringify({ sync_type: 'history' }) });
fetch('https://graph.facebook.com/v18.0/1/request_display_name', { method: 'POST', body: JSON.stringify({ new_display_name }) });
fetch('https://graph.facebook.com/v18.0/1/pin', { method: 'DELETE' });
fetch('https://graph.facebook.com/v18.0/1/settings', { method: 'POST', body: JSON.stringify({ calling }) });
fetch('https://graph.facebook.com/v18.0/message_template_library?fields=name');
fetch('https://graph.facebook.com/v18.0/1/moderate_conversations', { method: 'POST', body: JSON.stringify({ user_ids, actions }) });
fetch('https://graph.facebook.com/v18.0/2?phone_number_id=1&fields=url');`,
    });
    expect(proposal.moves).toEqual([]);
    expect(proposal.stops.map((stop) => [stop.line, stop.reasons])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((line) => [line, [reason(line)]]),
    );
  });

  it('applies a whole-node change only to requests on a single opaque node', async () => {
    const list = changes([
      change({
        id: 'node',
        version: 'v20.0',
        kind: 'endpoint-removed',
        path: '/{offline-event-set-id}',
      }),
    ]);
    const proposal = await propose(
      {
        'a.js': `fetch('https://graph.facebook.com/v18.0/123?fields=id');
fetch('https://graph.facebook.com/v18.0/me?fields=id');
fetch('https://graph.facebook.com/v18.0/123/photos?fields=id');
fetch('https://graph.facebook.com/v18.0/oauth/access_token?client_id=1&client_secret=2&grant_type=client_credentials');`,
      },
      list,
    );
    expect(proposal.stops.map((stop) => [stop.line, stop.reasons])).toEqual([
      [1, ['a.js:1: v20.0 endpoint-removed node: node changes.']],
    ]);
    expect(proposal.moves.map((move) => move.line)).toEqual([2, 3, 4]);
  });

  it('matches metric names regardless of case', async () => {
    const list = changes([
      change({ id: 'metric', version: 'v20.0', kind: 'metric-removed', name: 'TAPS_FORWARD' }),
    ]);
    const proposal = await propose(
      { 'a.js': "fetch('https://graph.facebook.com/v18.0/1/insights?metric=taps_forward');" },
      list,
    );
    expect(proposal.stops.map((stop) => stop.reasons)).toEqual([
      ['a.js:1: v20.0 metric-removed metric: metric changes.'],
    ]);
  });

  it('moves safe requests and stops the rest with concrete reasons under the committed list', async () => {
    const list = await loadMetaGraphChanges(DEFAULT_META_GRAPH_CHANGES, NOW);
    const proposal = await proposeVersionMoves(FIXTURE, 'v25.0', list, registry, NOW);
    const pinned = proposal.stops.filter((stop) => stop.from);
    // Every changelog from v14.0 to v25.0 is reviewed, so no stop is for an unread changelog.
    expect(
      pinned.every((stop) => !stop.reasons.some((reason) => reason.includes('not reviewed'))),
    ).toBe(true);
    expect(pinned.every((stop) => stop.reasons.length > 0)).toBe(true);
    // A Page photo post crosses no recorded change and no excluded product.
    const photo = await proposeVersionMoves(
      await repository({ 'a.js': SEND }),
      'v25.0',
      list,
      registry,
      NOW,
    );
    expect(photo.stops).toEqual([]);
    expect(photo.moves.map((move) => [move.from, move.to])).toEqual([['v18.0', 'v25.0']]);
  });
});

describe('matching', () => {
  it('reads every field name a fields value requests, at any depth', () => {
    expect([
      ...fieldNames([
        'id',
        'posts{message,from{id,name}}',
        'reactions.limit(0).summary(true)',
        'picture.type(large)',
      ]),
    ]).toEqual(['id', 'posts', 'message', 'from', 'name', 'reactions', 'picture']);
  });

  it('matches root endpoints by path, with runtime segments compared as placeholders', () => {
    const call = { path: '/{igUserId}/media', edge: 'media', fields: [] } as unknown as GraphCall;
    const removed = (path: string) =>
      change({ id: 'x', version: 'v20.0', kind: 'endpoint-removed', path });
    expect(changesUsedBy(call, [removed('/{id}/media')])).toHaveLength(1);
    expect(changesUsedBy(call, [removed('/{id}/media_publish')])).toHaveLength(0);
    const oembed = { path: '/instagram_oembed', edge: null, fields: [] } as unknown as GraphCall;
    expect(changesUsedBy(oembed, [removed('/instagram_oembed')])).toHaveLength(1);
    // A runtime node ID may be `me`, so it matches a change written for `/me/accounts`.
    const accounts = {
      path: '/{userId}/accounts',
      edge: 'accounts',
      fields: [],
    } as unknown as GraphCall;
    expect(changesUsedBy(accounts, [removed('/me/accounts')])).toHaveLength(1);
    expect(changesUsedBy(accounts, [removed('/me/businesses')])).toHaveLength(0);
  });
});

it('writes a patch for review from the CLI and leaves the repository unchanged', async () => {
  const root = await repository({ 'a.js': SEND });
  const list = join(root, 'changes.json');
  const patch = join(root, 'move.patch');
  await writeFile(list, JSON.stringify(changes()));
  const { stdout } = await execute(process.execPath, [
    CLI,
    'meta-graph',
    '--propose-version-moves',
    '--target',
    'v25.0',
    '--repository',
    root,
    '--changes',
    list,
    '--output',
    patch,
  ]);
  expect(stdout).toContain('Review only: nothing was applied or validated.');
  expect(stdout).toContain('a.js:2  v18.0 to v25.0');
  expect(stdout).toContain(`Patch written to ${patch}`);
  expect(await readFile(patch, 'utf8')).toContain('graph.facebook.com/v25.0/123/photos');
  expect(await readFile(join(root, 'a.js'), 'utf8')).toBe(SEND);
  const json = await execute(process.execPath, [
    CLI,
    'meta-graph',
    '--propose-version-moves',
    '--target',
    'v25.0',
    '--repository',
    root,
    '--json',
  ]);
  // The committed list reviews v14.0 to v26.0, so the same photo post moves with it too.
  const report = JSON.parse(json.stdout);
  expect(report.stops).toEqual([]);
  expect(report.moves.map((move: { line: number }) => move.line)).toEqual([2]);
  const missing = await execute(process.execPath, [
    CLI,
    'meta-graph',
    '--propose-version-moves',
    '--repository',
    root,
  ]).catch((error: { code: number; stderr: string }) => error);
  expect(missing).toMatchObject({ code: 1 });
  expect(missing.stderr).toContain('--propose-version-moves requires --target');
}, 60_000);

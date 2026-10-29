import { describe, expect, it } from 'vitest';
import {
  aiReconstructGraphCall,
  applyReconstructions,
  movedReconstructions,
  needsReconstruction,
  reconstructionProblem,
  reconstructionSources,
} from './meta-graph-ai.ts';
import type { GraphCall } from './meta-graph-calls.ts';

const AI = { apiKey: 'test', model: 'gpt-6.1-sol' };
const SOURCE = [
  "const GRAPH_BASE = process.env.GRAPH_BASE || 'https://graph.facebook.com/v19.0';",
  'export async function graph(path, params, method) {',
  '  return fetch(GRAPH_BASE + path, { method, body: new URLSearchParams(params) });',
  '}',
  "export const pages = () => graph('/me/accounts', { fields: 'id,name' }, 'GET');",
].join('\n');
const files = [{ path: 'api/ig.js', content: SOURCE }];

function unread(overrides: Partial<GraphCall> = {}): GraphCall {
  return {
    kind: 'url',
    host: 'graph.facebook.com',
    file: 'api/ig.js',
    line: 3,
    use: 'live',
    client: 'fetch',
    method: null,
    version: 'v19.0',
    versionSource: 'env-default',
    pin: { file: 'api/ig.js', line: 1 },
    path: null,
    edge: null,
    fields: null,
    metrics: null,
    parameters: null,
    unknown: ['path is built at runtime from `path`'],
    text: '',
    ...overrides,
  };
}

const answer = (value: object) => async () => ({
  content: JSON.stringify(value),
  model: 'gpt-6.1-sol',
  responseId: 'r',
  usage: null,
  budget: { costUsd: 0.01 },
});

const accounts = {
  method: 'GET' as const,
  path: '/me/accounts',
  fields: ['id', 'name'],
  metrics: [],
  parameters: ['fields'],
};

describe('AI reconstruction of unread Graph requests', () => {
  it('keeps a reconstruction whose names are all written in the code', async () => {
    const kept = await aiReconstructGraphCall({
      call: unread(),
      sources: files,
      ai: AI,
      request: answer({
        requests: [accounts],
        version: 'v19.0',
        pinFile: 'api/ig.js',
        pinLine: 1,
        explanation: 'pages() calls graph with /me/accounts.',
      }) as never,
    });
    expect(kept).toMatchObject({ status: 'kept', costUsd: 0.01, requests: [accounts] });
    const [call] = applyReconstructions([unread()], [kept]);
    expect(call).toMatchObject({
      method: 'GET',
      path: '/me/accounts',
      edge: 'accounts',
      fields: ['id', 'name'],
      parameters: ['fields'],
      unknown: [],
      reconstructed: 'gpt-6.1-sol',
      version: 'v19.0',
    });
  });

  it('refuses names the code does not contain, changed traced parts and unwritten versions', () => {
    const output = { requests: [accounts], version: 'v19.0', pinFile: 'api/ig.js', pinLine: 1 };
    expect(
      reconstructionProblem(
        unread(),
        { ...output, requests: [{ ...accounts, fields: ['id', 'email'] }] },
        files,
      ),
    ).toMatch(/email/);
    expect(reconstructionProblem(unread({ method: 'POST' }), output, files)).toMatch(/sends GET/);
    expect(reconstructionProblem(unread(), { ...output, version: 'v21.0' }, files)).toMatch(
      /pins v19.0/,
    );
    expect(
      reconstructionProblem(
        unread({ version: null, versionSource: 'unknown', pin: null }),
        { ...output, pinLine: 3 },
        files,
      ),
    ).toMatch(/does not write v19.0/);
    expect(
      reconstructionProblem(
        unread(),
        { ...output, requests: [{ ...accounts, parameters: [] }] },
        files,
      ),
    ).toMatch(/fields parameter/);
    expect(
      reconstructionProblem(unread({ version: null, versionSource: 'unversioned' }), output, files),
    ).toMatch(/adds a version/);
    expect(reconstructionProblem(unread(), output, files)).toBeUndefined();
  });

  it('records a refusal and never applies it', async () => {
    const refused = await aiReconstructGraphCall({
      call: unread(),
      sources: files,
      ai: AI,
      request: answer({
        requests: [],
        version: '',
        pinFile: '',
        pinLine: 0,
        explanation: 'The path comes from callers in other files.',
      }) as never,
    });
    expect(refused.status).toBe('refused');
    expect(applyReconstructions([unread()], [refused])[0].path).toBeNull();
  });

  it('reads a runtime version from its pin and follows it after a move', async () => {
    const call = unread({ version: null, versionSource: 'unknown', pin: null });
    expect(needsReconstruction(call)).toBe(true);
    const kept = await aiReconstructGraphCall({
      call,
      sources: files,
      ai: AI,
      request: answer({
        requests: [accounts],
        version: 'v19.0',
        pinFile: 'api/ig.js',
        pinLine: 1,
        explanation: 'GRAPH_BASE defaults to v19.0.',
      }) as never,
    });
    expect(kept).toMatchObject({ version: 'v19.0', pin: { file: 'api/ig.js', line: 1 } });
    const [moved] = movedReconstructions([kept], {
      files: [{ path: 'api/ig.js', content: SOURCE.replace('v19.0', 'v26.0') }],
    });
    expect(moved.version).toBe('v26.0');
    expect(applyReconstructions([call], [kept])[0]).toMatchObject({
      version: 'v19.0',
      pin: { file: 'api/ig.js', line: 1 },
    });
  });

  it('gives the model the call file and the files it imports', () => {
    const sources = reconstructionSources(
      [
        { path: 'src/a.ts', content: "import { b } from './lib/b';" },
        { path: 'src/lib/b.ts', content: 'export const b = 1;' },
        { path: 'src/c.ts', content: 'unrelated' },
      ],
      'src/a.ts',
    );
    expect(sources.map((source) => source.path)).toEqual(['src/a.ts', 'src/lib/b.ts']);
  });
});

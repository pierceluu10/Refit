import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, Obligation } from '../../shared/types.ts';
import { AUDIT_PATHS, auditCsv, serveAudit } from './index.ts';
import type { AuditDeps } from './index.ts';

const SERVICE_TOKEN = 'test-service-token';
const AUTHORIZATION = `Bearer ${SERVICE_TOKEN}`;
const BOM = '﻿';
const HEADER = [
  'Time',
  'Repository',
  'Change',
  'Obligation',
  'Action',
  'Pull request',
  'Evidence',
  'Actor',
];
const FIRST = 'test-owner/first';
const SECOND = 'test-owner/second';

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  at: '2026-11-01T10:00:00Z',
  repo: FIRST,
  changeId: 'test-change',
  action: 'detected',
  evidence: ['test evidence'],
  actor: 'refit',
  ...overrides,
});

// RFC 4180, so a broken quoting rule fails here instead of in an auditor's spreadsheet.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += char;
  }
  if (field !== '' || row.length > 0) throw new Error(`CSV has an unterminated row: ${row}`);
  return rows;
}

const parseBody = (text: string) => parseCsv(text.replace(BOM, ''));

let server: Server | undefined;

async function start(overrides: Partial<AuditDeps> = {}) {
  const deps: AuditDeps = {
    access: async (request) =>
      request.headers.authorization === AUTHORIZATION ? 'all' : undefined,
    listRepos: vi.fn(async () => [FIRST, SECOND]),
    listAudit: vi.fn(async () => []),
    ...overrides,
  };
  // Mounted the way P1 mounts it beside serveRuns in app/server.ts.
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && AUDIT_PATHS.includes(path)) {
      serveAudit(request, response, deps).catch(() => response.writeHead(500).end());
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = (path: string, authorization: string | null = AUTHORIZATION) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: authorization === null ? {} : { authorization },
    });
  return { deps, get };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('audit auth', () => {
  it.each(AUDIT_PATHS)(
    'answers 401 with an empty body on %s without touching data',
    async (path) => {
      const listObligations = vi.fn(async () => []);
      const { deps, get } = await start({ listObligations });
      for (const authorization of [null, 'Bearer wrong-token']) {
        const response = await get(`${path}?repo=${encodeURIComponent(FIRST)}`, authorization);
        expect(response.status).toBe(401);
        expect(await response.text()).toBe('');
      }
      expect(deps.listAudit).not.toHaveBeenCalled();
      expect(deps.listRepos).not.toHaveBeenCalled();
      expect(listObligations).not.toHaveBeenCalled();
    },
  );

  it('checks auth before validating the repo', async () => {
    const { get } = await start();
    expect((await get('/api/audit?repo=..%2Fetc', null)).status).toBe(401);
  });
});

describe.each(['/api/audit', '/api/audit.csv'])('repo validation on %s', (path) => {
  it.each([
    ['a parent path', '../etc'],
    ['a bare name', 'first'],
    ['CRLF header injection', 'test-owner/first\r\nX-Injected: yes'],
    ['a quote that would break the filename', 'test-owner/first"x'],
  ])('rejects %s', async (_, repo) => {
    const { deps, get } = await start();
    const response = await get(`${path}?repo=${encodeURIComponent(repo)}`);
    expect(response.status).toBe(400);
    expect(response.headers.get('x-injected')).toBeNull();
    expect(await response.json()).toEqual({ error: 'repo must be owner/name' });
    expect(deps.listAudit).not.toHaveBeenCalled();
  });
});

describe('GET /api/audit', () => {
  it('returns one repo’s entries as JSON and reads only that repo', async () => {
    const stored = [entry({ pr: 'https://github.com/test-owner/first/pull/1' })];
    const listAudit = vi.fn(async () => stored);
    const { deps, get } = await start({ listAudit });
    const response = await get(`/api/audit?repo=${encodeURIComponent(FIRST)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(stored);
    expect(listAudit.mock.calls).toEqual([[FIRST]]);
    expect(deps.listRepos).not.toHaveBeenCalled();
  });

  it('merges every repo chronologically when no repo is given', async () => {
    const stored: Record<string, AuditEntry[]> = {
      [FIRST]: [
        entry({ changeId: 'first-late', at: '2026-11-03T00:00:00Z' }),
        entry({ changeId: 'first-early', at: '2026-11-01T00:00:00Z' }),
      ],
      [SECOND]: [entry({ repo: SECOND, changeId: 'second-middle', at: '2026-11-02T00:00:00Z' })],
    };
    const { get } = await start({ listAudit: async (repo) => stored[repo] });
    const body = (await (await get('/api/audit')).json()) as AuditEntry[];
    expect(body.map((item) => item.changeId)).toEqual([
      'first-early',
      'second-middle',
      'first-late',
    ]);
  });

  it('treats an empty repo parameter as every repo', async () => {
    const { deps, get } = await start();
    expect((await get('/api/audit?repo=')).status).toBe(200);
    expect(deps.listRepos).toHaveBeenCalledOnce();
  });

  it('lets a store failure reject to the mount instead of answering an empty trail', async () => {
    const { get } = await start({
      listAudit: async () => {
        throw new Error('test store failure');
      },
    });
    expect((await get(`/api/audit?repo=${encodeURIComponent(FIRST)}`)).status).toBe(500);
  });
});

describe('GET /api/audit.csv', () => {
  it('names the attachment after the repo', async () => {
    const { get } = await start();
    const response = await get(`/api/audit.csv?repo=${encodeURIComponent(FIRST)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="refit-audit-test-owner-first.csv"',
    );
  });

  it('exports every repo chronologically when no repo is given', async () => {
    const stored: Record<string, AuditEntry[]> = {
      [FIRST]: [entry({ at: '2026-11-02T00:00:00Z' })],
      [SECOND]: [entry({ repo: SECOND, at: '2026-11-01T00:00:00Z' })],
    };
    const { get } = await start({ listAudit: async (repo) => stored[repo] });
    const response = await get('/api/audit.csv');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="refit-audit-all-repositories.csv"',
    );
    const rows = parseBody(await response.text());
    expect(rows.slice(1).map((row) => row[1])).toEqual([SECOND, FIRST]);
  });
});

describe('secrets never leave', () => {
  const fakeToken = 'ghp_' + 'a'.repeat(36);
  const envValue = 'test-env-secret-value';

  async function exposed(path: string) {
    vi.stubEnv('REFIT_TEST_TOKEN', envValue);
    const { get } = await start({
      listAudit: async () => [
        entry({
          evidence: [`log tail ${fakeToken}`, `env ${envValue}`],
          actor: `actor-${envValue}`,
        }),
      ],
    });
    return (await get(`${path}?repo=${encodeURIComponent(FIRST)}`)).text();
  }

  it.each(['/api/audit', '/api/audit.csv'])('redacts evidence and actor on %s', async (path) => {
    const body = await exposed(path);
    expect(body).toContain('log tail [redacted]');
    expect(body).toContain('actor-[redacted]');
    expect(body).not.toContain(fakeToken);
    expect(body).not.toContain(envValue);
  });
});

describe('GET /api/obligations', () => {
  it('answers an empty list when no read is wired', async () => {
    const { get } = await start();
    const response = await get('/api/obligations');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('returns the wired obligations', async () => {
    const obligations: Obligation[] = [
      {
        id: 'test-obligation',
        rule: { name: 'Test Rule', url: 'https://example.test/rule', quote: 'test quote' },
        requirement: 'test requirement',
        appliesTo: 'test surface',
        inCode: 'test code',
        checkable: ['test check'],
        needsHuman: ['test confirmation'],
      },
    ];
    const { get } = await start({ listObligations: async () => obligations });
    expect(await (await get('/api/obligations')).json()).toEqual(obligations);
  });
});

describe('auditCsv', () => {
  it('starts with a BOM and ends every row with CRLF', () => {
    const csv = auditCsv([entry()]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(BOM, '').split('\r\n')).toHaveLength(3);
  });

  it('writes only the header row when there are no entries', () => {
    expect(auditCsv([])).toBe(`${BOM}${HEADER.join(',')}\r\n`);
  });

  it('round-trips commas, quotes and newlines, and leaves optional cells empty', () => {
    const rows = parseBody(
      auditCsv([
        entry({
          changeId: 'a,b',
          obligationId: 'say "hello"',
          pr: 'https://example.test/pull/1',
          evidence: ['axe scan, 0 new', 'said "fine"', 'line\r\nbreak'],
        }),
        entry({ at: '2026-11-02T00:00:00Z', evidence: [] }),
      ]),
    );
    expect(rows[0]).toEqual(HEADER);
    expect(rows[1]).toEqual([
      '2026-11-01T10:00:00Z',
      FIRST,
      'a,b',
      'say "hello"',
      'detected',
      'https://example.test/pull/1',
      'axe scan, 0 new\nsaid "fine"\nline\r\nbreak',
      'refit',
    ]);
    expect(rows[2].slice(3)).toEqual(['', 'detected', '', '', 'refit']);
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'neutralizes a cell starting with %j in every column',
    (prefix) => {
      const value = `${prefix}cmd`;
      const rows = parseBody(
        auditCsv([
          {
            at: value,
            repo: value,
            changeId: value,
            obligationId: value,
            action: value as AuditEntry['action'],
            pr: value,
            evidence: [value],
            actor: value,
          },
        ]),
      );
      expect(rows[1]).toHaveLength(HEADER.length);
      expect(rows[1]).toEqual(HEADER.map(() => `'${value}`));
    },
  );

  it('sorts oldest first across time zones without mutating its input', () => {
    const later = entry({ changeId: 'later', at: '2026-11-01T10:00:00Z' });
    const earlier = entry({ changeId: 'earlier', at: '2026-11-01T11:00:00+02:00' });
    const input = Object.freeze([later, earlier]) as AuditEntry[];
    const rows = parseBody(auditCsv(input));
    expect(rows.slice(1).map((row) => row[2])).toEqual(['earlier', 'later']);
    expect(input).toEqual([later, earlier]);
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  listAudit as listStoredAudit,
  listObligations as listStoredObligations,
} from '../../compliance/index.ts';
import { redactSecrets } from '../../harness/secrets.ts';
import type { AuditEntry, Obligation } from '../../shared/types.ts';
import { canRead } from '../api/auth.ts';
import type { Access } from '../api/auth.ts';
import { REPO_PATTERN } from '../types.ts';
import { auditCsv, chronological } from './csv.ts';

export { auditCsv } from './csv.ts';

const AUDIT_PATH = '/api/audit';
const CSV_PATH = '/api/audit.csv';
const OBLIGATIONS_PATH = '/api/obligations';
export const AUDIT_PATHS = [AUDIT_PATH, CSV_PATH, OBLIGATIONS_PATH];

const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const ALL_REPOSITORIES = 'all-repositories';

export type AuditDeps = {
  access: (request: IncomingMessage) => Promise<Access | undefined>;
  listRepos: () => Promise<string[]>;
  listAudit?: (repo: string) => Promise<AuditEntry[]>;
  listObligations?: () => Promise<Obligation[]>;
};

const sendJson = (response: ServerResponse, status: number, body: unknown) =>
  void response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

const redacted = (entry: AuditEntry): AuditEntry => ({
  ...entry,
  evidence: entry.evidence.map((line) => redactSecrets(line)),
  actor: redactSecrets(entry.actor),
});

async function entriesFor(
  repo: string | undefined,
  access: Access,
  deps: AuditDeps,
): Promise<AuditEntry[]> {
  const list = deps.listAudit ?? listStoredAudit;
  const wanted = repo === undefined ? await deps.listRepos() : [repo];
  const repos = wanted.filter((name) => canRead(access, name));
  const entries = (await Promise.all(repos.map((name) => list(name)))).flat();
  return chronological(entries).map(redacted);
}

export async function serveAudit(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AuditDeps,
): Promise<void> {
  const access = await deps.access(request);
  if (!access) {
    response.writeHead(UNAUTHORIZED).end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Obligations are the rules' own text, shared by every org: they hold no customer data.
  if (url.pathname === OBLIGATIONS_PATH) {
    sendJson(response, OK, await (deps.listObligations ?? listStoredObligations)());
    return;
  }
  const repo = url.searchParams.get('repo') || undefined;
  if (repo !== undefined && !REPO_PATTERN.test(repo)) {
    sendJson(response, BAD_REQUEST, { error: 'repo must be owner/name' });
    return;
  }
  const entries = await entriesFor(repo, access, deps);
  if (url.pathname !== CSV_PATH) {
    sendJson(response, OK, entries);
    return;
  }
  const name = repo?.replace('/', '-') ?? ALL_REPOSITORIES;
  response
    .writeHead(OK, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="refit-audit-${name}.csv"`,
    })
    .end(auditCsv(entries));
}

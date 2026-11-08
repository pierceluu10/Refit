import type {
  AuditEntry,
  BehindItem,
  ExternalChange,
  Obligation,
  RunView,
  ScanReport,
} from '../../shared/types.ts';

const RUNS_LIMIT = 100;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

// No API is served here: a static deploy answers 404 or falls back to index.html.
export class ApiUnavailableError extends Error {}
// The API needs a sign-in the site can't do yet.
export class ApiSignedOutError extends Error {}

export type RepoData = {
  report: ScanReport | null; // null until the repo's first scan
  runs: RunView[];
  audit: AuditEntry[];
  obligations: Obligation[];
};

export type PageData = { repos: string[]; selected?: string; data?: RepoData };

async function getJson(path: string, signal: AbortSignal, notFoundIsEmpty = false) {
  // Same origin with no credentials: the dev proxy attaches the token on the server.
  const response = await fetch(path, { signal });
  if (response.status === UNAUTHORIZED) throw new ApiSignedOutError();
  const json = response.headers.get('content-type')?.includes('application/json');
  if (response.status === NOT_FOUND) {
    if (json && notFoundIsEmpty) return null;
    throw new ApiUnavailableError();
  }
  // Checked before the JSON test: the app answers its own failures with an empty body.
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
  if (!json) throw new ApiUnavailableError();
  return (await response.json()) as unknown;
}

async function getList<T>(path: string, signal: AbortSignal): Promise<T[]> {
  const body = await getJson(path, signal);
  if (!Array.isArray(body)) throw new Error(`${path} returned something other than a list.`);
  return body as T[];
}

// shortcut: P3 hasn't settled the shape of /api/repos, so this accepts names or objects; narrow it when P3 lands.
function repoName(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { repo, fullName, full_name, name } = entry as Record<string, unknown>;
  const value = repo ?? fullName ?? full_name ?? name;
  return typeof value === 'string' ? value : undefined;
}

export const pickRepo = (repos: string[], requested: string | null) =>
  requested && repos.includes(requested) ? requested : repos[0];

export async function loadPage(requested: string | null, signal: AbortSignal): Promise<PageData> {
  const repos = (await getList<unknown>('/api/repos', signal))
    .map(repoName)
    .filter((name) => name !== undefined);
  const selected = pickRepo(repos, requested);
  if (!selected) return { repos };
  const repo = new URLSearchParams({ repo: selected });
  const limited = new URLSearchParams({ repo: selected, limit: String(RUNS_LIMIT) });
  const [report, runs, audit, obligations] = await Promise.all([
    getJson(`/api/report?${repo}`, signal, true) as Promise<ScanReport | null>,
    getList<RunView>(`/api/runs?${limited}`, signal),
    getList<AuditEntry>(`/api/audit?${repo}`, signal),
    getList<Obligation>('/api/obligations', signal),
  ]);
  return { repos, selected, data: { report, runs, audit, obligations } };
}

export function auditCsvPath(repo: string) {
  return `/api/audit.csv?${new URLSearchParams({ repo })}`;
}

// Evidence and sources come from outside, so anything but http(s) never becomes a link.
export function safeHref(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

const timeOf = (value: string | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

export const deadlineOf = (item: BehindItem) => item.deadline ?? item.change.effectiveDate;

const byDeadline = (a: BehindItem, b: BehindItem) => {
  const [first, second] = [timeOf(deadlineOf(a)), timeOf(deadlineOf(b))];
  return first === second ? 0 : first - second;
};

// Display only: which heading a finding sits under. It decides nothing about the finding.
const PLATFORM_GROUPS: { name: string; kinds: ExternalChange['kind'][] }[] = [
  { name: 'Kubernetes and cloud', kinds: ['k8s-version', 'cloud-deprecation'] },
  { name: 'Serverless', kinds: ['serverless-runtime'] },
  { name: 'App stores and mobile', kinds: ['platform-policy', 'mobile-os'] },
  { name: 'Browsers', kinds: ['browser-change'] },
  { name: 'TLS and login', kinds: ['tls-crypto', 'auth-standard'] },
];
const RULE_KINDS: ExternalChange['kind'][] = ['regulation', 'payment-rule'];

export function platformGroups(items: BehindItem[]) {
  return PLATFORM_GROUPS.map(({ name, kinds }) => ({
    name,
    items: items.filter((item) => kinds.includes(item.change.kind)).sort(byDeadline),
  })).filter((group) => group.items.length > 0);
}

export const newestFirst = (entries: AuditEntry[]) =>
  [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

export type RuleView = {
  item: BehindItem;
  obligation?: Obligation;
  applies: boolean;
  why: string[];
  changed?: string;
  checks: string[];
  sources: string[];
  needsReview: boolean;
};

const unique = (values: string[]) => [...new Set(values)];

export function ruleViews({ report, runs, audit, obligations }: RepoData): RuleView[] {
  const items = (report?.items ?? []).filter((item) => RULE_KINDS.includes(item.change.kind));
  const views = items.map((item): RuleView => {
    const entries = newestFirst(audit).filter((entry) => entry.changeId === item.change.id);
    const obligation = entries
      .map((entry) => obligations.find(({ id }) => id === entry.obligationId))
      .find((match) => match !== undefined);
    // A rule another rule's task also resolves shares that task's id, so it shares the run.
    const run = runs.find(
      (candidate) => candidate.changeId === item.change.id || candidate.taskId === item.taskId,
    );
    const decision = entries.find(
      ({ action }) => action === 'matched' || action === 'not-affected',
    );
    const textOf = (evidence: string[]) => evidence.filter((line) => !safeHref(line));
    const applies = item.status !== 'not-affected';
    const why = textOf(decision?.evidence ?? []);
    const nothingToConfirm = obligation?.needsHuman.length === 0;
    return {
      item,
      obligation,
      applies,
      why: why.length > 0 ? why : item.dependency.notes ? [item.dependency.notes] : [],
      changed: run?.summary,
      checks: unique(
        entries
          .filter(({ action }) => action === 'pr-opened' || action === 'pr-updated')
          .flatMap(({ evidence }) => textOf(evidence)),
      ),
      sources: unique(entries.flatMap(({ evidence }) => evidence.filter(safeHref))),
      needsReview: applies && !(run?.outcome === 'verified' && nothingToConfirm),
    };
  });
  return views.sort((a, b) => Number(b.applies) - Number(a.applies) || byDeadline(a.item, b.item));
}

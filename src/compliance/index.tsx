import {
  ArrowUpRight,
  CheckCircle,
  DownloadSimple,
  FolderSimple,
  GitPullRequest,
  Info,
  Scales,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { auditCsv } from '../../app/audit/csv.ts';
import type { AuditEntry, BehindItem } from '../../shared/types.ts';
import {
  ApiSignedOutError,
  ApiUnavailableError,
  auditCsvPath,
  deadlineOf,
  loadPage,
  newestFirst,
  pickRepo,
  platformGroups,
  ruleViews,
  safeHref,
} from './api';
import type { PageData, RepoData, RuleView } from './api';
import { EXAMPLE_NOTE, exampleData, exampleRepos } from './fixtures';
import './compliance.css';

const LEGAL_NOTE =
  "Refit doesn't give legal advice. Have counsel confirm the items marked for review.";
const NO_CONFIRM_RECORD =
  'Refit has no record of what to confirm here. Read the PR, and have counsel review it.';
const EXAMPLE_LINE = '# Example data. Not a real audit record.';
const BOM = '\uFEFF';
const REVOKE_DELAY_MS = 1000;

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Engines read loose text like "early 2027" as an exact day, so only ISO dates get reformatted.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const formatted = (value: string, format: Intl.DateTimeFormat) => {
  const date = new Date(value);
  return ISO_DATE.test(value) && !Number.isNaN(date.getTime()) ? format.format(date) : value;
};

const statusStyles = {
  open: { label: 'Open', className: 'status-attention', Icon: WarningCircle },
  'pr-open': { label: 'PR open', className: 'status-attention', Icon: GitPullRequest },
  merged: { label: 'Merged', className: 'status-positive', Icon: CheckCircle },
  'not-affected': { label: 'Not affected', className: 'status-positive', Icon: CheckCircle },
} satisfies Record<BehindItem['status'], object>;

const actionLabels: Record<AuditEntry['action'], string> = {
  detected: 'Detected',
  matched: 'Matched',
  'not-affected': 'Not affected',
  'pr-opened': 'PR opened',
  'pr-updated': 'PR updated',
  merged: 'Merged',
  closed: 'Closed',
};

type Example = 'signed-out' | 'unavailable';
type Ready = PageData & { example?: Example };

function exampleReady(requested: string | null, example: Example): Ready {
  const selected = pickRepo(exampleRepos, requested);
  return { repos: exampleRepos, selected, data: exampleData(selected), example };
}

function ExternalLink({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children: ReactNode;
}) {
  const href = safeHref(url);
  if (!href) return <span className="rules-plain">{url}</span>;
  return (
    <a
      className="text-link rules-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label} (opens in a new tab)`}
    >
      {children}
      <ArrowUpRight aria-hidden="true" />
    </a>
  );
}

function PullRequest({ item }: { item: Pick<BehindItem, 'pr' | 'repo'> & { id: string } }) {
  if (!item.pr) return <span className="rules-missing">No PR yet</span>;
  return (
    <ExternalLink url={item.pr} label={`Pull request for ${item.id} on ${item.repo}`}>
      Pull request
    </ExternalLink>
  );
}

function SourceQuote({ url, quote, title }: { url: string; quote: string; title: string }) {
  return (
    <p className="rules-source">
      <span>{quote}</span>{' '}
      <ExternalLink url={url} label={`Source for ${title}`}>
        Source
      </ExternalLink>
    </p>
  );
}

function Declared({ item }: { item: BehindItem }) {
  const place = item.dependency.declaredIn[0];
  if (!place) return null;
  return (
    <code>
      {place.file}
      {place.line === undefined ? '' : `:${place.line}`}
    </code>
  );
}

function Finding({ item }: { item: BehindItem }) {
  const { label, className, Icon } = statusStyles[item.status];
  const deadline = deadlineOf(item);
  const { change, dependency } = item;
  return (
    <li className="rules-finding">
      <p className="rules-deadline">
        {deadline ? (
          <time dateTime={deadline}>{formatted(deadline, dateFormat)}</time>
        ) : (
          <span className="rules-missing">No date published</span>
        )}
      </p>
      <div className="rules-finding-body">
        <h4>{change.title}</h4>
        <p className="rules-meta">
          <code>
            {dependency.name}
            {dependency.version ? ` ${dependency.version}` : ''}
          </code>
          <Declared item={item} />
          {change.toVersion && (
            <span>
              Target <code>{change.toVersion}</code>
            </span>
          )}
        </p>
        <SourceQuote url={change.source.url} quote={change.source.quote} title={change.title} />
      </div>
      <div className="rules-finding-side">
        <span className={`resource-status ${className}`}>
          <Icon aria-hidden="true" />
          {label}
        </span>
        {item.pr && <PullRequest item={{ ...item, id: change.id }} />}
      </div>
    </li>
  );
}

function Platforms({ data, repo }: { data: RepoData; repo: string }) {
  const groups = platformGroups(data.report?.items ?? []);
  return (
    <Section title="Platforms" description="Platform changes this repository depends on.">
      {groups.length === 0 ? (
        <p className="rules-empty">No platform findings in {repo}.</p>
      ) : (
        groups.map((group) => (
          <div className="rules-group" key={group.name}>
            <h3>{group.name}</h3>
            <ul aria-label={group.name}>
              {group.items.map((item) => (
                <Finding item={item} key={item.change.id} />
              ))}
            </ul>
          </div>
        ))
      )}
    </Section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Lines({ lines, missing }: { lines: string[]; missing: string }) {
  if (lines.length === 0) return <span className="rules-missing">{missing}</span>;
  return (
    <ul className="rules-lines">
      {lines.map((line, index) => (
        <li key={`${index}-${line}`}>{line}</li>
      ))}
    </ul>
  );
}

function ForReview({ rule }: { rule: RuleView }) {
  if (!rule.obligation) return <span className="rules-missing">{NO_CONFIRM_RECORD}</span>;
  if (rule.obligation.needsHuman.length === 0)
    return <span className="rules-missing">Nothing is marked for review.</span>;
  return (
    <ul className="rules-review">
      {rule.obligation.needsHuman.map((line) => (
        <li key={line}>
          <span className="rules-review-mark">
            <WarningCircle aria-hidden="true" />
            For review
          </span>
          {line}
        </li>
      ))}
    </ul>
  );
}

function Rule({ rule }: { rule: RuleView }) {
  const { item, obligation, applies } = rule;
  const title = obligation?.rule.name ?? item.change.title;
  const source = obligation?.rule ?? item.change.source;
  const deadline = deadlineOf(item) ?? obligation?.effectiveDate;
  return (
    <li className="rules-rule">
      <div className="rules-rule-heading">
        <div>
          <h3>{title}</h3>
          <p className="rules-meta">
            {obligation?.rule.jurisdiction && <span>{obligation.rule.jurisdiction}</span>}
            {deadline && (
              <span>
                Effective <time dateTime={deadline}>{formatted(deadline, dateFormat)}</time>
              </span>
            )}
          </p>
        </div>
        {rule.needsReview ? (
          <span className="resource-status status-attention">
            <WarningCircle aria-hidden="true" />
            Needs review
          </span>
        ) : (
          applies && (
            <span className="resource-status status-positive">
              <CheckCircle aria-hidden="true" />
              Nothing marked for review
            </span>
          )
        )}
      </div>
      {obligation && <p className="rules-requirement">{obligation.requirement}</p>}
      <SourceQuote url={source.url} quote={source.quote} title={title} />
      <dl className="rules-facts">
        <Fact term="Does it apply?">
          <strong>{applies ? 'Likely applies' : "Likely doesn't apply"}</strong>
          <span className="rules-hint"> Refit's read, not a legal finding.</span>
        </Fact>
        <Fact term="Why">
          <Lines lines={rule.why} missing="Refit recorded no reason for this." />
          {applies && (
            <p className="rules-meta">
              <Declared item={item} />
            </p>
          )}
        </Fact>
        <Fact term="What Refit changed">
          {rule.changed ?? <span className="rules-missing">No change recorded yet.</span>}
        </Fact>
        <Fact term="What each check showed">
          <Lines lines={rule.checks} missing="No check results recorded." />
        </Fact>
        {applies && (
          <Fact term="What a person or lawyer must confirm">
            <ForReview rule={rule} />
          </Fact>
        )}
        <Fact term="Pull request">
          <PullRequest item={{ ...item, id: item.change.id }} />
        </Fact>
        {rule.sources.length > 0 && (
          <Fact term="Sources">
            <ul className="rules-lines">
              {rule.sources.map((url) => (
                <li key={url}>
                  <ExternalLink url={url} label={`Evidence source ${url}`}>
                    {url}
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </Fact>
        )}
      </dl>
    </li>
  );
}

function Rules({ data, repo }: { data: RepoData; repo: string }) {
  const rules = ruleViews(data);
  return (
    <Section
      title="Rules"
      description="Laws and payment rules, what Refit did about each, and what is left for people."
    >
      {rules.length === 0 ? (
        <p className="rules-empty">No rules matched {repo}.</p>
      ) : (
        <ul className="rules-rule-list" aria-label="Rules">
          {rules.map((rule) => (
            <Rule rule={rule} key={rule.item.change.id} />
          ))}
        </ul>
      )}
    </Section>
  );
}

// The first line and the file name keep an example from passing for a real audit record.
function exampleCsv(entries: AuditEntry[]) {
  return `${BOM}${EXAMPLE_LINE}\r\n${auditCsv(entries).replace(BOM, '')}`;
}

function downloadExample(entries: AuditEntry[], repo: string) {
  const url = URL.createObjectURL(
    new Blob([exampleCsv(entries)], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `refit-audit-example-${repo.replace('/', '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function ExportCsv({
  entries,
  repo,
  example,
}: {
  entries: AuditEntry[];
  repo: string;
  example: boolean;
}) {
  const content = (
    <>
      <DownloadSimple aria-hidden="true" /> Export CSV
    </>
  );
  const className = 'button button-secondary button-small';
  return example ? (
    <button type="button" className={className} onClick={() => downloadExample(entries, repo)}>
      {content}
    </button>
  ) : (
    <a className={className} href={auditCsvPath(repo)} download>
      {content}
    </a>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr>
      <td className="rules-time">
        <time dateTime={entry.at}>{formatted(entry.at, timeFormat)}</time>
      </td>
      <td>{actionLabels[entry.action] ?? entry.action}</td>
      <td>
        <code>{entry.changeId}</code>
      </td>
      <td>
        {entry.obligationId ? (
          <code>{entry.obligationId}</code>
        ) : (
          <span className="rules-missing">None</span>
        )}
      </td>
      <td>
        <ul className="rules-lines">
          {entry.evidence.map((line, index) => (
            <li key={`${index}-${line}`}>
              {safeHref(line) ? (
                <ExternalLink url={line} label={`Evidence for ${entry.changeId}: ${line}`}>
                  {line}
                </ExternalLink>
              ) : (
                line
              )}
            </li>
          ))}
        </ul>
      </td>
      <td>{entry.actor}</td>
      <td>
        {entry.pr ? (
          <PullRequest item={{ pr: entry.pr, repo: entry.repo, id: entry.changeId }} />
        ) : (
          <span className="rules-missing">None</span>
        )}
      </td>
    </tr>
  );
}

function AuditTrail({ data, repo, example }: { data: RepoData; repo: string; example: boolean }) {
  const entries = newestFirst(data.audit);
  return (
    <Section
      title="Audit trail"
      description="Every step Refit took on this repository, newest first."
      action={<ExportCsv entries={data.audit} repo={repo} example={example} />}
    >
      {entries.length === 0 ? (
        <p className="rules-empty">No audit entries for {repo} yet.</p>
      ) : (
        // Focusable so a keyboard can scroll the table on a narrow screen.
        <div
          className="rules-table-scroll"
          role="region"
          aria-label="Audit trail table"
          tabIndex={0}
        >
          <table aria-label={`Audit trail for ${repo}`}>
            <thead>
              <tr>
                {['Time', 'Action', 'Change', 'Obligation', 'Evidence', 'Actor', 'PR'].map(
                  (column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <AuditRow entry={entry} key={`${entry.at}-${entry.changeId}-${index}`} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `rules-${title.toLowerCase().replace(' ', '-')}`;
  return (
    <section className="rules-section" aria-labelledby={id}>
      <div className="rules-section-heading">
        <div>
          <h2 id={id}>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ScanFacts({ data }: { data: RepoData }) {
  if (!data.report)
    return <p className="rules-scanned">This repository hasn’t been scanned yet.</p>;
  const { scannedAt, errors } = data.report;
  return (
    <>
      <p className="rules-scanned">
        Last scanned <time dateTime={scannedAt}>{formatted(scannedAt, timeFormat)}</time>
      </p>
      {errors.length > 0 && (
        <div className="rules-unread">
          <h2>What Refit couldn’t read</h2>
          <Lines lines={errors} missing="" />
        </div>
      )}
    </>
  );
}

export function PlatformsAndRules() {
  const [parameters, setParameters] = useSearchParams();
  const requested = parameters.get('repo');
  const [ready, setReady] = useState<Ready>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const stale = () => controller.signal.aborted;
    loadPage(requested, controller.signal)
      .then(
        (page) => {
          if (!stale()) setReady(page);
        },
        (reason: unknown) => {
          if (stale()) return;
          if (reason instanceof ApiUnavailableError)
            setReady(exampleReady(requested, 'unavailable'));
          else if (reason instanceof ApiSignedOutError)
            setReady(exampleReady(requested, 'signed-out'));
          else {
            setReady(undefined);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        },
      )
      .finally(() => {
        if (!stale()) setLoading(false);
      });
    return () => controller.abort();
  }, [requested, attempt]);

  const example = ready?.example;
  const repos = ready?.repos ?? [];
  const selected = pickRepo(repos, requested);
  const shown = !loading && !error && ready;

  return (
    <div className="rules-page">
      <div className="app-page-heading">
        <div>
          {example && <span className="rules-example-chip">Example data</span>}
          <h1>Platforms and rules</h1>
          <p>
            Platform changes and rules that touch your code, what Refit did and what people must
            still confirm.
          </p>
        </div>
      </div>
      <p className="detail-explanation rules-legal" role="note">
        <Scales aria-hidden="true" />
        <span>{LEGAL_NOTE}</span>
      </p>
      {example && (
        <p className="detail-explanation rules-example-note">
          <Info aria-hidden="true" />
          <span>
            {example === 'signed-out'
              ? 'This view needs a sign-in, which isn’t available yet. Everything below is example data.'
              : 'No Refit API is reachable from this site. Everything below is example data.'}
          </span>
        </p>
      )}
      {repos.length > 0 && (
        <div className="rules-toolbar">
          <label>
            Repository
            <select
              className="rules-select"
              value={selected}
              onChange={(event) =>
                setParameters((current) => {
                  current.set('repo', event.target.value);
                  return current;
                })
              }
            >
              {repos.map((repo) => (
                <option key={repo}>{repo}</option>
              ))}
            </select>
          </label>
          {shown && ready.data && <ScanFacts data={ready.data} />}
        </div>
      )}
      {loading && (
        <p className="rules-empty" role="status">
          Loading platforms and rules…
        </p>
      )}
      {error && (
        <div className="empty-state" role="alert">
          <WarningCircle size={30} aria-hidden="true" />
          <h2>Couldn’t load platforms and rules.</h2>
          <p>{error} Check that the Refit app is running, then try again.</p>
          <button
            className="button button-secondary button-small"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {shown && !ready.data && (
        <div className="empty-state">
          <FolderSimple size={30} aria-hidden="true" />
          <h2>No repositories yet</h2>
          <p>Install the GitHub App on a repository, and its findings appear here.</p>
        </div>
      )}
      {shown && ready.data && selected && (
        <>
          <Platforms data={ready.data} repo={selected} />
          <Rules data={ready.data} repo={selected} />
          <AuditTrail data={ready.data} repo={selected} example={Boolean(example)} />
          {example && <p className="rules-footnote">{EXAMPLE_NOTE}</p>}
        </>
      )}
    </div>
  );
}

import {
  ArrowUpRight,
  CheckCircle,
  ClockCountdown,
  FolderSimple,
  GitMerge,
  GitPullRequest,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { BehindItem, RunRecord } from '../../shared/types.ts';
import { outcomeLabels } from '../fixtures';

const outcomeStyles = {
  verified: { className: 'status-positive', Icon: CheckCircle },
  'not-affected': { className: 'status-positive', Icon: CheckCircle },
  'needs-review': { className: 'status-attention', Icon: WarningCircle },
  failed: { className: 'status-negative', Icon: XCircle },
  'waiting-budget': { className: 'status-attention', Icon: ClockCountdown },
} satisfies Record<RunRecord['outcome'], object>;

export function Status({ outcome }: { outcome: RunRecord['outcome'] }) {
  const { className, Icon } = outcomeStyles[outcome];
  return (
    <span className={`resource-status ${className}`}>
      <Icon />
      {outcomeLabels[outcome]}
    </span>
  );
}

export const behindStatusLabels: Record<BehindItem['status'], string> = {
  open: 'Open',
  'pr-open': 'PR open',
  merged: 'Merged',
  'not-affected': 'Not affected',
};

const behindStatusStyles = {
  open: { className: 'status-attention', Icon: WarningCircle },
  'pr-open': { className: 'status-progress', Icon: GitPullRequest },
  merged: { className: 'status-positive', Icon: GitMerge },
  'not-affected': { className: 'status-positive', Icon: CheckCircle },
} satisfies Record<BehindItem['status'], object>;

export function BehindStatus({ status }: { status: BehindItem['status'] }) {
  const { className, Icon } = behindStatusStyles[status];
  return (
    <span className={`resource-status ${className}`}>
      <Icon />
      {behindStatusLabels[status]}
    </span>
  );
}

export function labelOf(labels: Record<string, string>, value: string) {
  return labels[value] ?? value;
}

export function repoPath(repo: string) {
  return `/app/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

// UTC, because a date-only deadline parses as UTC and would otherwise show a day early in the US.
export function formatDay(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : dayFormat.format(time);
}

export function ExternalLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  // These addresses come from scans of outside pages, so only web addresses become links.
  if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a className="text-link" href={href} target="_blank" rel="noreferrer" aria-label={label}>
      {children}
      <ArrowUpRight />
    </a>
  );
}

export function DataCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td data-label={label}>
      <div>{children}</div>
    </td>
  );
}

export function ScanErrors({ repo, errors }: { repo: string; errors: string[] }) {
  return (
    <div className="detail-explanation scan-note">
      <WarningCircle />
      <div>
        <p>Refit couldn’t read everything in {repo}.</p>
        <ul>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function NoRepositories() {
  return (
    <div className="empty-state">
      <FolderSimple size={30} />
      <h2>No repositories yet</h2>
      <p>Install the GitHub App and choose your repositories. Refit scans them from there.</p>
      <Link className="button button-primary" to="/onboarding">
        Install the GitHub App
      </Link>
    </div>
  );
}

export function PageHeading({
  title,
  description,
  action,
  example,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  example: boolean;
}) {
  return (
    <div className="app-page-heading">
      <div>
        {example && <span className="example-chip">Example data</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function WorkspaceMissing() {
  return (
    <div className="empty-state">
      <FolderSimple size={32} />
      <h1>Nothing at this address.</h1>
      <p>This page isn’t part of the dashboard.</p>
      <Link className="button button-primary" to="/app">
        Back to What’s behind
      </Link>
    </div>
  );
}

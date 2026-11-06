import { CheckCircle, FolderSimple, WarningCircle, XCircle } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { RunRecord } from '../../shared/types.ts';
import { outcomeLabels } from '../fixtures';

const outcomeStyles = {
  verified: { className: 'status-positive', Icon: CheckCircle },
  'not-affected': { className: 'status-positive', Icon: CheckCircle },
  'needs-review': { className: 'status-attention', Icon: WarningCircle },
  failed: { className: 'status-negative', Icon: XCircle },
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

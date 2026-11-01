import { CheckCircle, FolderSimple, WarningCircle, XCircle } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ApiUsage, RunRecord } from '../../shared/types.ts';
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
  example = true,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  example?: boolean;
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

export function CallSites({ callSites }: { callSites: ApiUsage['callSites'] }) {
  return (
    <ul className="call-sites">
      {callSites.map((site) => (
        <li key={`${site.file}:${site.line}`}>
          <code>
            {site.file}:{site.line}
          </code>
          <strong>{site.operation}</strong>
          {site.fields && <span>Fields: {site.fields.join(', ')}</span>}
          {site.notes && <span>{site.notes}</span>}
        </li>
      ))}
    </ul>
  );
}

export function WorkspaceMissing() {
  return (
    <div className="empty-state">
      <FolderSimple size={32} />
      <h1>Nothing at this address.</h1>
      <p>This resource is not part of the example dashboard.</p>
      <Link className="button button-primary" to="/app">
        Back to overview
      </Link>
    </div>
  );
}

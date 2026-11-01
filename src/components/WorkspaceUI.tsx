import { CheckCircle, WarningCircle, FolderSimple } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ApiUsage } from '../../shared/types.ts';
import { outcomeLabels } from '../fixtures';
import type { Outcome } from '../fixtures';

export function Status({ outcome }: { outcome: Outcome }) {
  const positive = outcome !== 'needs-review';
  return (
    <span className={`resource-status ${positive ? 'status-positive' : 'status-attention'}`}>
      {positive ? <CheckCircle /> : <WarningCircle />}
      {outcomeLabels[outcome]}
    </span>
  );
}

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="app-page-heading">
      <div>
        <span className="example-chip">Example data</span>
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

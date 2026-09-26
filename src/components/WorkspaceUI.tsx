import { CheckCircle, WarningCircle, FolderSimple } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Status({ value }: { value: string }) {
  const positive = ['Unaffected', 'Example complete'].includes(value);
  const negative = value === 'Example failed';
  return (
    <span
      className={`resource-status ${positive ? 'status-positive' : negative ? 'status-negative' : 'status-attention'}`}
    >
      {positive ? <CheckCircle /> : <WarningCircle />}
      {value}
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
      <p>This resource is not part of the sample workspace.</p>
      <Link className="button button-primary" to="/app">
        Back to overview
      </Link>
    </div>
  );
}

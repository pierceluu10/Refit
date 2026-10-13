import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const MAX_API_VERSION_LENGTH = 256;

export type ApiVersionStatus = 'matches-before' | 'matches-after' | 'matches-neither' | 'unknown';

export interface ApiVersionEvidence {
  application: string | null;
  before: string | null;
  after: string | null;
  applicability: ApiVersionStatus;
  reason: string;
}

function specificationVersion(document: Record<string, unknown>) {
  const info = document.info;
  if (!isObject(info) || typeof info.version !== 'string' || !info.version.trim()) return null;
  return info.version.trim();
}

export function compareApiVersion(
  applicationVersion: string | undefined,
  beforeDocument: Record<string, unknown>,
  afterDocument: Record<string, unknown>,
): ApiVersionEvidence {
  const before = specificationVersion(beforeDocument);
  const after = specificationVersion(afterDocument);
  const application = applicationVersion ?? null;
  let applicability: ApiVersionStatus;
  let reason: string;
  if (!application || !before) {
    applicability = 'unknown';
    reason = !application
      ? 'Application API version is not configured; automated migration requires an exact match to the before contract version.'
      : 'The before specification has no OpenAPI info.version; application API-version applicability cannot be verified.';
  } else if (application === before) {
    applicability = 'matches-before';
    reason = `Application API version ${application} matches the before contract.`;
  } else if (after && application === after) {
    applicability = 'matches-after';
    reason = `Application API version ${application} already matches the after contract, not the before contract used for this migration.`;
  } else {
    applicability = 'matches-neither';
    reason = `Application API version ${application} matches neither the before contract (${before}) nor the after contract${after ? ` (${after})` : ' version, which is unknown'}.`;
  }
  return { application, before, after, applicability, reason };
}

export function validateApiVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > MAX_API_VERSION_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new PipelineInputError(
      'API version must be a trimmed string of at most 256 printable characters.',
    );
  return value;
}

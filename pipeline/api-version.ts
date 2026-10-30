import { isObject } from './specifications.ts';
import { PipelineInputError, type Location } from './types.ts';

const MAX_API_VERSION_LENGTH = 256;

export type ApiVersionStatus =
  'matches-before' | 'matches-after' | 'matches-neither' | 'conflicts-with-code' | 'unknown';
export type ApiVersionPolicy = 'operator-pin' | 'source-verified';

export interface ApiVersionDeclaration extends Location {
  kind: 'constructor' | 'request';
  value: string | null;
  status: 'literal' | 'inherited' | 'unknown';
  reason: string;
  // A safely traced constructor without the version option: stripe-node 12+ sends its own pin.
  absent?: true;
  // The literal also sets a webhook endpoint's api_version (see declared-api-versions.ts).
  endpoint?: true;
  // An untraced client's literal pin the patch moves to the target: the version it sent.
  moved?: string;
  // A literal pin on a client Refit cannot trace, in a repository where every version option is a
  // literal: wherever the client goes it sends this pin, which the version move updates.
  untracedPin?: true;
  // The version is read from this deployment environment variable; `value` is its repository default.
  environment?: string;
}

export interface ApiVersionSource {
  status: 'verified' | 'conflict' | 'unknown' | 'not-configured';
  declarations: ApiVersionDeclaration[];
  reason: string;
}

export interface ApiVersionEvidence {
  application: string | null;
  before: string | null;
  after: string | null;
  applicability: ApiVersionStatus;
  reason: string;
  policy: ApiVersionPolicy;
  source: ApiVersionSource;
}

export function validateApiVersionPolicy(value: unknown): ApiVersionPolicy {
  if (value === undefined) return 'operator-pin';
  if (value !== 'operator-pin' && value !== 'source-verified')
    throw new PipelineInputError('API-version policy must be operator-pin or source-verified.');
  return value;
}

function compareDeclaredVersions(
  application: string | null,
  configured: boolean,
  declarations: ApiVersionDeclaration[],
): ApiVersionSource {
  if (!configured)
    return {
      status: 'not-configured',
      declarations,
      reason:
        'The adapter does not describe SDK API-version options; source verification is unavailable.',
    };
  const conflict = declarations.find(
    (declaration) => declaration.value !== null && application && declaration.value !== application,
  );
  if (conflict)
    return {
      status: 'conflict',
      declarations,
      reason: `Declared SDK API version ${conflict.value} at ${conflict.file}:${conflict.line} conflicts with the application pin ${application}.`,
    };
  if (
    !application ||
    !declarations.some((declaration) => declaration.kind === 'constructor') ||
    declarations.some((declaration) => declaration.status === 'unknown')
  )
    return {
      status: 'unknown',
      declarations,
      reason:
        'SDK API-version declarations are missing, dynamic or unsafe to resolve statically; the operator pin is not verified in source.',
    };
  return {
    status: 'verified',
    declarations,
    reason:
      'All supported SDK constructor declarations and request overrides match the operator pin under the recorded adapter mapping.',
  };
}

// Whether every SDK declaration Refit can read sends `version`, as after a merged migration to it.
export function declaresVersion(source: ApiVersionSource, version: string) {
  return (
    source.status !== 'not-configured' &&
    compareDeclaredVersions(version, true, source.declarations).status === 'verified'
  );
}

// With `reviewConflicts` (owner decision 1) code that pins several versions is not refused: the
// patch moves every pin to the target and the draft lists each one, so only a source-verified
// refusal blocks.
export function apiVersionSourceBlocked(evidence: ApiVersionEvidence, reviewConflicts = false) {
  return (
    (!reviewConflicts && evidence.source?.status === 'conflict') ||
    (evidence.policy === 'source-verified' && evidence.source?.status !== 'verified')
  );
}

export function specificationVersion(document: Record<string, unknown>) {
  const info = document.info;
  if (!isObject(info) || typeof info.version !== 'string' || !info.version.trim()) return null;
  return info.version.trim();
}

export function compareApiVersion(
  applicationVersion: string | undefined,
  beforeDocument: Record<string, unknown>,
  afterDocument: Record<string, unknown>,
  sourceInput: { configured: boolean; declarations: ApiVersionDeclaration[] } = {
    configured: false,
    declarations: [],
  },
  policyInput?: ApiVersionPolicy,
): ApiVersionEvidence {
  const before = specificationVersion(beforeDocument);
  const after = specificationVersion(afterDocument);
  const application = applicationVersion ?? null;
  const policy = validateApiVersionPolicy(policyInput);
  const source = compareDeclaredVersions(
    application,
    sourceInput.configured,
    sourceInput.declarations,
  );
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
  if (source.status === 'conflict') {
    applicability = 'conflicts-with-code';
    reason = source.reason;
  } else if (policy === 'source-verified' && source.status !== 'verified') {
    applicability = 'unknown';
    reason = `Source-verified policy blocks automated migration. ${source.reason}`;
  }
  return { application, before, after, applicability, reason, policy, source };
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

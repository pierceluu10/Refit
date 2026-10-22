export interface Location {
  file: string;
  line: number;
  column: number;
}

export interface Removal {
  id: string;
  schema: string;
  property: string;
  pointer: string;
  type?: 'string';
}

export interface Finding extends Location {
  changeId: string;
  expression: string;
  confidence: 'confirmed' | 'review';
  reason: string;
  declaredType?: { schema?: string };
  // Confirmed only because TypeScript's checker resolves the receiver to a Stripe type;
  // `asserted` when a type assertion states that type. Stops automatic migration for review.
  typeEvidence?: { receiverTypes: string[]; asserted?: true };
  classClient?: { origin: Location; stability: 'review' };
  helperClient?: { origin: Location; parameter: Location; stability: 'review' };
  // How a migrated subscription-period read handles subscriptions whose items have different
  // periods: an item the code already selects, the configured price policy, or not at all.
  // A same-named read whose receiver Refit could not trace to a provider object.
  untraced?: true;
  // Why this finding cannot be migrated automatically; any such finding stops the run for review.
  contractReview?: string;
  // A request parameter the target contract removed, still sent in a traced SDK call body.
  requestParameter?: { operationId: string; parameter: string };
  subscriptionPeriod?: {
    rareCase: 'item-in-code' | 'price-policy' | 'flagged';
    selection?: string;
  };
  webhook?: {
    eventTypes: string[];
    schema?: string;
    origin: Location;
    apiVersion: 'unverified';
    migration?:
      | {
          rule: 'stripe-subscription-periods-price-id';
          priceId: string;
          beforeApiVersion: string;
          afterApiVersion: string;
        }
      | { rule: 'stripe-subscription-periods-helper' }
      | { rule: 'stripe-invoice-subscription-helper' }
      | { rule: 'stripe-invoice-price-id-helper' }
      | { rule: 'stripe-checkout-shipping-details-helper' }
      | { rule: 'ai-version-tolerant' };
  };
}

export interface SourceEdit {
  file: string;
  start: number;
  end: number;
  replacement: string;
  changeId: string;
  rule?:
    | 'stripe-subscription-periods-price-id'
    | 'stripe-subscription-periods-helper'
    | 'stripe-invoice-subscription-helper'
    | 'stripe-invoice-price-id-helper'
    | 'stripe-checkout-shipping-details-helper'
    | 'stripe-card-allowed-payment-method-types'
    | 'stripe-listed-allowed-payment-method-types'
    | 'stripe-api-version'
    | 'model-retirement';
}

export interface Repository {
  root: string;
  files: { path: string; content: string; encoding?: 'utf-16' }[];
  configurations?: Repository['files'];
  excludedPaths?: string[];
  // Every package.json read, so a caller can tell which packages any manifest names.
  manifests?: { path: string; content: string }[];
  dependencies: (DependencyDeclaration & { lock: LockedDependency })[];
  lockfiles: { file: string; hash: string; version: number | null }[];
  warnings: string[];
}

export interface DependencyDeclaration {
  file: string;
  section: string;
  version: string;
}

export interface LockedDependency {
  status: 'locked' | 'unknown';
  file: string | null;
  packagePath: string | null;
  version: string | null;
  reason: string;
}

export class PipelineInputError extends Error {
  override name = 'PipelineInputError';
}

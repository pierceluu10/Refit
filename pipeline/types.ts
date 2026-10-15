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
  classClient?: { origin: Location; stability: 'review' };
  helperClient?: { origin: Location; parameter: Location; stability: 'review' };
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
      | { rule: 'stripe-subscription-periods-either-version' };
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
    | 'stripe-subscription-periods-items'
    | 'stripe-subscription-periods-either-version'
    | 'stripe-api-version';
}

export interface Repository {
  root: string;
  files: { path: string; content: string }[];
  configurations?: Repository['files'];
  excludedPaths?: string[];
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

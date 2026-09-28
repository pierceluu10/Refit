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
}

export interface Finding extends Location {
  changeId: string;
  expression: string;
  confidence: 'confirmed' | 'review';
  reason: string;
}

export interface SourceEdit {
  file: string;
  start: number;
  end: number;
  replacement: string;
  changeId: string;
}

export interface Repository {
  root: string;
  files: { path: string; content: string }[];
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

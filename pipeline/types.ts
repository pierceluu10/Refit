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

export interface Repository {
  root: string;
  files: { path: string; content: string }[];
  dependencies: { file: string; section: string; version: string }[];
  warnings: string[];
}

export class PipelineInputError extends Error {
  override name = 'PipelineInputError';
}

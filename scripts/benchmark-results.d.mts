// Types for the plain-JavaScript results validator, so pipeline code and tests can import it.

export interface Problem {
  // JSON pointer into the checked value; `/` for the whole value.
  pointer: string;
  message: string;
}

export interface Checked {
  errors: Problem[];
  // Required fields missing because the data predates them (their schema carries `x-added`).
  predates: Problem[];
}

export type Schemas = Map<string, Record<string, unknown>>;

export const SCHEMA_DIRECTORY: string;
export function loadSchemas(directory?: string): Schemas;
export function validate(schemas: Schemas, format: string, data: unknown): Checked;
export function pointerPattern(pointer: string): string;
export function assertResults(
  format: string,
  data: unknown,
  options?: { allowPredating?: boolean; schemas?: Schemas },
): { predates: string[] };
export function validateRunDirectory(
  directory: string,
  schemas?: Schemas,
): Checked & { format: string | undefined };
export function validateCommitted(
  benchmarks?: string,
  schemas?: Schemas,
): Array<Checked & { file: string; format?: string }>;

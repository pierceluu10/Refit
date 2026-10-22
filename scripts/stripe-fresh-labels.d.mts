// Types for the plain-JavaScript fresh-set labelling helpers, so pipeline tests can import them.

export function group(outcome: string): 'affected' | 'not-affected' | null;
export function draw(
  rows: { repo: string; outcome: string }[],
  seed?: number,
  size?: number,
): { affected: string[]; notAffected: string[]; stopped: string[]; outcome: Map<string, string> };
export function lockedStripe(
  files: Partial<Record<'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | 'bun.lock', string>>,
  declared: string | undefined,
): { version: string; source: string } | null;

interface Decision {
  repo: string;
  file: string;
  line: number;
  column: number;
  property: string;
  label: string;
  field?: string;
  note?: string;
}
export function labelRepository(options: {
  entry: { repo: string; before: string; version: string; source: string };
  oracle: {
    reads: {
      file: string;
      line: number;
      column: number;
      property: string;
      label: string;
      schemas: string[];
      request?: string;
    }[];
  };
  decisions: {
    reads: Decision[];
    requests: Decision[];
    disputed?: (Omit<Decision, 'label'> & { disputed: string })[];
  };
  source: (file: string) => string;
}): {
  repo: string;
  verdict: 'broken' | 'unaffected';
  breaking: number;
  reads: (Omit<Decision, 'repo'> & { source: string; disputed?: string })[];
  requests: (Omit<Decision, 'repo'> & { source: string })[];
};

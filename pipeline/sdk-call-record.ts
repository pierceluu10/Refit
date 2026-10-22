// The language-neutral record of one traced SDK call (docs/ARCHITECTURE.md, "Other languages").
// Tracers for Python and later languages produce it; rules and reports read it instead of a syntax
// tree.

export interface SourceSite {
  file: string;
  line: number;
  column: number;
}

// What an argument can resolve to: every literal it reaches, with where it is written and how it
// was reached, and why the rest of it could not be traced.
export interface TracedValue {
  literals: (SourceSite & { value: string; via: string })[];
  // Null when every source of the value is one of the literals above.
  stop: string | null;
}

export interface SdkCallRecord extends SourceSite {
  language: 'python' | 'go';
  provider: string;
  // The SDK package in its own ecosystem, such as `openai` on PyPI.
  package: string;
  // `chat.completions` and `create` for `client.chat.completions.create(...)`.
  resource: string;
  method: string;
  expression: string;
  // How the client was obtained, where, and the custom endpoint or platform it is set up for.
  client: {
    kind: 'module' | 'constructor' | 'class-field' | 'parameter';
    file: string;
    line: number;
    custom: string | null;
  };
  // The keyword or field names the request sets, and whether it also passes options it cannot name.
  options: string[];
  spread: boolean;
  arguments: Record<string, TracedValue>;
}

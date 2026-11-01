// A small, dependency-free GraphQL lexer, parser and schema checker.
// It is a helper for provider tools: it reports what it finds and never decides anything.
// Supported: executable documents (operations, fragments, variables, aliases, inline fragments,
// directives) and SDL type definitions. Validation covers fields, arguments, variables and
// fragment type conditions against a "reduced" schema (see ReducedSchema).

import { closest } from './text.ts';

export type GqlLoc = { line: number; column: number };

export class GraphQLSyntaxError extends Error {
  line: number;
  column: number;
  constructor(message: string, loc: GqlLoc) {
    super(`Syntax error at line ${loc.line}, column ${loc.column}: ${message}`);
    this.line = loc.line;
    this.column = loc.column;
  }
}

// ---------------------------------------------------------------------------
// Lexer

type TokenKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
export type GqlToken = { kind: TokenKind; value: string; line: number; column: number };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

export function lex(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const loc = (at = i): GqlLoc => ({ line, column: at - lineStart + 1 });
  const fail = (message: string, at = i): never => {
    throw new GraphQLSyntaxError(message, loc(at));
  };
  const newline = (at: number) => {
    line++;
    lineStart = at + 1;
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      newline(i);
      i++;
      continue;
    }
    if (ch === '\r') {
      if (source[i + 1] === '\n') i++;
      newline(i);
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    const start = loc();
    if (ch === '.') {
      if (source.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...', ...start });
        i += 3;
        continue;
      }
      fail('Unexpected "." (did you mean "..."?)');
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, ...start });
      i++;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i, i + 256))!;
      tokens.push({ kind: 'name', value: m[0], ...start });
      i += m[0].length;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i, i + 64));
      if (!m) fail(`Invalid number starting with "${ch}"`);
      const text = m![0];
      if (/[_A-Za-z.]/.test(source[i + text.length] ?? '')) {
        fail(`Invalid number "${text}${source[i + text.length]}"`);
      }
      tokens.push({ kind: m![2] || m![3] ? 'float' : 'int', value: text, ...start });
      i += text.length;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        let value = '';
        for (;;) {
          if (j >= source.length) fail('Unterminated block string', i);
          if (source.startsWith('\\"""', j)) {
            value += '"""';
            j += 4;
            continue;
          }
          if (source.startsWith('"""', j)) break;
          const c = source[j];
          if (c === '\n' || (c === '\r' && source[j + 1] !== '\n')) newline(j);
          value += c;
          j++;
        }
        tokens.push({ kind: 'string', value: dedentBlockString(value), ...start });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        const c = source[j];
        if (c === undefined || c === '\n' || c === '\r') fail('Unterminated string', i);
        if (c === '"') break;
        if (c === '\\') {
          const e = source[j + 1];
          const map: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (e in map) {
            value += map[e];
            j += 2;
            continue;
          }
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(j + 2, j + 6))) {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          fail(`Invalid escape sequence "\\${e ?? ''}"`, j);
        }
        value += c;
        j++;
      }
      tokens.push({ kind: 'string', value, ...start });
      i = j + 1;
      continue;
    }
    fail(`Unexpected character "${ch}"`);
  }
  tokens.push({ kind: 'eof', value: '<end of document>', ...loc() });
  return tokens;
}

function dedentBlockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let indent = Infinity;
  for (const l of lines.slice(1)) {
    const lead = l.length - l.trimStart().length;
    if (lead < l.length) indent = Math.min(indent, lead);
  }
  const out = lines.map((l, idx) => (idx === 0 || indent === Infinity ? l : l.slice(indent)));
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// AST

export type GqlValue =
  | { kind: 'Variable'; name: string; loc: GqlLoc }
  | { kind: 'Int' | 'Float' | 'String' | 'Boolean' | 'Null' | 'Enum'; value: string; loc: GqlLoc }
  | { kind: 'List'; values: GqlValue[]; loc: GqlLoc }
  | { kind: 'Object'; fields: { name: string; value: GqlValue; loc: GqlLoc }[]; loc: GqlLoc };

export type GqlArgument = { name: string; value: GqlValue; loc: GqlLoc };
export type GqlDirective = { name: string; args: GqlArgument[]; loc: GqlLoc };

export type GqlField = {
  kind: 'Field';
  alias?: string;
  name: string;
  args: GqlArgument[];
  directives: GqlDirective[];
  selections?: GqlSelection[];
  loc: GqlLoc;
};
export type GqlSelection =
  | GqlField
  | { kind: 'FragmentSpread'; name: string; directives: GqlDirective[]; loc: GqlLoc }
  | {
      kind: 'InlineFragment';
      typeCondition?: string;
      typeLoc?: GqlLoc;
      directives: GqlDirective[];
      selections: GqlSelection[];
      loc: GqlLoc;
    };

export type GqlVariableDefinition = {
  name: string;
  type: string;
  defaultValue?: GqlValue;
  loc: GqlLoc;
};

export type GqlOperation = {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: GqlVariableDefinition[];
  directives: GqlDirective[];
  selections: GqlSelection[];
  loc: GqlLoc;
};

export type GqlFragment = {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  typeLoc: GqlLoc;
  directives: GqlDirective[];
  selections: GqlSelection[];
  loc: GqlLoc;
};

export type GqlDocument = { definitions: (GqlOperation | GqlFragment)[] };

// ---------------------------------------------------------------------------
// Parser (shared by executable documents and SDL)

class Parser {
  private pos = 0;
  private tokens: GqlToken[];
  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): GqlToken {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  next(): GqlToken {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }
  at(value: string, kind?: TokenKind): boolean {
    const t = this.peek();
    return t.value === value && (kind ? t.kind === kind : t.kind === 'punct' || t.kind === 'name');
  }
  skip(value: string): boolean {
    if (this.at(value)) {
      this.next();
      return true;
    }
    return false;
  }
  fail(message: string, token = this.peek()): never {
    throw new GraphQLSyntaxError(message, token);
  }
  expect(value: string): GqlToken {
    const t = this.peek();
    if (t.value !== value || t.kind === 'string') {
      this.fail(`Expected "${value}", found ${describe(t)}`);
    }
    return this.next();
  }
  name(): GqlToken {
    const t = this.peek();
    if (t.kind !== 'name') this.fail(`Expected a name, found ${describe(t)}`);
    return this.next();
  }
  loc(t = this.peek()): GqlLoc {
    return { line: t.line, column: t.column };
  }

  // Executable document --------------------------------------------------

  document(): GqlDocument {
    const definitions: (GqlOperation | GqlFragment)[] = [];
    if (this.peek().kind === 'eof') this.fail('The document is empty');
    while (this.peek().kind !== 'eof') definitions.push(this.definition());
    return { definitions };
  }

  definition(): GqlOperation | GqlFragment {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return {
        kind: 'Operation',
        operation: 'query',
        variables: [],
        directives: [],
        selections: this.selectionSet(),
        loc: this.loc(t),
      };
    }
    if (t.kind === 'name' && ['query', 'mutation', 'subscription'].includes(t.value)) {
      this.next();
      const name = this.peek().kind === 'name' ? this.next().value : undefined;
      const variables = this.at('(') ? this.variableDefinitions() : [];
      const directives = this.directives(false);
      return {
        kind: 'Operation',
        operation: t.value as GqlOperation['operation'],
        name,
        variables,
        directives,
        selections: this.selectionSet(),
        loc: this.loc(t),
      };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const nameTok = this.name();
      if (nameTok.value === 'on') this.fail('A fragment cannot be named "on"', nameTok);
      if (!this.at('on'))
        this.fail(`Expected "on" after fragment name, found ${describe(this.peek())}`);
      this.next();
      const typeTok = this.name();
      return {
        kind: 'Fragment',
        name: nameTok.value,
        typeCondition: typeTok.value,
        typeLoc: this.loc(typeTok),
        directives: this.directives(false),
        selections: this.selectionSet(),
        loc: this.loc(t),
      };
    }
    return this.fail(
      `Expected "query", "mutation", "subscription", "fragment" or "{", found ${describe(t)}`,
    );
  }

  variableDefinitions(): GqlVariableDefinition[] {
    this.expect('(');
    const defs: GqlVariableDefinition[] = [];
    while (!this.at(')')) {
      const start = this.expect('$');
      const name = this.name().value;
      this.expect(':');
      const type = this.typeRef();
      const defaultValue = this.skip('=') ? this.value(true) : undefined;
      this.directives(true);
      defs.push({ name, type, defaultValue, loc: this.loc(start) });
      if (this.peek().kind === 'eof') this.fail('Unclosed variable definitions');
    }
    this.expect(')');
    if (defs.length === 0) this.fail('Empty variable definitions "()"');
    return defs;
  }

  typeRef(): string {
    let type: string;
    if (this.skip('[')) {
      type = `[${this.typeRef()}]`;
      this.expect(']');
    } else {
      type = this.name().value;
    }
    if (this.at('!') && this.peek().kind === 'punct') {
      this.next();
      type += '!';
    }
    return type;
  }

  selectionSet(): GqlSelection[] {
    const open = this.expect('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') this.fail(`Unclosed "{" opened at line ${open.line}`);
      selections.push(this.selection());
    }
    this.next();
    if (selections.length === 0) this.fail('Empty selection set "{}"', open);
    return selections;
  }

  selection(): GqlSelection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const after = this.peek();
      if (after.kind === 'name' && after.value !== 'on') {
        this.next();
        return {
          kind: 'FragmentSpread',
          name: after.value,
          directives: this.directives(false),
          loc: this.loc(t),
        };
      }
      let typeCondition: string | undefined;
      let typeLoc: GqlLoc | undefined;
      if (after.kind === 'name' && after.value === 'on') {
        this.next();
        const typeTok = this.name();
        typeCondition = typeTok.value;
        typeLoc = this.loc(typeTok);
      }
      return {
        kind: 'InlineFragment',
        typeCondition,
        typeLoc,
        directives: this.directives(false),
        selections: this.selectionSet(),
        loc: this.loc(t),
      };
    }
    const first = this.name();
    let alias: string | undefined;
    let nameTok = first;
    if (this.at(':') && this.peek().kind === 'punct') {
      this.next();
      alias = first.value;
      nameTok = this.name();
    }
    const args = this.at('(') ? this.arguments(false) : [];
    const directives = this.directives(false);
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.selectionSet() : undefined;
    return {
      kind: 'Field',
      alias,
      name: nameTok.value,
      args,
      directives,
      selections,
      loc: this.loc(nameTok),
    };
  }

  arguments(constant: boolean): GqlArgument[] {
    this.expect('(');
    const args: GqlArgument[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') this.fail('Unclosed "(" in arguments');
      const nameTok = this.name();
      this.expect(':');
      args.push({ name: nameTok.value, value: this.value(constant), loc: this.loc(nameTok) });
    }
    this.next();
    if (args.length === 0) this.fail('Empty arguments "()"');
    return args;
  }

  directives(constant: boolean): GqlDirective[] {
    const out: GqlDirective[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      const at = this.next();
      const name = this.name().value;
      out.push({ name, args: this.at('(') ? this.arguments(constant) : [], loc: this.loc(at) });
    }
    return out;
  }

  value(constant: boolean): GqlValue {
    const t = this.peek();
    const loc = this.loc(t);
    if (t.kind === 'punct') {
      if (t.value === '$') {
        if (constant) this.fail('Variables are not allowed here');
        this.next();
        return { kind: 'Variable', name: this.name().value, loc };
      }
      if (t.value === '[') {
        this.next();
        const values: GqlValue[] = [];
        while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
          if (this.peek().kind === 'eof') this.fail('Unclosed "[" in a list value');
          values.push(this.value(constant));
        }
        this.next();
        return { kind: 'List', values, loc };
      }
      if (t.value === '{') {
        this.next();
        const fields: { name: string; value: GqlValue; loc: GqlLoc }[] = [];
        while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
          if (this.peek().kind === 'eof') this.fail('Unclosed "{" in an object value');
          const nameTok = this.name();
          this.expect(':');
          fields.push({ name: nameTok.value, value: this.value(constant), loc: this.loc(nameTok) });
        }
        this.next();
        return { kind: 'Object', fields, loc };
      }
      return this.fail(`Expected a value, found ${describe(t)}`);
    }
    this.next();
    if (t.kind === 'int') return { kind: 'Int', value: t.value, loc };
    if (t.kind === 'float') return { kind: 'Float', value: t.value, loc };
    if (t.kind === 'string') return { kind: 'String', value: t.value, loc };
    if (t.kind === 'name') {
      if (t.value === 'true' || t.value === 'false')
        return { kind: 'Boolean', value: t.value, loc };
      if (t.value === 'null') return { kind: 'Null', value: 'null', loc };
      return { kind: 'Enum', value: t.value, loc };
    }
    return this.fail(`Expected a value, found ${describe(t)}`, t);
  }

  // SDL -------------------------------------------------------------------

  sdl(): ReducedSchema {
    const schema: ReducedSchema = { types: {}, complete: true };
    const ensure = (name: string, kind: ReducedType['kind']): ReducedType => {
      const existing = schema.types[name];
      if (existing) return existing;
      const created: ReducedType = { kind };
      schema.types[name] = created;
      return created;
    };
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'string') this.next(); // description
      let keyword = this.name();
      if (keyword.value === 'extend') keyword = this.name();
      switch (keyword.value) {
        case 'schema': {
          this.directives(true);
          this.expect('{');
          while (!this.skip('}')) {
            const op = this.name().value;
            this.expect(':');
            const type = this.name().value;
            if (op === 'query') schema.queryType = type;
            if (op === 'mutation') schema.mutationType = type;
            if (op === 'subscription') schema.subscriptionType = type;
          }
          break;
        }
        case 'scalar': {
          ensure(this.name().value, 'SCALAR');
          this.directives(true);
          break;
        }
        case 'type':
        case 'interface':
        case 'input': {
          const name = this.name().value;
          const kind =
            keyword.value === 'type'
              ? 'OBJECT'
              : keyword.value === 'input'
                ? 'INPUT_OBJECT'
                : 'INTERFACE';
          const type = ensure(name, kind);
          if (this.at('implements')) {
            this.next();
            this.skip('&');
            const interfaces = [this.name().value];
            while (this.skip('&')) interfaces.push(this.name().value);
            type.interfaces = [...(type.interfaces ?? []), ...interfaces];
          }
          this.directives(true);
          if (this.at('{') && this.peek().kind === 'punct') {
            this.next();
            type.fields = type.fields ?? {};
            while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
              if (this.peek().kind === 'eof') this.fail(`Unclosed "{" in ${name}`);
              if (this.peek().kind === 'string') this.next();
              const fieldName = this.name().value;
              const field: ReducedField = { type: '' };
              if (this.at('(') && this.peek().kind === 'punct') {
                this.next();
                while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
                  if (this.peek().kind === 'string') this.next();
                  const argName = this.name().value;
                  this.expect(':');
                  let argType = this.typeRef();
                  if (this.skip('=')) {
                    this.value(true);
                    argType = argType.replace(/!$/, '');
                  }
                  const dirs = this.directives(true);
                  field.args = { ...field.args, [argName]: argType };
                  const dep = deprecation(dirs);
                  if (dep) field.deprecatedArgs = { ...field.deprecatedArgs, [argName]: dep };
                }
                this.next();
              }
              this.expect(':');
              field.type = this.typeRef();
              if (this.skip('=')) {
                this.value(true);
                field.type = field.type.replace(/!$/, '');
              }
              const dep = deprecation(this.directives(true));
              if (dep) {
                field.isDeprecated = true;
                field.deprecationReason = dep;
              }
              type.fields[fieldName] = field;
            }
            this.next();
          }
          break;
        }
        case 'union': {
          const type = ensure(this.name().value, 'UNION');
          this.directives(true);
          if (this.skip('=')) {
            this.skip('|');
            const members = [this.name().value];
            while (this.skip('|')) members.push(this.name().value);
            type.possibleTypes = [...(type.possibleTypes ?? []), ...members];
          }
          break;
        }
        case 'enum': {
          const type = ensure(this.name().value, 'ENUM');
          this.directives(true);
          if (this.skip('{')) {
            const values: string[] = [];
            while (!this.skip('}')) {
              if (this.peek().kind === 'eof') this.fail('Unclosed enum');
              if (this.peek().kind === 'string') this.next();
              values.push(this.name().value);
              this.directives(true);
            }
            type.enumValues = [...(type.enumValues ?? []), ...values];
          }
          break;
        }
        case 'directive': {
          this.expect('@');
          this.name();
          if (this.at('(') && this.peek().kind === 'punct') {
            this.next();
            while (!this.skip(')')) {
              if (this.peek().kind === 'eof') this.fail('Unclosed directive arguments');
              if (this.peek().kind === 'string') this.next();
              this.name();
              this.expect(':');
              this.typeRef();
              if (this.skip('=')) this.value(true);
              this.directives(true);
            }
          }
          if (this.at('repeatable')) this.next();
          if (!this.at('on')) this.fail('Expected "on" in directive definition');
          this.next();
          this.skip('|');
          this.name();
          while (this.skip('|')) this.name();
          break;
        }
        default:
          this.fail(`Unexpected "${keyword.value}" in SDL`, keyword);
      }
    }
    schema.queryType = schema.queryType ?? (schema.types.Query ? 'Query' : undefined);
    schema.mutationType = schema.mutationType ?? (schema.types.Mutation ? 'Mutation' : undefined);
    schema.subscriptionType =
      schema.subscriptionType ?? (schema.types.Subscription ? 'Subscription' : undefined);
    // Interfaces: compute possible types from implementations.
    for (const [name, type] of Object.entries(schema.types)) {
      for (const iface of type.interfaces ?? []) {
        const target = schema.types[iface];
        if (target) target.possibleTypes = [...(target.possibleTypes ?? []), name];
      }
    }
    return schema;
  }
}

function deprecation(directives: GqlDirective[]): string | undefined {
  const d = directives.find((x) => x.name === 'deprecated');
  if (!d) return undefined;
  const reason = d.args.find((a) => a.name === 'reason');
  return reason && reason.value.kind === 'String' ? reason.value.value : 'No longer supported';
}

function describe(t: GqlToken): string {
  if (t.kind === 'eof') return 'the end of the document';
  if (t.kind === 'string') return 'a string';
  return `"${t.value}"`;
}

/** Parse an executable GraphQL document. Throws GraphQLSyntaxError with line/column. */
export function parseDocument(source: string): GqlDocument {
  return new Parser(lex(source)).document();
}

/** Parse SDL type definitions into a ReducedSchema. Throws GraphQLSyntaxError with line/column. */
export function parseSdl(source: string): ReducedSchema {
  return new Parser(lex(source)).sdl();
}

// ---------------------------------------------------------------------------
// Reduced schema

export type ReducedField = {
  /** Type reference as written in GraphQL, e.g. "[Product!]!". */
  type: string;
  /** Argument types. A trailing "!" means required (args with a default have the "!" dropped). */
  args?: Record<string, string>;
  deprecatedArgs?: Record<string, string>;
  isDeprecated?: boolean;
  deprecationReason?: string;
  /** Only the return type is known (an excerpt): arguments are not checked. */
  stub?: boolean;
};

export type ReducedType = {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  /** Output fields, or input fields for INPUT_OBJECT. */
  fields?: Record<string, ReducedField>;
  possibleTypes?: string[];
  interfaces?: string[];
  enumValues?: string[];
  /** True when the fields were filtered (an excerpt): unknown fields are "not checked", not errors. */
  partial?: boolean;
};

export type ReducedSchema = {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  /** True when every type of the API is present. False for excerpts: missing types are "not checked". */
  complete?: boolean;
  types: Record<string, ReducedType>;
};

type IntrospectionTypeRef = {
  kind: string;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
};

export function typeRefToString(ref: IntrospectionTypeRef | null | undefined): string {
  if (!ref) return 'Unknown';
  if (ref.kind === 'NON_NULL') return `${typeRefToString(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeRefToString(ref.ofType)}]`;
  return ref.name ?? 'Unknown';
}

/** The named type inside a type reference: "[Product!]!" -> "Product". */
export function namedType(typeRef: string): string {
  return typeRef.replace(/[[\]!\s]/g, '');
}

type IntrospectionField = {
  name: string;
  type: IntrospectionTypeRef;
  args?: {
    name: string;
    type: IntrospectionTypeRef;
    defaultValue?: string | null;
    isDeprecated?: boolean;
    deprecationReason?: string | null;
  }[];
  isDeprecated?: boolean;
  deprecationReason?: string | null;
  defaultValue?: string | null;
};

/** Reduce a standard introspection result ({data:{__schema}} or {__schema}) to a ReducedSchema. */
export function reduceIntrospection(json: unknown): ReducedSchema {
  const root = json as { data?: { __schema?: unknown }; __schema?: unknown };
  const schema = (root?.data?.__schema ?? root?.__schema) as
    | {
        queryType?: { name: string } | null;
        mutationType?: { name: string } | null;
        subscriptionType?: { name: string } | null;
        types: {
          kind: string;
          name: string;
          fields?: IntrospectionField[] | null;
          inputFields?: IntrospectionField[] | null;
          enumValues?: { name: string }[] | null;
          possibleTypes?: { name: string }[] | null;
          interfaces?: { name: string }[] | null;
        }[];
      }
    | undefined;
  if (!schema || !Array.isArray(schema.types)) {
    throw new Error('Not an introspection result (no __schema.types)');
  }
  const out: ReducedSchema = {
    queryType: schema.queryType?.name ?? undefined,
    mutationType: schema.mutationType?.name ?? undefined,
    subscriptionType: schema.subscriptionType?.name ?? undefined,
    complete: true,
    types: {},
  };
  for (const t of schema.types) {
    if (!t?.name || t.name.startsWith('__')) continue;
    const kind = t.kind as ReducedType['kind'];
    const reduced: ReducedType = { kind };
    const source = kind === 'INPUT_OBJECT' ? t.inputFields : t.fields;
    if (source) {
      reduced.fields = {};
      for (const f of source) reduced.fields[f.name] = reduceField(f, kind === 'INPUT_OBJECT');
    }
    if (t.possibleTypes?.length) reduced.possibleTypes = t.possibleTypes.map((p) => p.name);
    if (t.interfaces?.length) reduced.interfaces = t.interfaces.map((p) => p.name);
    if (t.enumValues?.length) reduced.enumValues = t.enumValues.map((v) => v.name);
    out.types[t.name] = reduced;
  }
  return out;
}

function reduceField(f: IntrospectionField, isInput: boolean): ReducedField {
  let type = typeRefToString(f.type);
  if (isInput && f.defaultValue != null) type = type.replace(/!$/, '');
  const field: ReducedField = { type };
  if (f.args?.length) {
    field.args = {};
    for (const a of f.args) {
      let argType = typeRefToString(a.type);
      if (a.defaultValue != null) argType = argType.replace(/!$/, '');
      field.args[a.name] = argType;
      if (a.isDeprecated) {
        field.deprecatedArgs = {
          ...field.deprecatedArgs,
          [a.name]: a.deprecationReason ?? 'Deprecated',
        };
      }
    }
  }
  if (f.isDeprecated) {
    field.isDeprecated = true;
    if (f.deprecationReason) field.deprecationReason = f.deprecationReason;
  }
  return field;
}

/**
 * Expand the compact excerpt encoding used for committed snapshots ("format": "compact-v1"):
 * a field is either a signature string "(arg: Type, other: Type!): ReturnType" (or just "ReturnType"),
 * or {sig, deprecated?, deprecatedArgs?, stub?}; a type may list `stubFields` {name: ReturnType}
 * whose arguments were not captured. Already-expanded fields pass through unchanged.
 */
export function expandCompactSchema(json: Record<string, unknown>): ReducedSchema {
  const types: Record<string, ReducedType> = {};
  const rawTypes = (json.types ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, raw] of Object.entries(rawTypes)) {
    const { fields, stubFields, ...rest } = raw as {
      fields?: Record<string, unknown>;
      stubFields?: Record<string, string>;
    } & Record<string, unknown>;
    const type = { ...rest } as ReducedType;
    if (fields || stubFields) {
      type.fields = {};
      for (const [fieldName, value] of Object.entries(fields ?? {})) {
        type.fields[fieldName] = expandField(value);
      }
      for (const [fieldName, returnType] of Object.entries(stubFields ?? {})) {
        type.fields[fieldName] = { type: returnType, stub: true };
      }
    }
    types[name] = type;
  }
  return {
    queryType: json.queryType as string | undefined,
    mutationType: json.mutationType as string | undefined,
    subscriptionType: json.subscriptionType as string | undefined,
    complete: json.complete as boolean | undefined,
    types,
  };
}

function parseSignature(sig: string): Pick<ReducedField, 'type' | 'args'> {
  const m = /^\((.*)\):\s*(.+)$/.exec(sig.trim());
  if (!m) return { type: sig.trim() };
  const args: Record<string, string> = {};
  for (const part of m[1].split(',')) {
    const [argName, argType] = part.split(':').map((x) => x.trim());
    if (argName && argType) args[argName] = argType;
  }
  return { type: m[2].trim(), args };
}

function expandField(value: unknown): ReducedField {
  if (typeof value === 'string') return parseSignature(value);
  const v = value as {
    sig?: string;
    type?: string;
    deprecated?: string;
    deprecatedArgs?: Record<string, string>;
    stub?: boolean;
  } & Partial<ReducedField>;
  if (!v.sig) return v as ReducedField;
  const field: ReducedField = parseSignature(v.sig);
  if (v.deprecated) {
    field.isDeprecated = true;
    field.deprecationReason = v.deprecated;
  }
  if (v.deprecatedArgs) field.deprecatedArgs = v.deprecatedArgs;
  if (v.stub) field.stub = true;
  return field;
}

/** Load a schema from text: introspection JSON, a reduced (or compact) schema JSON, or SDL. */
export function schemaFromText(text: string): ReducedSchema {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    if (json.types && typeof json.types === 'object' && !Array.isArray(json.types)) {
      return expandCompactSchema(json);
    }
    return reduceIntrospection(json);
  }
  return parseSdl(text);
}

// ---------------------------------------------------------------------------
// Validation

export type GqlIssue = {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  column?: number;
};

export type ValidateOptions = {
  /** Variables the caller plans to send; used to spot missing required variables. */
  variables?: Record<string, unknown>;
  /** Other schemas (e.g. older versions) used to explain fields that are missing from `schema`. */
  history?: { label: string; schema: ReducedSchema }[];
};

export type ValidateResult = {
  document?: GqlDocument;
  issues: GqlIssue[];
  /** Number of fields checked against the schema. */
  checkedFields: number;
  /** Types that were referenced but are not in the (partial) schema, so their selections were not checked. */
  uncheckedTypes: string[];
};

const BUILTIN_SCALARS = new Set(['Int', 'Float', 'String', 'Boolean', 'ID']);

/** Validate a GraphQL document against a reduced schema. Reports; never throws. */
export function validateDocument(
  source: string,
  schema: ReducedSchema,
  options: ValidateOptions = {},
): ValidateResult {
  let document: GqlDocument;
  try {
    document = parseDocument(source);
  } catch (error) {
    if (error instanceof GraphQLSyntaxError) {
      return {
        issues: [
          { severity: 'error', message: error.message, line: error.line, column: error.column },
        ],
        checkedFields: 0,
        uncheckedTypes: [],
      };
    }
    throw error;
  }
  const v = new Validator(schema, options);
  v.run(document);
  return { document, issues: v.issues, checkedFields: v.checked, uncheckedTypes: [...v.unchecked] };
}

class Validator {
  issues: GqlIssue[] = [];
  checked = 0;
  unchecked = new Set<string>();
  private seen = new Set<string>();
  private fragments = new Map<string, GqlFragment>();
  private usedFragments = new Set<string>();

  private schema: ReducedSchema;
  private options: ValidateOptions;

  constructor(schema: ReducedSchema, options: ValidateOptions) {
    this.schema = schema;
    this.options = options;
  }

  private add(severity: GqlIssue['severity'], message: string, loc?: GqlLoc) {
    const key = `${severity}|${message}|${loc?.line}|${loc?.column}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.push({ severity, message, line: loc?.line, column: loc?.column });
  }

  private type(name: string): ReducedType | undefined {
    return this.schema.types[name];
  }

  private isLeaf(name: string): boolean | undefined {
    if (BUILTIN_SCALARS.has(name)) return true;
    const t = this.type(name);
    if (!t) return undefined;
    return t.kind === 'SCALAR' || t.kind === 'ENUM';
  }

  /** Is the type unknown because the schema is only an excerpt? Records it once. */
  private missingType(name: string, loc: GqlLoc, what: string): void {
    if (this.schema.complete === false) {
      if (!this.unchecked.has(name)) {
        this.unchecked.add(name);
        this.add(
          'info',
          `Type ${name} is not in the offline excerpt, so ${what} was not checked.`,
          loc,
        );
      }
      return;
    }
    const suggestions = closest(name, Object.keys(this.schema.types));
    this.add(
      'error',
      `Unknown type "${name}"${suggestions.length ? `. Did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : '.'}`,
      loc,
    );
  }

  run(document: GqlDocument) {
    for (const def of document.definitions) {
      if (def.kind !== 'Fragment') continue;
      if (this.fragments.has(def.name)) {
        this.add('error', `Fragment "${def.name}" is defined more than once.`, def.loc);
      }
      this.fragments.set(def.name, def);
    }
    const operations = document.definitions.filter(
      (d): d is GqlOperation => d.kind === 'Operation',
    );
    const anonymous = operations.filter((o) => !o.name);
    if (anonymous.length && operations.length > 1) {
      this.add(
        'error',
        'An anonymous operation must be the only operation in the document.',
        anonymous[0].loc,
      );
    }
    const names = new Set<string>();
    for (const op of operations) {
      if (op.name && names.has(op.name))
        this.add('error', `Operation "${op.name}" is defined more than once.`, op.loc);
      if (op.name) names.add(op.name);
      this.operation(op);
    }
    for (const fragment of this.fragments.values()) {
      if (this.type(fragment.typeCondition)) {
        const kind = this.type(fragment.typeCondition)!.kind;
        if (kind === 'SCALAR' || kind === 'ENUM' || kind === 'INPUT_OBJECT') {
          this.add(
            'error',
            `Fragment "${fragment.name}" is on ${fragment.typeCondition}, which is a ${kind.toLowerCase()}, not an object, interface or union.`,
            fragment.typeLoc,
          );
        }
      } else {
        this.missingType(fragment.typeCondition, fragment.typeLoc, `fragment "${fragment.name}"`);
      }
      this.selections(fragment.selections, fragment.typeCondition, new Set());
      if (!this.usedFragments.has(fragment.name)) {
        this.add('warning', `Fragment "${fragment.name}" is never used.`, fragment.loc);
      }
    }
  }

  private operation(op: GqlOperation) {
    const rootName =
      op.operation === 'query'
        ? this.schema.queryType
        : op.operation === 'mutation'
          ? this.schema.mutationType
          : this.schema.subscriptionType;
    if (!rootName) {
      this.add(
        this.schema.complete === false ? 'info' : 'error',
        `The schema has no ${op.operation} root type${this.schema.complete === false ? ' in this excerpt; root fields were not checked' : ''}.`,
        op.loc,
      );
    }
    const defined = new Map<string, GqlVariableDefinition>();
    for (const def of op.variables) {
      if (defined.has(def.name))
        this.add('error', `Variable "$${def.name}" is declared more than once.`, def.loc);
      defined.set(def.name, def);
      const base = namedType(def.type);
      const t = this.type(base);
      if (!BUILTIN_SCALARS.has(base)) {
        if (!t) this.missingType(base, def.loc, `variable "$${def.name}"`);
        else if (t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'UNION') {
          this.add(
            'error',
            `Variable "$${def.name}" has type ${def.type}, but ${base} is an output type; variables need an input type, scalar or enum.`,
            def.loc,
          );
        }
      }
    }
    const used = new Map<string, GqlLoc>();
    this.collectVariables(op.selections, used, new Set());
    for (const d of op.directives) for (const a of d.args) this.valueVariables(a.value, used);
    for (const [name, loc] of used) {
      if (!defined.has(name)) {
        this.add(
          'error',
          `Variable "$${name}" is used but not declared by operation ${op.name ?? '(anonymous)'}.`,
          loc,
        );
      }
    }
    for (const def of op.variables) {
      if (!used.has(def.name))
        this.add('warning', `Variable "$${def.name}" is declared but never used.`, def.loc);
    }
    const provided = this.options.variables;
    if (provided) {
      for (const def of op.variables) {
        if (def.type.endsWith('!') && !def.defaultValue && provided[def.name] === undefined) {
          this.add(
            'warning',
            `Required variable "$${def.name}" (${def.type}) is not in the variables you passed.`,
            def.loc,
          );
        }
      }
      for (const key of Object.keys(provided)) {
        if (!defined.has(key))
          this.add(
            'info',
            `Variable "${key}" was passed but operation ${op.name ?? '(anonymous)'} does not declare it.`,
          );
      }
    }
    if (rootName) this.selections(op.selections, rootName, new Set());
    else this.selections(op.selections, undefined, new Set());
  }

  private collectVariables(
    selections: GqlSelection[],
    used: Map<string, GqlLoc>,
    visiting: Set<string>,
  ) {
    for (const s of selections) {
      for (const d of s.directives) for (const a of d.args) this.valueVariables(a.value, used);
      if (s.kind === 'Field') {
        for (const a of s.args) this.valueVariables(a.value, used);
        if (s.selections) this.collectVariables(s.selections, used, visiting);
      } else if (s.kind === 'InlineFragment') {
        this.collectVariables(s.selections, used, visiting);
      } else {
        this.usedFragments.add(s.name);
        const fragment = this.fragments.get(s.name);
        if (fragment && !visiting.has(s.name)) {
          visiting.add(s.name);
          this.collectVariables(fragment.selections, used, visiting);
          visiting.delete(s.name);
        }
      }
    }
  }

  private valueVariables(value: GqlValue, used: Map<string, GqlLoc>) {
    if (value.kind === 'Variable') {
      if (!used.has(value.name)) used.set(value.name, value.loc);
    } else if (value.kind === 'List') value.values.forEach((x) => this.valueVariables(x, used));
    else if (value.kind === 'Object')
      value.fields.forEach((f) => this.valueVariables(f.value, used));
  }

  private selections(
    selections: GqlSelection[],
    parent: string | undefined,
    visiting: Set<string>,
  ) {
    for (const s of selections) {
      if (s.kind === 'FragmentSpread') {
        this.usedFragments.add(s.name);
        const fragment = this.fragments.get(s.name);
        if (!fragment) {
          const suggestions = closest(s.name, this.fragments.keys());
          this.add(
            'error',
            `Unknown fragment "${s.name}"${suggestions.length ? `. Did you mean "${suggestions[0]}"?` : '.'}`,
            s.loc,
          );
        } else if (visiting.has(s.name)) {
          this.add('error', `Fragment "${s.name}" spreads itself (a cycle).`, s.loc);
        }
        // Fragment bodies are checked once, against their own type condition.
        continue;
      }
      if (s.kind === 'InlineFragment') {
        const target = s.typeCondition ?? parent;
        if (s.typeCondition && !this.type(s.typeCondition)) {
          this.missingType(
            s.typeCondition,
            s.typeLoc ?? s.loc,
            `the inline fragment on ${s.typeCondition}`,
          );
        }
        this.selections(s.selections, target, visiting);
        continue;
      }
      this.field(s, parent, visiting);
    }
  }

  private field(node: GqlField, parent: string | undefined, visiting: Set<string>) {
    const label = node.alias ? `${node.alias}: ${node.name}` : node.name;
    if (node.name === '__typename') {
      if (node.selections)
        this.add('error', '"__typename" is a String and cannot have a selection set.', node.loc);
      return;
    }
    if (node.name === '__schema' || node.name === '__type') return;
    if (!parent) {
      if (node.selections) this.selections(node.selections, undefined, visiting);
      return;
    }
    const parentType = this.type(parent);
    if (!parentType) {
      if (!this.unchecked.has(parent) && this.schema.complete === false) {
        this.missingType(parent, node.loc, `fields selected on it`);
      }
      if (node.selections) this.selections(node.selections, undefined, visiting);
      return;
    }
    if (parentType.kind === 'UNION') {
      this.add(
        'error',
        `Cannot select "${node.name}" directly on union ${parent}; use an inline fragment such as "... on ${parentType.possibleTypes?.[0] ?? 'SomeType'} { ${node.name} }".`,
        node.loc,
      );
      if (node.selections) this.selections(node.selections, undefined, visiting);
      return;
    }
    const field = parentType.fields?.[node.name];
    if (!field) {
      const history = this.history(parent, node.name);
      if (parentType.partial) {
        this.add(
          'info',
          `${parent}.${node.name} is not in the offline excerpt (only part of ${parent} is captured), so it was not checked.${history}`,
          node.loc,
        );
      } else {
        const suggestions = closest(node.name, Object.keys(parentType.fields ?? {}));
        this.add(
          'error',
          `Field "${node.name}" does not exist on type ${parent}.${suggestions.length ? ` Did you mean ${suggestions.map((x) => `"${x}"`).join(', ')}?` : ''}${history}`,
          node.loc,
        );
      }
      if (node.selections) this.selections(node.selections, undefined, visiting);
      return;
    }
    this.checked++;
    if (field.isDeprecated) {
      this.add(
        'warning',
        `${parent}.${node.name} is deprecated: ${field.deprecationReason ?? 'no reason given'}`,
        node.loc,
      );
    }
    if (field.stub) {
      if (node.args.length) {
        this.add(
          'info',
          `Arguments of ${parent}.${node.name} are not in the offline excerpt, so they were not checked.`,
          node.loc,
        );
      }
    } else {
      this.arguments(node, parent, field);
    }
    const returnName = namedType(field.type);
    const leaf = this.isLeaf(returnName);
    if (leaf === true && node.selections) {
      this.add(
        'error',
        `Field "${label}" on ${parent} returns ${field.type}, a scalar or enum; remove its selection set.`,
        node.loc,
      );
      return;
    }
    if (leaf === false && !node.selections) {
      this.add(
        'error',
        `Field "${label}" on ${parent} returns ${field.type}; it needs a selection set (e.g. { id }).`,
        node.loc,
      );
      return;
    }
    if (node.selections) {
      if (leaf === undefined && this.schema.complete === false) {
        this.missingType(returnName, node.loc, `the selection under ${parent}.${node.name}`);
      }
      this.selections(node.selections, returnName, visiting);
    }
  }

  private history(type: string, field: string): string {
    const notes: string[] = [];
    for (const h of this.options.history ?? []) {
      const old = h.schema.types[type]?.fields?.[field];
      if (old) {
        notes.push(
          ` It exists in ${h.label}${old.isDeprecated ? ` (deprecated there: ${old.deprecationReason ?? 'no reason given'})` : ''}, so it was probably removed or renamed since.`,
        );
      }
    }
    return notes.join('');
  }

  private arguments(node: GqlField, parent: string, field: ReducedField) {
    const args = field.args ?? {};
    const given = new Set<string>();
    for (const arg of node.args) {
      if (given.has(arg.name))
        this.add('error', `Argument "${arg.name}" is given more than once.`, arg.loc);
      given.add(arg.name);
      const argType = args[arg.name];
      if (!argType) {
        const suggestions = closest(arg.name, Object.keys(args));
        this.add(
          'error',
          `Unknown argument "${arg.name}" on ${parent}.${node.name}.${suggestions.length ? ` Did you mean ${suggestions.map((x) => `"${x}"`).join(', ')}?` : ''}${Object.keys(args).length ? ` Known: ${Object.keys(args).join(', ')}.` : ' It takes no arguments.'}`,
          arg.loc,
        );
        continue;
      }
      const dep = field.deprecatedArgs?.[arg.name];
      if (dep)
        this.add(
          'warning',
          `Argument "${arg.name}" on ${parent}.${node.name} is deprecated: ${dep}`,
          arg.loc,
        );
      this.inputValue(arg.value, argType, `${parent}.${node.name}(${arg.name})`);
    }
    for (const [name, type] of Object.entries(args)) {
      if (type.endsWith('!') && !given.has(name)) {
        this.add(
          'error',
          `Missing required argument "${name}: ${type}" on ${parent}.${node.name}.`,
          node.loc,
        );
      }
    }
  }

  private inputValue(value: GqlValue, typeRef: string, where: string) {
    if (value.kind === 'Variable') return;
    if (value.kind === 'Null') {
      if (typeRef.endsWith('!'))
        this.add('error', `${where} is ${typeRef} (non-null) but null was given.`, value.loc);
      return;
    }
    const inner = typeRef.replace(/!$/, '');
    if (inner.startsWith('[')) {
      const item = inner.slice(1, -1);
      const values = value.kind === 'List' ? value.values : [value];
      values.forEach((x) => this.inputValue(x, item, where));
      return;
    }
    const t = this.type(inner);
    if (value.kind === 'Object') {
      if (BUILTIN_SCALARS.has(inner)) {
        this.add('error', `${where} expects ${inner}, but an object was given.`, value.loc);
        return;
      }
      if (!t || t.kind !== 'INPUT_OBJECT' || t.partial || !t.fields) return;
      const keys = new Set<string>();
      for (const f of value.fields) {
        keys.add(f.name);
        const def = t.fields[f.name];
        if (!def) {
          const suggestions = closest(f.name, Object.keys(t.fields));
          this.add(
            'error',
            `Input field "${f.name}" does not exist on ${inner} (in ${where}).${suggestions.length ? ` Did you mean ${suggestions.map((x) => `"${x}"`).join(', ')}?` : ''}${this.history(inner, f.name)}`,
            f.loc,
          );
          continue;
        }
        if (def.isDeprecated)
          this.add(
            'warning',
            `Input field ${inner}.${f.name} is deprecated: ${def.deprecationReason ?? 'no reason given'}`,
            f.loc,
          );
        this.inputValue(f.value, def.type, `${inner}.${f.name}`);
      }
      for (const [name, def] of Object.entries(t.fields)) {
        if (def.type.endsWith('!') && !keys.has(name)) {
          this.add(
            'error',
            `Missing required input field "${name}: ${def.type}" on ${inner} (in ${where}).`,
            value.loc,
          );
        }
      }
      return;
    }
    if (
      value.kind === 'Enum' &&
      t?.kind === 'ENUM' &&
      t.enumValues &&
      !t.enumValues.includes(value.value)
    ) {
      const suggestions = closest(value.value, t.enumValues);
      this.add(
        'error',
        `"${value.value}" is not a value of enum ${inner} (in ${where}).${suggestions.length ? ` Did you mean ${suggestions.map((x) => `"${x}"`).join(', ')}?` : ''}`,
        value.loc,
      );
    }
  }
}

/** Format issues as readable lines, errors first. */
export function formatIssues(issues: GqlIssue[]): string[] {
  const order = { error: 0, warning: 1, info: 2 } as const;
  return [...issues]
    .sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0))
    .map((i) => `${i.line ? `line ${i.line}:${i.column} ` : ''}${i.severity}: ${i.message}`);
}

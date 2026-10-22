// A small TOML reader (1.0, plus 1.1's multi-line inline tables) for package manifests and lockfiles (pyproject.toml, Pipfile, uv.lock,
// poetry.lock, Cargo.toml, Cargo.lock, gradle/libs.versions.toml). It covers tables, arrays of
// tables, dotted and quoted keys, the four string forms, arrays, inline tables, numbers, booleans
// and date-times (kept as strings). Anything else throws TomlError, which callers report as a
// named stop instead of crashing. Values are plain JSON-like objects.

export class TomlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'TomlError';
    this.line = line;
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

// Tables have no prototype, so a `__proto__` key or table is an ordinary entry and cannot reach
// Object.prototype.
const newTable = (): TomlTable => Object.create(null) as TomlTable;
// Arrays and inline tables nested deeper than this are refused instead of exhausting the stack.
const MAX_DEPTH = 100;

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToml(text: string): TomlTable {
  try {
    return parseDocument(text);
  } catch (error) {
    if (error instanceof TomlError) throw error;
    // Anything the checks below miss still reaches callers as a named stop, not a crash.
    throw new TomlError(`Unreadable TOML: ${(error as Error).message}`, 0);
  }
}

function parseDocument(text: string): TomlTable {
  const source = text.replace(/\r\n/g, '\n');
  const root = newTable();
  // Tables created implicitly by a dotted header may be defined later; explicit ones only once.
  const defined = new Set<TomlTable>();
  let position = 0;
  let line = 1;
  let current = root;
  let depth = 0;

  const fail = (message: string): never => {
    throw new TomlError(message, line);
  };
  const peek = () => source[position];
  const advance = () => {
    if (source[position] === '\n') line += 1;
    position += 1;
  };
  const skipSpaces = () => {
    while (peek() === ' ' || peek() === '\t') advance();
  };
  const skipComment = () => {
    if (peek() === '#') while (position < source.length && peek() !== '\n') advance();
  };
  // Whitespace, newlines and comments, as allowed inside arrays.
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === '\n') advance();
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (position < source.length && peek() !== '\n') fail('Expected the end of the line');
  };

  function basicString(): string {
    const multiline = source.startsWith('"""', position);
    position += multiline ? 3 : 1;
    if (multiline && peek() === '\n') advance();
    let value = '';
    for (;;) {
      if (position >= source.length) fail('Unterminated string');
      if (multiline ? source.startsWith('"""', position) : peek() === '"') {
        position += multiline ? 3 : 1;
        // Up to two extra quotes may close a multiline string.
        while (multiline && peek() === '"') {
          value += '"';
          position += 1;
        }
        return value;
      }
      const character = peek();
      if (character === '\n' && !multiline) fail('Newline in a single-line string');
      if (character === '\\') {
        advance();
        const escape = peek();
        if (multiline && (escape === '\n' || escape === ' ' || escape === '\t')) {
          // A line-ending backslash trims the newline and following whitespace.
          while (peek() === ' ' || peek() === '\t' || peek() === '\n') advance();
          continue;
        }
        if (escape === 'u' || escape === 'U') {
          const length = escape === 'u' ? 4 : 8;
          const hex = source.slice(position + 1, position + 1 + length);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) fail('Invalid unicode escape');
          const code = parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('Invalid unicode escape');
          value += String.fromCodePoint(code);
          position += length + 1;
          continue;
        }
        if (!(escape in ESCAPES)) fail(`Invalid escape \\${escape}`);
        value += ESCAPES[escape];
        advance();
        continue;
      }
      value += character;
      advance();
    }
  }

  function literalString(): string {
    const multiline = source.startsWith("'''", position);
    position += multiline ? 3 : 1;
    if (multiline && peek() === '\n') advance();
    const close = multiline ? "'''" : "'";
    let end = source.indexOf(close, position);
    if (end < 0) fail('Unterminated string');
    while (multiline && source[end + 3] === "'") end += 1;
    const value = source.slice(position, end);
    if (!multiline && value.includes('\n')) fail('Newline in a single-line string');
    for (const character of value) if (character === '\n') line += 1;
    position = end + close.length;
    return value;
  }

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      const character = peek();
      if (character === '"') parts.push(basicString());
      else if (character === "'") parts.push(literalString());
      else {
        const match = BARE_KEY.exec(source.slice(position, position + 256));
        if (!match) fail('Expected a key');
        parts.push(match![0]);
        position += match![0].length;
      }
      skipSpaces();
      if (peek() !== '.') return parts;
      position += 1;
    }
  }

  function scalar(): TomlValue {
    const rest = source.slice(position, position + 128);
    const match = /^[^\s,\]}#]+(?: \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/.exec(
      rest,
    );
    if (!match) fail('Expected a value');
    const token = match![0];
    position += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?(?:inf|nan)$/.test(token)) return Number(token.replace('inf', 'Infinity'));
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(token)) return token;
    const number = token.replace(/_/g, '');
    if (/^[+-]?(?:0x[0-9A-Fa-f]+|0o[0-7]+|0b[01]+)$/.test(number))
      return Number(number.replace(/^\+/, ''));
    if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) return Number(number);
    return fail(`Invalid value ${token}`);
  }

  function value(): TomlValue {
    if (depth >= MAX_DEPTH) fail('Arrays or inline tables are nested too deeply');
    depth += 1;
    try {
      return plainValue();
    } finally {
      depth -= 1;
    }
  }

  function plainValue(): TomlValue {
    const character = peek();
    if (character === '"') return basicString();
    if (character === "'") return literalString();
    if (character === '[') {
      advance();
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (peek() === ']') {
          advance();
          return items;
        }
        items.push(value());
        skipBlank();
        if (peek() === ',') advance();
        else if (peek() !== ']') fail('Expected , or ] in an array');
      }
    }
    if (character === '{') {
      // TOML 1.1 (which Cargo reads) allows newlines, comments and a trailing comma here.
      advance();
      const table = newTable();
      for (;;) {
        skipBlank();
        if (peek() === '}') {
          advance();
          return table;
        }
        assign(table, key());
        skipBlank();
        if (peek() === ',') advance();
        else if (peek() !== '}') fail('Expected , or } in an inline table');
      }
    }
    return scalar();
  }

  function descend(table: TomlTable, part: string): TomlTable {
    const existing = Object.hasOwn(table, part) ? table[part] : undefined;
    if (existing === undefined) return (table[part] = newTable());
    if (isTable(existing)) return existing;
    if (Array.isArray(existing) && isTable(existing.at(-1))) return existing.at(-1) as TomlTable;
    return fail(`Key ${part} is already a value`);
  }

  function assign(table: TomlTable, parts: string[]) {
    let target = table;
    for (const part of parts.slice(0, -1)) target = descend(target, part);
    const last = parts.at(-1)!;
    skipSpaces();
    if (peek() !== '=') fail('Expected =');
    advance();
    skipSpaces();
    if (last in target) fail(`Duplicate key ${parts.join('.')}`);
    target[last] = value();
  }

  while (position < source.length) {
    skipSpaces();
    skipComment();
    if (position >= source.length) break;
    if (peek() === '\n') {
      advance();
      continue;
    }
    if (peek() === '[') {
      const array = source[position + 1] === '[';
      position += array ? 2 : 1;
      const parts = key();
      if (!source.startsWith(array ? ']]' : ']', position)) fail('Unterminated table header');
      position += array ? 2 : 1;
      endOfLine();
      let parent = root;
      for (const part of parts.slice(0, -1)) parent = descend(parent, part);
      const last = parts.at(-1)!;
      if (array) {
        const existing = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(existing)) fail(`${parts.join('.')} is not an array of tables`);
        const table = newTable();
        (existing as TomlValue[]).push(table);
        current = table;
      } else {
        const existing = parent[last];
        if (existing !== undefined && !isTable(existing))
          fail(`${parts.join('.')} is already a value`);
        const table = (existing as TomlTable | undefined) ?? (parent[last] = newTable());
        if (defined.has(table as TomlTable)) fail(`Table ${parts.join('.')} is defined twice`);
        defined.add(table as TomlTable);
        current = table as TomlTable;
      }
      continue;
    }
    assign(current, key());
    endOfLine();
  }
  return root;
}

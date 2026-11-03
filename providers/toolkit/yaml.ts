// A small, dependency-free YAML 1.2 parser for provider tools that read OpenAPI and Swagger specs
// published as YAML. It is a helper: it turns text into plain values and reports errors with a
// line and column. It decides nothing.
//
// Supported: block mappings and sequences (including compact `- key: value` items), plain, quoted
// and block scalars, flow collections, comments, directives, anchors, aliases, merge keys and the
// core-schema tags. Only the first document is read. Plain mapping keys keep their source text,
// so `1.0:` gives the key "1.0". Unlike strict YAML, a value on its key's line may contain ": ".
// Throws YamlError for complex `? ` keys, collections used as keys and tabs used as indentation.

const TAB = 9;
const LF = 10;
const SP = 32;
const BANG = 33; // !
const DQUOTE = 34; // "
const HASH = 35; // #
const PERCENT = 37; // %
const AMP = 38; // &
const SQUOTE = 39; // '
const STAR = 42; // *
const PLUS = 43; // +
const COMMA = 44; // ,
const DASH = 45; // -
const DOT = 46; // .
const COLON = 58; // :
const LT = 60; // <
const GT = 62; // >
const QUESTION = 63; // ?
const AT = 64; // @
const LBRACKET = 91; // [
const BACKSLASH = 92; // \
const RBRACKET = 93; // ]
const BACKTICK = 96; // `
const LBRACE = 123; // {
const PIPE = 124; // |
const RBRACE = 125; // }
const TILDE = 126; // ~

// Far deeper than any real spec; it keeps hostile input from overflowing the call stack.
const MAX_DEPTH = 500;

// Where a node starts. Block collections may only begin at the start of a line or after "- ".
const LINE = 0;
const COMPACT = 1; // after "- " on the same line
const VALUE = 2; // after "key:" on the same line
const DOC = 3; // after "---" on the same line
type Mode = typeof LINE | typeof COMPACT | typeof VALUE | typeof DOC;

type Props = { anchor: string | undefined; tag: string | undefined; at: number };

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUES = new Set(['true', 'True', 'TRUE']);
const FALSES = new Set(['false', 'False', 'FALSE']);
const DECIMAL = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INTEGER = /^[-+]?[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const OCTAL = /^0o[0-7]+$/;
const INFINITY = /^[-+]?\.(?:inf|Inf|INF)$/;
const NOT_A_NUMBER = /^\.(?:nan|NaN|NAN)$/;
const SCALAR_TAGS = new Set(['!!str', '!!int', '!!float', '!!bool', '!!null']);

const ESCAPES = new Map<string, string>([
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['t', '\t'],
  ['\t', '\t'],
  ['n', '\n'],
  ['v', '\v'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\x1b'],
  [' ', ' '],
  ['"', '"'],
  ['/', '/'],
  ['\\', '\\'],
  ['N', '\x85'],
  ['_', '\xa0'],
  ['L', ' '],
  ['P', ' '],
]);

export class YamlError extends Error {
  readonly line: number; // 1-based
  readonly column: number; // 1-based
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'YamlError';
    this.line = line;
    this.column = column;
  }
}

/**
 * Parse the first YAML document in `source` into plain JS values (objects, arrays, strings,
 * numbers, booleans, null). Throws YamlError.
 */
export function parseYaml(source: string): unknown {
  let text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
  return new Parser(text).parse();
}

// Core schema: null, booleans, integers and floats. Everything else stays a string.
function resolvePlain(text: string): unknown {
  if (text.length === 0) return null;
  const c = text.charCodeAt(0);
  if (c === TILDE || c === 0x6e || c === 0x4e) return NULLS.has(text) ? null : text; // ~ n N
  if (c === 0x74 || c === 0x54) return TRUES.has(text) ? true : text; // t T
  if (c === 0x66 || c === 0x46) return FALSES.has(text) ? false : text; // f F
  if ((c >= 0x30 && c <= 0x39) || c === DASH || c === PLUS || c === DOT) {
    const number = parseFloatText(text);
    if (number !== undefined) return number;
  }
  return text;
}

function parseIntText(text: string): number | undefined {
  if (INTEGER.test(text)) return Number(text);
  if (HEX.test(text)) return parseInt(text.slice(2), 16);
  if (OCTAL.test(text)) return parseInt(text.slice(2), 8);
  return undefined;
}

function parseFloatText(text: string): number | undefined {
  if (DECIMAL.test(text)) return Number(text);
  if (INFINITY.test(text)) return text.charCodeAt(0) === DASH ? -Infinity : Infinity;
  if (NOT_A_NUMBER.test(text)) return NaN;
  return parseIntText(text);
}

// The string a scalar becomes when it is used as a mapping key, or undefined for a collection.
function keyOf(value: unknown): string | undefined {
  if (value === null) return 'null';
  return typeof value === 'object' ? undefined : String(value);
}

// "__proto__" must become an own property, never the object's prototype.
function setProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function isFlowIndicator(c: number): boolean {
  return c === COMMA || c === LBRACKET || c === RBRACKET || c === LBRACE || c === RBRACE;
}

// Characters allowed in anchor, alias and tag names.
function isNameChar(c: number): boolean {
  return c !== SP && c !== TAB && c !== LF && !isFlowIndicator(c);
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

function preview(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

// Works on the whole text with an index; positions become line and column only when it fails.
class Parser {
  private readonly src: string;
  private readonly len: number;
  private pos = 0;
  private depth = 0;
  private readonly anchors = new Map<string, unknown>();
  // How the last flow node reads as a mapping key; set by parseFlowNode.
  private flowKey: string | undefined = undefined;
  private flowKeyJson = false;
  private flowKeyMerge = false;

  constructor(src: string) {
    this.src = src;
    this.len = src.length;
  }

  parse(): unknown {
    const s = this.src;
    let directives = false;
    let indent = this.peekLine();
    // Directives, and "..." lines with no document before them, come before the first document.
    while (
      (indent === 0 && s.charCodeAt(this.pos) === PERCENT) ||
      (indent < 0 && !directives && s.startsWith('...', this.pos))
    ) {
      if (indent === 0) directives = true;
      this.pos = Math.min(this.lineEnd(this.pos) + 1, this.len);
      indent = this.peekLine();
    }
    let root: unknown = null;
    if (indent >= 0) {
      if (directives) this.fail('expected "---" after the directives', this.pos + indent);
      root = this.parseBlockNode(-1, false, null);
    } else if (s.startsWith('---', this.pos)) {
      this.pos += 3;
      root = this.parseAfterIndicator(-1, DOC, -1);
    } else if (directives) {
      this.fail('expected "---" after the directives');
    }
    // A document marker here starts a later document, which is ignored.
    const next = this.peekLine();
    if (next >= 0) {
      this.fail('unexpected content after the document (check the indentation)', this.pos + next);
    }
    return root;
  }

  // From a line start, skips blank and comment lines. Leaves pos at the start of the next content
  // line and returns its indent, or -1 at the end of input or at a document marker.
  private peekLine(): number {
    const s = this.src;
    const len = this.len;
    let i = this.pos;
    while (i < len) {
      const start = i;
      while (i < len && s.charCodeAt(i) === SP) i++;
      let j = i;
      while (j < len && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
      if (j >= len) break;
      const c = s.charCodeAt(j);
      if (c === LF || c === HASH) {
        i = c === LF ? j + 1 : this.lineEnd(j) + 1;
        continue;
      }
      if (j > i) this.fail('tabs are not allowed in indentation', i);
      this.pos = start;
      const indent = i - start;
      return indent === 0 && this.isDocMarker(start) ? -1 : indent;
    }
    this.pos = len;
    return -1;
  }

  // Parses a node that starts on a later line, indented more than its parent (n). A mapping
  // value may also be a sequence at the parent's own indent.
  private parseBlockNode(n: number, seqAtParentIndent: boolean, props: Props | null): unknown {
    const m = this.peekLine();
    if (m > n) {
      this.pos += m;
      return this.parseContent(n, m, LINE, props);
    }
    if (m === n && seqAtParentIndent && this.isSeqEntry(this.pos + m)) {
      this.pos += m;
      return this.collection(this.parseBlockSequence(m), props);
    }
    return this.scalar('', true, props);
  }

  // Parses what follows "key:", "- " or "---" on the same line.
  private parseAfterIndicator(n: number, mode: Mode, lineStart: number): unknown {
    const s = this.src;
    let i = this.pos;
    while (i < this.len && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
    this.pos = i;
    if (i >= this.len || s.charCodeAt(i) === LF || s.charCodeAt(i) === HASH) {
      this.finishLine();
      return this.parseBlockNode(n, mode === VALUE, null);
    }
    return this.parseContent(n, i - lineStart, mode, null);
  }

  // Parses a node whose first character is at pos and at column col. n is the parent's indent;
  // outer holds an anchor or tag written on an earlier line.
  private parseContent(n: number, col: number, mode: Mode, outer: Props | null): unknown {
    if (++this.depth > MAX_DEPTH) this.fail('the document is nested too deeply');
    const s = this.src;
    const start = this.pos;
    const block = mode === LINE || mode === COMPACT;
    let value: unknown;
    if (block && s.charCodeAt(start) === DASH && this.wsOrEnd(start + 1)) {
      value = this.collection(this.parseBlockSequence(col), outer);
    } else {
      const c = s.charCodeAt(start);
      const props = c === AMP || c === BANG ? this.readProps(false) : null;
      const d = this.pos < this.len ? s.charCodeAt(this.pos) : LF;
      if (props !== null && (d === LF || d === HASH)) {
        // Properties alone on a line belong to the node below them.
        this.finishLine();
        value = this.parseBlockNode(n, mode === VALUE, this.joinProps(outer, props));
      } else if (block && this.isImplicitKey()) {
        // Properties before a first key belong to that key, so readKey reads them again.
        this.pos = start;
        value = this.collection(this.parseBlockMapping(col), outer);
      } else {
        value = this.parseInline(n, mode, this.joinProps(outer, props));
      }
    }
    this.depth--;
    return value;
  }

  // Scalars, flow collections and aliases that start on the current line.
  private parseInline(n: number, mode: Mode, props: Props | null): unknown {
    const c = this.src.charCodeAt(this.pos);
    let value: unknown;
    if (c === STAR) {
      if (props !== null) this.fail('an alias cannot have an anchor or tag', props.at);
      value = this.readAlias();
    } else if (c === LBRACKET || c === LBRACE) {
      value = this.collection(c === LBRACKET ? this.parseFlowSeq() : this.parseFlowMap(), props);
    } else if (c === PIPE || c === GT) {
      return this.scalar(this.readBlockScalar(n), false, props);
    } else if (c === DQUOTE || c === SQUOTE) {
      value = this.scalar(c === DQUOTE ? this.readDouble() : this.readSingle(), false, props);
    } else {
      this.checkPlainStart(this.pos);
      value = this.scalar(this.readPlain(n, false, mode === VALUE), true, props);
    }
    this.finishLine();
    return value;
  }

  private parseBlockMapping(m: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const at = this.pos;
      const key = this.readKey();
      const value = this.parseAfterIndicator(m, VALUE, -1);
      if (key === null) this.mergeInto(out, value, at);
      else setProp(out, key, value);
      const next = this.peekLine();
      if (next !== m) {
        if (next > m) this.fail('bad indentation of a mapping entry', this.pos + next);
        return out;
      }
      this.pos += m;
    }
  }

  private parseBlockSequence(m: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const lineStart = this.pos - m;
      this.pos++;
      out.push(this.parseAfterIndicator(m, COMPACT, lineStart));
      const next = this.peekLine();
      if (next === m && this.isSeqEntry(this.pos + m)) {
        this.pos += m;
        continue;
      }
      if (next > m) this.fail('bad indentation of a sequence entry', this.pos + next);
      return out;
    }
  }

  // Reads a block mapping key and its ":". Returns null for a merge key ("<<").
  private readKey(): string | null {
    const s = this.src;
    const c0 = s.charCodeAt(this.pos);
    const props = c0 === AMP || c0 === BANG ? this.readProps(false) : null;
    const start = this.pos;
    const c = start < this.len ? s.charCodeAt(start) : LF;
    if (c === LF || c === HASH) this.fail('expected a mapping key after the anchor or tag', start);
    if ((c === DASH || c === QUESTION || c === COLON) && this.wsOrEnd(start + 1)) {
      this.fail(
        c === DASH
          ? 'expected a mapping key, found a sequence entry'
          : c === QUESTION
            ? 'complex mapping keys ("? ") are not supported'
            : 'empty mapping keys are not supported',
        start,
      );
    }
    let key: string | undefined;
    if (c === DQUOTE || c === SQUOTE) {
      const text = c === DQUOTE ? this.readDouble() : this.readSingle();
      const nl = s.indexOf('\n', start);
      if (nl !== -1 && nl < this.pos) this.fail('a mapping key must fit on one line', start);
      key = props === null ? text : keyOf(this.scalar(text, false, props));
    } else if (c === STAR) {
      if (props !== null) this.fail('an alias cannot have an anchor or tag', props.at);
      key = keyOf(this.readAlias());
      if (key === undefined) this.fail('an alias to a collection cannot be a mapping key', start);
    } else if (c === LBRACKET || c === LBRACE) {
      this.fail('flow collections as mapping keys are not supported', start);
    } else {
      this.checkPlainStart(start);
      const colon = this.scanPlainKeyEnd(start);
      if (colon < 0) this.fail('expected a "key: value" mapping entry', start);
      let end = colon;
      while (end > start && (s.charCodeAt(end - 1) === SP || s.charCodeAt(end - 1) === TAB)) end--;
      const text = s.slice(start, end);
      this.pos = colon + 1;
      if (props === null || props.tag === undefined) {
        if (props !== null) this.scalar(text, true, props);
        return text === '<<' ? null : text;
      }
      return keyOf(this.scalar(text, true, props)) ?? text;
    }
    // A quoted or alias key may have spaces before its ":".
    let i = this.pos;
    while (i < this.len && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
    if (s.charCodeAt(i) !== COLON) this.fail('expected ":" after the mapping key', i);
    this.pos = i + 1;
    return key ?? '';
  }

  // Looks ahead on the current line for an implicit "key:" without consuming anything.
  private isImplicitKey(): boolean {
    const s = this.src;
    const len = this.len;
    const i = this.pos;
    if (i >= len) return false;
    const c = s.charCodeAt(i);
    let j: number;
    if (c === DQUOTE || c === SQUOTE) {
      j = this.scanQuotedEnd(i);
      if (j < 0) return false;
    } else if (c === STAR) {
      j = i + 1;
      while (j < len && isNameChar(s.charCodeAt(j))) j++;
    } else if (c === LBRACKET || c === LBRACE || c === PIPE || c === GT || c === LF) {
      return false;
    } else {
      return this.scanPlainKeyEnd(i) >= 0;
    }
    while (j < len && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
    return s.charCodeAt(j) === COLON && (c !== STAR || this.wsOrEnd(j + 1));
  }

  // Index of the ":" that ends a plain key on this line, or -1 when the line holds no key.
  private scanPlainKeyEnd(i: number): number {
    const s = this.src;
    const len = this.len;
    for (; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === LF) return -1;
      if (c === COLON) {
        if (this.wsOrEnd(i + 1)) return i;
      } else if (c === HASH) {
        const p = s.charCodeAt(i - 1);
        if (p === SP || p === TAB) return -1;
      }
    }
    return -1;
  }

  // Index just past a quoted scalar that closes on this line, or -1.
  private scanQuotedEnd(i: number): number {
    const s = this.src;
    const q = s.charCodeAt(i);
    for (let j = i + 1; j < this.len; j++) {
      const c = s.charCodeAt(j);
      if (c === LF) return -1;
      if (q === DQUOTE && c === BACKSLASH) {
        j++;
      } else if (c === q) {
        if (q === SQUOTE && s.charCodeAt(j + 1) === SQUOTE) j++;
        else return j + 1;
      }
    }
    return -1;
  }

  // After a node: allows trailing spaces and a comment, then moves to the next line.
  private finishLine(): void {
    const s = this.src;
    let i = this.pos;
    while (i < this.len && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
    if (i < this.len && s.charCodeAt(i) === HASH) i = this.lineEnd(i);
    if (i < this.len && s.charCodeAt(i) !== LF) {
      this.fail(
        s.charCodeAt(i) === COLON
          ? 'unexpected ":" (a mapping is not allowed here; check the indentation)'
          : `unexpected "${s[i]}" after the value`,
        i,
      );
    }
    this.pos = i < this.len ? i + 1 : this.len;
  }

  private checkPlainStart(i: number): void {
    const s = this.src;
    const c = s.charCodeAt(i);
    if (c === DASH || c === QUESTION || c === COLON) {
      if (!this.wsOrEnd(i + 1)) return;
      if (c === DASH) this.fail('a block sequence cannot start here', i);
      if (c === QUESTION) this.fail('complex mapping keys ("? ") are not supported', i);
      this.fail('unexpected ":"', i);
    }
    if (
      isFlowIndicator(c) ||
      c === HASH ||
      c === PERCENT ||
      c === AT ||
      c === BACKTICK ||
      c === PIPE ||
      c === GT
    ) {
      this.fail(`unexpected "${s[i]}"`, i);
    }
  }

  private isSeqEntry(i: number): boolean {
    return this.src.charCodeAt(i) === DASH && this.wsOrEnd(i + 1);
  }

  private isDocMarker(i: number): boolean {
    const s = this.src;
    const c = s.charCodeAt(i);
    if (c !== DASH && c !== DOT) return false;
    return s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c && this.wsOrEnd(i + 3);
  }

  private wsOrEnd(i: number): boolean {
    if (i >= this.len) return true;
    const c = this.src.charCodeAt(i);
    return c === SP || c === TAB || c === LF;
  }

  private lineEnd(i: number): number {
    const e = this.src.indexOf('\n', i);
    return e === -1 ? this.len : e;
  }

  // Reads a plain scalar. In block context later lines continue it when indented more than n; in
  // flow context it also stops at flow indicators. lenient keeps ": " on the first line as text:
  // strict YAML rejects that, but right after a key it can only be text.
  private readPlain(n: number, flow: boolean, lenient: boolean): string {
    const s = this.src;
    const len = this.len;
    let i = this.pos;
    let start = i;
    let text = '';
    let more = false; // text already holds earlier lines
    for (;;) {
      let end = i;
      let stopped = false;
      for (; i < len; i++) {
        const c = s.charCodeAt(i);
        if (c === LF) break;
        if (c === SP || c === TAB) {
          if (s.charCodeAt(i + 1) === HASH) {
            stopped = true;
            break;
          }
        } else if (c === COLON && (flow || more || !lenient) && this.endsPlain(i + 1, flow)) {
          stopped = true;
          break;
        } else if (flow && isFlowIndicator(c)) {
          stopped = true;
          break;
        } else {
          end = i + 1;
        }
      }
      text = more ? text + s.slice(start, end) : s.slice(start, end);
      if (stopped || i >= len) {
        this.pos = i;
        return text;
      }
      // At a line break: the scalar goes on if the next content line continues it.
      let j = i + 1;
      let breaks = 0;
      let next = -1;
      while (j < len) {
        let k = j;
        while (k < len && s.charCodeAt(k) === SP) k++;
        const indent = k - j;
        while (k < len && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
        if (k >= len) break;
        const c = s.charCodeAt(k);
        if (c === LF) {
          breaks++;
          j = k + 1;
          continue;
        }
        if (c === HASH || (!flow && indent <= n) || (indent === 0 && this.isDocMarker(j))) break;
        if (c === COLON && this.endsPlain(k + 1, flow)) break;
        if (flow && isFlowIndicator(c)) break;
        next = k;
        break;
      }
      if (next < 0) {
        this.pos = i;
        return text;
      }
      text += breaks === 0 ? ' ' : '\n'.repeat(breaks);
      more = true;
      start = i = next;
    }
  }

  private endsPlain(i: number, flow: boolean): boolean {
    return this.wsOrEnd(i) || (flow && isFlowIndicator(this.src.charCodeAt(i)));
  }

  private readSingle(): string {
    const s = this.src;
    const open = this.pos;
    let i = open + 1;
    let start = i;
    let out = '';
    for (;;) {
      if (i >= this.len) this.fail('unterminated single-quoted string', open);
      const c = s.charCodeAt(i);
      if (c === SQUOTE) {
        if (s.charCodeAt(i + 1) !== SQUOTE) {
          this.pos = i + 1;
          return out + s.slice(start, i);
        }
        out += s.slice(start, i + 1);
        i += 2;
        start = i;
      } else if (c === LF) {
        out += s.slice(start, this.trimEnd(start, i)) + this.foldBreak(i);
        i = start = this.pos;
      } else {
        i++;
      }
    }
  }

  private readDouble(): string {
    const s = this.src;
    const open = this.pos;
    let i = open + 1;
    let start = i;
    let out = '';
    for (;;) {
      if (i >= this.len) this.fail('unterminated double-quoted string', open);
      const c = s.charCodeAt(i);
      if (c === DQUOTE) {
        this.pos = i + 1;
        return out + s.slice(start, i);
      }
      if (c === BACKSLASH) {
        out += s.slice(start, i);
        const e = s.charAt(i + 1);
        const simple = ESCAPES.get(e);
        if (simple !== undefined) {
          out += simple;
          i += 2;
        } else if (e === 'x' || e === 'u' || e === 'U') {
          const size = e === 'x' ? 2 : e === 'u' ? 4 : 8;
          const code = this.hex(i, size);
          out += size === 8 ? String.fromCodePoint(code) : String.fromCharCode(code);
          i += 2 + size;
        } else if (e === '\n') {
          // An escaped line break joins the lines without a space.
          const fold = this.foldBreak(i + 1);
          if (fold !== ' ') out += fold;
          i = this.pos;
        } else {
          this.fail(`invalid escape "\\${e}" in a double-quoted string`, i);
        }
        start = i;
      } else if (c === LF) {
        out += s.slice(start, this.trimEnd(start, i)) + this.foldBreak(i);
        i = start = this.pos;
      } else {
        i++;
      }
    }
  }

  // At a line break inside a quoted scalar: returns what the break folds to and moves pos to the
  // first non-blank character after it.
  private foldBreak(i: number): string {
    const s = this.src;
    let breaks = 0;
    let j = i + 1;
    for (;;) {
      while (j < this.len && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
      if (j >= this.len || s.charCodeAt(j) !== LF) break;
      breaks++;
      j++;
    }
    this.pos = j;
    return breaks === 0 ? ' ' : '\n'.repeat(breaks);
  }

  private trimEnd(start: number, end: number): number {
    const s = this.src;
    while (end > start && (s.charCodeAt(end - 1) === SP || s.charCodeAt(end - 1) === TAB)) end--;
    return end;
  }

  // The code point of a \x, \u or \U escape that starts at i.
  private hex(i: number, size: number): number {
    let code = 0;
    for (let k = i + 2; k < i + 2 + size; k++) {
      const d = hexDigit(this.src.charCodeAt(k));
      if (d < 0) this.fail(`expected ${size} hex digits after "\\${this.src[i + 1]}"`, i);
      code = code * 16 + d;
    }
    if (code > 0x10ffff) this.fail('escape is outside the Unicode range', i);
    return code;
  }

  // Reads a literal (|) or folded (>) block scalar. n is the parent's indent.
  private readBlockScalar(n: number): string {
    const s = this.src;
    const len = this.len;
    const header = this.pos;
    const literal = s.charCodeAt(header) === PIPE;
    let i = header + 1;
    let chomp = 0; // -1 strip, 0 clip, 1 keep
    let indent = -1;
    for (let k = 0; k < 2; k++) {
      const c = s.charCodeAt(i);
      if ((c === DASH || c === PLUS) && chomp === 0) {
        chomp = c === DASH ? -1 : 1;
        i++;
      } else if (c >= 0x31 && c <= 0x39 && indent < 0) {
        indent = Math.max(n, 0) + c - 0x30;
        i++;
      }
    }
    if (!this.wsOrEnd(i)) this.fail('invalid block scalar header', header);
    this.pos = i;
    this.finishLine();
    i = this.pos;
    let out = '';
    let empty = 0; // blank lines since the last content line
    let started = false;
    let spaced = false; // the last line was more indented, so folding keeps its line break
    let lastBreak = false;
    while (i < len) {
      let k = i;
      const max = indent < 0 ? len : Math.min(len, i + indent);
      while (k < max && s.charCodeAt(k) === SP) k++;
      const end = this.lineEnd(k);
      // Lines of spaces are blank. A short line of spaces and tabs once the indent is known is
      // read as blank too, instead of ending the scalar early.
      if (k === end || (indent >= 0 && k - i < indent && isBlank(s, k, end))) {
        if (end >= len) {
          i = len;
          break;
        }
        empty++;
        i = end + 1;
        continue;
      }
      if (indent < 0) {
        if (k - i <= n) break;
        indent = k - i;
      }
      if (k - i < indent || (indent === 0 && this.isDocMarker(i))) break;
      const c = s.charCodeAt(k);
      const lead = c === SP || c === TAB;
      if (!started) out += '\n'.repeat(empty);
      else if (literal || lead || spaced) out += '\n'.repeat(empty + 1);
      else out += empty === 0 ? ' ' : '\n'.repeat(empty);
      out += s.slice(k, end);
      started = true;
      spaced = lead;
      empty = 0;
      lastBreak = end < len;
      i = lastBreak ? end + 1 : len;
    }
    this.pos = i;
    if (chomp === 1) out += (lastBreak ? '\n' : '') + '\n'.repeat(empty);
    else if (chomp === 0 && lastBreak) out += '\n';
    return out;
  }

  // Reads an anchor and a tag, in either order. In flow context line breaks may follow them.
  private readProps(flow: boolean): Props | null {
    const s = this.src;
    const at = this.pos;
    let anchor: string | undefined;
    let tag: string | undefined;
    for (;;) {
      const c = s.charCodeAt(this.pos);
      if (c === AMP) {
        if (anchor !== undefined) this.fail('a node can only have one anchor');
        const start = this.pos + 1;
        let i = start;
        while (i < this.len && isNameChar(s.charCodeAt(i))) i++;
        if (i === start) this.fail('an anchor needs a name');
        anchor = s.slice(start, i);
        this.pos = i;
      } else if (c === BANG) {
        if (tag !== undefined) this.fail('a node can only have one tag');
        tag = this.readTag();
      } else {
        break;
      }
      if (flow) {
        this.skipFlowSpace();
      } else {
        while (
          this.pos < this.len &&
          (s.charCodeAt(this.pos) === SP || s.charCodeAt(this.pos) === TAB)
        ) {
          this.pos++;
        }
      }
    }
    return anchor === undefined && tag === undefined ? null : { anchor, tag, at };
  }

  // Returns "!!name" for core tags, including the verbatim form, and the raw text otherwise.
  private readTag(): string {
    const s = this.src;
    const start = this.pos;
    if (s.charCodeAt(start + 1) === LT) {
      const end = s.indexOf('>', start);
      if (end === -1 || end > this.lineEnd(start)) this.fail('unterminated verbatim tag', start);
      this.pos = end + 1;
      const uri = s.slice(start + 2, end);
      return uri.startsWith('tag:yaml.org,2002:') ? `!!${uri.slice(18)}` : `!<${uri}>`;
    }
    let i = start + 1;
    while (i < this.len && isNameChar(s.charCodeAt(i))) i++;
    this.pos = i;
    return s.slice(start, i);
  }

  private readAlias(): unknown {
    const s = this.src;
    const at = this.pos;
    let i = at + 1;
    while (i < this.len && isNameChar(s.charCodeAt(i))) i++;
    if (i === at + 1) this.fail('an alias needs a name', at);
    const name = s.slice(at + 1, i);
    if (!this.anchors.has(name)) this.fail(`unknown alias "*${name}"`, at);
    this.pos = i;
    return this.anchors.get(name);
  }

  // Turns scalar text into a value, honoring core tags, and records its anchor.
  private scalar(text: string, plain: boolean, props: Props | null): unknown {
    if (props === null) return plain ? resolvePlain(text) : text;
    let value: unknown;
    if (props.tag === undefined) value = plain ? resolvePlain(text) : text;
    else value = this.tagScalar(props.tag, text, plain, props.at);
    if (props.anchor !== undefined) this.anchors.set(props.anchor, value);
    return value;
  }

  private tagScalar(tag: string, text: string, plain: boolean, at: number): unknown {
    let value: unknown;
    switch (tag) {
      case '!!str':
        return text;
      case '!!null':
        value = NULLS.has(text) ? null : undefined;
        break;
      case '!!bool':
        value = TRUES.has(text) ? true : FALSES.has(text) ? false : undefined;
        break;
      case '!!int':
        value = parseIntText(text);
        break;
      case '!!float':
        value = parseFloatText(text);
        break;
      case '!!map':
      case '!!seq':
        // An empty node with a collection tag is an empty collection.
        if (plain && text === '') return tag === '!!map' ? {} : [];
        return this.fail(`the ${tag} tag cannot be used on a scalar`, at);
      default:
        return plain ? resolvePlain(text) : text; // other tags are ignored
    }
    if (value === undefined) this.fail(`"${preview(text)}" is not a valid ${tag} value`, at);
    return value;
  }

  private collection<T extends object>(value: T, props: Props | null): T {
    if (props === null) return value;
    const tag = props.tag;
    if (tag !== undefined) {
      const isSeq = Array.isArray(value);
      if ((tag === '!!map' && isSeq) || (tag === '!!seq' && !isSeq) || SCALAR_TAGS.has(tag)) {
        this.fail(`the ${tag} tag cannot be used on a ${isSeq ? 'sequence' : 'mapping'}`, props.at);
      }
    }
    if (props.anchor !== undefined) this.anchors.set(props.anchor, value);
    return value;
  }

  // Properties may be split over two lines, as long as each kind appears once.
  private joinProps(outer: Props | null, inner: Props | null): Props | null {
    if (outer === null) return inner;
    if (inner === null) return outer;
    if (
      (outer.anchor !== undefined && inner.anchor !== undefined) ||
      (outer.tag !== undefined && inner.tag !== undefined)
    ) {
      this.fail('a node can only have one anchor and one tag', inner.at);
    }
    return { anchor: outer.anchor ?? inner.anchor, tag: outer.tag ?? inner.tag, at: outer.at };
  }

  // Merge keys only fill keys the mapping does not have yet: explicit keys always win, and
  // earlier mappings in a merge list win over later ones.
  private mergeInto(target: Record<string, unknown>, value: unknown, at: number): void {
    for (const source of Array.isArray(value) ? value : [value]) {
      if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        this.fail('a merge key ("<<") needs a mapping or a list of mappings', at);
      }
      const record = source as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(target, key)) setProp(target, key, record[key]);
      }
    }
  }

  // Skips spaces, line breaks and comments inside a flow collection.
  private skipFlowSpace(): void {
    const s = this.src;
    let i = this.pos;
    while (i < this.len) {
      const c = s.charCodeAt(i);
      if (c === SP || c === TAB || c === LF) i++;
      else if (c === HASH) i = this.lineEnd(i);
      else break;
    }
    this.pos = i;
  }

  // Parses one node inside a flow collection and notes how it reads as a mapping key.
  private parseFlowNode(): unknown {
    if (++this.depth > MAX_DEPTH) this.fail('the document is nested too deeply');
    const s = this.src;
    const c0 = s.charCodeAt(this.pos);
    const props = c0 === AMP || c0 === BANG ? this.readProps(true) : null;
    const at = this.pos;
    const c = s.charCodeAt(at);
    let value: unknown;
    let key: string | undefined;
    let json = false;
    let merge = false;
    if (c === LBRACKET || c === LBRACE) {
      value = this.collection(c === LBRACKET ? this.parseFlowSeq() : this.parseFlowMap(), props);
      json = true;
    } else if (c === STAR) {
      if (props !== null) this.fail('an alias cannot have an anchor or tag', props.at);
      value = this.readAlias();
      key = keyOf(value);
    } else if (c === DQUOTE || c === SQUOTE) {
      const text = c === DQUOTE ? this.readDouble() : this.readSingle();
      value = this.scalar(text, false, props);
      key = props === null || props.tag === undefined ? text : keyOf(value);
      json = true;
    } else if (
      at >= this.len ||
      isFlowIndicator(c) ||
      (c === COLON && this.endsPlain(at + 1, true))
    ) {
      if (props === null) {
        this.fail(
          at >= this.len
            ? 'unexpected end of input inside a flow collection'
            : `unexpected "${s[at]}"`,
          at,
        );
      }
      value = this.scalar('', true, props); // a node with only an anchor or a tag
    } else {
      this.checkPlainStart(at);
      const text = this.readPlain(-1, true, false);
      value = this.scalar(text, true, props);
      const untagged = props === null || props.tag === undefined;
      key = untagged ? text : keyOf(value);
      merge = untagged && text === '<<';
    }
    this.flowKey = key;
    this.flowKeyJson = json;
    this.flowKeyMerge = merge;
    this.depth--;
    return value;
  }

  private parseFlowSeq(): unknown[] {
    const s = this.src;
    const open = this.pos;
    const out: unknown[] = [];
    this.pos++;
    for (;;) {
      this.skipFlowSpace();
      if (this.pos >= this.len) this.fail('unterminated flow sequence (missing "]")', open);
      let c = s.charCodeAt(this.pos);
      if (c === RBRACKET) break;
      if (c === COMMA) this.fail('unexpected "," in a flow sequence');
      const at = this.pos;
      let item = this.parseFlowNode();
      this.skipFlowSpace();
      c = s.charCodeAt(this.pos);
      if (c === COLON && (this.flowKeyJson || this.endsPlain(this.pos + 1, true))) {
        // A "key: value" pair inside a sequence is a mapping with one entry.
        const key = this.flowKey;
        const merge = this.flowKeyMerge;
        if (key === undefined) this.fail('only scalars can be mapping keys', at);
        this.pos++;
        this.skipFlowSpace();
        c = s.charCodeAt(this.pos);
        const value = c === COMMA || c === RBRACKET ? null : this.parseFlowNode();
        const pair: Record<string, unknown> = {};
        if (merge) this.mergeInto(pair, value, at);
        else setProp(pair, key, value);
        item = pair;
        this.skipFlowSpace();
        c = s.charCodeAt(this.pos);
      }
      out.push(item);
      if (c === COMMA) {
        this.pos++;
      } else if (c !== RBRACKET) {
        if (this.pos >= this.len) this.fail('unterminated flow sequence (missing "]")', open);
        this.fail('expected "," or "]" in a flow sequence');
      }
    }
    this.pos++;
    return out;
  }

  private parseFlowMap(): Record<string, unknown> {
    const s = this.src;
    const open = this.pos;
    const out: Record<string, unknown> = {};
    this.pos++;
    for (;;) {
      this.skipFlowSpace();
      if (this.pos >= this.len) this.fail('unterminated flow mapping (missing "}")', open);
      let c = s.charCodeAt(this.pos);
      if (c === RBRACE) break;
      if (c === COMMA) this.fail('unexpected "," in a flow mapping');
      if (c === QUESTION && this.endsPlain(this.pos + 1, true)) {
        this.fail('complex mapping keys ("? ") are not supported');
      }
      const at = this.pos;
      this.parseFlowNode();
      const key = this.flowKey;
      const merge = this.flowKeyMerge;
      if (key === undefined) this.fail('only scalars can be mapping keys', at);
      this.skipFlowSpace();
      let value: unknown = null;
      c = s.charCodeAt(this.pos);
      if (c === COLON && (this.flowKeyJson || this.endsPlain(this.pos + 1, true))) {
        this.pos++;
        this.skipFlowSpace();
        c = s.charCodeAt(this.pos);
        if (c !== COMMA && c !== RBRACE) value = this.parseFlowNode();
      }
      if (merge) this.mergeInto(out, value, at);
      else setProp(out, key, value);
      this.skipFlowSpace();
      c = s.charCodeAt(this.pos);
      if (c === COMMA) {
        this.pos++;
      } else if (c !== RBRACE) {
        if (this.pos >= this.len) this.fail('unterminated flow mapping (missing "}")', open);
        this.fail('expected "," or "}" in a flow mapping');
      }
    }
    this.pos++;
    return out;
  }

  private fail(message: string, at: number = this.pos): never {
    const s = this.src;
    const end = Math.min(at, this.len);
    let line = 1;
    let lineStart = 0;
    for (let i = s.indexOf('\n'); i !== -1 && i < end; i = s.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    throw new YamlError(message, line, end - lineStart + 1);
  }
}

function isBlank(s: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

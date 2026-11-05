// A small lexer for the dead-API scan: it splits a file into strings, comments and everything else,
// so a match can say where it sits. TypeScript 7 has no JS compiler API here, and the scan reads many
// languages, so this is a lexer and not a parser. It only has to be right about where a name sits.
import path from 'node:path';

export type SpanKind = 'string' | 'comment';

/** A string or comment. `start` and `end` hold the delimiters; `innerStart` and `innerEnd` don't. */
export type Span = {
  kind: SpanKind;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  quote?: string; // `/` is a JS regex literal
};

export type FileMode =
  'js' | 'python' | 'clike' | 'php' | 'ruby' | 'hash' | 'html' | 'json' | 'notebook' | 'prose';

export type Lexed = {
  text: string;
  mode: FileMode;
  spans: Span[];
  /** The text with comments and string contents blanked, same length, so offsets carry over. */
  code: string;
};

const MODE_BY_EXTENSION: Record<string, FileMode> = {
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.mts': 'js',
  '.cts': 'js',
  '.py': 'python',
  '.go': 'clike',
  '.java': 'clike',
  '.kt': 'clike',
  '.kts': 'clike',
  '.gradle': 'clike',
  '.scala': 'clike',
  '.c': 'clike',
  '.h': 'clike',
  '.cc': 'clike',
  '.cpp': 'clike',
  '.hpp': 'clike',
  '.lua': 'clike',
  '.cs': 'clike',
  '.rs': 'clike',
  '.swift': 'clike',
  '.dart': 'clike',
  '.php': 'php',
  '.rb': 'ruby',
  '.ex': 'ruby',
  '.exs': 'ruby',
  '.r': 'ruby',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.astro': 'html',
  '.xml': 'html',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.yml': 'hash',
  '.yaml': 'hash',
  '.toml': 'hash',
  '.tf': 'hash',
  '.properties': 'hash',
  '.ps1': 'hash',
  '.ini': 'hash',
  '.cfg': 'hash',
  '.conf': 'hash',
  '.env': 'hash',
  '.sh': 'hash',
  '.bash': 'hash',
  '.zsh': 'hash',
  '.ipynb': 'notebook',
  '.md': 'prose',
  '.mdx': 'prose',
  '.rst': 'prose',
  '.txt': 'prose',
  '.adoc': 'prose',
};
const DOCKERFILE = /^(?:.+\.)?dockerfile(?:\..+)?$/i;
const ENV_TEMPLATE = /^\.env(?:\.|$)/;
const TASK_FILE = /^(?:makefile|gnumakefile|procfile)$/i;
// config.yaml.example reads as the config it's a template of.
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|tmpl|tpl|dist)$/i;

/** How to read a file, or undefined for a kind the scan doesn't read. */
export function modeOf(file: string): FileMode | undefined {
  const name = path.posix.basename(file);
  if (DOCKERFILE.test(name) || ENV_TEMPLATE.test(name) || TASK_FILE.test(name)) return 'hash';
  const inner = name.replace(TEMPLATE_SUFFIX, '');
  return MODE_BY_EXTENSION[path.posix.extname(inner).toLowerCase()];
}

type Rules = {
  lineComments: string[];
  blockComment?: [string, string];
  quotes: string[];
  triple?: boolean; // Python's """ and '''
  template?: boolean; // JS `…${code}…`
  rawTick?: boolean; // Go's `…`: spans lines, no interpolation
  regex?: boolean;
  hashNeedsSpace?: boolean; // shell and YAML: # starts a comment only after a space
};

const RULES: Record<Exclude<FileMode, 'html' | 'notebook' | 'prose'>, Rules> = {
  js: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    template: true,
    regex: true,
  },
  python: { lineComments: ['#'], quotes: ['"', "'"], triple: true },
  clike: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    rawTick: true,
  },
  php: { lineComments: ['//', '#'], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
  ruby: { lineComments: ['#'], quotes: ['"', "'"] },
  hash: { lineComments: ['#'], quotes: ['"', "'"], hashNeedsSpace: true },
  json: { lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"'] },
};

// What can sit right before a `/` that opens a regex rather than dividing.
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '\n']);
const WORD_BEFORE_REGEX = /\b(?:return|typeof|case|of|in|do|else)\s*$/;
const HTML_COMMENT: [string, string] = ['<!--', '-->'];
const SCRIPT_OPEN = /<script\b[^>]*>/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const TAG_START = /[A-Za-z/]/;
const URL_SCHEME_BEFORE = /https?:$/;
const ASTRO_FENCE = '---';
const REGEX_LOOK_BEHIND_CHARS = 16;

class Lexer {
  readonly spans: Span[] = [];
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private push(
    kind: SpanKind,
    start: number,
    end: number,
    open: number,
    close: number,
    quote?: string,
  ) {
    this.spans.push({ kind, start, end, innerStart: start + open, innerEnd: end - close, quote });
  }

  private lineEnd(from: number, limit: number): number {
    const end = this.text.indexOf('\n', from);
    return end === -1 || end > limit ? limit : end;
  }

  private comment(start: number, limit: number, open: string, close: string): number {
    const found = this.text.indexOf(close, start + open.length);
    const end = found === -1 || found >= limit ? limit : found + close.length;
    this.push('comment', start, end, open.length, found === -1 ? 0 : close.length);
    return end;
  }

  // A quote that never closes on its line is an apostrophe in text, as in JSX, and ends at the line.
  private quoted(start: number, limit: number, quote: string): number {
    let at = start + 1;
    while (at < limit && this.text[at] !== quote && this.text[at] !== '\n') {
      at += this.text[at] === '\\' ? 2 : 1;
    }
    const closed = this.text[at] === quote;
    const end = closed ? at + 1 : Math.min(at, limit);
    this.push('string', start, end, 1, closed ? 1 : 0, quote);
    return end;
  }

  private spanning(start: number, limit: number, delimiter: string): number {
    let at = start + delimiter.length;
    while (at < limit && !this.text.startsWith(delimiter, at)) {
      at += this.text[at] === '\\' && delimiter !== '`' ? 2 : 1;
    }
    const closed = at < limit;
    const end = closed ? at + delimiter.length : limit;
    this.push('string', start, end, delimiter.length, closed ? delimiter.length : 0, delimiter);
    return end;
  }

  // A template's text pieces are strings of their own, and each ${…} is code.
  private template(start: number, limit: number, rules: Rules): number {
    let pieceStart = start;
    let at = start + 1;
    let open = 1;
    while (at < limit && this.text[at] !== '`') {
      if (this.text[at] === '\\') {
        at += 2;
      } else if (this.text.startsWith('${', at)) {
        this.push('string', pieceStart, at, open, 0, '`');
        at = this.code(at + 2, limit, rules, true);
        pieceStart = at;
        open = 0;
      } else {
        at += 1;
      }
    }
    const closed = this.text[at] === '`';
    const end = closed ? at + 1 : limit;
    this.push('string', pieceStart, end, open, closed ? 1 : 0, '`');
    return end;
  }

  private regexEnd(start: number, limit: number): number | undefined {
    const before = this.text.slice(Math.max(0, start - REGEX_LOOK_BEHIND_CHARS), start);
    const previous = before.trimEnd().at(-1) ?? '\n';
    const opensRegex =
      BEFORE_REGEX.has(previous) ||
      WORD_BEFORE_REGEX.test(before) ||
      before.trimEnd().endsWith('=>');
    if (!opensRegex) return undefined;
    let inClass = false;
    for (let at = start + 1; at < limit; at += 1) {
      const char = this.text[at];
      if (char === '\n') return undefined;
      if (char === '\\') at += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) return at + 1;
    }
    return undefined;
  }

  /** Lexes code up to `limit`, or to the `}` closing a template's ${ when `untilBrace`. */
  code(start: number, limit: number, rules: Rules, untilBrace = false): number {
    let at = start;
    let depth = 0;
    while (at < limit) {
      const char = this.text[at];
      if (untilBrace) {
        if (char === '}' && depth === 0) return at + 1;
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
      }
      const line = rules.lineComments.find((open) => this.text.startsWith(open, at));
      const hashOk = !rules.hashNeedsSpace || at === 0 || /\s/.test(this.text[at - 1]);
      // A URL in JSX text: https://x isn't a comment opening at its slashes.
      const inUrl =
        line === '//' && URL_SCHEME_BEFORE.test(this.text.slice(Math.max(0, at - 6), at));
      if (line && hashOk && !inUrl) {
        const end = this.lineEnd(at, limit);
        this.push('comment', at, end, line.length, 0);
        at = end;
      } else if (rules.blockComment && this.text.startsWith(rules.blockComment[0], at)) {
        at = this.comment(at, limit, ...rules.blockComment);
      } else if (
        rules.triple &&
        (this.text.startsWith('"""', at) || this.text.startsWith("'''", at))
      ) {
        at = this.spanning(at, limit, this.text.slice(at, at + 3));
      } else if (rules.quotes.includes(char)) {
        at = this.quoted(at, limit, char);
      } else if (char === '`' && rules.template) {
        at = this.template(at, limit, rules);
      } else if (char === '`' && rules.rawTick) {
        at = this.spanning(at, limit, '`');
      } else if (char === '/' && rules.regex) {
        const end = this.regexEnd(at, limit);
        if (end) this.push('string', at, end, 1, 1, '/');
        at = end ?? at + 1;
      } else {
        at += 1;
      }
    }
    return at;
  }

  private tag(start: number, limit: number): number {
    let at = start + 1;
    while (at < limit && this.text[at] !== '>') {
      if (this.text[at] === '"' || this.text[at] === "'")
        at = this.quoted(at, limit, this.text[at]);
      else at += 1;
    }
    return Math.min(at + 1, limit);
  }

  html(): void {
    const limit = this.text.length;
    let at = 0;
    // An Astro file's frontmatter is code.
    if (this.text.startsWith(ASTRO_FENCE)) {
      const fence = this.text.indexOf(`\n${ASTRO_FENCE}`, ASTRO_FENCE.length);
      if (fence !== -1) {
        this.code(ASTRO_FENCE.length, fence, RULES.js);
        at = fence + ASTRO_FENCE.length + 1;
      }
    }
    while (at < limit) {
      if (this.text.startsWith(HTML_COMMENT[0], at)) {
        at = this.comment(at, limit, ...HTML_COMMENT);
      } else if (this.text[at] === '<' && this.text.slice(at, at + 7).toLowerCase() === '<script') {
        SCRIPT_OPEN.lastIndex = at;
        const open = SCRIPT_OPEN.exec(this.text);
        if (!open) return;
        const bodyStart = open.index + open[0].length;
        SCRIPT_CLOSE.lastIndex = bodyStart;
        const close = SCRIPT_CLOSE.exec(this.text);
        const bodyEnd = close ? close.index : limit;
        this.code(bodyStart, bodyEnd, RULES.js);
        at = close ? close.index + close[0].length : limit;
      } else if (this.text[at] === '<' && TAG_START.test(this.text[at + 1] ?? '')) {
        at = this.tag(at, limit);
      } else {
        at += 1;
      }
    }
  }
}

function blanked(text: string, spans: Span[]): string {
  const parts: string[] = [];
  let at = 0;
  const blank = (from: number, to: number) =>
    parts.push(text.slice(from, to).replace(/[^\n]/g, ' '));
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    parts.push(text.slice(at, span.start));
    if (span.kind === 'comment') {
      blank(span.start, span.end);
    } else {
      parts.push(text.slice(span.start, span.innerStart));
      blank(span.innerStart, span.innerEnd);
      parts.push(text.slice(span.innerEnd, span.end));
    }
    at = span.end;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

export function lex(text: string, mode: FileMode): Lexed {
  if (mode === 'prose') {
    const spans: Span[] = [
      {
        kind: 'comment',
        start: 0,
        end: text.length,
        innerStart: 0,
        innerEnd: text.length,
      },
    ];
    return { text, mode, spans, code: blanked(text, spans) };
  }
  const lexer = new Lexer(text);
  if (mode === 'html') lexer.html();
  else lexer.code(0, text.length, RULES[mode === 'notebook' ? 'python' : mode]);
  const spans = lexer.spans.sort((a, b) => a.start - b.start);
  return { text, mode, spans, code: blanked(text, spans) };
}

/** The string or comment holding an offset, if any. Spans are sorted and don't overlap. */
export function spanAt(spans: Span[], offset: number): Span | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offset < spans[middle].start) high = middle - 1;
    else if (offset >= spans[middle].end) low = middle + 1;
    else return spans[middle];
  }
  return undefined;
}

export const innerText = (lexed: Lexed, span: Span) =>
  lexed.text.slice(span.innerStart, span.innerEnd);

/** One file ready to scan. Offsets are into `text`, and for a notebook that's its joined code cells. */
export type Source = Lexed & {
  file: string;
  generated?: boolean; // build output or type declarations: a fix never edits these
  lower: string;
  lines: string[];
  lineStarts: number[];
  lineMap?: number[]; // a notebook's joined-code line to its line in the file, both 0-based
};

export function toSource(file: string, text: string, mode: FileMode, lineMap?: number[]): Source {
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return { ...lex(text, mode), file, lower: text.toLowerCase(), lines, lineStarts, lineMap };
}

/** The 0-based line holding an offset. */
export function lineIndexAt(source: Source, offset: number): number {
  let low = 0;
  let high = source.lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (source.lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The 1-based line a finding reports. */
export const reportedLine = (source: Source, lineIndex: number) =>
  (source.lineMap?.[lineIndex] ?? lineIndex) + 1;

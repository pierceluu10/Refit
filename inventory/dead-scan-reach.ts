// Whether a match can reach the API at all, from what the code does with it afterwards. Anything these
// rules can't settle stays as it was: they only speak up when the code plainly shows the value stops here.
import path from 'node:path';
import { escapeRegex } from '../dead-apis/match.ts';
import { lineIndexAt, reportedLine, spanAt, type Source, type Span } from './dead-scan-lex.ts';
import { enclosing, listName, wordPattern } from './dead-scan-place.ts';
import type { Manifest } from './scanners.ts';

export type Reach = { kind: 'catalog' | 'unclear'; reason: string };

export type Readers = {
  /** Files that can read a value: written code and config, no tests, docs or build output. */
  sources: Source[];
  manifests: Manifest[];
  orphans: Map<string, boolean>;
  /** Reads of a word in a file, since a package's hits ask about the same few names. */
  reads: Map<string, Read[]>;
  uses: Map<string, Uses>;
};

type Read = { source: Source; line: string; offset: number };
type Uses = { read: boolean; display: boolean; paths: boolean };

const LOOK_BACK_CHARS = 200;
const MAX_READS_SHOWN = 5;
const SELECT_VALUE =
  /<[A-Za-z.]*[sS]elect\b[^<]*?\bvalue=\{([\w$.]+)\}[^<]*>(?:(?!<\/[A-Za-z.]*[sS]elect)[\s\S])*$/;
const FUNCTION_LOOK_BACK_CHARS = 2_000;
const RETURN_BEFORE = /\breturn\s*$/;
const FUNCTION_HEAD =
  /\b(?:def|function)\s+([\w$]+)|^[ \t]*(?:(?:public|private|protected|static|async|override)\s+)*(?!(?:if|for|while|switch|catch|return)\b)([\w$]+)\s*\([^)\n]*\)\s*(?::[^{\n]+)?\{\s*$/gm;
const MAX_HOPS = 2;
const MAX_ANCESTORS = 4;
// Past this a line is data, and the patterns below get slow on it.
const MAX_LINE_CHARS = 1_000;
const MIN_LOCAL_IMPORTS = 3;
const DATA_MODE = 'json';
const JS_MODE = 'js';
const PYTHON_MODE = 'python';

const MODIFIERS =
  '(?:(?:export|default|public|private|protected|static|abstract|async|readonly|override|declare|const|let|var)\\s+|self\\.|this\\.)*';
const DISPLAY_SINK =
  /\b(?:console\.\w+|print|pprint|printf|puts|echo|logger\.\w+|logging\.\w+|log\.\w+|render_template|res\.render|st\.(?:write|markdown|text|caption|info))\s*\(/;
const PATH_SINK =
  /\+\s*["'`][/\\]["'`]\s*\+|\b(?:read_csv|read_json|read_excel|read_parquet|to_csv|to_json|open|Path|makedirs|mkdir|os\.path\.\w+)\s*\(|\.(?:csv|jsonl?|tsv|pkl|xlsx?|parquet|npy)\b/;
const IMPORT_STAR = /\bimport\s+\*/;
const PYTHON_IMPORT_LINE = /^\s*(?:from\s+\S+\s+)?import\s/m;
const PYTHON_DEF_LINE = /^(\s*)(?:async\s+)?def\s+\w+\s*\(([^)]*)\)?/;
const PYTHON_SCOPE_LINE = /^\s*(?:async\s+def|def|class)\b/;
const DEF_BEFORE = /\b(?:def|function)\s*[\w$]*\s*$/;
const ASSIGNED_WITH_EQUALS = /(?:^|[^\w$.])((?:self\.|this\.)?[\w$]+)\s*(?::[^=\n,]*)?=\s*$/;
const LOCAL_DECLARATION = /^\s*(?:const|let|var)\s/;
const JS_EXPORTED = /^\s*export\b/;
const CONSTRUCTED =
  /([\w$.]+)\s*(?::[^=\n]*)?=\s*(?:await\s+)?(?:new\s+[\w$.]+|(?:[\w$]+\.)*[A-Z][\w$]*)\s*$/;
const CALLEE = /(?:^|[^\w$.])([A-Za-z_][\w]*)\s*$/;
const KEY_BEFORE = /(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*:\s*$/;
const PYTHON_NAMES =
  /^(?:and|assert|await|elif|if|in|is|lambda|not|or|return|yield|while|abs|all|any|bool|bytes|callable|dict|enumerate|exit|filter|float|format|frozenset|getattr|hasattr|input|int|isinstance|issubclass|iter|len|list|map|max|min|next|object|open|print|range|repr|reversed|round|set|setattr|sorted|str|sum|super|tuple|type|vars|zip)$/;
const LOCAL_IMPORT = /\bfrom\s+["'](?:\.{1,2}\/|[@~]\/)|\brequire\(\s*["']\.{1,2}\//;
// Names and folders a framework or a runner starts on its own, so nothing has to import them.
const ENTRY_NAME =
  /^(?:index|main|app|server|cli|route|page|layout|loading|error|handler|worker|middleware|proxy|background|content|popup|preload|sw|service-worker|\w+\.config)$/;
const ENTRY_FOLDER =
  /(?:^|\/)(?:app|pages|api|functions|routes|scripts?|bin|cli|tools|commands|lambdas?|handlers|workers|jobs|migrations|plugins|bench|benchmarks)\//;

const isComment = (source: Source, offset: number) =>
  spanAt(source.spans, offset)?.kind === 'comment';

const lineAt = (source: Source, offset: number) =>
  source.lines[lineIndexAt(source, offset)].slice(0, MAX_LINE_CHARS);

function isDefinition(line: string, word: string): boolean {
  const name = escapeRegex(word);
  return new RegExp(
    `^\\s*(?:(?:export\\s+|default\\s+|async\\s+)*(?:def|function\\*?)\\s+${name}(?![\\w$])` +
      `|${MODIFIERS}${name}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{\\s*$` +
      `|${MODIFIERS}${name}\\s*\\([^)]*\\)\\s*:[^={]+;?\\s*$` +
      `|${MODIFIERS}["']?${name}["']?\\??\\s*:` +
      `|${MODIFIERS}${name}\\s*(?::[^=\\n]*)?=(?!=))`,
  ).test(line);
}

// A name passed down as `def f(client):` is that function's own, whatever the file holds under it.
function shadowedLines(source: Source, word: string): Set<number> {
  const shadowed = new Set<number>();
  if (source.mode !== PYTHON_MODE) return shadowed;
  const taken = new RegExp(`(?<![\\w$])${escapeRegex(word)}(?![\\w$])`);
  let indent: number | undefined;
  source.lines.forEach((line, index) => {
    if (!line.trim()) return;
    const depth = line.length - line.trimStart().length;
    if (indent !== undefined && depth > indent) shadowed.add(index);
    else indent = undefined;
    const def = PYTHON_DEF_LINE.exec(line);
    if (def && taken.test(def[2])) {
      indent = depth;
      shadowed.add(index);
    }
  });
  return shadowed;
}

function readsIn(readers: Readers, source: Source, word: string): Read[] {
  const key = `${source.file}|${word}`;
  const known = readers.reads.get(key);
  if (known) return known;
  const shadowed = shadowedLines(source, word);
  const reads: Read[] = [];
  // Data files hold values, not code that reads one.
  const matches = source.mode === DATA_MODE ? [] : source.text.matchAll(wordPattern(word));
  for (const match of matches) {
    if (isComment(source, match.index)) continue;
    const line = lineAt(source, match.index);
    if (shadowed.has(lineIndexAt(source, match.index)) || isDefinition(line, word)) continue;
    reads.push({ source, line, offset: match.index });
  }
  readers.reads.set(key, reads);
  return reads;
}

function packageOf(readers: Readers, file: string): Source[] {
  const folders = readers.manifests
    .map((manifest) => path.posix.dirname(manifest.file))
    .filter((folder) => folder === '.' || file.startsWith(`${folder}/`))
    .sort((a, b) => b.length - a.length);
  const folder = folders[0] ?? '.';
  return readers.sources.filter((source) => folder === '.' || source.file.startsWith(`${folder}/`));
}

function holderOf(line: string, word: string): string | undefined {
  const at = line.search(wordPattern(word));
  const holder =
    /(?:^|[\s{,(])(?:self\.|this\.)?([\w$]+)["']?\??\s*(?::[^=,]*?)?[:=](?!=)[^,;]*$/.exec(
      line.slice(0, at),
    )?.[1];
  return holder === word ? undefined : holder;
}

// Where a value goes, following what holds it for a couple of steps. Any read that isn't plainly
// a display or a local path counts against it, so an unknown use keeps the match as it was.
function usesOf(
  readers: Readers,
  scope: Source[],
  word: string,
  hops: number,
  seen: Set<string> = new Set([word]),
): Uses {
  const key = `${scope.length === 1 ? scope[0].file : `package of ${scope[0]?.file}`}|${word}|${hops}`;
  const known = readers.uses.get(key);
  if (known) return known;
  const uses: Uses = { read: false, display: true, paths: true };
  for (const source of scope) {
    for (const read of readsIn(readers, source, word)) {
      uses.read = true;
      if (DISPLAY_SINK.test(read.line)) {
        uses.paths = false;
      } else if (PATH_SINK.test(read.line)) {
        uses.display = false;
      } else {
        const holder = holderOf(read.line, word);
        const next = holder && hops > 0 && !seen.has(holder) ? holder : undefined;
        const onward = next
          ? usesOf(readers, scope, next, hops - 1, new Set([...seen, next]))
          : undefined;
        // A holder nothing reads says nothing about where the value goes.
        uses.display &&= Boolean(onward?.read && onward.display);
        uses.paths &&= Boolean(onward?.read && onward.paths);
      }
      if (!uses.display && !uses.paths) break;
    }
    if (!uses.display && !uses.paths) break;
  }
  readers.uses.set(key, uses);
  return uses;
}

function placeOfDeclaration(source: Source, offset: number): 'local' | 'exported' | 'member' {
  const line = lineAt(source, offset);
  if (source.mode === PYTHON_MODE) {
    const depth = line.length - line.trimStart().length;
    if (depth === 0) return 'member';
    for (let index = lineIndexAt(source, offset) - 1; index >= 0; index -= 1) {
      const above = source.lines[index];
      if (!above.trim() || above.length - above.trimStart().length >= depth) continue;
      if (PYTHON_SCOPE_LINE.test(above)) return /^\s*class\b/.test(above) ? 'member' : 'local';
    }
    return 'member';
  }
  if (JS_EXPORTED.test(line)) return 'exported';
  return LOCAL_DECLARATION.test(line) ? 'local' : 'member';
}

// Whether another file can pick up a name: `.name`, an import of it, or everything a module has.
function readElsewhere(readers: Readers, source: Source, word: string, exported: boolean): boolean {
  const name = escapeRegex(word);
  const pattern = exported
    ? wordPattern(word)
    : new RegExp(`\\.${name}(?![\\w$])|\\bimport\\b[^\\n]*(?<![\\w$])${name}(?![\\w$])`);
  return packageOf(readers, source.file).some(
    (other) =>
      other !== source &&
      (IMPORT_STAR.test(other.text) || new RegExp(pattern.source).test(other.text)),
  );
}

function assignedReach(
  readers: Readers,
  source: Source,
  span: Span,
  namesProvider: boolean,
): Reach | undefined {
  const { code } = source;
  const around = enclosing(code, span.start);
  if (around?.char === '[') return undefined;
  if (around?.char === '(' && !DEF_BEFORE.test(code.slice(0, around.open))) return undefined;
  const ahead = code.slice(Math.max(0, span.start - LOOK_BACK_CHARS), span.start);
  const assigned = ASSIGNED_WITH_EQUALS.exec(ahead)?.[1];
  if (!assigned) return undefined;
  const word = assigned.replace(/^(?:self|this)\./, '');
  const where = placeOfDeclaration(source, span.start);
  if (where !== 'local' && readElsewhere(readers, source, word, where === 'exported')) {
    return undefined;
  }
  const uses = usesOf(readers, [source], word, MAX_HOPS);
  // No read at all says nothing either way: a config value can be picked up in ways a word search misses.
  if (!uses.read) return undefined;
  if (uses.display) {
    return { kind: 'catalog', reason: `${word} is only shown or logged, never sent` };
  }
  return uses.paths && !namesProvider
    ? {
        kind: 'catalog',
        reason: `${word} only labels a local path, in a file that never names the provider`,
      }
    : undefined;
}

function constructedReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  let at = offset;
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    if (open.char === '(') {
      const ahead = source.code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open);
      const word = CONSTRUCTED.exec(ahead)?.[1]?.split('.').at(-1);
      if (!word) return undefined;
      const where = placeOfDeclaration(source, open.open);
      const elsewhere =
        where !== 'local' && readElsewhere(readers, source, word, where === 'exported');
      // Only a parameter of the same name reads it, which is the code's own sign the client goes unused.
      const unused =
        shadowedLines(source, word).size > 0 && readsIn(readers, source, word).length === 0;
      return !elsewhere && unused
        ? { kind: 'catalog', reason: `set on ${word}, a client nothing uses` }
        : undefined;
    }
    at = open.open;
  }
  return undefined;
}

// The function or method a `return [` belongs to, when the list goes back to whoever called it.
function returnedBy(source: Source, open: number): string | undefined {
  const ahead = source.code.slice(Math.max(0, open - FUNCTION_LOOK_BACK_CHARS), open);
  if (!RETURN_BEFORE.test(ahead)) return undefined;
  return [...ahead.matchAll(FUNCTION_HEAD)].at(-1)?.slice(1).find(Boolean);
}

function listReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  const list = enclosing(source.code, offset);
  if (list?.char !== '[' && list?.char !== '(') return undefined;
  // A list handed straight to a call goes wherever that call sends it.
  if (enclosing(source.code, list.open)?.char === '(') return undefined;
  const word = returnedBy(source, list.open) ?? listName(source, list).split('.').at(-1);
  if (!word) return undefined;
  const uses = usesOf(readers, packageOf(readers, source.file), word, MAX_HOPS);
  return uses.read && uses.display
    ? { kind: 'catalog', reason: `the list ${word} is only shown or logged, never sent` }
    : undefined;
}

function unreadOwnerReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  let at = offset;
  const scope = packageOf(readers, source.file);
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    const key = KEY_BEFORE.exec(
      source.code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open),
    )?.[1];
    if (level > 0 && key && !scope.some((one) => readsIn(readers, one, key).length > 0)) {
      return { kind: 'catalog', reason: `an option under ${key}, which nothing here reads` };
    }
    at = open.open;
  }
  return undefined;
}

function unresolvedCall(source: Source, offset: number): Reach | undefined {
  if (source.mode !== PYTHON_MODE) return undefined;
  const open = enclosing(source.code, offset);
  if (open?.char !== '(') return undefined;
  const callee = CALLEE.exec(
    source.code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open),
  )?.[1];
  if (!callee || PYTHON_NAMES.test(callee) || IMPORT_STAR.test(source.text)) return undefined;
  // A snippet with no imports isn't a module anyone runs as it stands, so its gaps say nothing.
  if (!PYTHON_IMPORT_LINE.test(source.text)) return undefined;
  const name = escapeRegex(callee);
  const defined = new RegExp(
    `^\\s*(?:(?:async\\s+)?def\\s+${name}\\b|class\\s+${name}\\b|${name}\\s*(?::[^=\\n]*)?=(?!=))|\\bimport\\b[^\\n]*\\b${name}\\b|^\\s*${name}\\s*,?\\s*$|\\bfor\\s+[^\\n]*\\b${name}\\b[^\\n]*\\bin\\b|\\bwith\\b[^\\n]*\\bas\\s+${name}\\b`,
    'm',
  );
  return defined.test(source.text)
    ? undefined
    : {
        kind: 'unclear',
        reason: `an argument to ${callee}, which this file never defines or imports, so the call may fail before it sends anything`,
      };
}

// Only with a graph to read: a lone script or a short excerpt has no imports to be missing from.
function isOrphan(readers: Readers, source: Source): boolean {
  const known = readers.orphans.get(source.file);
  if (known !== undefined) return known;
  const name = path.posix.basename(source.file).replace(/\.[^.]+$/, '');
  const inFolder = source.file.includes('/');
  const candidate =
    source.mode === JS_MODE &&
    inFolder &&
    !ENTRY_NAME.test(name) &&
    !ENTRY_FOLDER.test(source.file) &&
    readers.sources.filter((one) => LOCAL_IMPORT.test(one.text)).length >= MIN_LOCAL_IMPORTS &&
    !readers.sources.some((one) => one !== source && one.text.includes(name));
  readers.orphans.set(source.file, candidate);
  return candidate;
}

/** Where the code reads what holds a list or a picked option, for the AI check to follow. */
export function holderReads(readers: Readers, source: Source, offset: number): string[] {
  const list = enclosing(source.code, offset);
  const picked = SELECT_VALUE.exec(
    source.text.slice(Math.max(0, offset - FUNCTION_LOOK_BACK_CHARS), offset),
  )?.[1];
  const word =
    picked?.split('.').at(-1) ??
    (list && (returnedBy(source, list.open) ?? listName(source, list).split('.').at(-1)));
  if (!word) return [];
  const scope = picked ? [source] : packageOf(readers, source.file);
  return scope
    .flatMap((one) => readsIn(readers, one, word))
    .slice(0, MAX_READS_SHOWN)
    .map(
      (read) =>
        `${read.source.file}:${reportedLine(read.source, lineIndexAt(read.source, read.offset))}: ${read.line.trim()}`,
    );
}

export type ReachInput = {
  source: Source;
  offset: number;
  span?: Span;
  picker: boolean;
  fileNamesProvider: boolean;
};

/** Why this match never reaches the API, or undefined when nothing here shows that. */
export function reachOf(readers: Readers, input: ReachInput): Reach | undefined {
  const { source, offset, span, picker, fileNamesProvider } = input;
  if (isOrphan(readers, source)) {
    return {
      kind: 'unclear',
      reason: 'no other file in this repo names this module, so it may be left over from a rewrite',
    };
  }
  if (span?.kind !== 'string') return undefined;
  return (
    unresolvedCall(source, offset) ??
    assignedReach(readers, source, span, fileNamesProvider) ??
    constructedReach(readers, source, offset) ??
    listReach(readers, source, offset) ??
    (picker ? unreadOwnerReach(readers, source, offset) : undefined)
  );
}

// Whether a match can reach the API at all, from what the code does with it afterwards. Anything these
// rules can't settle stays as it was: they only speak up when the code plainly shows the value stops here.
import path from 'node:path';
import { escapeRegex } from '../dead-apis/match.ts';
import {
  innerText,
  lineIndexAt,
  reportedLine,
  spanAt,
  type Source,
  type Span,
} from './dead-scan-lex.ts';
import { closeOf, enclosing, listName, wordPattern } from './dead-scan-place.ts';
import type { Manifest } from './scanners.ts';

export type Reach = { kind: 'catalog' | 'unclear'; reason: string; reads?: string[] };

export type Readers = {
  /** Files that can read a value: written code and config, no tests, docs or build output. */
  sources: Source[];
  manifests: Manifest[];
  /** Modules nothing that runs imports, worked out once a hit asks. */
  orphans?: Set<string>;
  /** Reads of a word in a file, since a package's hits ask about the same few names. */
  reads: Map<string, Read[]>;
  uses: Map<string, Uses>;
  /** Next.js API routes as path segments, worked out once a hit asks. */
  routes?: string[][];
};

type Read = { source: Source; line: string; offset: number };
type Uses = { read: boolean; display: boolean; paths: boolean };

const LOOK_BACK_CHARS = 200;
const MAX_READS_SHOWN = 5;
const SELECT_VALUE =
  /<[A-Za-z.]*[sS]elect\b[^<]*?\bvalue=\{([\w$.]+)\}[^<]*>(?:(?!<\/[A-Za-z.]*[sS]elect)[\s\S])*$/;
// A controlled input's value only says what it shows. What's sent is what its change handler stored.
const CONTROLLED_VALUE =
  /<([A-Za-z.]*(?:[sS]elect|[iI]nput|[cC]ombobox|[tT]extarea|[rR]adioGroup)[A-Za-z.]*)\b[^<]*?\bvalue=$/;
const HIDDEN_INPUT = /\btype=["']hidden["']/;
const NAME_KEY_BEFORE = /(?:^|[\s{,])["']?name["']?\s*:\s*$/;
const ID_KEY = /(?:^|[\s{,])["']?id["']?\s*:/;
const LOCAL_NAMED_IMPORT =
  /\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s+["']((?:\.{1,2}\/|[@~]\/)[^"']+)["']/g;
// A barrel passes a name on with `export { X } from './y'`, so an import can reach its module through one.
const LOCAL_NAMED_REEXPORT =
  /\bexport\s+\{([^}]*)\}\s*from\s+["']((?:\.{1,2}\/|[@~]\/)[^"']+)["']/g;
const IMPORT_ALIAS = /\s+as\s+/;
const LINE_COMMENT = /\/\/[^\n]*/g;
const PICKER_PROP = /[\w-]+=\{\s*$/;
const MAPPED_AFTER = /^\s*\??\.map\s*\(/;
const WALKED_BEFORE = /\bObject\.(?:entries|values)\(\s*$/;
const WALKED_AFTER = /^\s*\)\s*\??\.(?:map|flatMap)\s*\(/;
const PICKER_SIGN = /\bon(?:Click|Select|ValueChange|Change)\b|<(?:option|SelectItem|MenuItem)\b/;
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
const PYTHON_BARE_IMPORT = /^[ \t]*(?:import|from)[ \t]+(\w+)/gm;
const PYTHON_FROM_IMPORT = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
const PYTHON_RELATIVE_IMPORT = /^[ \t]*from[ \t]+\./m;
const PAIR_MENTION = /(?=\b([\w-]+)[./]([\w-]+))/g;
// A URL or a media type has slashes, and no module's path: cdn.x/libs/pdf.js, application/pdf.
const NOT_A_PATH =
  /\b(?:https?|wss?):\/\/[^\s'"`<>)]+|\b(?:application|image|text|audio|video)\/[\w.+-]+/g;
const PATH_MENTION = /\/([\w$.-]+)/g;
const JS_BARE_IMPORT = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)["'`]([\w$.-]+)["'`]/g;
const SCRIPT_TAG_FILE = /["'`]([\w$.-]+\.(?:m?js|cjs|tsx?|jsx))["'`]/g;
const EXTENSION = /\.[^.]+$/;
// Code that loads a folder's modules by listing them, so none of them has to be imported by name.
const DYNAMIC_LOAD =
  /\b(?:importlib|__import__|pkgutil|iter_modules|readdirSync|readdir|require\.context|import\.meta\.glob|glob)\b/;
// A Python module a framework loads by its name, as the ENTRY_NAME list does for JS.
const PYTHON_ENTRY_NAME =
  /^(?:__main__|manage|wsgi|asgi|settings|urls|views|models|admin|apps|tasks|signals|serializers|forms|setup|celery|run|train|bot)$/;
const PYTHON_MAIN_GUARD = /^if\s+__name__\s*==/m;
const PYTHON_TOP_LEVEL_CALL = /^[A-Za-z_][\w.]*\s*\(/m;
const PYTHON_NOTEBOOK = '.ipynb';
const PYTHON_INIT = '__init__';
// Past this a file is data. Nothing that size imports a module by a name a scan could read.
const MAX_GRAPH_CHARS = 2_000_000;
const STAR_ARGUMENT = /^\s*\*/;
const DEFINING_HEAD =
  /(?:\b(?:def|function\*?)\s+([\w$]+)|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?)\s*$/;
const PARAMETER_DEFAULT = /(?:^|,)\s*(?:\.\.\.)?([\w$]+)\s*(?::[^=,]*)?=\s*["'`]?$/;
const SELF_PARAMETER = /^\s*(?:self|cls)\s*(?:,|$)/;
const ANNOTATION_BEFORE = /(?:\w\s*:|->|\|)\s*$/;
const IMPORT_LINE = /^\s*(?:from\s|import\s)/;
const IMPORT_OPEN = /\bimport\s*$/;
const CLASS_LINE = /^\s*class\s+(\w+)/;
const INIT_METHOD = '__init__';
const TOP_LEVEL_DEF = /^(?:async\s+)?(?:def|function\*?)\s+([\w$]+)/;
const TOP_LEVEL_CALL = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
const DECORATOR_LINE = /^\s*@/;
const IMPORT_AS = /^[ \t]*import[ \t]+([\w.]+)[ \t]+as[ \t]+(\w+)[ \t]*(?:#.*)?$/gm;
const MODEL_WORD = /\bmodel\b/;
const MEMBER_CALL = /(?:^|[^\w$.])([\w$]+)(?:\??\.[\w$]+)*\??\.([\w$]+)\s*$/;
const LOCAL_SPECIFIER = /^(?:\.{1,2}\/|[@~]\/)/;
const RELATIVE_CODE_IMPORT = /(?:\bfrom\s+|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
// With an extension that isn't code, such as ./x.css or ./data.json, which the scan may not read.
const NON_CODE_IMPORT = /\.(?!m?[jt]sx?["']?$|cjs$)\w+$/;
const CODE_EXTENSION = /\.[cm]?[jt]sx?$/;
const SPECIFIER_PREFIX = /^(?:(?:\.{1,2}|[@~])\/)+/;
// Names and folders a framework or a runner starts on its own, so nothing has to import them.
const ENTRY_NAME =
  /^(?:index|main|app|server|cli|route|page|layout|loading|error|handler|worker|middleware|proxy|background|content|popup|preload|sw|service-worker|\w+\.config)$/;
// `app bkp1.py`, `app_old.py`, `app - Copy.py`: the part before the mark names the original.
const BACKUP_NAME = /^(.+?)[\s._-]+(?:bkp|bak|backup|old|orig|copy)(?:[\s._-]*\d+)?$/i;
// `settings.model || 'x'`: what's read off an object, with the property's name. An environment
// variable is unset all the time, so its fallback is what runs.
const FALLBACK_LEFT = /(?<![\w$.])([\w$]+(?:\??\.[\w$]+)*)\??\.([\w$]+)\s*(?:\|\||\?\?)\s*$/;
const ENVIRONMENT_ROOT = /^(?:process|import\.meta|Deno|Bun)\b|\benv$/;
const NAMED_IMPORT =
  /\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s+["'](\.{1,2}\/[^"']+)["']/g;
const IMPORT_SPEC_TYPE = /^type\s/;
const STAR_EXPORT = /\bexport\s*\*|\bmodule\.exports\s*=\s*require\b/;
const BOOKKEEPING_CALL =
  /^(?:save|store|record|log|track|insert|write|add|report|update|increment)\w*(?:usage|cost|spend|tokens?|billing|telemetry|analytics|metrics?)$/i;
const CALL_WORD = /([\w$]+)\s*$/;
const FETCH_CALL = /(?<![\w$.])fetch\s*$/;
const OWN_API_PATH = /^\s*["'`](\/api\/[^"'`?#]*)/;
const APP_ROUTE = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/;
const PAGES_ROUTE = /(?:^|\/)pages\/(api\/.*?)(?:\/index)?\.[cm]?[jt]sx?$/;
const ROUTE_GROUP = /^\(.*\)$/;
const CATCH_ALL = /^\[\[?\.\.\./;
const DYNAMIC_SEGMENT = /^\[.*\]$/;
const NEXT_CONFIG = /(?:^|\/)next\.config\.\w+$/;
const REWRITES = /\brewrites\b/;
const PACKAGING_FILE = /(?:^|\/)(?:setup\.py|pyproject\.toml)$/;
const JS_PATH_STRING = /["'`]([\w$@~./-]*\/[\w$.-]+)["'`]/g;
// A returned object often goes to a framework that calls its members by name, as a Vite plugin does.
const OBJECT_OR_PLAIN_CLASS = /(?:(?<![=!<>])=|\bclass\s+[\w$]+)\s*$/;
const ARROW_MEMBER =
  /(?:^|[\s{,])([\w$]+)\s*:\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*(?::[^=\n]+)?=>\s*$/;
const METHOD_MEMBER =
  /(?:^|[\s{,])(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return)\b)([\w$]+)\s*\([^()]*\)\s*(?::[^\n]+)?$/;
const ARROW_CONST =
  /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*(?::[^=\n]+)?=>\s*$/;
const TRAILING_CALLEE = /[\w$.]+\s*$/;
// A Convex function runs when a client names it, so one nobody names is left over.
const CONVEX_FILE = /(?:^|\/)convex\//;
const CONVEX_FUNCTION =
  /^export\s+const\s+([\w$]+)\s*=\s*(?:internal)?(?:action|mutation|query)\s*\(/i;
const MEMBER_ACCESS_AFTER = /^\s*\??\.[\w$]/;
const NOT_A_VALUE_READ = /\btypeof\b|\bimport\s*\(|\brequire\s*\(/;
const OBJECT_ASSIGNED = /([\w$]+)\s*(?::[^=\n]*)?=\s*$/;
const GUARD_OPEN = /\bif\s*\(\s*([\w$]+)\s*\)\s*$/;
const MAX_GUARD_WALK = 12;
// In a Next.js app folder only these names are served: anything else there runs once it's imported.
const NEXT_APP_FOLDER = /^(?:src\/)?app\//;
const NEXT_SERVED_NAME =
  /^(?:template|default|global-error|not-found|forbidden|unauthorized|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)$/;
const NEXT_PACKAGE = 'next';
const NOT_A_FUNCTION = /^(?:if|for|while|switch|catch|return|elif|with)$/;
const BODY_OPENS_LINE = /^[^\n;]*?(?:=>\s*)?\{[ \t]*(?:\n|$)/;
const USES_ALL_ARGUMENTS = /\b(?:arguments|locals|eval)\b/;
const PYTHON_ENUM_CLASS = /^\s*class\s+(\w+)\s*\([^)]*\b\w*Enum\b[^)]*\)\s*:/;
const CLASS_NAME_BEFORE = /\bclass\s+([\w$]+)\s*$/;
const RECEIVER_BEFORE = /([\w$]+)\??\.\s*$/;
const INSIDE_A_CALL = /[(,]\s*$/;
const STATEMENT_START = /^[^\s})\]]/;
const ENTRY_FOLDER =
  /(?:^|\/)(?:app|pages|api|functions|routes|scripts?|bin|cli|tools|commands|lambdas?|handlers|workers|jobs|migrations|plugins|bench|benchmarks|convex|prisma)\//;

const isComment = (source: Source, offset: number) =>
  spanAt(source.spans, offset)?.kind === 'comment';

const lineAt = (source: Source, offset: number) =>
  source.lines[lineIndexAt(source, offset)].slice(0, MAX_LINE_CHARS);

function lastLineBefore(source: Source, offset: number, wanted: (line: string) => boolean) {
  for (let index = lineIndexAt(source, offset) - 1; index >= 0; index -= 1) {
    if (wanted(source.lines[index])) return source.lines[index];
  }
  return undefined;
}

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

function packageFolder(readers: Readers, file: string): string {
  const folders = readers.manifests
    .map((manifest) => path.posix.dirname(manifest.file))
    .filter((folder) => folder === '.' || file.startsWith(`${folder}/`))
    .sort((a, b) => b.length - a.length);
  return folders[0] ?? '.';
}

function packageOf(readers: Readers, file: string): Source[] {
  const folder = packageFolder(readers, file);
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

const folderOf = (file: string) => path.posix.dirname(file);
const lastFolder = (file: string) => path.posix.basename(folderOf(file));
const moduleName = (file: string) => path.posix.basename(file).replace(EXTENSION, '');
const isPythonModule = (source: Source) =>
  source.mode === PYTHON_MODE && !source.file.endsWith(PYTHON_NOTEBOOK);

function pythonFromImports(source: Source, mentions: Set<string>): void {
  for (const [, dots, module, names] of source.text.matchAll(PYTHON_FROM_IMPORT)) {
    let base = folderOf(source.file);
    for (let up = 1; up < dots.length; up += 1) base = folderOf(base);
    const from = module ? module.split('.').at(-1) : path.posix.basename(base);
    if (dots && module) mentions.add(`${path.posix.basename(base)}/${module.split('.')[0]}`);
    for (const one of names.replace(/[()]/g, '').split(',')) {
      const name = one.trim().split(/\s/)[0];
      if (name) mentions.add(`${from}/${name}`);
    }
  }
}

// What a file names that could be a module: `f/n` for Python's folder and module, `/n` for a JS path's
// tail, and `bare/n` for an import with no path, which a local module or a package can answer.
function mentionsOf(source: Source): Set<string> {
  const mentions = new Set<string>();
  if (source.text.length > MAX_GRAPH_CHARS) return mentions;
  for (const [, folder, name] of source.text.matchAll(PAIR_MENTION)) {
    mentions.add(`${folder}/${name}`);
  }
  for (const [, tail] of source.text.replace(NOT_A_PATH, '').matchAll(PATH_MENTION)) {
    mentions.add(`/${tail}`);
    mentions.add(`/${tail.replace(EXTENSION, '')}`);
  }
  if (isPythonModule(source)) {
    pythonFromImports(source, mentions);
    for (const [, name] of source.text.matchAll(PYTHON_BARE_IMPORT)) mentions.add(`bare/${name}`);
  } else {
    for (const [, name] of source.text.matchAll(JS_BARE_IMPORT)) mentions.add(`bare/${name}`);
    for (const [, name] of source.text.matchAll(SCRIPT_TAG_FILE)) {
      mentions.add(`/${name.replace(EXTENSION, '')}`);
    }
    for (const [, written] of source.text.matchAll(JS_PATH_STRING)) {
      const code = written.replace(CODE_EXTENSION, '');
      mentions.add(
        written.startsWith('.')
          ? `whole/${path.posix.join(folderOf(source.file), code)}`
          : `tail/${code.replace(SPECIFIER_PREFIX, '')}`,
      );
    }
  }
  return mentions;
}

const normalName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function isDependency(readers: Readers, name: string): boolean {
  return readers.manifests.some((manifest) =>
    manifest.dependencies.some((one) => normalName(one.name) === normalName(name)),
  );
}

// Another module of the same name means a path's tail can't say which one an import means.
function namesTwin(mentions: Set<string>, target: Source): boolean {
  const bare = target.file.replace(EXTENSION, '');
  return [...mentions].some(
    (one) =>
      one === `whole/${bare}` ||
      (one.startsWith('tail/') && `/${bare}`.endsWith(`/${one.slice('tail/'.length)}`)),
  );
}

function namesModule(readers: Readers, mentions: Set<string>, target: Source): boolean {
  const name = moduleName(target.file);
  const named = isPythonModule(target) ? `${lastFolder(target.file)}/${name}` : `/${name}`;
  if (mentions.has(`bare/${name}`) && !isDependency(readers, name)) return true;
  if (!mentions.has(named)) return false;
  const twin =
    target.mode === JS_MODE &&
    readers.sources.some(
      (one) => one !== target && one.mode === JS_MODE && moduleName(one.file) === name,
    );
  return !twin || namesTwin(mentions, target);
}

// A main guard says a module can be started by hand, unless its folder is plainly a library: one whose
// modules import each other, where the guard is a debug block.
function isLibraryFolder(
  source: Source,
  python: Source[],
  mentionsFor: (one: Source) => Set<string>,
  readers: Readers,
): boolean {
  const folder = folderOf(source.file);
  const siblings = python.filter((one) => folderOf(one.file) === folder);
  return siblings.some((one) =>
    siblings.some((other) => other !== one && namesModule(readers, mentionsFor(one), other)),
  );
}

// The folder as a path or module part. A short name such as `ai` turns up inside any other word.
const folderMention = (folder: string) => new RegExp(`["'\`/.]${escapeRegex(folder)}["'\`/.]`);

function inNextAppFolder(readers: Readers, file: string): boolean {
  const folder = packageFolder(readers, file);
  const inside = folder === '.' ? file : file.slice(folder.length + 1);
  return (
    NEXT_APP_FOLDER.test(inside) &&
    readers.manifests.some(
      (manifest) =>
        path.posix.dirname(manifest.file) === folder &&
        manifest.dependencies.some((one) => one.name === NEXT_PACKAGE),
    )
  );
}

function isImportedModule(readers: Readers, source: Source): boolean {
  const name = moduleName(source.file);
  if (source.mode === JS_MODE && inNextAppFolder(readers, source.file)) {
    return !ENTRY_NAME.test(name) && !NEXT_SERVED_NAME.test(name);
  }
  if (!source.file.includes('/') || ENTRY_FOLDER.test(source.file)) return false;
  if (source.mode === JS_MODE) return !ENTRY_NAME.test(name);
  // A package's __init__ is what importers see from outside the repo, and top-level calls are a script.
  return (
    isPythonModule(source) &&
    !ENTRY_NAME.test(name) &&
    !PYTHON_ENTRY_NAME.test(name) &&
    name !== PYTHON_INIT &&
    !PYTHON_TOP_LEVEL_CALL.test(source.code)
  );
}

function hasGraph(readers: Readers, python: Source[]): { js: boolean; python: boolean } {
  const local = new Set(python.flatMap((one) => [moduleName(one.file), lastFolder(one.file)]));
  const importsLocal = (one: Source) =>
    PYTHON_RELATIVE_IMPORT.test(one.text) ||
    [...one.text.matchAll(PYTHON_BARE_IMPORT)].some(([, name]) => local.has(name));
  return {
    js:
      readers.sources.filter((one) => one.mode === JS_MODE && LOCAL_IMPORT.test(one.text)).length >=
      MIN_LOCAL_IMPORTS,
    python: python.filter(importsLocal).length >= MIN_LOCAL_IMPORTS,
  };
}

// A relative import of code that isn't in the repo stops the module at load.
function canLoad(readers: Readers, source: Source): boolean {
  return [...source.text.matchAll(RELATIVE_CODE_IMPORT)].every(
    ([, specifier]) =>
      NON_CODE_IMPORT.test(specifier) || localModule(readers, source, specifier) !== undefined,
  );
}

/**
 * The modules nothing that runs reaches. Everything that isn't a module waiting to be imported runs,
 * and each file it names runs too, so two left-over modules that import each other stay left over.
 * Only with a graph to read: a lone script or a short excerpt has no imports to be missing from.
 */
function orphansOf(readers: Readers): Set<string> {
  if (readers.orphans) return readers.orphans;
  const known = new Map<Source, Set<string>>();
  const mentionsFor = (one: Source) => {
    const held = known.get(one) ?? mentionsOf(one);
    known.set(one, held);
    return held;
  };
  const python = readers.sources.filter(isPythonModule);
  const graph = hasGraph(readers, python);
  const waiting = new Set(
    readers.sources.filter((one) => {
      if (!isImportedModule(readers, one) || !(one.mode === JS_MODE ? graph.js : graph.python)) {
        return false;
      }
      if (one.mode === JS_MODE) return true;
      return (
        !PYTHON_MAIN_GUARD.test(one.code) || isLibraryFolder(one, python, mentionsFor, readers)
      );
    }),
  );
  // A JS module nobody names may still be an entry a bundler starts, so what it imports counts, unless
  // it can't load. In Python a module with no start of its own only runs through its importers.
  const running = readers.sources.filter(
    (one) => !waiting.has(one) || (one.mode === JS_MODE && canLoad(readers, one)),
  );
  while (running.length > 0) {
    const one = running.pop() as Source;
    const mentions = mentionsFor(one);
    const loads = DYNAMIC_LOAD.test(one.text);
    for (const module of waiting) {
      if (module === one) continue;
      const loaded = loads && folderMention(lastFolder(module.file)).test(one.text);
      if (loaded || namesModule(readers, mentions, module)) {
        waiting.delete(module);
        running.push(module);
      }
    }
  }
  readers.orphans = new Set([...waiting].map((one) => one.file));
  return readers.orphans;
}

function callArguments(code: string, open: number): string[] {
  const close = closeOf(code, open);
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < close; at += 1) {
    const char = code[at];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(code.slice(start, at));
      start = at + 1;
    }
  }
  const last = code.slice(start, close);
  return last.trim() ? [...parts, last] : parts;
}

function classAbove(source: Source, offset: number): string | undefined {
  const depth = lineAt(source, offset).search(/\S/);
  for (let index = lineIndexAt(source, offset) - 1; index >= 0; index -= 1) {
    const above = source.lines[index];
    if (above.trim() && above.search(/\S/) < depth) return CLASS_LINE.exec(above)?.[1];
  }
  return undefined;
}

// Whether one read of a function is a call that hands it this parameter. A read that isn't a call,
// such as a reference or a string, can do anything, so it counts against.
function passesParameter(read: Read, word: string, parameter: string, index: number): boolean {
  const { source, offset } = read;
  const at = offset + word.length;
  const open = at + source.code.slice(at, at + LOOK_BACK_CHARS).search(/\S|$/);
  if (source.code[open] !== '(' || spanAt(source.spans, offset)) return false;
  const args = callArguments(source.code, open);
  if (args.some((arg) => new RegExp(`^\\s*${escapeRegex(parameter)}\\s*=(?!=)`).test(arg))) {
    return true;
  }
  const shown = args.slice(0, index + 1);
  return (
    shown.length > index && !shown.some((arg) => STAR_ARGUMENT.test(arg) || /^\s*\.\.\./.test(arg))
  );
}

// The name inside an error message, say: it calls nothing. A whole string can be a reference, as in
// getattr(x, "f"), and an f-string can hold a real call, so neither of those is passed over.
function isProseMention({ source, offset, line }: Read, word: string): boolean {
  const span = spanAt(source.spans, offset);
  if (span?.kind !== 'string' || innerText(source, span).trim() === word) return false;
  const at = line.search(wordPattern(word)) + word.length;
  return line[at] !== '(';
}

const isTypeAnnotation = ({ source, offset }: Read) =>
  ANNOTATION_BEFORE.test(source.code.slice(Math.max(0, offset - LOOK_BACK_CHARS), offset));

function isImportOf(read: Read): boolean {
  if (IMPORT_LINE.test(read.line) || CLASS_LINE.test(read.line)) return true;
  const around = enclosing(read.source.code, read.offset);
  return (
    around?.char === '(' &&
    IMPORT_OPEN.test(
      read.source.code.slice(Math.max(0, around.open - LOOK_BACK_CHARS), around.open),
    )
  );
}

/** A parameter's default, when every call in the repo passes that parameter, so it's never what's sent. */
function defaultReach(readers: Readers, source: Source, span: Span): Reach | undefined {
  const { code } = source;
  const open = enclosing(code, span.start);
  if (open?.char !== '(') return undefined;
  const head = DEFINING_HEAD.exec(code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open));
  const defined = head?.[1] ?? head?.[2];
  const parameters = code.slice(open.open + 1, span.start + 1);
  const parameter = PARAMETER_DEFAULT.exec(parameters)?.[1];
  if (!defined || !parameter || JS_EXPORTED.test(lineAt(source, open.open))) return undefined;
  const isInit = defined === INIT_METHOD;
  const word = isInit ? classAbove(source, open.open) : defined;
  if (!word) return undefined;
  const earlier = callArguments(
    `(${parameters.slice(0, parameters.lastIndexOf(parameter))})`,
    0,
  ).filter((part) => !SELF_PARAMETER.test(part));
  const orphans = orphansOf(readers);
  const definedHere = new RegExp(
    `(?:\\bdef\\s+|\\bfunction\\s+|\\bclass\\s+)${escapeRegex(word)}\\b`,
  );
  const callers = readers.sources.filter(
    (one) => one === source || !(orphans.has(one.file) || definedHere.test(one.text)),
  );
  const allReads = callers
    .flatMap((one) => readsIn(readers, one, word))
    .filter((read) => !isProseMention(read, word));
  const called = allReads.filter((read) => moduleName(read.source.file) !== PYTHON_INIT);
  const reads = called.filter((read) => !isImportOf(read) && !(isInit && isTypeAnnotation(read)));
  if (reads.length === 0) return undefined;
  // A package that re-exports a function offers it to callers this repo can't show, unless it's
  // an app's own folder: nothing publishes it, and its callers sit outside it.
  const offeredBy = allReads.find((read) => !called.includes(read));
  if (offeredBy) {
    const folder = `${folderOf(offeredBy.source.file)}/`;
    const published = readers.sources.some((one) => PACKAGING_FILE.test(one.file));
    if (published || reads.every((read) => read.source.file.startsWith(folder))) return undefined;
  }
  return reads.every((read) => passesParameter(read, word, parameter, earlier.length))
    ? {
        kind: 'catalog',
        reason: `the default of ${parameter}: every call of ${word} passes its own, so this one is never sent`,
      }
    : undefined;
}

function bodyOf(source: Source, closeParen: number, defLine: number): string | undefined {
  if (source.mode === PYTHON_MODE) {
    const depth = source.lines[defLine].search(/\S/);
    const after = lineIndexAt(source, closeParen) + 1;
    const end = source.lines.findIndex(
      (line, index) => index >= after && line.trim() !== '' && line.search(/\S/) <= depth,
    );
    return source.lines.slice(after, end === -1 ? undefined : end).join('\n');
  }
  const rest = source.code.slice(closeParen + 1);
  if (!BODY_OPENS_LINE.test(rest)) return undefined;
  const open = closeParen + 1 + rest.indexOf('\n') - 1;
  const brace = source.code.lastIndexOf('{', open);
  return source.text.slice(brace, closeOf(source.code, brace));
}

/** A parameter's default in a function whose body never reads that parameter, so it goes nowhere. */
function ignoredDefaultReach(source: Source, span: Span): Reach | undefined {
  const { code } = source;
  const open = enclosing(code, span.start);
  if (open?.char !== '(') return undefined;
  const callee = CALL_WORD.exec(code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open));
  if (!callee || NOT_A_FUNCTION.test(callee[1])) return undefined;
  const parameter = PARAMETER_DEFAULT.exec(code.slice(open.open + 1, span.start + 1))?.[1];
  if (!parameter) return undefined;
  if (source.mode === PYTHON_MODE) {
    if (!DEF_BEFORE.test(code.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open))) {
      return undefined;
    }
  } else if (source.mode !== JS_MODE) {
    return undefined;
  }
  const body = bodyOf(source, closeOf(code, open.open), lineIndexAt(source, open.open));
  // No lines under the def means a one-liner, whose body this can't see.
  if (!body?.trim() || USES_ALL_ARGUMENTS.test(body) || wordPattern(parameter).test(body)) {
    return undefined;
  }
  return {
    kind: 'catalog',
    reason: `the default of ${parameter}, which ${callee[1]} never reads, so it's never sent`,
  };
}

function enclosingTopLevelDef(source: Source, offset: number): string | undefined {
  const first = lineIndexAt(source, offset);
  for (let index = first; index >= 0; index -= 1) {
    const line = source.lines[index];
    if (!line.trim() || /^\s/.test(line)) continue;
    const name = TOP_LEVEL_DEF.exec(line)?.[1];
    return name && index !== first && !DECORATOR_LINE.test(source.lines[index - 1] ?? '')
      ? name
      : undefined;
  }
  return undefined;
}

/** A function nothing calls, in a script that shows what it does run. */
function uncalledReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  const name = enclosingTopLevelDef(source, offset);
  if (!name) return undefined;
  const called = [...source.code.matchAll(TOP_LEVEL_CALL)]
    .map((match) => match[1])
    .find(
      (one) =>
        one !== name &&
        new RegExp(`^(?:async\\s+)?(?:def|function\\*?)\\s+${escapeRegex(one)}\\b`, 'm').test(
          source.code,
        ),
    );
  const started = called ?? (PYTHON_MAIN_GUARD.test(source.code) ? 'its main guard' : undefined);
  if (!started || readers.sources.some((one) => readsIn(readers, one, name).length > 0)) {
    return undefined;
  }
  return {
    kind: 'unclear',
    reason: `inside ${name}, which nothing calls: this script starts from ${started}`,
  };
}

function backupReach(readers: Readers, source: Source): Reach | undefined {
  const stem = moduleName(source.file);
  const original = BACKUP_NAME.exec(stem)?.[1];
  if (!original) return undefined;
  const sibling = path.posix.join(
    folderOf(source.file),
    `${original}${path.posix.extname(source.file)}`,
  );
  const isCopy =
    readers.sources.some((one) => one.file === sibling) &&
    !readers.sources.some((one) => one !== source && one.text.includes(stem));
  return isCopy
    ? { kind: 'catalog', reason: `a backup copy of ${sibling} that nothing starts or imports` }
    : undefined;
}

/** A named import its module never mentions: the file fails to build, or throws once it's called. */
function brokenImportReach(readers: Readers, source: Source): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  for (const [, names, specifier] of source.text.matchAll(NAMED_IMPORT)) {
    const module = localModule(readers, source, specifier);
    if (!module || module === source || STAR_EXPORT.test(module.text)) continue;
    const missing = names
      .split(',')
      .map((one) => one.trim().split(/\s+as\s+/)[0])
      .find((one) => one && !IMPORT_SPEC_TYPE.test(one) && !wordPattern(one).test(module.text));
    if (missing) {
      return {
        kind: 'unclear',
        reason: `this file imports ${missing} from ${module.file}, which never names it, so the file may not build or load`,
      };
    }
  }
  return undefined;
}

/** A Python enum's value that a `case` turns into the id it sends: the enum only holds a label. */
function enumLabelReach(readers: Readers, source: Source, span: Span): Reach | undefined {
  if (source.mode !== PYTHON_MODE) return undefined;
  const depth = lineAt(source, span.start).search(/\S/);
  const owner = lastLineBefore(
    source,
    span.start,
    (line) => line.trim() !== '' && line.search(/\S/) < depth,
  );
  const name = owner && PYTHON_ENUM_CLASS.exec(owner)?.[1];
  if (!name) return undefined;
  const arm = new RegExp(
    `\\bcase\\s+["']${escapeRegex(innerText(source, span))}["']\\s*:\\s*[\\w$.]*model[\\w$.]*\\s*=(?!=)`,
    'i',
  );
  const mapper = packageOf(readers, source.file).find(
    (one) => one !== source && arm.test(one.text),
  );
  return mapper
    ? {
        kind: 'catalog',
        reason: `a label in the enum ${name}: ${mapper.file} maps it to the id it sends`,
      }
    : undefined;
}

/** A value handed to the app's own usage or cost record, which stays local. */
function bookkeepingReach(source: Source, offset: number): Reach | undefined {
  let at = offset;
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    at = open.open;
    if (open.char !== '(') continue;
    const word = CALL_WORD.exec(source.code.slice(Math.max(0, at - LOOK_BACK_CHARS), at))?.[1];
    if (word && BOOKKEEPING_CALL.test(word)) {
      return {
        kind: 'catalog',
        reason: `a copy kept by ${word}, the app's own record, never sent`,
      };
    }
  }
  return undefined;
}

/** The fallback in `<Select value={saved ?? 'x'}>`, which is only shown until someone picks. */
function controlledValueReach(source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  const open = enclosing(source.code, offset);
  if (open?.char !== '{') return undefined;
  const control = CONTROLLED_VALUE.exec(
    source.text.slice(Math.max(0, open.open - LOOK_BACK_CHARS), open.open),
  );
  return control && !HIDDEN_INPUT.test(control[0])
    ? {
        kind: 'catalog',
        reason: `only what ${control[1]} shows, and the picked value is what's kept`,
      }
    : undefined;
}

const namedSpecifiers = (names: string) =>
  names
    .replace(LINE_COMMENT, '')
    .split(',')
    .map((one) => one.trim().split(IMPORT_ALIAS) as [string, string?]);

function leadsTo(
  readers: Readers,
  module: Source | undefined,
  target: Source,
  name: string,
  hops = MAX_HOPS,
): boolean {
  if (!module || module === target) return module === target;
  if (hops === 0) return false;
  return [...module.text.matchAll(LOCAL_NAMED_REEXPORT)].some(
    ([, names, specifier]) =>
      namedSpecifiers(names).some(([original]) => original === name) &&
      leadsTo(readers, localModule(readers, module, specifier), target, name, hops - 1),
  );
}

function importedAs(readers: Readers, importer: Source, target: Source, name: string) {
  for (const match of importer.text.matchAll(LOCAL_NAMED_IMPORT)) {
    if (isComment(importer, match.index)) continue;
    const found = namedSpecifiers(match[1]).find(([original]) => original === name);
    if (found && leadsTo(readers, localModule(readers, importer, match[2]), target, name)) {
      return found[1] ?? name;
    }
  }
  return undefined;
}

// What a file gathers a list into, so it's offered under that name: MODEL_GROUPS = { free: FREE_MODELS }.
function gatheredInto(source: Source, name: string): string[] {
  const names = [...source.code.matchAll(wordPattern(name))].flatMap((match) => {
    const around = enclosing(source.code, match.index);
    if (around?.char !== '{' && around?.char !== '[') return [];
    return listName(source, around).split('.').at(-1) || [];
  });
  return [...new Set(names)].filter((one) => one !== name);
}

function offeredAs(readers: Readers, one: Source, target: Source, name: string) {
  const local = one === target ? name : importedAs(readers, one, target, name);
  if (!local || !PICKER_SIGN.test(one.text)) return undefined;
  return readsIn(readers, one, local).find((read) => {
    if (isImportOf(read)) return false;
    const ahead = one.code.slice(Math.max(0, read.offset - LOOK_BACK_CHARS), read.offset);
    const behind = one.code.slice(read.offset + local.length);
    return (
      PICKER_PROP.test(ahead) ||
      MAPPED_AFTER.test(behind) ||
      (WALKED_BEFORE.test(ahead) && WALKED_AFTER.test(behind))
    );
  })
    ? local
    : undefined;
}

/** Why a model record's list is what users pick from: a file with a handler maps it or passes it as a prop. */
export function recordPicker(readers: Readers, source: Source, offset: number): string | undefined {
  const record = enclosing(source.code, offset);
  const list = record && enclosing(source.code, record.open);
  if (!record || list?.char !== '[') return undefined;
  // Beside an id, a record's name is its label, whatever it spells.
  const key = source.code.slice(record.open, offset - 1);
  if (
    NAME_KEY_BEFORE.test(key) &&
    ID_KEY.test(source.code.slice(record.open, closeOf(source.code, record.open)))
  ) {
    return undefined;
  }
  const name = listName(source, list).split('.').at(-1);
  if (!name) return undefined;
  for (const held of [name, ...gatheredInto(source, name)]) {
    for (const one of packageOf(readers, source.file)) {
      const local = offeredAs(readers, one, source, held);
      if (local) return `a model record in ${name}, which ${one.file} offers to users as ${local}`;
    }
  }
  return undefined;
}

function routesOf(readers: Readers): string[][] {
  readers.routes ??= readers.sources.flatMap((one) => {
    const page = PAGES_ROUTE.exec(one.file)?.[1];
    const app = APP_ROUTE.exec(one.file)?.[1];
    const route = page ?? app;
    if (route === undefined) return [];
    const segments = route.split('/').filter((part) => part && !ROUTE_GROUP.test(part));
    return segments[0] === 'api' ? [segments] : [];
  });
  return readers.routes;
}

function routeServes(route: string[], wanted: string[]): boolean {
  return (
    route.every(
      (segment, index) =>
        CATCH_ALL.test(segment) ||
        (index < wanted.length &&
          (segment === wanted[index] ||
            DYNAMIC_SEGMENT.test(segment) ||
            wanted[index].includes('$'))),
    ) &&
    (route.length === wanted.length || CATCH_ALL.test(route.at(-1) ?? ''))
  );
}

/** A request to the app's own /api path that no route in the repo serves, so it never gets further. */
function missingRouteReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  let at = offset;
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    at = open.open;
    if (
      open.char !== '(' ||
      !FETCH_CALL.test(source.code.slice(Math.max(0, at - LOOK_BACK_CHARS), at))
    ) {
      continue;
    }
    const wanted = OWN_API_PATH.exec(source.text.slice(at + 1, at + LOOK_BACK_CHARS))?.[1];
    if (!wanted) return undefined;
    const routes = routesOf(readers);
    const rewritten = readers.sources.some(
      (one) => NEXT_CONFIG.test(one.file) && REWRITES.test(one.text),
    );
    const parts = wanted.split('/').filter(Boolean);
    if (routes.length === 0 || rewritten || routes.some((one) => routeServes(one, parts))) {
      return undefined;
    }
    return {
      kind: 'unclear',
      reason: `sent to ${wanted}, and no route in this repo serves that path, so it may never reach the provider`,
    };
  }
  return undefined;
}

/** A fallback whose left side is given its own default elsewhere, so it may never be empty. */
function fallbackReach(readers: Readers, source: Source, span: Span): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  const left = FALLBACK_LEFT.exec(
    source.code.slice(Math.max(0, span.start - LOOK_BACK_CHARS), span.start),
  );
  if (!left || ENVIRONMENT_ROOT.test(left[1])) return undefined;
  const property = escapeRegex(left[2]);
  const defaulted = new RegExp(
    `(?<![\\w$.])${property}["']?\\s*[:=](?!=)[^,;\\n]*(?:\\|\\||\\?\\?)\\s*["'\`][^"'\`]+["'\`]`,
  );
  const hitLine = lineIndexAt(source, span.start);
  for (const one of packageOf(readers, source.file)) {
    const found = one.lines.findIndex(
      (line, index) =>
        line.length < MAX_LINE_CHARS &&
        defaulted.test(line) &&
        !(one === source && index === hitLine),
    );
    if (found === -1) continue;
    const shown = `${one.file}:${reportedLine(one, found)}: ${one.lines[found].trim()}`;
    return {
      kind: 'unclear',
      reason: `the fallback for ${left[1]}.${left[2]}, and ${shown} gives ${left[2]} a value of its own, so this may never be taken`,
      reads: [shown],
    };
  }
  return undefined;
}

// The method or function-valued key this offset is inside, when its owner is a plain object or a
// class with no base, whose members only this repo's code can call.
function ownerMember(source: Source, offset: number): { name: string; open: number } | undefined {
  let at = offset;
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    at = open.open;
    const ahead = source.code.slice(Math.max(0, at - FUNCTION_LOOK_BACK_CHARS), at);
    const name =
      open.char === '{'
        ? (ARROW_MEMBER.exec(ahead) ?? METHOD_MEMBER.exec(ahead) ?? ARROW_CONST.exec(ahead))?.[1]
        : open.char === '('
          ? ARROW_MEMBER.exec(ahead.replace(TRAILING_CALLEE, ''))?.[1]
          : undefined;
    if (name) return { name, open: at };
  }
  return undefined;
}

// A definition split over lines, which a line's own text can't show: `async f(\n a,\n): T {`.
function isMethodHead({ source, offset }: Read, word: string): boolean {
  const open = offset + word.length;
  if (source.code[open] !== '(' || source.code[offset - 1] === '.') return false;
  return BODY_OPENS_LINE.test(source.code.slice(closeOf(source.code, open) + 1));
}

// The class a method is called on, when the file constructs what it's called on: x = new K(). A class
// that inherits may be running the method it's asked about, so that one doesn't count as another class.
function receiverClass({ source, offset }: Read, own: string | undefined): string | undefined {
  const ahead = source.code.slice(0, offset);
  const receiver = RECEIVER_BEFORE.exec(ahead.slice(-LOOK_BACK_CHARS))?.[1];
  if (!receiver) return undefined;
  const made = new RegExp(
    `(?<![\\w$])${escapeRegex(receiver)}\\s*(?::[^=\\n]*)?=\\s*(?:await\\s+)?new\\s+([\\w$]+)`,
    'g',
  );
  const found = [...ahead.matchAll(made)].at(-1)?.[1];
  if (!found || !own) return found;
  const inherits = new RegExp(`\\bclass\\s+${escapeRegex(found)}\\s+extends\\b`);
  return source.text.match(inherits) ? own : found;
}

/** A member of an object or class that nothing here ever names outside its own definition. */
function uncalledMemberReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  const member = ownerMember(source, offset);
  if (!member) return undefined;
  const owner = enclosing(source.code, member.open);
  if (
    owner?.char !== '{' ||
    !OBJECT_OR_PLAIN_CLASS.test(
      source.code.slice(Math.max(0, owner.open - LOOK_BACK_CHARS), owner.open),
    )
  ) {
    return undefined;
  }
  const calls = packageOf(readers, source.file)
    .flatMap((one) => readsIn(readers, one, member.name))
    .filter((read) => !isMethodHead(read, member.name));
  if (calls.length === 0) {
    return {
      kind: 'unclear',
      reason: `inside ${member.name}, which nothing in this repo calls, so it may never run`,
    };
  }
  const own = CLASS_NAME_BEFORE.exec(
    source.code.slice(Math.max(0, owner.open - LOOK_BACK_CHARS), owner.open),
  )?.[1];
  const others = calls.map((read) => receiverClass(read, own));
  return own && others.every((other) => other !== undefined && other !== own)
    ? {
        kind: 'catalog',
        reason: `inside ${own}.${member.name}, and nothing calls it on ${own}: every call of ${member.name} here is on ${others[0]}, another class`,
      }
    : undefined;
}

function uncalledConvexReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE || !CONVEX_FILE.test(source.file)) return undefined;
  for (let index = lineIndexAt(source, offset); index >= 0; index -= 1) {
    const line = source.lines[index];
    if (!line.trim() || /^\s/.test(line) || line.startsWith('}')) continue;
    const name = CONVEX_FUNCTION.exec(line)?.[1];
    if (!name) return undefined;
    return packageOf(readers, source.file).some((one) => readsIn(readers, one, name).length > 0)
      ? undefined
      : { kind: 'unclear', reason: `inside ${name}, a Convex function nothing in this repo calls` };
  }
  return undefined;
}

/** A list under a key of a table the code only reads by other keys, so nothing ever picks this one. */
function unreadKeyReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  const list = enclosing(source.code, offset);
  if (list?.char !== '[') return undefined;
  const key = KEY_BEFORE.exec(
    source.code.slice(Math.max(0, list.open - LOOK_BACK_CHARS), list.open),
  )?.[1];
  const table = enclosing(source.code, list.open);
  if (!key || table?.char !== '{') return undefined;
  const name = OBJECT_ASSIGNED.exec(
    source.code.slice(Math.max(0, table.open - LOOK_BACK_CHARS), table.open),
  )?.[1];
  if (!name) return undefined;
  const scope = packageOf(readers, source.file);
  if (scope.some((one) => readsIn(readers, one, key).length > 0)) return undefined;
  const reads = scope
    .flatMap((one) => readsIn(readers, one, name))
    .filter((read) => !isImportOf(read) && !NOT_A_VALUE_READ.test(read.line));
  const onlyByKey =
    reads.length > 0 &&
    reads.every((read) =>
      MEMBER_ACCESS_AFTER.test(
        read.source.code.slice(
          read.offset + name.length,
          read.offset + name.length + LOOK_BACK_CHARS,
        ),
      ),
    );
  return onlyByKey
    ? {
        kind: 'catalog',
        reason: `under ${key} in ${name}, and the code only reads other keys of it`,
      }
    : undefined;
}

// shortcut: only JS `const x = false` and `if (x) {`, add Python and ternaries when a repo shows them.
function falseGuard(source: Source, offset: number): string | undefined {
  if (source.mode !== JS_MODE) return undefined;
  let at = offset;
  for (let level = 0; level < MAX_GUARD_WALK; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    at = open.open;
    if (open.char !== '{') continue;
    const guard = GUARD_OPEN.exec(source.code.slice(Math.max(0, at - LOOK_BACK_CHARS), at))?.[1];
    if (
      guard &&
      new RegExp(`\\bconst\\s+${escapeRegex(guard)}\\s*(?::\\s*boolean\\s*)?=\\s*false\\b`).test(
        source.code,
      )
    ) {
      return guard;
    }
  }
  return undefined;
}

/** Inside a branch a constant turns off, or in a list only ever read inside such a branch. */
function deadBranchReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  const here = falseGuard(source, offset);
  if (here) return { kind: 'catalog', reason: `inside if (${here}), and ${here} is always false` };
  const list = enclosing(source.code, offset);
  if (list?.char !== '[') return undefined;
  const word = listName(source, list).split('.').at(-1);
  if (!word) return undefined;
  const reads = packageOf(readers, source.file).flatMap((one) => readsIn(readers, one, word));
  const guards = reads.map((read) => falseGuard(read.source, read.offset));
  return reads.length > 0 && guards.every(Boolean)
    ? {
        kind: 'catalog',
        reason: `the list ${word} is only read inside if (${guards[0]}), and ${guards[0]} is always false`,
      }
    : undefined;
}

function localModule(readers: Readers, source: Source, specifier: string): Source | undefined {
  const code = specifier.replace(CODE_EXTENSION, '');
  const wanted = specifier.startsWith('.')
    ? path.posix.join(folderOf(source.file), code)
    : code.replace(SPECIFIER_PREFIX, '');
  return readers.sources.find((one) => {
    const bare = one.file.replace(EXTENSION, '');
    if (bare === wanted || bare === `${wanted}/index`) return true;
    return !specifier.startsWith('.') && bare.endsWith(`/${wanted}`);
  });
}

const importLine = (source: Source, offset: number) =>
  `${source.file}:${reportedLine(source, lineIndexAt(source, offset))}: ${lineAt(source, offset).trim()}`;

// `import cc_anthropic as anthropic`: a local module takes the SDK's name, so calls that read like the
// SDK's run that module's code instead, and it decides what goes where.
function facadeReach(readers: Readers, source: Source, packages: string[]): Reach | undefined {
  if (source.mode !== PYTHON_MODE) return undefined;
  const own = new Set(packages.map(normalName));
  for (const match of source.text.matchAll(IMPORT_AS)) {
    const [, module, alias] = match;
    if (!own.has(normalName(alias)) || normalName(module) === normalName(alias)) continue;
    const file = `/${module.replace(/\./g, '/')}.py`;
    const facade = readers.sources.find((one) => `/${one.file}`.endsWith(file));
    if (!facade) continue;
    const lines = facade.lines.flatMap((line, index) =>
      MODEL_WORD.test(line) ? [`${facade.file}:${index + 1}: ${line.trim()}`] : [],
    );
    return {
      kind: 'unclear',
      reason: `this file imports its own ${facade.file} under the name ${alias}, so that module decides what's sent, not the SDK`,
      reads: [importLine(source, match.index), ...lines].slice(0, MAX_READS_SHOWN),
    };
  }
  return undefined;
}

// `ai.models.generateImages(...)` where `ai` is the app's own Proxy or object: a method its module
// never names isn't there to call, whatever the real SDK offers.
function wrapperReach(readers: Readers, source: Source, offset: number): Reach | undefined {
  if (source.mode !== JS_MODE) return undefined;
  let at = offset;
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const open = enclosing(source.code, at);
    if (!open) return undefined;
    at = open.open;
    if (open.char !== '(') continue;
    const call = MEMBER_CALL.exec(source.code.slice(Math.max(0, at - LOOK_BACK_CHARS), at));
    if (!call) return undefined;
    const [, root, method] = call;
    const imported = new RegExp(
      `\\bimport\\s[^;]*?\\b${escapeRegex(root)}\\b[^;]*?\\bfrom\\s+["']([^"']+)["']`,
    ).exec(source.text)?.[1];
    if (!imported || !LOCAL_SPECIFIER.test(imported)) return undefined;
    const module = localModule(readers, source, imported);
    const wrapped = new RegExp(
      `\\b${escapeRegex(root)}\\s*(?::[^=\\n]*)?=\\s*(?:new\\s+Proxy\\s*\\(|\\{)`,
    );
    if (!module || !wrapped.test(module.code) || wordPattern(method).test(module.text)) {
      return undefined;
    }
    return {
      kind: 'unclear',
      reason: `${root} is the app's own wrapper in ${module.file}, which never names ${method}, so this call may fail before it sends anything`,
    };
  }
  return undefined;
}

/** Where the code reads what holds a list or a picked option, for the AI check to follow. */
export function holderReads(readers: Readers, source: Source, offset: number): string[] {
  const list = enclosing(source.code, offset);
  const picked = SELECT_VALUE.exec(
    source.text.slice(Math.max(0, offset - FUNCTION_LOOK_BACK_CHARS), offset),
  )?.[1];
  const named = list && (returnedBy(source, list.open) ?? listName(source, list));
  // client.messages.create({...}) names a method every client has, which says nothing about this one.
  const isMethodArgument =
    list !== undefined &&
    named?.includes('.') &&
    INSIDE_A_CALL.test(source.code.slice(Math.max(0, list.open - LOOK_BACK_CHARS), list.open));
  const word =
    picked?.split('.').at(-1) ?? (isMethodArgument ? undefined : named?.split('.').at(-1));
  if (word) {
    const scope = picked ? [source] : packageOf(readers, source.file);
    const reads = scope.flatMap((one) => readsIn(readers, one, word));
    return reads.slice(0, MAX_READS_SHOWN).map(shownRead);
  }
  return callerReads(readers, source, offset);
}

const shownRead = (read: Read) =>
  `${read.source.file}:${reportedLine(read.source, lineIndexAt(read.source, read.offset))}: ${read.line.trim()}`;

// The statement a call sits in at the file's top: a route, a job or a loop says who starts it.
function startedIn({ source, offset }: Read): string | undefined {
  return lastLineBefore(source, offset, (one) => STATEMENT_START.test(one))?.trim();
}

// The function a line sits inside, by its braces in JS and its indent in Python.
function holdingFunction(source: Source, offset: number): string | undefined {
  if (source.mode === PYTHON_MODE) {
    const depth = lineAt(source, offset).search(/\S/);
    const above = lastLineBefore(
      source,
      offset,
      (line) => line.trim() !== '' && line.search(/\S/) < depth,
    );
    return above && TOP_LEVEL_DEF.exec(above.trim())?.[1];
  }
  return ownerMember(source, offset)?.name;
}

/** Who calls the function holding this line, for a value that goes straight to a request from there. */
function callerReads(readers: Readers, source: Source, offset: number): string[] {
  const name = holdingFunction(source, offset);
  if (!name) return [];
  return packageOf(readers, source.file)
    .flatMap((one) => readsIn(readers, one, name))
    .filter((read) => !isMethodHead(read, name))
    .slice(0, MAX_READS_SHOWN)
    .map((read) => {
      const start = startedIn(read);
      return start ? `${shownRead(read)} (in ${start})` : shownRead(read);
    });
}

export type ReachInput = {
  source: Source;
  offset: number;
  span?: Span;
  picker: boolean;
  fileNamesProvider: boolean;
  packages: string[];
};

/** Why this match never reaches the API, or undefined when nothing here shows that. */
export function reachOf(readers: Readers, input: ReachInput): Reach | undefined {
  const { source, offset, span, picker, fileNamesProvider, packages } = input;
  const backup = backupReach(readers, source);
  if (backup) return backup;
  if (orphansOf(readers).has(source.file)) {
    return {
      kind: 'unclear',
      reason:
        'nothing that runs imports this module, so it may be left over from a rewrite, and it only runs if someone starts it by hand',
    };
  }
  const stopped =
    brokenImportReach(readers, source) ?? uncalledConvexReach(readers, source, offset);
  if (stopped) return stopped;
  if (span?.kind !== 'string') return undefined;
  return (
    deadBranchReach(readers, source, offset) ??
    controlledValueReach(source, offset) ??
    unreadKeyReach(readers, source, offset) ??
    facadeReach(readers, source, packages) ??
    wrapperReach(readers, source, offset) ??
    ignoredDefaultReach(source, span) ??
    defaultReach(readers, source, span) ??
    enumLabelReach(readers, source, span) ??
    bookkeepingReach(source, offset) ??
    missingRouteReach(readers, source, offset) ??
    fallbackReach(readers, source, span) ??
    uncalledReach(readers, source, offset) ??
    uncalledMemberReach(readers, source, offset) ??
    unresolvedCall(source, offset) ??
    assignedReach(readers, source, span, fileNamesProvider) ??
    constructedReach(readers, source, offset) ??
    listReach(readers, source, offset) ??
    (picker ? unreadOwnerReach(readers, source, offset) : undefined)
  );
}

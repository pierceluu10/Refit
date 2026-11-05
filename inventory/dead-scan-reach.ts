// Whether a match can reach the API at all, from what the code does with it afterwards. Anything these
// rules can't settle stays as it was: they only speak up when the code plainly shows the value stops here.
import path from 'node:path';
import { escapeRegex } from '../dead-apis/match.ts';
import { lineIndexAt, reportedLine, spanAt, type Source, type Span } from './dead-scan-lex.ts';
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
const SPECIFIER_PREFIX = /^(?:(?:\.{1,2}|[@~])\/)+/;
// Names and folders a framework or a runner starts on its own, so nothing has to import them.
const ENTRY_NAME =
  /^(?:index|main|app|server|cli|route|page|layout|loading|error|handler|worker|middleware|proxy|background|content|popup|preload|sw|service-worker|\w+\.config)$/;
const ENTRY_FOLDER =
  /(?:^|\/)(?:app|pages|api|functions|routes|scripts?|bin|cli|tools|commands|lambdas?|handlers|workers|jobs|migrations|plugins|bench|benchmarks|convex|prisma)\//;

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
  }
  return mentions;
}

const normalName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function isDependency(readers: Readers, name: string): boolean {
  return readers.manifests.some((manifest) =>
    manifest.dependencies.some((one) => normalName(one.name) === normalName(name)),
  );
}

function namesModule(readers: Readers, mentions: Set<string>, target: Source): boolean {
  const name = moduleName(target.file);
  const named = isPythonModule(target) ? `${lastFolder(target.file)}/${name}` : `/${name}`;
  return mentions.has(named) || (mentions.has(`bare/${name}`) && !isDependency(readers, name));
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

function isImportedModule(source: Source): boolean {
  const name = moduleName(source.file);
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
      if (!isImportedModule(one) || !(one.mode === JS_MODE ? graph.js : graph.python)) return false;
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
      const loaded = loads && one.text.includes(lastFolder(module.file));
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
  const allReads = callers.flatMap((one) => readsIn(readers, one, word));
  // A package that re-exports a function offers it to callers this repo can't show.
  if (allReads.some((read) => moduleName(read.source.file) === PYTHON_INIT)) return undefined;
  const reads = allReads.filter((read) => !isImportOf(read) && !(isInit && isTypeAnnotation(read)));
  if (reads.length === 0) return undefined;
  return reads.every((read) => passesParameter(read, word, parameter, earlier.length))
    ? {
        kind: 'catalog',
        reason: `the default of ${parameter}: every call of ${word} passes its own, so this one is never sent`,
      }
    : undefined;
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

function localModule(readers: Readers, source: Source, specifier: string): Source | undefined {
  const code = specifier.replace(/\.[cm]?[jt]sx?$/, '');
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
  packages: string[];
};

/** Why this match never reaches the API, or undefined when nothing here shows that. */
export function reachOf(readers: Readers, input: ReachInput): Reach | undefined {
  const { source, offset, span, picker, fileNamesProvider, packages } = input;
  if (orphansOf(readers).has(source.file)) {
    return {
      kind: 'unclear',
      reason:
        'nothing that runs imports this module, so it may be left over from a rewrite, and it only runs if someone starts it by hand',
    };
  }
  if (span?.kind !== 'string') return undefined;
  return (
    facadeReach(readers, source, packages) ??
    wrapperReach(readers, source, offset) ??
    defaultReach(readers, source, span) ??
    uncalledReach(readers, source, offset) ??
    unresolvedCall(source, offset) ??
    assignedReach(readers, source, span, fileNamesProvider) ??
    constructedReach(readers, source, offset) ??
    listReach(readers, source, offset) ??
    (picker ? unreadOwnerReach(readers, source, offset) : undefined)
  );
}

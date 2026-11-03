// The inventory's deterministic first pass. Ordinary code reads the manifests, lockfiles, imports
// and API hosts, and builds an ApiUsage for every clear hit: a known SDK imported, made into a
// client and called, or a known API host fetched. Everything it cannot settle (dependencies it
// does not know, HTTP calls to hosts it does not know, SDKs with no call it can see, env-built
// URLs, GraphQL, webhooks) becomes a lead for the agent, with the scan as evidence. The scan
// never decides that something is not an API: what it does not record, it hands on.
import path from 'node:path';
import type { ApiUsage, ProviderHints } from '../shared/types.ts';
import {
  catalogEntry,
  dependencyProvider,
  hostProvider,
  npmPackageName,
  npmProvider,
  pythonModuleProvider,
  type CatalogEntry,
} from './catalog.ts';
import { listFiles, readText } from './repo-files.ts';
import { listManifests, lockedVersions, type Manifest } from './scanners.ts';

export const SCAN_VERSION = 'scan-v7';

type CallSite = ApiUsage['callSites'][number];

export type LeadGroup = { kind: string; title: string; items: string[]; more: number };

/** A usage the scan built. `ecosystem` keeps a PyPI SDK apart from the npm one of the same name. */
export type ScannedUsage = ApiUsage & { ecosystem?: 'python' };

export type ScanResult = {
  usages: ScannedUsage[];
  /** Folders holding many leads to read, for area readers; empty when there are few. */
  areas?: { area: string; leads: number }[];
  leads: LeadGroup[];
  /** HTTP calls to the repo's own routes (relative URLs): not external, counted so nothing is hidden. */
  internalCalls: { count: number; examples: string[] };
  stats: { files: number; sourceFiles: number; dependencies: number; manifests: number };
};

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const JS_LIKE = new Set([...JS_EXTENSIONS, '.vue', '.svelte', '.astro']);
const OTHER_CODE = new Set(['.go', '.rb', '.php', '.java', '.kt', '.cs', '.rs', '.swift', '.dart']);
const CONFIG = new Set(['.json', '.yaml', '.yml', '.toml', '.env', '.ini', '.cfg', '.conf', '.sh']);
const LOW_SIGNAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(www\.)?example\.(com|org|net)|www\.w3\.org|schemas\.\S+|json-schema\.org)$/;
const MAX_ITEMS = 40;
const MAX_REGION_LINES = 30;
const NOTE = 'Found by the code scan (import, client, member call); response handling not read.';

// ---- Source files ----

type Source = { file: string; ext: string; lines: string[]; text: string };

function isEnvFile(name: string): boolean {
  return /^\.env(\.|$)|\.env$/.test(name);
}

// Real env files are never read: their values would be secrets. Templates are fine.
function scannable(file: string): boolean {
  const name = path.posix.basename(file);
  if (isEnvFile(name)) return /example|sample|template/i.test(name);
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock)$/.test(file)) return false;
  const ext = path.posix.extname(name);
  return JS_LIKE.has(ext) || ext === '.py' || OTHER_CODE.has(ext) || CONFIG.has(ext);
}

async function readSources(repoDir: string, files: string[]): Promise<Source[]> {
  const sources: Source[] = [];
  for (const file of files) {
    if (!scannable(file)) continue;
    const text = await readText(repoDir, file).catch(() => undefined);
    if (text === undefined) continue;
    sources.push({ file, ext: path.posix.extname(file), lines: text.split(/\r?\n/), text });
  }
  return sources;
}

const isComment = (line: string, python: boolean) =>
  python ? /^\s*#/.test(line) : /^\s*(\/\/|\*|\/\*)/.test(line);

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

// ---- Imports and bindings ----

type BindingKind = 'default' | 'namespace' | 'named';
type Binding = {
  local: string;
  kind: BindingKind;
  imported?: string;
  /** The catalog provider and the package (npm name or PyPI-side module) the binding comes from. */
  provider: string;
  pkg: string;
  /** npm and PyPI can both have a "stripe": they are different SDKs with their own versions. */
  ecosystem: 'npm' | 'python';
  line: number;
  /** The repo's own function that returns a client of this package. */
  factory?: boolean;
};

type LocalImport = { local: string; imported: string; spec: string; line: number };

function parseJsClause(clause: string): { local: string; kind: BindingKind; imported?: string }[] {
  const found: { local: string; kind: BindingKind; imported?: string }[] = [];
  let rest = clause.trim();
  const braces = /\{([^}]*)\}/.exec(rest);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec || /^type\s/.test(part.trim())) continue;
      const [imported, local] = spec.split(/\s+as\s+|\s*:\s*/).map((value) => value.trim());
      if (/^[\w$]+$/.test(local ?? imported))
        found.push({ local: local ?? imported, kind: 'named', imported });
    }
    rest = rest.replace(braces[0], '');
  }
  const namespace = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (namespace) {
    found.push({ local: namespace[1], kind: 'namespace' });
    rest = rest.replace(namespace[0], '');
  }
  const fallback = /^[\s,]*([\w$]+)/.exec(rest);
  if (fallback) found.push({ local: fallback[1], kind: 'default' });
  return found;
}

const JS_IMPORT = /\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"]+)['"]/g;
const JS_REQUIRE =
  /\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*(?:await\s+)?(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

function jsImports(source: Source): { spec: string; line: number; clause: string }[] {
  const found: { spec: string; line: number; clause: string }[] = [];
  for (const match of source.text.matchAll(JS_IMPORT)) {
    if (match[1]) continue; // `import type`: no runtime use
    found.push({ spec: match[3], line: lineOf(source.text, match.index), clause: match[2] });
  }
  for (const match of source.text.matchAll(JS_REQUIRE)) {
    found.push({ spec: match[2], line: lineOf(source.text, match.index), clause: match[1] });
  }
  return found;
}

const PY_FROM = /^\s*from\s+([.\w]+)\s+import\s+(\(?)([^#\n]*)/;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/;

function pythonImports(
  source: Source,
): { module: string; names: { local: string; imported?: string }[]; line: number }[] {
  const found: { module: string; names: { local: string; imported?: string }[]; line: number }[] =
    [];
  source.lines.forEach((line, index) => {
    const from = PY_FROM.exec(line);
    if (from) {
      let names = from[3];
      if (from[2]) {
        // Parenthesised list across lines.
        for (let next = index + 1; !names.includes(')') && next < source.lines.length; next++) {
          names += ` ${source.lines[next]}`;
        }
        names = names.replace(/\).*$/, '');
      }
      const parsed = names
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /^\w+(\s+as\s+\w+)?$/.test(part))
        .map((part) => {
          const [imported, local] = part.split(/\s+as\s+/);
          return { imported, local: local ?? imported };
        });
      found.push({ module: from[1], names: parsed, line: index + 1 });
      return;
    }
    const plain = PY_IMPORT.exec(line);
    if (plain) {
      for (const part of plain[1].split(',')) {
        const [module, alias] = part.trim().split(/\s+as\s+/);
        found.push({ module, names: [{ local: alias ?? module.split('.')[0] }], line: index + 1 });
      }
    }
  });
  return found;
}

// ---- Clients and call sites ----

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What makes a client rather than calling the API: a class (new X(), Client()), or a factory such
// as createClient, initializeApp, getFirestore or boto3.client. "create" alone is an API call.
const CONSTRUCTOR = /^[A-Z]/;
const FACTORY =
  /^(?:create|init|connect|configure|setup)[A-Z_]|^initializeApp$|^get(?:Firestore|Auth|Storage|Database|Messaging|Functions|Analytics|App|GenerativeModel)$|^(?:client|resource|get_generative_model)$/;

type FileScan = {
  /** Identifiers that are a client or namespace of a provider package, by identifier. */
  clients: Map<string, Binding>;
  /** Named function imports whose direct calls are API calls. */
  functions: Map<string, Binding>;
  /** Identifiers that hold a client and are exported (or module-level in Python). */
  exported: Map<string, Binding>;
  /** The repo's own functions that return a client (`export function createClient()`), by name. */
  factories: Map<string, Binding>;
  /** Those factories other files can import. */
  exportedFactories: Map<string, Binding>;
  /** Lines that construct a client: not call sites, but where the pinned version lives. */
  constructions: { binding: Binding; line: number; column: number }[];
  /** Where each holder was given a client, so `this.client` in two classes keeps both apart. */
  assignments: Map<string, { line: number; binding: Binding }[]>;
};

/**
 * The client a name holds at a line. One file can give the same holder clients of different SDKs
 * (`this.client = new Anthropic()` in one class, `new OpenAI()` in the next): a call then takes
 * the nearest assignment above it, or failing that the first below it.
 */
function clientAt(scan: FileScan, name: string, line: number): Binding {
  const assigned = scan.assignments.get(name) ?? [];
  if (new Set(assigned.map((entry) => `${entry.binding.provider}|${entry.binding.pkg}`)).size < 2) {
    return scan.clients.get(name) as Binding;
  }
  const above = assigned.filter((entry) => entry.line <= line).at(-1);
  return (above ?? assigned[0]).binding;
}

const emptyScan = (): FileScan => ({
  clients: new Map(),
  functions: new Map(),
  exported: new Map(),
  factories: new Map(),
  exportedFactories: new Map(),
  assignments: new Map(),
  constructions: [],
});

// `const x = new Client(` and the like: the identifier (a plain name, this./self. field, or a React
// ref's .current), whether `new` is used, the binding called, and any member chain after it.
const declarationPattern = (names: string) =>
  new RegExp(
    String.raw`(?:^|[^\w$.])((?:this\.|self\.)?[A-Za-z_$][\w$]*(?:\.current)?)\s*(?::\s*[^=(]{1,80})?=\s*(?:await\s+)?(new\s+)?(${names})\b((?:\s*\.\s*[\w$]+)*)\s*\(`,
  );

function holderNames(holder: string): string[] {
  const bare = holder.replace(/^(this|self)\./, '');
  return [...new Set([holder, bare, `this.${bare}`, `self.${bare}`])];
}

/** Clients made in this file: by constructing a catalog binding, or by calling a known factory. */
function findClients(source: Source, bindings: Binding[], scan: FileScan): void {
  const python = source.ext === '.py';
  const names = bindings.map((binding) => escape(binding.local)).join('|');
  if (!names) return;
  const declaration = declarationPattern(names);
  source.lines.forEach((line, index) => {
    if (isComment(line, python)) return;
    const match = declaration.exec(line);
    if (!match) return;
    const binding = bindings.find((candidate) => candidate.local === match[3]) as Binding;
    const chain = match[4]
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean);
    const last = chain.at(-1) ?? binding.local;
    const makesClient = binding.factory || match[2] || CONSTRUCTOR.test(last) || FACTORY.test(last);
    if (!makesClient) return; // an API call, whose result is data
    for (const name of holderNames(match[1])) {
      scan.clients.set(name, binding);
      const assigned = scan.assignments.get(name) ?? [];
      assigned.push({ line: index + 1, binding });
      scan.assignments.set(name, assigned);
    }
    scan.constructions.push({
      binding,
      line: index + 1,
      column: match.index + match[0].length - 1,
    });
    const exportedDeclaration = python
      ? /^[A-Za-z_]/.test(line)
      : /^\s*export\s+(?:const|let|var)\s/.test(line);
    if (exportedDeclaration) scan.exported.set(match[1].replace(/^(this|self)\./, ''), binding);
  });
}

const FUNCTION_START =
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|def\s+([A-Za-z_]\w*)\s*\()/;

/** The file's own functions whose body returns a new client, so their callers hold one. */
function findFactories(source: Source, scan: FileScan): void {
  const python = source.ext === '.py';
  const clientNames = [...scan.clients.keys()];
  const bindings = [...new Set([...scan.clients.values(), ...scan.functions.values()])];
  const names = [...new Set(bindings.map((binding) => binding.local))].map(escape).join('|');
  if (!names) return;
  const returns = new RegExp(
    String.raw`(?:\breturn\s+|=>\s*)(?:await\s+)?(new\s+)?(${names})\b((?:\s*\.\s*[\w$]+)*)\s*\(`,
  );
  const returnsClient = clientNames.length
    ? new RegExp(String.raw`\breturn\s+(${clientNames.map(escape).join('|')})\s*;?\s*$`)
    : undefined;
  for (let index = 0; index < source.lines.length; index++) {
    const start = FUNCTION_START.exec(source.lines[index]);
    if (!start) continue;
    const name = start[2] ?? start[3] ?? start[4];
    const indent = start[1].length;
    for (let row = index; row < Math.min(source.lines.length, index + 40); row++) {
      const line = source.lines[row];
      if (row > index && line.trim() && indentOf(line) <= indent && FUNCTION_START.test(line))
        break;
      if (
        row > index &&
        !python &&
        line.trim() &&
        indentOf(line) <= indent &&
        /^\s*\}/.test(line)
      ) {
        break;
      }
      const made = returns.exec(line);
      if (made) {
        const binding = bindings.find((candidate) => candidate.local === made[2]) as Binding;
        const last =
          made[3]
            .split('.')
            .map((part) => part.trim())
            .filter(Boolean)
            .at(-1) ?? binding.local;
        if (made[1] || binding.factory || CONSTRUCTOR.test(last) || FACTORY.test(last)) {
          addFactory(scan, name, binding, source.lines[index], python, indent);
          // The returned construction makes a client; it is not a call of the API.
          scan.constructions.push({
            binding,
            line: row + 1,
            column: made.index + made[0].length - 1,
          });
          break;
        }
      }
      const returned = returnsClient?.exec(line);
      if (returned) {
        addFactory(
          scan,
          name,
          scan.clients.get(returned[1]) as Binding,
          source.lines[index],
          python,
          indent,
        );
        break;
      }
    }
  }
}

function addFactory(
  scan: FileScan,
  name: string,
  binding: Binding,
  line: string,
  python: boolean,
  indent: number,
): void {
  scan.factories.set(name, binding);
  scan.functions.delete(name);
  if (python ? indent === 0 : /^\s*export\b/.test(line)) scan.exportedFactories.set(name, binding);
  if (!python && /^\s*export\s+default\b/.test(line))
    scan.exportedFactories.set('default', binding);
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function scanClients(source: Source, bindings: Binding[]): FileScan {
  const python = source.ext === '.py';
  const scan = emptyScan();
  for (const binding of bindings) {
    const lower = !CONSTRUCTOR.test(binding.local);
    if (binding.factory) continue; // the repo's own factory: its calls make clients
    // A namespace or module (and in Python a lowercase name, often a module): its members are the API.
    if (binding.kind !== 'named' || (python && lower)) scan.clients.set(binding.local, binding);
    // A lowercase named import is a function: calling it is a call of the API.
    if (binding.kind === 'named' && lower) scan.functions.set(binding.local, binding);
  }
  findClients(source, bindings, scan);
  findFactories(source, scan);
  // Calls of this file's own factories make clients too.
  if (scan.factories.size) {
    findClients(
      source,
      [...scan.factories].map(([name, binding]) => ({ ...binding, local: name, factory: true })),
      scan,
    );
  }
  if (!python) {
    const names = bindings.map((binding) => escape(binding.local)).join('|');
    const defaultNew = new RegExp(String.raw`\bexport\s+default\s+new\s+(${names})\b`).exec(
      source.text,
    );
    if (defaultNew) {
      const binding = bindings.find((candidate) => candidate.local === defaultNew[1]);
      if (binding) scan.exported.set('default', binding);
    }
    for (const match of source.text.matchAll(
      /\bexport\s+default\s+([\w$]+)\s*;?|\bexport\s*\{([^}]*)\}|\bmodule\.exports\s*=\s*\{?([^};\n]*)/g,
    )) {
      const listed = (match[1] ?? match[2] ?? match[3] ?? '').split(',').map((part) => {
        const [local, alias] = part.trim().split(/\s+as\s+|\s*:\s*/);
        return { local: local?.trim(), alias: alias?.trim() };
      });
      for (const { local, alias } of listed) {
        const name = match[1] ? 'default' : (alias ?? local);
        const client = local ? scan.clients.get(local) : undefined;
        if (client) scan.exported.set(name, client);
        const factory = local ? scan.factories.get(local) : undefined;
        if (factory) scan.exportedFactories.set(name, factory);
      }
    }
  }
  return scan;
}

type FoundCall = {
  binding: Binding;
  line: number;
  operation: string;
  column: number;
  /** A component an SDK renders (<Analytics />, <InlineWidget />): it calls the vendor from the browser. */
  jsx?: string[];
};

// TypeScript type arguments between a name and its call: client.fetch<Post[]>(query).
const TYPE_ARGS = String.raw`(?:\s*<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?`;
const MEMBER_CHAIN = String.raw`([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*)${TYPE_ARGS}\s*\(`;
const JSX_FILES = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro']);

function findCalls(
  source: Source,
  scan: FileScan,
  skipLines: Set<number>,
  components: Binding[] = [],
): FoundCall[] {
  const python = source.ext === '.py';
  const calls: FoundCall[] = [];
  const tags =
    JSX_FILES.has(source.ext) && components.length
      ? new RegExp(
          String.raw`<(${components.map((binding) => escape(binding.local)).join('|')})(?=[\s/>.]|$)`,
        )
      : undefined;
  source.lines.forEach((line, index) => {
    const tag = tags?.exec(line);
    if (!tag || isComment(line, false)) return;
    const binding = components.find((candidate) => candidate.local === tag[1]) as Binding;
    const attributes = [...line.slice(tag.index).matchAll(/\s([A-Za-z_$][\w$-]*)=/g)].map(
      (match) => match[1],
    );
    calls.push({
      binding,
      line: index + 1,
      operation: `<${binding.imported ?? binding.local} />`,
      column: tag.index,
      jsx: attributes,
    });
  });
  const clientNames = [...scan.clients.keys()].map(escape).join('|');
  const functionNames = [...scan.functions.keys()].map(escape).join('|');
  const member = clientNames
    ? new RegExp(String.raw`(?<![\w$.])(${clientNames})\s*(?:\?\.|\.)\s*${MEMBER_CHAIN}`, 'g')
    : undefined;
  // `await supabase` at a line's end, with `.from(...)` on the next: the call is on the next line.
  const dangling = clientNames
    ? new RegExp(String.raw`(?<![\w$.])(${clientNames})\s*$`)
    : undefined;
  const continued = new RegExp(String.raw`^\s*(?:\?\.|\.)\s*${MEMBER_CHAIN}`);
  const direct = functionNames
    ? new RegExp(String.raw`(?<![\w$.])(${functionNames})${TYPE_ARGS}\s*\(`, 'g')
    : undefined;
  source.lines.forEach((line, index) => {
    if (skipLines.has(index + 1) || isComment(line, python)) return;
    if (/^\s*(import|from)\s/.test(line) || /\brequire\s*\(/.test(line)) return;
    for (const match of member ? line.matchAll(member) : []) {
      if (/\bnew\s+$/.test(line.slice(0, match.index))) continue; // new client.Error(): a class
      const binding = clientAt(scan, match[1], index + 1);
      const operation = match[2].replace(/\s+/g, '').replace(/\?\./g, '.');
      calls.push({
        binding,
        line: index + 1,
        operation,
        column: match.index + match[0].length - 1,
      });
    }
    const hanging = dangling?.exec(line);
    const next = hanging ? continued.exec(source.lines[index + 1] ?? '') : undefined;
    if (hanging && next && !skipLines.has(index + 2)) {
      calls.push({
        binding: clientAt(scan, hanging[1], index + 2),
        line: index + 2,
        operation: next[1].replace(/\s+/g, '').replace(/\?\./g, '.'),
        column: next.index + next[0].length - 1,
      });
    }
    // One direct call per line, the outermost: setDoc(doc(db, ...)) is one request.
    for (const match of direct ? line.matchAll(direct) : []) {
      const before = line.slice(0, match.index);
      if (/\b(function|def|class)\s+$/.test(before) || /\bnew\s+$/.test(before)) continue;
      const binding = scan.functions.get(match[1]) as Binding;
      calls.push({
        binding,
        line: index + 1,
        operation: binding.imported ?? binding.local,
        column: match.index + match[0].length - 1,
      });
      break;
    }
  });
  return calls;
}

// The text of a call's arguments, from its opening parenthesis until it closes (or a few lines on).
function callRegion(lines: string[], index: number, column: number): string {
  let depth = 0;
  let text = '';
  let quote: string | undefined;
  for (let row = index; row < Math.min(lines.length, index + MAX_REGION_LINES); row++) {
    const line = row === index ? lines[row].slice(column) : lines[row];
    for (const char of line) {
      text += char;
      if (quote) {
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(' || char === '{' || char === '[') depth++;
      else if (char === ')' || char === '}' || char === ']') {
        depth--;
        if (depth === 0) return text;
      }
    }
    text += '\n';
    quote = undefined;
  }
  return text;
}

// Keys of the first object argument (JS) or keyword arguments (Python), at the top level.
function topLevelFields(region: string, python: boolean): string[] {
  const fields: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let token = '';
  const target = python ? 1 : 2; // inside "(" for kwargs; inside "({" for object keys
  for (const char of region) {
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      token = '';
      continue;
    }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    if (depth === target && /[\w$]/.test(char)) {
      token += char;
      continue;
    }
    if (depth === target && token && (python ? char === '=' : char === ':' || char === ',')) {
      if (!/^\d/.test(token)) fields.push(token);
    }
    if (!/\s/.test(char)) token = '';
  }
  return [...new Set(fields)].slice(0, 20);
}

const MODEL = /\bmodel(?:Name|_name|Id)?\s*[:=]\s*['"`]([\w.:/@-]+)['"`]/;
const FIRST_STRING_ARG = /^\(\s*['"`]([\w.:/@-]+)['"`]/;
const API_VERSION = /\b(?:apiVersion|api_version)\s*[:=]\s*['"`]([\w.-]+)['"`]/;

// ---- Local imports between the repo's own files ----

const stripExtension = (file: string) =>
  file.replace(/\.(?:[mc]?[jt]sx?|py)$/, '').replace(/\/(?:index|__init__)$/, '');

function resolveLocal(importer: string, spec: string, candidates: string[]): string | undefined {
  if (spec.startsWith('.')) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
    return candidates.find((file) => stripExtension(file) === target);
  }
  const alias = /^(?:@|~|#)\/(.+)$/.exec(spec)?.[1] ?? spec;
  return candidates.find(
    (file) => stripExtension(file) === alias || stripExtension(file).endsWith(`/${alias}`),
  );
}

function pythonModuleFile(importer: string, module: string, candidates: string[]) {
  if (module.startsWith('.')) {
    const ups = /^\.+/.exec(module)?.[0].length ?? 1;
    let base = path.posix.dirname(importer);
    for (let up = 1; up < ups; up++) base = path.posix.dirname(base);
    const rest = module.slice(ups).replace(/\./g, '/');
    const target = rest ? path.posix.join(base, rest) : base;
    return candidates.find((file) => stripExtension(file) === path.posix.normalize(target));
  }
  const target = module.replace(/\./g, '/');
  return candidates.find(
    (file) => stripExtension(file) === target || stripExtension(file).endsWith(`/${target}`),
  );
}

// ---- The scan ----

type Draft = { usage: ApiUsage; seen: Set<string> };

/** A scan that found nothing: what the agent starts from when the scan could not run. */
export function emptyScanResult(): ScanResult {
  return {
    usages: [],
    leads: [],
    areas: [],
    internalCalls: { count: 0, examples: [] },
    stats: { files: 0, sourceFiles: 0, dependencies: 0, manifests: 0 },
  };
}

export async function scanRepo(repoDir: string, repo: string): Promise<ScanResult> {
  const files = await listFiles(repoDir);
  const sources = await readSources(repoDir, files);
  const sourceByFile = new Map(sources.map((source) => [source.file, source]));
  const { manifests } = await listManifests(repoDir);
  const dependencies = manifests.flatMap((manifest) =>
    manifest.dependencies.map((dependency) => ({ ...dependency, manifest })),
  );
  // Bare specifiers that name a top-level folder ("lib/stripe", "src/clients") are the repo's own.
  const topFolders = new Set(
    files.filter((file) => file.includes('/')).map((file) => file.split('/')[0]),
  );
  const isOwnModule = (spec: string) =>
    /^(?:[./~#]|@\/)/.test(spec) || topFolders.has(spec.split('/')[0]);

  // Bindings of catalog packages, per file, and the repo's own imports between its files.
  const bindingsByFile = new Map<string, Binding[]>();
  const localImports = new Map<string, LocalImport[]>();
  // Imported catalog packages, by ecosystem and name ("python|stripe" is not "npm|stripe").
  const imported = new Map<string, { pkg: string; provider: string; files: Set<string> }>();
  const noteImport = (pkg: string, ecosystem: string, provider: string, file: string) => {
    const key = `${ecosystem}|${ecosystem === 'python' ? normalizePy(pkg) : pkg}`;
    const entry = imported.get(key) ?? { pkg, provider, files: new Set<string>() };
    entry.files.add(file);
    imported.set(key, entry);
  };
  for (const source of sources) {
    const bindings: Binding[] = [];
    const locals: LocalImport[] = [];
    if (JS_LIKE.has(source.ext)) {
      for (const { spec, line, clause } of jsImports(source)) {
        const own = isOwnModule(spec);
        const hit = own ? undefined : npmProvider(spec);
        const parsed =
          clause.startsWith('{') && clause.includes(':') // require destructuring
            ? parseJsClause(clause.replace(/:/g, ' as '))
            : parseJsClause(clause);
        if (hit) {
          const pkg = npmPackageName(spec);
          noteImport(pkg, 'npm', hit.provider, source.file);
          for (const name of parsed) {
            bindings.push({ ...name, provider: hit.provider, pkg, ecosystem: 'npm', line });
          }
        } else if (own) {
          for (const name of parsed) {
            locals.push({
              local: name.local,
              imported: name.kind === 'default' ? 'default' : (name.imported ?? name.local),
              spec,
              line,
            });
          }
        }
      }
    } else if (source.ext === '.py') {
      for (const { module, names, line } of pythonImports(source)) {
        const moduleHit = pythonModuleProvider(module);
        for (const name of names) {
          const full = `${module}.${name.imported ?? ''}`;
          const hit = moduleHit ?? (name.imported ? pythonModuleProvider(full) : undefined);
          if (hit) {
            const pkg = pythonPackageFor(hit.entry, hit.module, dependencies);
            noteImport(pkg, 'python', hit.provider, source.file);
            const isModule = !name.imported || (!moduleHit && Boolean(hit));
            bindings.push({
              local: name.local,
              kind: isModule ? 'namespace' : 'named',
              imported: name.imported,
              provider: hit.provider,
              pkg,
              ecosystem: 'python',
              line,
            });
          } else if (name.imported) {
            locals.push({ local: name.local, imported: name.imported, spec: module, line });
          }
        }
      }
    }
    if (bindings.length) bindingsByFile.set(source.file, bindings);
    if (locals.length) localImports.set(source.file, locals);
  }

  // Clients per file, then clients other files import from the files that export them.
  const scans = new Map<string, FileScan>();
  for (const [file, bindings] of bindingsByFile) {
    scans.set(file, scanClients(sourceByFile.get(file) as Source, bindings));
  }
  const exporters = [...scans]
    .filter(([, scan]) => scan.exported.size > 0 || scan.exportedFactories.size > 0)
    .map(([file]) => file);
  if (exporters.length) {
    for (const [file, locals] of localImports) {
      const factories: Binding[] = [];
      for (const local of locals) {
        const python = file.endsWith('.py');
        const from = python
          ? pythonModuleFile(file, local.spec, exporters)
          : resolveLocal(file, local.spec, exporters);
        if (!from || from === file) continue;
        const exporter = scans.get(from) as FileScan;
        const client = exporter.exported.get(local.imported);
        const factory = exporter.exportedFactories.get(local.imported);
        if (!client && !factory) continue;
        const scan = scans.get(file) ?? emptyScan();
        scans.set(file, scan);
        if (client) {
          scan.clients.set(local.local, { ...client, line: local.line });
          noteImport(client.pkg, client.ecosystem, client.provider, file);
        }
        if (factory) {
          factories.push({ ...factory, local: local.local, factory: true, line: local.line });
          noteImport(factory.pkg, factory.ecosystem, factory.provider, file);
        }
      }
      // `const supabase = await createClient()`, with createClient imported from the repo's own lib.
      if (factories.length) {
        findClients(sourceByFile.get(file) as Source, factories, scans.get(file) as FileScan);
      }
    }
  }

  // Call sites become SDK usages, one per provider and package.
  const drafts = new Map<string, Draft>();
  const draftFor = (key: string, make: () => ApiUsage) => {
    let draft = drafts.get(key);
    if (!draft) {
      draft = { usage: make(), seen: new Set() };
      drafts.set(key, draft);
    }
    return draft;
  };
  const sdkLines = new Map<string, Set<number>>();
  const callsByPackage = new Map<string, number>();
  const componentSites = new Map<string, { binding: Binding; sites: CallSite[] }>();
  for (const [file, scan] of scans) {
    const source = sourceByFile.get(file) as Source;
    const python = source.ext === '.py';
    const constructionLines = new Set(scan.constructions.map((construction) => construction.line));
    const components = (bindingsByFile.get(file) ?? []).filter((binding) =>
      CONSTRUCTOR.test(binding.local),
    );
    for (const call of findCalls(source, scan, constructionLines, components)) {
      const { binding } = call;
      const entry = catalogEntry(binding.provider);
      const region = call.jsx ? '' : callRegion(source.lines, call.line - 1, call.column);
      const fields = call.jsx ?? topLevelFields(region, python);
      const model = entry?.models
        ? (MODEL.exec(region)?.[1] ??
          (scan.functions.has(binding.local) ? FIRST_STRING_ARG.exec(region)?.[1] : undefined))
        : undefined;
      const site: CallSite = {
        file,
        line: call.line,
        operation: call.operation,
        ...(fields.length ? { fields } : {}),
        notes: call.jsx
          ? 'Rendered SDK component (code scan); it calls the vendor from the browser.'
          : model
            ? `${NOTE} Model "${model}".`
            : NOTE,
      };
      if (call.jsx) {
        // Kept for packages with no other call (analytics, widgets, captcha), below.
        const list = componentSites.get(sdkKey(binding)) ?? { binding, sites: [] };
        list.sites.push(site);
        componentSites.set(sdkKey(binding), list);
        callsByPackage.set(`${binding.pkg}|${file}`, 1);
        continue;
      }
      const draft = draftFor(sdkKey(binding), () => ({
        repo,
        provider: binding.provider,
        via: 'sdk',
        callSites: [],
      }));
      const id = `${file}:${call.line}:${call.operation}`;
      if (draft.seen.has(id)) continue;
      draft.seen.add(id);
      draft.usage.callSites.push(site);
      callsByPackage.set(`${binding.pkg}|${file}`, 1);
      const lines = sdkLines.get(file) ?? new Set<number>();
      lines.add(call.line);
      sdkLines.set(file, lines);
      if (model && !draft.usage.pinnedVersion) {
        const offset = region.split('\n').findIndex((text) => text.includes(model));
        draft.usage.pinnedVersion = { value: model, file, line: call.line + Math.max(offset, 0) };
      }
      // A signed-webhook check through the SDK is the provider's webhook receiver, too.
      if (/webhook|constructEvent|verifyHeader|verify_header/i.test(call.operation)) {
        const webhook = draftFor(`${binding.provider}|webhook|`, () => ({
          repo,
          provider: binding.provider,
          via: 'webhook',
          callSites: [],
        }));
        if (!webhook.seen.has(id)) {
          webhook.seen.add(id);
          webhook.usage.callSites.push({ ...site, notes: 'Webhook signature check (code scan).' });
        }
      }
    }
  }
  // A UI-only SDK (<Analytics />, <InlineWidget />) is used through its components. A package that
  // also has calls keeps only those: its components (<PortableText />) are rendering, not requests.
  for (const [key, { binding, sites }] of componentSites) {
    if ((drafts.get(key)?.usage.callSites.length ?? 0) > 0) continue;
    const draft = draftFor(key, () => ({
      repo,
      provider: binding.provider,
      via: 'sdk',
      callSites: [],
    }));
    draft.usage.callSites.push(...sites);
  }
  // A pinned API version in a client's construction (Stripe's apiVersion) wins over a model a call
  // names; failing both, the model a client is made for (getGenerativeModel({ model })).
  for (const [file, scan] of scans) {
    const source = sourceByFile.get(file) as Source;
    for (const construction of scan.constructions) {
      const draft = drafts.get(sdkKey(construction.binding));
      if (!draft) continue;
      const region = callRegion(source.lines, construction.line - 1, construction.column);
      const rows = region.split('\n');
      const version = rows.findIndex((text) => API_VERSION.test(text));
      if (version !== -1) {
        const value = API_VERSION.exec(rows[version])?.[1] as string;
        draft.usage.pinnedVersion = { value, file, line: construction.line + version };
        continue;
      }
      if (draft.usage.pinnedVersion || !catalogEntry(construction.binding.provider)?.models) {
        continue;
      }
      const model = MODEL.exec(region)?.[1] ?? FIRST_STRING_ARG.exec(region)?.[1];
      if (model) {
        const row = Math.max(
          rows.findIndex((text) => text.includes(model)),
          0,
        );
        draft.usage.pinnedVersion = { value: model, file, line: construction.line + row };
      }
    }
  }

  // Raw HTTP: calls to known API hosts are usages; calls the scan cannot place are leads.
  const hostLines = new Map<string, { file: string; line: number; text: string }[]>();
  const codeHosts = new Set<string>();
  const baseUrls: string[] = [];
  const rawHttp: string[] = [];
  const internal: string[] = [];
  let internalCount = 0;
  const namedRawHttp: string[] = [];
  for (const source of sources) {
    const python = source.ext === '.py';
    const code = JS_LIKE.has(source.ext) || python || OTHER_CODE.has(source.ext);
    // Hosts this file names in code: a fetch with a runtime URL here likely goes to one of them.
    const fileHosts = code
      ? [
          ...new Set(
            source.lines
              .filter((line) => !isComment(line, python))
              .flatMap((line) =>
                [...line.matchAll(URL_HOST)].map((match) => match[1].toLowerCase()),
              )
              .filter((host) => !LOW_SIGNAL_HOST.test(host)),
          ),
        ]
      : [];
    source.lines.forEach((line, index) => {
      for (const match of line.matchAll(URL_HOST)) {
        const host = match[1].toLowerCase().replace(/[.-]+$/, '');
        const list = hostLines.get(host) ?? [];
        if (list.length < 20) list.push({ file: source.file, line: index + 1, text: clip(line) });
        hostLines.set(host, list);
        if (code && !isComment(line, python)) codeHosts.add(host);
      }
      // A client pointed at a service: often an SDK aimed at another vendor (OpenAI-compatible APIs).
      if (code && !isComment(line, python) && BASE_URL.test(line)) {
        baseUrls.push(`${source.file}:${index + 1}: ${clip(line)}`);
      }
      if (!code || isComment(line, python) || sdkLines.get(source.file)?.has(index + 1)) return;
      const call = HTTP_CALL.exec(line);
      if (!call) return;
      const after = line.slice(call.index + call[0].length);
      const url = URL_ONE.exec(after) ?? URL_ONE.exec(line);
      if (!url && /^\s*['"`]\//.test(after)) {
        internalCount += 1;
        if (internal.length < 3) internal.push(`${source.file}:${index + 1}: ${clip(line)}`);
        return;
      }
      let host = url?.[1].toLowerCase();
      let entry = host ? hostProvider(host) : undefined;
      // A URL built at runtime in a file whose only named host is a known API's: that API.
      const only = !host && fileHosts.length === 1 ? hostProvider(fileHosts[0]) : undefined;
      if (only) {
        host = fileHosts[0];
        entry = only;
      }
      if (!host || !entry) {
        const named = host ? [] : fileHosts.slice(0, 3);
        if (named.length) {
          namedRawHttp.push(
            `${source.file}:${index + 1}: ${clip(line)} [this file names ${named.join(', ')}]`,
          );
        } else {
          rawHttp.push(`${source.file}:${index + 1}: ${clip(line)}`);
        }
        return;
      }
      const region = callRegion(source.lines, index, call.index + call[0].length - 1);
      const method =
        /\bmethod\s*[:=]\s*['"`](\w+)['"`]/i.exec(region)?.[1]?.toUpperCase() ??
        /\.(get|post|put|patch|delete)\s*\(/i.exec(call[0])?.[1]?.toUpperCase() ??
        'GET';
      const urlPath = url
        ? (new RegExp(`${escape(url[0])}([^'"\`\\s?$]*)`).exec(line)?.[1] ?? '')
        : '';
      const draft = draftFor(`${entry.provider}|http|`, () => ({
        repo,
        provider: entry.provider,
        via: 'http',
        callSites: [],
      }));
      draft.usage.callSites.push({
        file: source.file,
        line: index + 1,
        operation: url ? `${method} ${urlPath || '/'}` : `${method} (URL built at runtime)`,
        notes: url
          ? `Raw HTTP to ${host} (code scan); response handling not read.`
          : `Raw HTTP with a URL built at runtime; this file names only ${host} (code scan).`,
      });
      draft.usage.hints = mergeHintLists(draft.usage.hints, { hosts: [host] });
    });
  }

  // Versions, lockfiles and hints for each SDK usage.
  for (const [key, { usage }] of drafts) {
    const entry = catalogEntry(usage.provider);
    const [, , pkg, ecosystem] = key.split('|');
    if (usage.via === 'sdk' && pkg) {
      usage.sdk = await sdkVersion(repoDir, pkg, ecosystem, dependencies);
    }
    const providerPackages = dependencies
      .filter(
        (dependency) =>
          dependencyProvider(dependency.manifest.ecosystem, dependency.name)?.provider ===
          usage.provider,
      )
      .map((dependency) => dependency.name);
    usage.hints = mergeHintLists(usage.hints, {
      packages: [...providerPackages, ...(usage.sdk ? [usage.sdk.name] : [])],
      hosts: entry?.hosts ?? [],
      docsUrls: entry?.docsUrls ?? [],
    });
    usage.callSites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  const usages: ScannedUsage[] = [...drafts]
    .filter(([, draft]) => draft.usage.callSites.length > 0)
    .map(([key, draft]) =>
      key.endsWith('|python') ? { ...draft.usage, ecosystem: 'python' as const } : draft.usage,
    );

  // ---- Leads: everything the scan could not settle, for the agent ----
  const recordedProviders = new Set(usages.map((usage) => usage.provider));
  const leads: LeadGroup[] = [];
  const group = (kind: string, title: string, items: string[], max = MAX_ITEMS) => {
    if (items.length === 0) return;
    leads.push({
      kind,
      title,
      items: items.slice(0, max),
      more: Math.max(0, items.length - max),
    });
  };

  const unknownDeps = new Map<string, string[]>();
  const notImported: string[] = [];
  for (const dependency of dependencies) {
    const hit = dependencyProvider(dependency.manifest.ecosystem, dependency.name);
    if (!hit) {
      if (dependency.dev) continue;
      const list = unknownDeps.get(dependency.manifest.file) ?? [];
      list.push(dependency.name);
      unknownDeps.set(dependency.manifest.file, list);
    } else if (
      !imported.has(`npm|${dependency.name}`) &&
      !imported.has(`python|${normalizePy(dependency.name)}`)
    ) {
      if (dependency.manifest.ecosystem === 'npm' || dependency.manifest.ecosystem === 'python') {
        notImported.push(
          `${dependency.name} (${hit.provider}) in ${dependency.manifest.file}:${dependency.line}${dependency.dev ? ', dev' : ''}`,
        );
      } else {
        notImported.push(
          `${dependency.name} (${hit.provider}, ${dependency.manifest.ecosystem}: the scan reads no ${dependency.manifest.ecosystem} call sites) in ${dependency.manifest.file}:${dependency.line}`,
        );
      }
    }
  }
  group(
    'unknown-dependencies',
    'Dependencies the scan does not know. Decide which talk to an external API (SDKs, API clients, webhook helpers) and find their call sites',
    [...unknownDeps].map(([file, names]) => `${file}: ${names.join(', ')}`),
  );
  // Per file: a file that imports a known SDK (or a client of one) where the scan saw no call.
  const noCall = [...imported.values()].flatMap(({ pkg, provider, files: where }) => {
    const silent = [...where].filter((file) => !callsByPackage.has(`${pkg}|${file}`));
    if (silent.length === 0) return [];
    const shown = silent.slice(0, 8).join(', ');
    return [
      `${pkg} (${provider}): no call found in ${shown}${silent.length > 8 ? ` and ${silent.length - 8} more files` : ''}`,
    ];
  });
  group(
    'sdk-without-calls',
    'Files that import a known SDK, or a client made from one, where the scan saw no call (a wrapper, a client passed around, a re-export, or UI components only)',
    noCall,
  );
  group(
    'sdk-not-imported',
    'Known SDKs declared but not imported anywhere the scan reads',
    notImported,
  );
  // Runtime-URL fetches in files that name a host come first: they are the likeliest external calls.
  group(
    'raw-http',
    'HTTP calls with no SDK, to a host the scan does not know or a URL built at runtime (follow the URL to its host; a provider used through its SDK and raw HTTP is two usages)',
    [...namedRawHttp, ...rawHttp],
    MAX_RAW_HTTP,
  );
  group(
    'base-urls',
    "Base URLs and endpoints set in code. An SDK pointed at another host is that vendor's API (an OpenAI-compatible provider, a proxy, a self-hosted server): record each one with the SDK that calls it",
    baseUrls,
    MAX_BASE_URLS,
  );
  const settledHosts = new Set(usages.flatMap((usage) => usage.hints?.hosts ?? []));
  // Hosts named in code come first: a link in a locale file or a README-like config is rarely an API.
  const unknownHosts = [...hostLines]
    .filter(([host]) => !LOW_SIGNAL_HOST.test(host) && !settledHosts.has(host))
    .filter(([host]) => {
      const entry = hostProvider(host);
      return !entry || !recordedProviders.has(entry.provider);
    })
    .sort(
      (a, b) =>
        Number(codeHosts.has(b[0])) - Number(codeHosts.has(a[0])) ||
        b[1].length - a[1].length ||
        a[0].localeCompare(b[0]),
    )
    .map(([host, list]) => {
      const first = list.find((entry) => codeHosts.has(host) && isCodeFile(entry.file)) ?? list[0];
      return `${host} (${list.length}${list.length === 20 ? '+' : ''}): ${first.file}:${first.line}: ${first.text}`;
    });
  group(
    'unknown-hosts',
    'Hosts in code and config the scan could not tie to a recorded usage (many are links, not APIs)',
    unknownHosts,
  );

  const envNames = new Map<string, string>();
  for (const source of sources) {
    source.lines.forEach((line, index) => {
      for (const match of line.matchAll(ENV_READ)) {
        const name = match.slice(1).find(Boolean) as string;
        if (SERVICE_ENV.test(name) && !envNames.has(name))
          envNames.set(name, `${source.file}:${index + 1}`);
      }
    });
  }
  group(
    'env',
    'Env names that look like a service URL, key or token (follow each to where it is used)',
    [...envNames].map(([name, where]) => `${name} (${where})`),
  );

  const graphql = sources.filter(
    (source) =>
      /\.(graphql|gql)$/.test(source.file) ||
      /\bgql\s*`|\bgraphql\s*\(|\b(query|mutation)\s+[A-Z]\w*\s*[({]/.test(source.text),
  );
  group(
    'graphql',
    'Files with GraphQL documents or clients (which API do they query?)',
    graphql.map((source) => source.file),
  );
  const webhookLines: string[] = [];
  for (const source of sources) {
    if (!(JS_LIKE.has(source.ext) || source.ext === '.py' || OTHER_CODE.has(source.ext))) continue;
    source.lines.forEach((line, index) => {
      if (
        WEBHOOK.test(line) &&
        !sdkLines.get(source.file)?.has(index + 1) &&
        !isComment(line, source.ext === '.py')
      ) {
        webhookLines.push(`${source.file}:${index + 1}: ${clip(line)}`);
      }
    });
  }
  // Checks and verifications first: a line that only says "webhook" is the weakest signal.
  const strength = (item: string) => Number(STRONG_WEBHOOK.test(item.replace(/^[^:]+:\d+: /, '')));
  group(
    'webhooks',
    'Webhook signals not tied to a scanned SDK call (receivers, signature checks, event handlers)',
    [...webhookLines].sort((a, b) => strength(b) - strength(a)),
  );
  const otherCode = sources.filter((source) => OTHER_CODE.has(source.ext)).length;
  if (otherCode > 0) {
    group(
      'other-languages',
      'Code in languages whose call sites the scan does not read (Go, Ruby, PHP, JVM, .NET and others)',
      [
        `${otherCode} files: ${[...new Set(sources.filter((source) => OTHER_CODE.has(source.ext)).map((source) => source.ext))].join(', ')}`,
      ],
    );
  }

  return {
    usages,
    leads,
    areas: suggestAreas(leads),
    internalCalls: { count: internalCount, examples: internal },
    stats: {
      files: files.length,
      sourceFiles: sources.filter(
        (source) => JS_LIKE.has(source.ext) || source.ext === '.py' || OTHER_CODE.has(source.ext),
      ).length,
      dependencies: dependencies.length,
      manifests: manifests.length,
    },
  };
}

// Leads that point at a file:line the agent has to read, as opposed to names (deps, env, hosts).
// Webhook signals are left out: the word alone fills that list in any app with a webhook feature.
const READ_LEADS = new Set(['base-urls', 'raw-http', 'graphql', 'sdk-without-calls']);
// Above this many, reading them one by one on the main model costs more than area readers do.
export const FAN_OUT_LEADS = 60;
const MAX_AREAS = 6;

/**
 * Where the leads to read are, by folder, when there are enough of them to fan out: a suggestion
 * the agent may take (one area reader each) or ignore. Empty below FAN_OUT_LEADS.
 */
function suggestAreas(leads: LeadGroup[]): { area: string; leads: number }[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const lead of leads.filter((found) => READ_LEADS.has(found.kind))) {
    total += lead.items.length + lead.more;
    for (const item of lead.items) {
      const file =
        lead.kind === 'sdk-without-calls'
          ? /no call found in ([^,\s]+)/.exec(item)?.[1]
          : /^([^:\s]+)/.exec(item)?.[1];
      if (!file) continue;
      const segments = file.split('/');
      const area = segments.slice(0, Math.min(3, Math.max(segments.length - 1, 1))).join('/');
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }
  }
  if (total < FAN_OUT_LEADS) return [];
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, MAX_AREAS - 1).map(([area, count]) => ({ area, leads: count }));
  const rest = sorted.slice(MAX_AREAS - 1).reduce((sum, [, count]) => sum + count, 0);
  return rest ? [...top, { area: 'everything else', leads: rest }] : top;
}

const URL_HOST = /\bhttps?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+\.[a-z]{2,}|localhost)/gi;
const URL_ONE = new RegExp(URL_HOST.source, 'i');
// `baseURL: 'https://api.deepseek.com/v1'`, `base_url="http://localhost:11434"`, `endpoint = "https://..."`.
const BASE_URL =
  /\b(?:base_?ur[li]|api_?(?:base|url|host|endpoint)|endpoint|host_?url|server_?url)\b['"]?\s*[:=]\s*['"`]https?:\/\//i;
// Every one is listed: lobe-chat names 47 OpenAI-compatible providers this way.
const MAX_BASE_URLS = 120;
const MAX_RAW_HTTP = 80;
const isCodeFile = (file: string) => {
  const ext = path.posix.extname(file);
  return JS_LIKE.has(ext) || ext === '.py' || OTHER_CODE.has(ext);
};
const HTTP_CALL =
  /\bfetch\s*\(|\$fetch\s*\(|\bofetch\s*\(|\b(?:axios|got|ky|superagent|needle)(?:\s*\.\s*(?:get|post|put|patch|delete|head|request))?\s*\(|\brequests\s*\.\s*(?:get|post|put|patch|delete|head|request)\s*\(|\bhttpx\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\bsession\s*\.\s*(?:get|post|put|patch|delete)\s*\(|\burlopen\s*\(|\bhttp\s*\.\s*(?:Get|Post|NewRequest|NewRequestWithContext)\s*\(|\bNet::HTTP\b|\bHTTParty\s*\.\s*\w+|\bFaraday\s*\.\s*\w+|\bRestClient\s*\.\s*\w+|\bcurl\s+-|\bwget\s+/;
// Receivers and their checks: signatures, WebSub verification (hub.challenge, used by Meta, Twitch
// and YouTube) and shared-token checks (Slack slash commands and the like).
const WEBHOOK =
  /webhook|stripe-signature|x-hub-signature|x-shopify-hmac|x-twilio-signature|x-slack-signature|svix|createHmac|hmac\.new|compare_digest|timingSafeEqual|constructEvent|hub\.(?:challenge|verify_token|mode)|signing_?secret|verification_?token/i;
const STRONG_WEBHOOK =
  /signature|svix|createHmac|hmac\.new|compare_digest|timingSafeEqual|constructEvent|hub\.(?:challenge|verify_token|mode)|signing_?secret|verification_?token|validate_?webhook|verify_?webhook/i;
const ENV_READ =
  /process\.env\.([A-Za-z_]\w*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]|import\.meta\.env\.([A-Za-z_]\w*)|os\.environ\[\s*['"]([^'"]+)['"]\s*\]|os\.environ\.get\(\s*['"]([^'"]+)['"]|getenv\(\s*['"]([^'"]+)['"]|\bENV\[\s*['"]([^'"]+)['"]\s*\]|^\s*([A-Z][A-Z0-9_]+)\s*=/g;
const SERVICE_ENV = /URL|URI|HOST|ENDPOINT|BASE|API|KEY|TOKEN|SECRET|WEBHOOK|DSN|_ID$/;

const clip = (line: string) => line.trim().slice(0, 160);
const normalizePy = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function pythonPackageFor(
  entry: CatalogEntry | undefined,
  module: string,
  dependencies: { name: string; manifest: Manifest }[],
): string {
  const packages = entry?.python?.packages ?? [];
  const declared = dependencies.find(
    (dependency) =>
      dependency.manifest.ecosystem === 'python' &&
      packages.some((known) => normalizePy(known) === normalizePy(dependency.name)),
  );
  if (declared) return declared.name;
  // Undeclared: the package whose module this is, by the catalog's order.
  const index = entry?.python?.modules.indexOf(module) ?? -1;
  return packages[Math.max(index, 0)] ?? module.split('.')[0];
}

const sdkKey = (binding: Pick<Binding, 'provider' | 'pkg' | 'ecosystem'>) =>
  `${binding.provider}|sdk|${binding.pkg}|${binding.ecosystem}`;

const NPM_LOCKS =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock)$/;
const PYTHON_LOCKS = /(^|\/)(poetry\.lock|uv\.lock|Pipfile\.lock)$/;

// The version from the package's own ecosystem: the lockfile first, then the manifest range. A
// Python manifest stands in for the lockfile when there is none, so the two "stripe"s stay apart.
async function sdkVersion(
  repoDir: string,
  pkg: string,
  ecosystem: string,
  dependencies: { name: string; version: string; manifest: Manifest }[],
): Promise<NonNullable<ApiUsage['sdk']>> {
  const lockPattern = ecosystem === 'python' ? PYTHON_LOCKS : NPM_LOCKS;
  const locked = (await lockedVersions(repoDir, pkg).catch(() => [])).find((entry) =>
    lockPattern.test(entry.lockfile),
  );
  if (locked) return { name: pkg, version: locked.version, lockfile: locked.lockfile };
  const declared = dependencies.find(
    (dependency) =>
      dependency.manifest.ecosystem === ecosystem &&
      (dependency.name === pkg || normalizePy(dependency.name) === normalizePy(pkg)),
  );
  return {
    name: pkg,
    version: declared?.version ?? '',
    ...(ecosystem === 'python' && declared ? { lockfile: declared.manifest.file } : {}),
  };
}

function mergeHintLists(existing: ProviderHints | undefined, added: ProviderHints): ProviderHints {
  const merged: ProviderHints = {};
  for (const kind of ['packages', 'hosts', 'docsUrls'] as const) {
    const values = [...new Set([...(existing?.[kind] ?? []), ...(added[kind] ?? [])])];
    if (values.length) merged[kind] = values;
  }
  return merged;
}

/** The scan as text for the agent's task prompt: what it recorded, then every lead it left. */
export function scanEvidence(scan: ScanResult): string {
  const recorded = scan.usages.length
    ? scan.usages
        .map((usage) => {
          const files = [...new Set(usage.callSites.map((site) => site.file))];
          const sdk = usage.sdk ? ` ${usage.sdk.name} ${usage.sdk.version}`.trimEnd() : '';
          const pinned = usage.pinnedVersion ? `, pins ${usage.pinnedVersion.value}` : '';
          return `- ${usage.provider} via ${usage.via}${sdk}${pinned}: ${usage.callSites.length} call site(s) in ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` and ${files.length - 6} more files` : ''}`;
        })
        .join('\n')
    : '- nothing';
  const leads = scan.leads.length
    ? scan.leads
        .map(
          (lead) =>
            `### ${lead.title}\n${lead.items.map((item) => `- ${item}`).join('\n')}${lead.more ? `\n- … ${lead.more} more (use the helper scanners)` : ''}`,
        )
        .join('\n\n')
    : 'None.';
  const internal = scan.internalCalls.count
    ? `\n\nNot recorded, as calls to the repo's own routes (relative URLs): ${scan.internalCalls.count}, for example:\n${scan.internalCalls.examples.map((example) => `- ${example}`).join('\n')}`
    : '';
  const areas = scan.areas?.length
    ? `\n\n## Suggested areas for area readers\n\nThere are more leads to read than one reader should take on. Fan out: one area reader per area, each given its area's leads (file:line) from the lists below.\n${scan.areas.map((area) => `- ${area.area}: ${area.leads} leads`).join('\n')}`
    : '';
  return `## What the code scan found (no AI)

${scan.stats.files} files, ${scan.stats.sourceFiles} of them code; ${scan.stats.manifests} manifests with ${scan.stats.dependencies} dependencies.

Recorded already (list_recorded_usages shows them in full; do not record them again):
${recorded}${areas}

## Leads the scan could not settle

${leads}${internal}`;
}

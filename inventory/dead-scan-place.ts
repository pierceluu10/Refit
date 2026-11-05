// Where a name sits, from the text around it: a check, a catalog entry, a picker, or prose. The classes
// and their word lists come from the old registry's classifier (PR #72); this reads them with a lexer.
import { catalogEntry } from './catalog.ts';
import { innerText, lineIndexAt, type Source, type Span } from './dead-scan-lex.ts';

export type Place = {
  kind: 'comment' | 'catalog' | 'picker' | 'unclear';
  reason: string;
  /** A list a value must be in before the code goes on: what it holds is all that can be sent. */
  guardedBy?: string;
  /** A key in a table the code walks: what's sent may be the key, or what the code turns it into. */
  tableKey?: boolean;
  /** A model's record beside its metadata, which a picker may offer: what's picked is what's sent. */
  modelRecord?: boolean;
};

// The registry's model-id shapes, to count a list of models that mixes providers.
const MODEL_SHAPES = [
  /^(?:openai\/)?(?:gpt-|chatgpt-|o\d(?:-|$)|text-(?:davinci|curie|babbage|ada|embedding|moderation)-|(?:davinci|curie|babbage|ada)(?:-|$)|dall-e-|tts-|whisper-|codex-|computer-use-|omni-moderation-|sora-)/,
  /^(?:anthropic\/)?claude-/,
  /^(?:google\/|models\/)?gemini-/,
  /^(?:meta\/|groq\/)?(?:llama|mixtral|gemma|deepseek|qwen)/i,
  /^(?:moonshotai\/)?(?:moonshot-v1-|kimi-)/,
];
const isModelName = (text: string) => MODEL_SHAPES.some((shape) => shape.test(text.trim()));

const CATALOG_SIZE = 3;
const MAX_ENCLOSING_WALK = 20_000;
const LOOK_AROUND_CHARS = 64;
const MODEL_KEY_LOOK_BACK_CHARS = 200;
const FUNCTION_LOOK_BACK_CHARS = 2_000;

const TOKENIZER_CALL = /\b(?:encoding_for_model|encodingForModel)\s*\(\s*$/;
const TOKENIZER_LINE = /\btiktoken\b/i;
const PRICE_CALL = /\b\w*(?:cost|price|pricing)\w*\s*\(\s*$/i;
// A name that says it looks a price up. withCostLimit() or runLowCost() may well send what they're given.
const PRICE_LOOKUP =
  /\b(?:(?:get|calc|comput|estimat|look_?up|find|fetch|model|tokens?|usage|total|input|output)\w*?)?(?:cost|price|pricing)s?(?:_?(?:for|of|per\w*|lookup|table|info|data|usd))?\s*\(\s*$/i;
const DISPLAY_KEY =
  /(?:^|[\s{,])["']?(?:placeholder|title|alt|label|aria-label|tooltip|helperText)["']?\s*[:=]\s*\{?\s*$/i;
const CHECK_CALL =
  /\.(?:startsWith|endsWith|startswith|endswith|includes|indexOf|has|match|test)\s*\(\s*$/;
const COMPARE_BEFORE = /[=!]==?\s*$/;
const COMPARE_AFTER = /^\s*[=!]==?/;
const CASE_LABEL = /\bcase\s*$/;
const IN_AFTER = /^\s*(?:not\s+)?in\b/;
const IN_BEFORE = /\b(?:not\s+)?in\s*$/;
// `for m in [...]` walks the list, and may send each one. Only `m in [...]` checks a value against it.
const FOR_IN_BEFORE = /\bfor\s+[\w\s,()]*\bin\s*$/;
// `any(x in name for x in ("a", "b"))`: what the walk does with each one, when that's the whole of it.
const WALK_OPEN = /^([\s\S]*)\bfor\s+(\w+)\s+in\s*$/;
const WALK_TEST = (word: string) =>
  new RegExp(
    `^\\s*\\(?\\s*(?:${word}\\s+(?:not\\s+)?in\\s+[\\w$.\\[\\]]+|[\\w$.\\[\\]]+\\.(?:startswith|endswith)\\(\\s*${word}\\s*\\)|[\\w$.\\[\\]]+\\s*[=!]=\\s*${word}|${word}\\s*[=!]=\\s*[\\w$.\\[\\]]+)\\s*\\)?\\s*$`,
  );
// `["a", "b"].some((x) => name.includes(x))`, the same in JS.
const SOME_TEST_AFTER =
  /^\s*\.(?:some|every)\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*[\w$.\[\]?]*(?:\.(?:includes|startsWith|endsWith|indexOf)\(\s*\1\s*\)|\s*[=!]==?\s*\1\b|\1\s*[=!]==?)/;
const WALK_LOOK_CHARS = 200;
// A bare word where an id goes: /v18.0/pixel_id/events can't be a request unless the code fills it in.
const PLACEHOLDER_IN_URL = /^https?:\/\/[^/\s]+\/(?:[^/\s?#]+\/)*?([a-z]\w*_id)(?:[/?#]|$)/i;
// `assert x in NAME`, or a rejection when it isn't: the code stops unless the value is on the list.
const GUARDED_BY = (name: string) =>
  new RegExp(
    `\\bassert\\s+[\\w$.\\[\\]"']+\\s+in\\s+${name}\\b|\\bif\\s+[\\w$.\\[\\]"']+\\s+not\\s+in\\s+${name}\\b|\\bif\\s*\\(\\s*!\\s*${name}\\.(?:includes|has)\\(`,
  );
const LIST_CHECK_AFTER = /^\s*\.(?:includes|indexOf|has)\s*\(/;
const MEMBER_CHECK_AFTER = /^\s*\??\.(?:includes|indexOf|has|contains)\s*\(/;
const DEFINITION_AFTER = /^\s*(?::[^=\n]*)?=(?!=)/;
const DEFINITION_BEFORE = /\b(?:enum|type|interface)\s+$/;
const EXPORTED_BEFORE = /\bexport\b/;
const IN_NAME_BEFORE = /\b(?:not\s+)?in\s+$/;
const FOR_STATEMENT = /^\s*(?:async\s+)?for\s/;
const KEY_READ_BEFORE = /(?:\bObject\.(?:keys|entries)\(\s*|\bfor\s+[\w\s,()]*\b(?:in|of)\s+)$/;
const KEY_READ_AFTER = /^\s*\.(?:keys|items)\s*\(/;
const MEMBERSHIP =
  /(?:\bnew\s+(?:Set|Map|WeakSet|WeakMap)(?:<[^>]*>)?\s*\(|\b(?:frozenset|set)\s*\()\s*$/;
const LITERAL_TYPE = /\bLiteral\s*$/;
const ENUM_OPEN = /\benum\s+(\w+)\s*$/;
const TYPE_OPEN = /\b(?:interface\s+\w+[^{]*|type\s+\w+[^=\n]*=\s*)$/;
const TYPE_LINE = /^\s*(?:export\s+)?type\s+\w+/;
const VERSIONS_KEY = /\bversions["']?\s*[:=]\s*$/;
const OPTION_TAG = /<(?:option|SelectItem|MenuItem|Select\.Option|Option)\b/;
const OPTION_WITH_VALUE = /<(?:option|SelectItem|MenuItem|Select\.Option|Option)\b[^>]*\bvalue=/;
const PICKER_NAME = /model|option|choice|select|dropdown|picker/i;
const DENY_NAME = /deprecated|retired|legacy|unsupported|blocked|denied|deny/i;
const METADATA_NAME = /(?:^|\.)(?:keywords|tags|categories|topics)$/i;
const TABLE_NAME =
  /([\w$.]+)["']?\s*(?::[^=\n,]*)?[:=]\s*(?:(?:new\s+)?[\w$.]*\s*(?:<[^>]*>)?\s*\(\s*\[?\s*)?$/;
const ASSIGNED_NAME = /([\w$.]+)["']?\s*(?::[^=\n,]*)?[:=]\s*$/;
const CALL_NAME = /([\w$.]+)\s*$/;
const RETURN_BEFORE = /\breturn\s*$/;
const FUNCTION_NAME = /(?:\bdef\s+|\bfunction\s+|\b(?:const|let|var)\s+)([\w$]+)/g;
const RECORD_NAME_KEY = /(?:^|[\s{,])["']?(?:id|name)["']?\s*[:=]\s*$/;
const RECORD_METADATA =
  /\b(?:contextWindow|context_window|contextLength|context_length|maxOutputTokens|max_output_tokens|maxInputTokens|max_input_tokens|inputTokenLimit|outputTokenLimit|knowledgeCutoff|knowledge_cutoff|pricing|cost|owned_by)\b/;
const OPTION_VALUE_KEY = /(?:^|[\s{,])["']?value["']?\s*[:=]\s*$/;
const LABEL_KEY = /\blabel\b/;
// What's before a `[` that indexes a value, as opposed to one that opens a list.
const INDEXED_VALUE = /(?:[\w$)\]])\s*$/;
const LIST_KEYWORD_BEFORE = /\b(?:return|in|of|yield|await|case)\s*$/;
// Text that sets a model right before a name inside a longer string, so it isn't prose.
const MODEL_KEYS = [
  /(?:^|[^a-z0-9_-])[a-z0-9_-]*model(?:[_-]?(?:id|name))?["'\s]*[:=]\s*$/i,
  /(?:^|\s)(?:--[a-z-]*model(?:[_-]?(?:id|name))?|-m)["'=\s]*$/i,
  /(?:^|[^A-Z0-9_])[A-Z0-9_]*MODEL["'\s]*$/,
];
// Printable ASCII with no space is a bare value. Chinese or Japanese prose has no spaces either.
const BARE_VALUE = /^[\x21-\x7e]*$/;
// What a template fills in is code, so a space in f"https://x/{quote(a, safe='')}" isn't a word break.
const TEMPLATE_HOLE = /\$?\{[^{}]*\}/g;
// A string that opens like GraphQL or a request is what gets sent, whatever it says.
const REQUEST_TEXT =
  /^\s*(?:(?:query|mutation|subscription|fragment)\b|(?:GET|POST|PUT|PATCH|DELETE|curl)\s)/;
// A query held in a template that opens on a field: `... on Commit {`, `nodes {` or `commit {oid url}`.
// Two fields at least, since `Model {name}` is how a Python f-string fills in one value.
const GRAPHQL_SELECTION =
  /\.\.\.\s*on\s+[A-Z]\w*\s*\{|\b(?:nodes|edges|pageInfo)\s*\{|\b[a-zA-Z_]\w*(?:\([^()\n]*\))?\s*\{\s*[a-zA-Z_]\w*(?:\s+[a-zA-Z_]\w*)+\s*\}/;
const WHOLE_JSON = /^\s*[{[][\s\S]*[}\]]\s*$/;
// The value of a quoted key on its own line, as in "model": "gpt-4".
const QUOTED_KEY_VALUE = /["'][\w.-]+["']\s*:\s*["']?$/;
const BEFORE_STATEMENT_STRING = /[(,=[{+%]$/;
// A tag, then words, with no code in between: JSX text, not a quoted value. <td>use 'x'</td>.
// An opening tag right after a name is a generic: send(r as Req<Body>, 'x').
const JSX_TEXT = /(?:<\/|(?<![\w$.)\]])<)[A-Za-z][^<>]*>\s*[^(\s<>{}=;&|][^<>{}=;&|]*$/;
// What can sit right before an object literal's brace, as opposed to a block's.
const BEFORE_OBJECT = /(?:[=:,([]|\breturn|\bin)\s*$/;
const PACKAGE_MANIFEST = /(?:^|\/)package\.json$/;
const SCRIPTS_KEY = /"scripts"\s*:\s*$/;

type Enclosure = { open: number; char: string };

export function enclosing(code: string, offset: number): Enclosure | undefined {
  let depth = 0;
  for (let at = offset - 1; at >= Math.max(0, offset - MAX_ENCLOSING_WALK); at -= 1) {
    const char = code[at];
    if (char === ')' || char === ']' || char === '}') depth += 1;
    else if (char === '(' || char === '[' || char === '{') {
      if (depth === 0) return { open: at, char };
      depth -= 1;
    }
  }
  return undefined;
}

/** The offset of the bracket closing an open one, or where the walk gave up. */
export function closeOf(code: string, open: number): number {
  let depth = 0;
  const limit = Math.min(code.length, open + MAX_ENCLOSING_WALK);
  for (let at = open; at < limit; at += 1) {
    const char = code[at];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth <= 0) return at;
    }
  }
  return limit;
}

const before = (text: string, offset: number, chars = LOOK_AROUND_CHARS) =>
  text.slice(Math.max(0, offset - chars), offset);
const after = (text: string, offset: number) => text.slice(offset, offset + LOOK_AROUND_CHARS);

const prevChar = (code: string, offset: number) => before(code, offset).trimEnd().at(-1) ?? '';
const nextChar = (code: string, offset: number) => after(code, offset).trimStart()[0] ?? '';

// A triple-quoted string standing alone: a docstring, which nothing sends.
function isDocstring(source: Source, span: Span): boolean {
  if (span.quote?.length !== 3) return false;
  const lineStart = source.lineStarts[lineIndexAt(source, span.start)];
  if (source.code.slice(lineStart, span.start).trim() !== '') return false;
  return !BEFORE_STATEMENT_STRING.test(before(source.code, span.start).trimEnd());
}

function isJsxText(source: Source, span: Span): boolean {
  if (source.mode !== 'js') return false;
  const lineStart = source.lineStarts[lineIndexAt(source, span.start)];
  return JSX_TEXT.test(source.code.slice(lineStart, span.start));
}

/** Whether a string holds a GraphQL selection, so what it names is asked for, not mentioned. */
export const isGraphqlText = (source: Source, span: Span) =>
  span.kind === 'string' && GRAPHQL_SELECTION.test(innerText(source, span));

// A value under "scripts" in a package.json is a shell command, however much it reads like a sentence.
function isPackageScript(source: Source, span: Span): boolean {
  if (!PACKAGE_MANIFEST.test(source.file)) return false;
  const object = enclosing(source.code, span.start);
  return object?.char === '{' && SCRIPTS_KEY.test(before(source.text, object.open));
}

/** Whether a name in a longer string is prose, such as an error message, and not what the code sends. */
export function isProse(source: Source, span: Span, name: string, offset: number): boolean {
  if (span.kind !== 'string') return false;
  if (isPackageScript(source, span)) return false;
  if (isJsxText(source, span)) return true;
  const inner = innerText(source, span);
  if (inner.trim() === name || BARE_VALUE.test(inner.replace(TEMPLATE_HOLE, ''))) return false;
  if (isDocstring(source, span)) return true;
  if (REQUEST_TEXT.test(inner) || GRAPHQL_SELECTION.test(inner)) return false;
  const lineStart = source.lineStarts[lineIndexAt(source, offset)];
  const start = Math.max(span.innerStart, lineStart, offset - MODEL_KEY_LOOK_BACK_CHARS);
  const ahead = source.text.slice(start, offset);
  if (MODEL_KEYS.some((key) => key.test(ahead)) || QUOTED_KEY_VALUE.test(ahead)) return false;
  return !(WHOLE_JSON.test(inner) && /["']$/.test(ahead));
}

// Every name a loop or `.some` takes from the list is only tested, so none of them is sent.
function onlyTested(source: Source, list: Enclosure): boolean {
  const { code } = source;
  const close = closeOf(code, list.open);
  if (SOME_TEST_AFTER.test(code.slice(close + 1, close + 1 + WALK_LOOK_CHARS))) return true;
  const parent = enclosing(code, list.open);
  if (!parent) return false;
  const walk = WALK_OPEN.exec(code.slice(parent.open + 1, list.open));
  return walk !== null && WALK_TEST(walk[2]).test(walk[1]);
}

function isPlaceholderUrl(source: Source, span: Span): boolean {
  const word = PLACEHOLDER_IN_URL.exec(innerText(source, span))?.[1];
  if (!word) return false;
  return !new RegExp(`\\.replace(?:All)?\\(\\s*["'\`/]${word}`).test(source.text);
}

function checkPlace(source: Source, span: Span): Place | undefined {
  const { code } = source;
  if (isPlaceholderUrl(source, span)) {
    return {
      kind: 'catalog',
      reason: 'a URL with a placeholder where the id goes, so not a request',
    };
  }
  const line = source.lines[lineIndexAt(source, span.start)];
  const ahead = before(code, span.start);
  const behind = after(code, span.end);
  if (span.quote === '/') return { kind: 'catalog', reason: 'a regex literal that checks a name' };
  if (TOKENIZER_CALL.test(ahead) || TOKENIZER_LINE.test(line)) {
    return { kind: 'catalog', reason: 'a local tokenizer call, not a request' };
  }
  if (PRICE_LOOKUP.test(ahead)) return { kind: 'catalog', reason: 'a local price lookup' };
  if (PRICE_CALL.test(ahead)) {
    return { kind: 'unclear', reason: 'handed to a function named for cost, which may send it' };
  }
  if (DISPLAY_KEY.test(ahead)) return { kind: 'catalog', reason: 'text shown to a user, not sent' };
  if (CHECK_CALL.test(ahead)) return { kind: 'catalog', reason: 'a prefix or membership check' };
  if (COMPARE_BEFORE.test(ahead) || COMPARE_AFTER.test(behind)) {
    return { kind: 'catalog', reason: 'a comparison, not what the code sends' };
  }
  if (CASE_LABEL.test(ahead)) return { kind: 'catalog', reason: 'a switch case label' };
  if (IN_AFTER.test(behind)) return { kind: 'catalog', reason: 'an `in` membership check' };
  const list = enclosing(code, span.start);
  if (!list) return undefined;
  const beforeList = before(code, list.open);
  const inList = IN_BEFORE.test(beforeList) && !FOR_IN_BEFORE.test(beforeList);
  if (inList || CHECK_CALL.test(beforeList)) {
    return { kind: 'catalog', reason: 'a list a value is checked against' };
  }
  if (onlyTested(source, list)) {
    return { kind: 'catalog', reason: 'each name is only tested against a value, never sent' };
  }
  if (LIST_CHECK_AFTER.test(after(code, closeOf(code, list.open) + 1))) {
    return { kind: 'catalog', reason: 'a list a value is checked against' };
  }
  return undefined;
}

function countModels(source: Source, open: number, close: number): number {
  const names = new Set<string>();
  for (const span of source.spans) {
    if (span.start > close) break;
    if (span.kind === 'string' && span.start > open && isModelName(innerText(source, span))) {
      names.add(innerText(source, span).trim());
    }
  }
  return names.size;
}

// The name a list goes by: its assignment or key, the call it's passed to, or the function returning it.
export function listName(source: Source, list: Enclosure): string {
  const ahead = before(source.text, list.open);
  const assigned = ASSIGNED_NAME.exec(ahead)?.[1];
  if (assigned) return assigned;
  if (RETURN_BEFORE.test(ahead)) {
    const functions = [
      ...before(source.text, list.open, FUNCTION_LOOK_BACK_CHARS).matchAll(FUNCTION_NAME),
    ];
    return functions.at(-1)?.[1] ?? '';
  }
  const parent = enclosing(source.code, list.open);
  return parent?.char === '(' ? (CALL_NAME.exec(before(source.text, parent.open))?.[1] ?? '') : '';
}

type TableUse = { checked: boolean; read: boolean; exported: boolean };

// What the rest of the file does with a table or list's name. A check sends nothing; anything else may.
export const wordPattern = (word: string) =>
  new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');

function tableUse(source: Source, name: string): TableUse {
  const word = name.split('.').at(-1) ?? name;
  const pattern = wordPattern(word);
  const use: TableUse = { checked: false, read: false, exported: false };
  for (const match of source.code.matchAll(pattern)) {
    const lineStart = source.lineStarts[lineIndexAt(source, match.index)];
    const ahead = source.code.slice(lineStart, match.index);
    const behind = after(source.code, match.index + word.length);
    if (DEFINITION_AFTER.test(behind) || DEFINITION_BEFORE.test(ahead)) {
      // A module-level Python name can be imported from anywhere.
      if (EXPORTED_BEFORE.test(ahead) || (source.mode === 'python' && ahead === '')) {
        use.exported = true;
      }
    } else if (
      MEMBER_CHECK_AFTER.test(behind) ||
      (IN_NAME_BEFORE.test(ahead) && !FOR_STATEMENT.test(ahead))
    ) {
      use.checked = true;
    } else {
      use.read = true;
    }
  }
  return use;
}

function tablePlace(source: Source, name: string | undefined, what: string): Place {
  if (!name) return { kind: 'unclear', reason: `${what}, handed straight to code` };
  const use = tableUse(source, name);
  return use.read || use.exported
    ? { kind: 'unclear', reason: `${what}, and the code reads ${name}, so it may send one` }
    : { kind: 'catalog', reason: `${what} that nothing here reads` };
}

const tableName = (source: Source, list: Enclosure) =>
  TABLE_NAME.exec(before(source.text, list.open))?.[1];

function objectPlace(source: Source, span: Span, list: Enclosure): Place | undefined {
  const ahead = before(source.code, list.open);
  const enumName = ENUM_OPEN.exec(ahead)?.[1];
  if (enumName) return tablePlace(source, enumName, 'an enum of model names');
  if (TYPE_OPEN.test(ahead)) return { kind: 'catalog', reason: 'a type position' };
  if (!BEFORE_OBJECT.test(ahead)) return undefined;
  const close = closeOf(source.code, list.open);
  const body = source.text.slice(list.open, close);
  const keyBefore = source.text.slice(list.open, span.start);
  if (RECORD_NAME_KEY.test(keyBefore) && RECORD_METADATA.test(body)) {
    return {
      kind: 'catalog',
      modelRecord: true,
      reason: 'a model record beside metadata such as its context window',
    };
  }
  if (OPTION_VALUE_KEY.test(keyBefore) && LABEL_KEY.test(body)) {
    return { kind: 'picker', reason: 'an option record offered to users, with a label and value' };
  }
  return countModels(source, list.open, close) < CATALOG_SIZE
    ? undefined
    : tablePlace(source, tableName(source, list), 'a table of model names');
}

function pickerPlace(source: Source, list: Enclosure): Place | undefined {
  const name = listName(source, list);
  if (METADATA_NAME.test(name)) return { kind: 'catalog', reason: `package metadata: ${name}` };
  if (!PICKER_NAME.test(name)) return undefined;
  const use = tableUse(source, name);
  const denied = DENY_NAME.test(name);
  // The name says what it's for, not what the code does with it.
  if (denied && use.read) {
    return { kind: 'unclear', reason: `a list named ${name}, and the code reads it` };
  }
  if (denied || (use.checked && !use.read)) {
    return {
      kind: 'catalog',
      reason: `a list a value is checked against, named ${name}`,
      ...(GUARDED_BY(name).test(source.code) && !denied ? { guardedBy: name } : {}),
    };
  }
  return { kind: 'picker', reason: `a list a dead model can be picked from, named ${name}` };
}

function listPlace(source: Source, span: Span, list: Enclosure): Place | undefined {
  const { code } = source;
  const ahead = before(code, list.open);
  const parent = enclosing(code, list.open);
  const inMap = parent?.char === '[' && MEMBERSHIP.test(before(code, parent.open));
  if (MEMBERSHIP.test(ahead) || inMap) {
    // A Map's values are what it hands back, and its keys and a Set's members are only looked up.
    const isValue = inMap && prevChar(code, span.start) === ',';
    const table = tableName(source, inMap && parent ? parent : list);
    if (isValue) return tablePlace(source, table, 'a Map holding model names');
    const use = table ? tableUse(source, table) : undefined;
    return use?.read && !use.checked
      ? { kind: 'unclear', reason: `a Set or Map of names, and the code reads ${table}` }
      : { kind: 'catalog', reason: 'a Set or Map of names' };
  }
  if (LITERAL_TYPE.test(ahead)) return { kind: 'catalog', reason: 'a type position' };
  if (VERSIONS_KEY.test(before(source.text, list.open))) {
    return { kind: 'catalog', reason: "a model reference's versions list" };
  }
  if (list.char === '[') {
    const picker = pickerPlace(source, list);
    if (picker) return picker;
  }
  return countModels(source, list.open, closeOf(code, list.open)) >= CATALOG_SIZE
    ? tablePlace(source, tableName(source, list), `a list of ${CATALOG_SIZE} or more model names`)
    : undefined;
}

function tableKeyPlace(source: Source, span: Span): Place {
  const list = enclosing(source.code, span.start);
  const name = list && tableName(source, list);
  const word = name?.split('.').at(-1);
  const keysRead =
    word !== undefined &&
    [...source.code.matchAll(wordPattern(word))].some(
      (match) =>
        KEY_READ_BEFORE.test(before(source.code, match.index)) ||
        KEY_READ_AFTER.test(after(source.code, match.index + word.length)),
    );
  return keysRead
    ? {
        kind: 'unclear',
        tableKey: true,
        reason: `a key in a table, and the code walks the keys of ${name}`,
      }
    : { kind: 'catalog', reason: 'a key in a table, such as prices or context windows' };
}

function catalogPlace(source: Source, span: Span): Place | undefined {
  const { code } = source;
  const previous = prevChar(code, span.start);
  const next = nextChar(code, span.end);
  const line = source.lines[lineIndexAt(source, span.start)];
  if (OPTION_TAG.test(line)) return { kind: 'picker', reason: 'an <option> offered to users' };
  if (next === ':' && (previous === '{' || previous === ',' || previous === '')) {
    return tableKeyPlace(source, span);
  }
  if (previous === '[' && next === ']') {
    const ahead = before(code, span.start).trimEnd().slice(0, -1);
    if (INDEXED_VALUE.test(ahead) && !LIST_KEYWORD_BEFORE.test(ahead))
      return { kind: 'catalog', reason: 'an index into a table' };
  }
  // A single | is a type union. || is a default, which the code does send.
  const isUnion =
    (previous === '|' && !before(code, span.start).trimEnd().endsWith('||')) ||
    (next === '|' && !after(code, span.end).trimStart().startsWith('||'));
  if (isUnion || TYPE_LINE.test(line)) return { kind: 'catalog', reason: 'a type position' };
  const list = enclosing(code, span.start);
  if (!list) return undefined;
  return list.char === '{' ? objectPlace(source, span, list) : listPlace(source, span, list);
}

const INI_COMMENT = /^\s*;/;
const PROSE_CONFIG_KEY =
  /^\s*-?\s*["']?(?:description|summary|about|comment|notes?|help|message)["']?\s*[:=]/i;

const isLineKey = (line: string, name: string) =>
  line.trimStart().replace(/^-\s*/, '').startsWith(`${name}:`);

/** Where a name in a string sits. Model tables and lists only apply to providers that have models. */
export function stringPlace(source: Source, span: Span, provider: string): Place | undefined {
  const check = checkPlace(source, span);
  if (check) return check;
  return catalogEntry(provider)?.models ? catalogPlace(source, span) : undefined;
}

/** Where a name sits in config text outside quotes, as in `gpt-4: 8192` or `<option>gpt-4</option>`. */
export function textPlace(line: string, name: string, provider: string): Place | undefined {
  if (INI_COMMENT.test(line)) return { kind: 'comment', reason: 'in a comment' };
  if (PROSE_CONFIG_KEY.test(line))
    return { kind: 'comment', reason: 'a description, not a setting' };
  if (!catalogEntry(provider)?.models) return undefined;
  if (OPTION_TAG.test(line)) return { kind: 'picker', reason: 'an <option> offered to users' };
  return isLineKey(line, name)
    ? { kind: 'catalog', reason: 'a key in a table, such as prices or context windows' }
    : undefined;
}

/** Lines where JSX or HTML text can hold a name outside quotes. JSX with a value on the tag only labels it. */
export const holdsOptionTag = (line: string, mode: Source['mode']) =>
  OPTION_TAG.test(line) && !(mode === 'js' && OPTION_WITH_VALUE.test(line));

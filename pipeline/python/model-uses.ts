import type { DeadlineUse } from '../deadline-exposure.ts';
import { PYTHON_TEST_PATH, stringValue } from './models.ts';
import { withPythonTrees, type Node, type PythonFile } from './syntax.ts';

// How a quoted model ID in Python code is used, with the classes and rules of the TypeScript
// matcher in deadline-exposure.ts: only `live` makes a repository exposed.
const TOKENIZER_CALLS = new Set(['encoding_for_model']);
const CHECK_CALLS = new Set(['startswith', 'endswith', 'find', 'index', 'count']);
const CHECK_OPERATORS = new Set(['==', '!=', 'in', 'not in']);
const MEMBERSHIP_CALLS = new Set(['set', 'frozenset']);
const COLLECTIONS = new Set(['list', 'tuple', 'set', 'expression_list']);
const CATALOG_SIZE = 3;
const RECORD_NAME = new Set(['id', 'name']);
const MODEL_METADATA = new Set([
  'context_window',
  'contextWindow',
  'context_length',
  'max_output_tokens',
  'max_input_tokens',
  'input_token_limit',
  'output_token_limit',
  'knowledge_cutoff',
  'pricing',
  'cost',
  'owned_by',
]);
// The same keys and flags that make a model inside a longer string a setting rather than prose.
const MODEL_KEYS = [
  /(?:^|[^a-z0-9_-])[a-z0-9_-]*model(?:[_-]?(?:id|name))?["'\s]*[:=]\s*$/i,
  /(?:^|\s)(?:--[a-z-]*model(?:[_-]?(?:id|name))?|-m)["'=\s]*$/i,
  /(?:^|[^A-Z0-9_])[A-Z0-9_]*MODEL["'\s]*$/,
];
const DATA_TEXT = /^\s*[{[]|["'][\w.-]+["']\s*:/;
const PLATFORM_MODEL = /^(?:[a-z]{2,4}\.)?anthropic\.claude-|^claude-[\w.-]+@\d{8}$/;

export interface PythonModelMatch {
  file: string;
  line: number;
  version: string;
  provider: string;
  use: DeadlineUse;
  text: string;
  // For live matches: where the literal is written, such as `it is assigned to \`MODEL\``.
  where?: string;
}

const field = (node: Node, name: string) => node.childForFieldName(name) ?? undefined;
const named = (node: Node) => node.namedChildren.filter((child): child is Node => Boolean(child));

function calleeName(call: Node) {
  const callee = field(call, 'function');
  return callee?.type === 'attribute'
    ? field(callee, 'attribute')!.text
    : callee?.type === 'identifier'
      ? callee.text
      : '';
}

function stripped(node: Node) {
  let current = node;
  while (current.parent?.type === 'parenthesized_expression') current = current.parent;
  return current;
}

function countModels(node: Node, isModel: (value: string) => boolean) {
  const found = new Set<string>();
  for (const item of node.descendantsOfType('string')) {
    const value = item ? stringValue(item) : undefined;
    if (value !== undefined && isModel(value)) found.add(value);
  }
  return found.size;
}

// A class body that assigns three or more model IDs, such as an Enum of models.
function modelClass(node: Node, isModel: (value: string) => boolean) {
  if (node.type !== 'block' || node.parent?.type !== 'class_definition') return false;
  const values = named(node).flatMap((statement) => {
    const assignment = statement.type === 'expression_statement' ? statement.namedChild(0) : null;
    const right = assignment?.type === 'assignment' ? field(assignment, 'right') : undefined;
    const value = right && stringValue(right);
    return value !== undefined && isModel(value) ? [value] : [];
  });
  return new Set(values).size >= CATALOG_SIZE;
}

function literalUse(
  string: Node,
  file: string,
  version: string,
  isModel: (value: string) => boolean,
): DeadlineUse {
  const node = stripped(string);
  const parent = node.parent;
  // A bare string statement is a docstring or a note, never sent.
  if (parent?.type === 'expression_statement' && parent.namedChildCount === 1) return 'comment';
  if (parent?.type === 'argument_list' && parent.parent?.type === 'call') {
    const callee = calleeName(parent.parent);
    if (TOKENIZER_CALLS.has(callee)) return 'tokenizer';
    if (CHECK_CALLS.has(callee)) return 'check';
  }
  if (parent?.type === 'comparison_operator') {
    const operators = parent.children
      .filter((child): child is Node => Boolean(child) && !child!.isNamed)
      .map((child) => child.text);
    if (operators.some((operator) => CHECK_OPERATORS.has(operator.replace(/\s+/g, ' '))))
      return 'check';
  }
  // A list searched with `in`: `if model in ("gpt-4", "gpt-4o")`.
  if (
    parent &&
    COLLECTIONS.has(parent.type) &&
    stripped(parent).parent?.type === 'comparison_operator'
  )
    return 'check';
  if (parent?.type === 'case_pattern' || node.parent?.parent?.type === 'case_clause')
    return 'check';
  if (PYTHON_TEST_PATH.test(file)) return 'test';
  // Keys and indexes name table entries, such as prices; a key's string value is what is sent.
  if (parent?.type === 'pair' && field(parent, 'key')?.id === node.id) return 'catalog';
  if (parent?.type === 'subscript' && field(parent, 'subscript')?.id === node.id) return 'catalog';
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === 'type') return 'catalog';
    if (up.type === 'function_definition' || up.type === 'module') break;
  }
  if (parent?.type === 'pair' && RECORD_NAME.has(stringValue(field(parent, 'key')!) ?? '')) {
    const keys = named(parent.parent!).flatMap((pair) =>
      pair.type === 'pair' ? [stringValue(field(pair, 'key')!) ?? ''] : [],
    );
    if (keys.some((key) => MODEL_METADATA.has(key))) return 'catalog';
  }
  if (parent?.type === 'keyword_argument' && RECORD_NAME.has(field(parent, 'name')!.text)) {
    const call = parent.parent;
    if (
      call &&
      named(call).some(
        (item) => item.type === 'keyword_argument' && MODEL_METADATA.has(field(item, 'name')!.text),
      )
    )
      return 'catalog';
  }
  // One model's IDs on several platforms.
  if (parent?.type === 'pair') {
    const values = named(parent.parent!).flatMap((pair) => {
      const value = pair.type === 'pair' ? stringValue(field(pair, 'value')!) : undefined;
      return value === undefined ? [] : [value];
    });
    if (
      values.some((value) => PLATFORM_MODEL.test(value)) &&
      values.filter((value) => isModel(value) || PLATFORM_MODEL.test(value)).length >= 2
    )
      return 'catalog';
  }
  // A class body that assigns three or more models, such as an Enum.
  const statement =
    parent?.type === 'assignment' && parent.parent?.type === 'expression_statement'
      ? parent.parent.parent
      : null;
  if (statement && modelClass(statement, isModel)) return 'catalog';
  for (let current = node; current.parent; current = current.parent) {
    const up = current.parent;
    // Membership collections of any size: a set literal, `set([...])`, `frozenset(...)`.
    if (up.type === 'set') return 'catalog';
    if (
      up.type === 'argument_list' &&
      up.parent?.type === 'call' &&
      MEMBERSHIP_CALLS.has(calleeName(up.parent))
    )
      return 'catalog';
    if (up.type === 'pair' && field(up, 'value')?.id === current.id) {
      const key = stringValue(field(up, 'key')!);
      if (key !== undefined && isModel(key) && current.type === 'dictionary') return 'catalog';
    }
    if (!(
      COLLECTIONS.has(up.type) ||
      up.type === 'dictionary' ||
      up.type === 'pair' ||
      up.type === 'parenthesized_expression'
    ))
      break;
    if (up.type !== 'pair' && countModels(up, isModel) >= CATALOG_SIZE) return 'catalog';
  }
  const value = stringValue(string);
  const full = value ?? string.text.slice(1, -1);
  if (full !== version && /\s/.test(full) && !DATA_TEXT.test(full)) {
    const position = full.indexOf(version);
    const before = full.slice(Math.max(0, position - 41), Math.max(0, position - 1));
    const joined =
      node.parent?.type === 'concatenated_string' ||
      (node.parent?.type === 'binary_operator' &&
        node.parent.children.some((child) => child?.text === '+')) ||
      named(string).some((child) => child.type === 'interpolation');
    if (!MODEL_KEYS.some((key) => key.test(before)) && !joined) return 'comment';
  }
  return 'live';
}

// Where a live literal is written, for a report that says why no traced request sends it.
function holder(string: Node) {
  let node = stripped(string);
  while (
    node.parent &&
    (node.parent.type === 'boolean_operator' || node.parent.type === 'conditional_expression')
  )
    node = stripped(node.parent);
  const parent = node.parent;
  const name = (item: Node | undefined) => (item ? `\`${item.text.slice(0, 60)}\`` : '');
  if (parent?.type === 'keyword_argument') {
    const call = parent.parent?.parent;
    return `it is the ${name(field(parent, 'name'))} argument of ${call?.type === 'call' ? `${field(call, 'function')!.text.slice(0, 60)}()` : 'a call'}`;
  }
  if (parent?.type === 'pair')
    return `it is the ${name(field(parent, 'key'))} value of a dictionary`;
  if (parent?.type === 'assignment') return `it is assigned to ${name(field(parent, 'left'))}`;
  if (parent?.type === 'default_parameter' || parent?.type === 'typed_default_parameter')
    return `it is the default of the parameter ${name(field(parent, 'name'))}`;
  if (parent?.type === 'return_statement') return 'it is returned from a function';
  if (parent?.type === 'argument_list' && parent.parent?.type === 'call')
    return `it is passed to ${field(parent.parent, 'function')!.text.slice(0, 60)}()`;
  if (parent && COLLECTIONS.has(parent.type)) return 'it is an entry in a list';
  if (
    parent?.type === 'interpolation' ||
    named(string).some((child) => child.type === 'interpolation')
  )
    return 'it is part of a longer string, such as an f-string';
  return 'it is not where a request reads its model';
}

// Quoted model IDs the registry names in Python files, each with how it is used. Gemini IDs also
// match in their `models/` form, as in deadline-exposure.ts.
export async function pythonModelMatches(
  files: PythonFile[],
  models: Map<string, string>,
  // The model test for a list holding a match of the given provider (`listModel`).
  isModel: (provider: string) => (value: string) => boolean,
): Promise<PythonModelMatch[]> {
  const candidates = files.filter((file) =>
    [...models.keys()].some(
      (model) =>
        file.content.includes(`'${model}`) ||
        file.content.includes(`"${model}`) ||
        file.content.includes(`/${model}`),
    ),
  );
  if (!candidates.length) return [];
  return withPythonTrees(candidates, (tree) => {
    const matches: PythonModelMatch[] = [];
    for (const file of candidates) {
      const root = tree(file.path)?.rootNode;
      if (!root) continue;
      let offset = 0;
      for (const [index, line] of file.content.split('\n').entries()) {
        const found: { version: string; column: number }[] = [];
        for (const match of line.matchAll(/(['"])([a-z0-9][a-z0-9.-]*)\1/dg))
          if (models.has(match[2]))
            found.push({ version: match[2], column: match.indices![2]![0] });
        for (const match of line.matchAll(/(['"])models\/([a-z0-9][a-z0-9.-]*)\1/dg))
          if (models.get(match[2]) === 'gemini')
            found.push({ version: match[2], column: match.indices![2]![0] });
        for (const { version, column } of found) {
          let node: Node | null = root.descendantForIndex(offset + column);
          while (node && node.type !== 'string' && node.type !== 'comment') node = node.parent;
          const use =
            node?.type === 'string'
              ? literalUse(node, file.path, version, isModel(models.get(version)!))
              : 'comment';
          matches.push({
            file: file.path,
            line: index + 1,
            version,
            provider: models.get(version)!,
            use,
            text: line.trim(),
            ...(use === 'live' && node ? { where: holder(node) } : {}),
          });
        }
        offset += line.length + 1;
      }
    }
    return matches;
  });
}

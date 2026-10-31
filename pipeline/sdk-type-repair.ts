import ts from 'typescript-compiler';
import type { SdkRule } from './ai-sdk-majors.ts';
import { applySourceEdits } from './patches.ts';
import { typeErrorKeys, typeErrors } from './type-errors.ts';
import type { SourceEdit } from './types.ts';

// The type-error-driven part of an SDK major upgrade (accuracy plan, fix 4). After the package
// moves, the repository's own type check is the map of what still breaks: every error the original
// code did not have is new, and its location names the call, import or type the new SDK changed.
// Each new error is looked up in the provider's SDK-major table (data/rules/<provider>/
// sdk-majors.json): an `auto` rule of a family below whose old shape is exactly what the error
// points at is applied, and the type check runs again, up to a small fixed number of rounds.
// Anything no rule matches is left open, with the rules and quotes that mention it, for the AI
// fallback (ai-fallback.ts) to take with the rest of the row; nothing here guesses.
//
// What resolves by rule, per error:
// - TS2339/TS2551 "Property 'x' does not exist on type 'Y'" on a chain whose tail is a renamed
//   method's old path (`method-rename`), where `Y` is the type of the segment before `x`
//   (`files.del` on `Files`, `beta.chat.completions.parse` on `Beta`); or a renamed runner method
//   on a `ChatCompletion…Runner` (`runner-method`).
// - TS2307 "Cannot find module 'm'" where `m` is an old import path (`import-path`, exact or prefix).
// - TS2353 "'betas' does not exist in type 'ModelListParams'" on `models.list`/`models.retrieve`,
//   which move under `beta` (`moved-call`).
// - TS2312 "An interface can only extend an object type …" on an interface that extends a type the
//   new SDK made a union, rewritten as the type alias the guide gives (`interface-to-alias`).
// - TS2345/TS2769 on the id argument of a method whose leading path parameters became named
//   (`named-path-rewrite`), and TS2322/TS2345 naming the new system message type on a callback
//   that rebuilds messages of any role (`role-guard`).

export const MAX_TYPE_REPAIR_ROUNDS = 3;

export interface TypeErrorAt {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  key: string;
}

export interface TypeRepair {
  file: string;
  line: number;
  code: string;
  rule: string;
  family: string;
  source: { url: string; capturedAt: string };
}

// A new error no rule resolves, for the AI fallback: the error, the code on its line and every
// rule of the table that names something at the error (a removed method, a review-only rename).
export interface OpenTypeError {
  file: string;
  line: number;
  code: string;
  message: string;
  text: string;
  reason: string;
  rules: { rule: string; status: string; summary: string; quote: string; url: string }[];
}

// Errors on the patch the original code did not report, matched without positions (type-errors.ts).
export function introducedTypeErrors(
  baseline: { stdout: string; stderr: string },
  patched: { stdout: string; stderr: string },
): TypeErrorAt[] {
  const before = typeErrorKeys(baseline);
  const seen = new Set<string>();
  return typeErrors(patched).filter((error) => {
    const at = `${error.file}:${error.line}:${error.column}:${error.key}`;
    if (before.has(error.key) || seen.has(at)) return false;
    seen.add(at);
    return true;
  });
}

const QUOTED = /'([^']+)'/g;
const quoted = (message: string) => [...message.matchAll(QUOTED)].map((match) => match[1]);
const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
// A type name as the checker prints it, without type arguments or a namespace.
const bareType = (name: string) => name.replace(/<.*$/s, '').split('.').at(-1) ?? name;

function scriptKind(path: string) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

// The innermost node that starts at the error's position.
function nodeAt(source: ts.SourceFile, line: number, column: number) {
  if (line < 1 || line > source.getLineStarts().length) return undefined;
  const position = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) <= position && position < node.getEnd()) {
      if (node.getStart(source) === position) found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return found;
}

// `a.b.c` from the identifier `b`: the whole property-access chain it is part of, as names.
function chainOf(name: ts.Node) {
  let top: ts.Expression = name.parent as ts.Expression;
  while (
    ts.isPropertyAccessExpression(top.parent) &&
    (top.parent as ts.PropertyAccessExpression).expression === top
  )
    top = top.parent as ts.PropertyAccessExpression;
  const accesses: ts.PropertyAccessExpression[] = [];
  let current: ts.Expression = top;
  while (ts.isPropertyAccessExpression(current)) {
    accesses.unshift(current);
    current = current.expression;
  }
  return { top, accesses };
}

const applies = (rule: SdkRule, fromMajor: number | null) =>
  typeof rule.data.fromMajor !== 'number' ||
  fromMajor === null ||
  fromMajor <= (rule.data.fromMajor as number);

interface Match {
  edit: { start: number; end: number; text: string };
  rule: SdkRule;
}

// TS2339/TS2551 on a renamed method's chain: `x` is a segment of the old path whose previous
// segment names the type the checker reports, and the chain holds the whole old path, ending where
// the call does. The old path is replaced by the new one; a chain with `?.` inside it stays open.
function renamedMember(
  node: ts.Node,
  typeName: string,
  rules: SdkRule[],
  source: ts.SourceFile,
): Match | undefined {
  if (!ts.isIdentifier(node) || !ts.isPropertyAccessExpression(node.parent)) return undefined;
  if (node.parent.name !== node) return undefined;
  const { top, accesses } = chainOf(node);
  const names = accesses.map((access) => access.name.text);
  // The longest old path first: `vectorStores.files.del` before `files.del`.
  const renames = rules
    .filter((rule) => rule.family === 'method-rename' && typeof rule.data.old === 'string')
    .sort((a, b) => (b.data.old as string).length - (a.data.old as string).length);
  for (const rule of renames) {
    const old = (rule.data.old as string).split('.');
    const index = old.indexOf(node.text);
    if (index < 1 || bareType(typeName) !== pascal(old[index - 1])) continue;
    // The old path must be the tail of the chain, and the chain the callee of a call.
    if (names.length < old.length || names.slice(-old.length).join('.') !== old.join('.')) continue;
    if (names.lastIndexOf(node.text) !== names.length - old.length + index) continue;
    if (!ts.isCallExpression(top.parent) || top.parent.expression !== top) continue;
    const first = accesses[accesses.length - old.length];
    const span = accesses.slice(-old.length);
    if (span.slice(1).some((access) => access.questionDotToken)) return undefined;
    return {
      edit: {
        start: first.name.getStart(source),
        end: accesses.at(-1)!.name.getEnd(),
        text: rule.data.new as string,
      },
      rule,
    };
  }
  for (const rule of rules) {
    if (rule.family !== 'runner-method' || rule.data.old !== node.text) continue;
    if (!/^ChatCompletion\w*Runner$/.test(bareType(typeName))) continue;
    return {
      edit: { start: node.getStart(source), end: node.getEnd(), text: rule.data.new as string },
      rule,
    };
  }
  return undefined;
}

// TS2307 on an import, export or require whose module an `import-path` rule moves.
function movedImport(node: ts.Node, module: string, rules: SdkRule[], source: ts.SourceFile) {
  if (!ts.isStringLiteralLike(node) || node.text !== module) return undefined;
  for (const rule of rules) {
    if (rule.family !== 'import-path') continue;
    let text: string | undefined;
    if (rule.data.old === module) text = rule.data.new as string;
    else if (
      typeof rule.data.oldPrefix === 'string' &&
      (module === rule.data.oldPrefix || module.startsWith(`${rule.data.oldPrefix}/`))
    )
      text = `${rule.data.newPrefix as string}${module.slice(rule.data.oldPrefix.length)}`;
    if (text !== undefined)
      return {
        edit: { start: node.getStart(source) + 1, end: node.getEnd() - 1, text },
        rule,
      };
  }
  return undefined;
}

// TS2353 on an option a `moved-call` rule moves under `beta`: `client.models.list({ betas })`
// becomes `client.beta.models.list({ betas })` when the property is the call's first argument's.
function movedCall(node: ts.Node, option: string, rules: SdkRule[], source: ts.SourceFile) {
  const property = ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.parent : undefined;
  if (
    !property ||
    (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
  )
    return undefined;
  const literal = property.parent;
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  const call = literal.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== literal) return undefined;
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const { accesses } = chainOf(call.expression.name);
  const names = accesses.map((access) => access.name.text);
  for (const rule of rules) {
    if (rule.family !== 'moved-call' || rule.data.option !== option) continue;
    const prefix = rule.data.prefix as string;
    const path = (rule.data.methods as string[]).find(
      (method) => names.slice(-method.split('.').length).join('.') === method,
    );
    if (!path) continue;
    const segments = path.split('.').length;
    if (names.length > segments && names[names.length - segments - 1] === prefix) continue;
    const first = accesses[accesses.length - segments];
    return {
      edit: {
        start: first.name.getStart(source),
        end: first.name.getStart(source),
        text: `${prefix}.`,
      },
      rule,
    };
  }
  return undefined;
}

// `interface X<T> extends A { … }` → `type X<T> = A & { … };`, the alias the Anthropic guide gives
// for a type that became a union. Only an interface with that one heritage type, declared once in
// its file and not inside `declare global` or a module augmentation, where merging could matter.
export function interfaceToAlias(
  declaration: ts.InterfaceDeclaration,
  source: ts.SourceFile,
  names: string[],
) {
  const clauses = declaration.heritageClauses ?? [];
  if (clauses.length !== 1 || clauses[0].types.length !== 1) return undefined;
  const heritage = clauses[0].types[0];
  if (!names.includes(heritage.expression.getText(source).split('.').at(-1) ?? ''))
    return undefined;
  let parent: ts.Node = declaration.parent;
  while (!ts.isSourceFile(parent)) {
    if (ts.isModuleDeclaration(parent)) return undefined;
    parent = parent.parent;
  }
  const modifiers = (ts.getModifiers(declaration) ?? []).map((modifier) => modifier.kind);
  if (modifiers.some((kind) => kind !== ts.SyntaxKind.ExportKeyword)) return undefined;
  const name = declaration.name.text;
  let declarations = 0;
  const count = (node: ts.Node) => {
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name?.text === name
    )
      declarations++;
    ts.forEachChild(node, count);
  };
  count(source);
  if (declarations !== 1) return undefined;
  const text = source.getFullText();
  const body = text.slice(clauses[0].getEnd(), declaration.getEnd()).trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return undefined;
  const parameters = declaration.typeParameters
    ? `<${declaration.typeParameters.map((parameter) => parameter.getText(source)).join(', ')}>`
    : '';
  return {
    start: declaration.getStart(source),
    end: declaration.getEnd(),
    text: `${modifiers.length ? 'export ' : ''}type ${name}${parameters} = ${heritage.getText(source)} & ${body};`,
  };
}

function unionInterface(node: ts.Node, rules: SdkRule[], source: ts.SourceFile) {
  let current: ts.Node | undefined = node;
  while (current && !ts.isInterfaceDeclaration(current)) current = current.parent;
  if (!current) return undefined;
  for (const rule of rules) {
    if (rule.family !== 'interface-to-alias') continue;
    const edit = interfaceToAlias(current, source, rule.data.names as string[]);
    if (edit) return { edit, rule };
  }
  return undefined;
}

// `client.vectorStores.files.retrieve(storeId, fileId)` → `retrieve(fileId, { vector_store_id:
// storeId })`: the v5 guide keeps only the last path parameter positional. The rule lists, per
// method, the path parameters that became named, in the URL's order, and whether the params object
// also carries a body or query, both read from the SDK's published code. In v4 a body or query came
// after the ids and the request options last; the body merges into the params, and the options
// stay the last argument.
export interface NamedPathMethod {
  parents: string[];
  body: boolean;
}

export function namedPathEdit(
  call: ts.CallExpression,
  method: NamedPathMethod,
  source: ts.SourceFile,
) {
  const args = call.arguments;
  const count = method.parents.length;
  if (args.length < count + 1 || args.length > count + (method.body ? 3 : 2)) return undefined;
  const leading = args.slice(0, count + 1);
  if (
    leading.some(
      (arg) =>
        ts.isObjectLiteralExpression(arg) ||
        ts.isSpreadElement(arg) ||
        ts.isArrowFunction(arg) ||
        ts.isFunctionExpression(arg),
    ) ||
    args.some(ts.isSpreadElement)
  )
    return undefined;
  const text = (node: ts.Node) => node.getText(source);
  const pairs = method.parents.map((name, index) =>
    text(args[index]) === name ? name : `${name}: ${text(args[index])}`,
  );
  const body = method.body ? args[count + 1] : undefined;
  const options = args[count + (method.body ? 2 : 1)];
  let params: string;
  if (
    !body ||
    body.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(body) && body.text === 'undefined')
  )
    params = `{ ${pairs.join(', ')} }`;
  else if (ts.isObjectLiteralExpression(body))
    params = `{ ${[...pairs, ...body.properties.map(text)].join(', ')} }`;
  else params = `{ ${[...pairs, `...${text(body)}`].join(', ')} }`;
  // The call's own separator, so arguments on their own lines stay on their own lines.
  const separator = source.getFullText().slice(args[0].getEnd(), args[1].getStart(source));
  const join = /^\s*,\s*$/.test(separator) ? separator : ', ';
  return {
    start: args[0].getStart(source),
    end: args.at(-1)!.getEnd(),
    text: [text(args[count]), params, ...(options ? [text(options)] : [])].join(join),
  };
}

// The error is on the argument where the kept id now goes (TS2345, TS2769) or, with too many
// arguments for the new signature (TS2554), on the first extra one.
function namedPath(node: ts.Node, rules: SdkRule[], source: ts.SourceFile, extra: boolean) {
  let argument: ts.Node = node;
  while (argument.parent && !ts.isCallExpression(argument.parent)) {
    if (argument.parent.getStart(source) !== node.getStart(source)) return undefined;
    argument = argument.parent;
  }
  const call = argument.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
    return undefined;
  const index = call.arguments.indexOf(argument as ts.Expression);
  if (index < 1) return undefined;
  const names = chainOf(call.expression.name).accesses.map((access) => access.name.text);
  for (const rule of rules) {
    if (rule.family !== 'named-path-rewrite') continue;
    const methods = rule.data.methods as Record<string, NamedPathMethod>;
    const path = Object.keys(methods).find(
      (method) => names.slice(-method.split('.').length).join('.') === method,
    );
    const count = path ? methods[path].parents.length : 0;
    if (!path || (extra ? index <= count : count !== index)) continue;
    const edit = namedPathEdit(call, methods[path], source);
    if (edit) return { edit, rule };
  }
  return undefined;
}

// `messages.map((message) => ({ ...message, content }))` once `MessageParam` is a union with a
// system variant: the Anthropic guide checks the role first, `message.role === "system" ? message :
// { ...message, content }`. Before 1.x a message had no system role, so the guard keeps every
// message the code built before as it was. Only the one object literal the callback returns that
// spreads its own parameter and sets `content`, and only on an error that names the system type.
function roleGuard(node: ts.Node, message: string, rules: SdkRule[], source: ts.SourceFile) {
  const rule = rules.find((item) => item.family === 'role-guard');
  if (!rule || !message.includes(rule.data.type as string)) return undefined;
  let expression: ts.Node = node;
  if (ts.isReturnStatement(expression) && expression.expression) expression = expression.expression;
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression))
    expression = expression.expression;
  if (!ts.isCallExpression(expression)) return undefined;
  const callback = expression.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
    return undefined;
  const parameter = callback.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return undefined;
  const name = parameter.text;
  const key = rule.data.key as string;
  const returned: ts.ObjectLiteralExpression[] = [];
  const unwrapped = (value: ts.Expression) => {
    let current = value;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  const consider = (value: ts.Expression | undefined) => {
    const literal = value && unwrapped(value);
    if (
      literal &&
      ts.isObjectLiteralExpression(literal) &&
      literal.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) &&
          ts.isIdentifier(property.expression) &&
          property.expression.text === name,
      ) &&
      literal.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(source) === key,
      )
    )
      returned.push(literal);
  };
  if (!ts.isBlock(callback.body)) consider(callback.body);
  else {
    const visit = (child: ts.Node) => {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child)) consider(child.expression);
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(callback.body, visit);
  }
  if (returned.length !== 1) return undefined;
  const [literal] = returned;
  const guarded = `${name}.role === ${JSON.stringify(rule.data.role)} ? ${name} : ${literal.getText(source)}`;
  const bare = ts.isParenthesizedExpression(literal.parent) || ts.isReturnStatement(literal.parent);
  return {
    edit: {
      start: literal.getStart(source),
      end: literal.getEnd(),
      text: bare ? guarded : `(${guarded})`,
    },
    rule,
  };
}

function match(error: TypeErrorAt, node: ts.Node, rules: SdkRule[], source: ts.SourceFile) {
  const [first, second] = quoted(error.message);
  switch (error.code) {
    case 'TS2339':
    case 'TS2551':
      return first && second ? renamedMember(node, second, rules, source) : undefined;
    case 'TS2345':
    case 'TS2769':
      return namedPath(node, rules, source, false) ?? roleGuard(node, error.message, rules, source);
    case 'TS2554':
      return namedPath(node, rules, source, true);
    case 'TS2322':
      return roleGuard(node, error.message, rules, source);
    case 'TS2307':
      return first ? movedImport(node, first, rules, source) : undefined;
    case 'TS2353':
      return first ? movedCall(node, first, rules, source) : undefined;
    case 'TS2312':
      return unionInterface(node, rules, source);
    default:
      return undefined;
  }
}

// The rules of the table that name an identifier or module at the error, for the AI: first those
// whose old name is the one the error quotes, then those that share a word with its line.
function relatedRules(error: TypeErrorAt, text: string, rules: SdkRule[]) {
  const [named] = quoted(error.message);
  const words = new Set([...quoted(error.message), ...(text.match(/[A-Za-z_$][\w$]*/g) ?? [])]);
  const score = (rule: SdkRule) => {
    const values = Object.values(rule.data)
      .flatMap((value) =>
        Array.isArray(value)
          ? value
          : typeof value === 'object' && value !== null
            ? Object.keys(value)
            : [value],
      )
      .filter((value): value is string => typeof value === 'string');
    const parts = values.flatMap((value) => value.split(/[./]/));
    return (
      (values.some((value) => value === named || value.split('.').at(-1) === named) ? 100 : 0) +
      parts.filter((part) => part.length > 2 && words.has(part)).length
    );
  };
  return rules
    .map((rule) => ({ rule, score: score(rule) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ rule }) => rule)
    .map((rule) => ({
      rule: rule.rule,
      status: rule.status,
      summary: rule.summary,
      quote: rule.quote,
      url: rule.source.url,
    }));
}

// One round: the edits the table's rules give for these errors, and the errors left open. At most
// one edit per error and none that overlap, so a round never applies two rules to the same code.
export function repairTypeErrors(
  errors: TypeErrorAt[],
  files: Map<string, string>,
  rules: SdkRule[],
  fromMajor: number | null,
) {
  const usable = rules.filter((rule) => rule.status === 'auto' && applies(rule, fromMajor));
  const edits: (SourceEdit & { rule: string })[] = [];
  const repairs: TypeRepair[] = [];
  const open: OpenTypeError[] = [];
  const sources = new Map<string, ts.SourceFile>();
  for (const error of errors) {
    const content = files.get(error.file);
    const leave = (reason: string, text = '') =>
      open.push({
        file: error.file,
        line: error.line,
        code: error.code,
        message: error.message,
        text,
        reason,
        rules: relatedRules(error, text, rules),
      });
    if (content === undefined) {
      leave(
        error.file.includes('node_modules/')
          ? 'The error is inside an installed package, not in the repository.'
          : 'The error is in a file Refit did not read.',
      );
      continue;
    }
    let source = sources.get(error.file);
    if (!source) {
      source = ts.createSourceFile(
        error.file,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(error.file),
      );
      sources.set(error.file, source);
    }
    const text = content.split('\n')[error.line - 1]?.trim().slice(0, 300) ?? '';
    const node = nodeAt(source, error.line, error.column);
    const found = node && match(error, node, usable, source);
    if (!found) {
      leave('No mapping in the SDK-major table matches this error.', text);
      continue;
    }
    const overlaps = edits.some(
      (item) =>
        item.file === error.file && item.start < found.edit.end && found.edit.start < item.end,
    );
    if (overlaps) continue;
    edits.push({
      file: error.file,
      start: found.edit.start,
      end: found.edit.end,
      replacement: found.edit.text,
      changeId: found.rule.rule,
      rule: found.rule.rule,
    });
    repairs.push({
      file: error.file,
      line: error.line,
      code: error.code,
      rule: found.rule.rule,
      family: found.rule.family,
      source: { url: found.rule.source.url, capturedAt: found.rule.source.capturedAt },
    });
  }
  return { edits, repairs, open };
}

export interface TypeRepairResult {
  status: 'clean' | 'open' | 'round-limit';
  rounds: { errors: number; repaired: number }[];
  repairs: TypeRepair[];
  // The new errors still reported after the last round, with what the AI needs about each.
  remaining: OpenTypeError[];
  // Every file a rule changed, with its final content.
  files: Map<string, string>;
  // The errors came from Refit's checkJs type check, which the repository does not run itself.
  checkJs?: boolean;
}

// The loop: repair the new errors by rule, type-check again, until none is new, a round repairs
// nothing, or the round limit is reached. `typecheck` runs the repository's type check on the
// files with the changes so far and returns the errors the original code did not have.
export async function typeRepairLoop(options: {
  errors: TypeErrorAt[];
  read: (path: string) => Promise<string | undefined>;
  typecheck: (changed: Map<string, string>) => Promise<TypeErrorAt[]>;
  rules: SdkRule[];
  fromMajor: number | null;
  maxRounds?: number;
}): Promise<TypeRepairResult> {
  const maxRounds = options.maxRounds ?? MAX_TYPE_REPAIR_ROUNDS;
  const changed = new Map<string, string>();
  const rounds: TypeRepairResult['rounds'] = [];
  const repairs: TypeRepair[] = [];
  let errors = options.errors;
  let remaining: OpenTypeError[] = [];
  for (let round = 0; ; round++) {
    const files = new Map<string, string>();
    for (const path of new Set(errors.map((error) => error.file))) {
      const content = changed.get(path) ?? (await options.read(path));
      if (content !== undefined) files.set(path, content);
    }
    const result = repairTypeErrors(errors, files, options.rules, options.fromMajor);
    remaining = result.open;
    if (!errors.length) return { status: 'clean', rounds, repairs, remaining, files: changed };
    if (!result.edits.length || round === maxRounds) {
      rounds.push({ errors: errors.length, repaired: 0 });
      return {
        status: result.edits.length ? 'round-limit' : 'open',
        rounds,
        repairs,
        remaining,
        files: changed,
      };
    }
    for (const [path, content] of files) {
      const edits = result.edits.filter((item) => item.file === path);
      if (edits.length) changed.set(path, applySourceEdits(content, edits));
    }
    rounds.push({ errors: errors.length, repaired: result.repairs.length });
    repairs.push(...result.repairs);
    errors = await options.typecheck(changed);
  }
}

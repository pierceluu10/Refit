import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import { rulesOf, type AiRule, type AiRulePage, type AiRuleTable } from './ai-rules.ts';
import type { ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import type { Repository, SourceEdit } from './types.ts';

// SDK major upgrades for the AI providers (item 4): finds the calls a major version changes and
// rewrites them with the provider's documented mapping (data/rules/<provider>/sdk-majors.json).
// Every edit comes from an `auto` rule; every site a `review` rule matches, and every call of the
// old SDK Refit did not trace, stops for review and is never edited.

export type SdkRule = AiRule & { source: AiRulePage };

export interface SdkMajorStop {
  file: string;
  line: number;
  rule: string;
  reason: string;
}

export interface SdkMajorProposal {
  provider: 'openai' | 'anthropic';
  packageName: string;
  // The release the root lockfile installs, else the declared range; null when neither is readable.
  installed: string | null;
  major: number | null;
  targetMajor: number;
  edits: (SourceEdit & { rule: string })[];
  stops: SdkMajorStop[];
  // Each rule an edit or stop came from, with its page, for the draft's sources.
  rules: SdkRule[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

export function majorOf(version: string | null) {
  const match = version && /(\d+)\.\d+\.\d+/.exec(version);
  return match ? Number(match[1]) : null;
}

function scriptKind(path: string) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

// One file in its own program: enough for the checker to resolve local bindings.
function fileProgram(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === path ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === path,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [path],
    options: { allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  return { source, checker: program.getTypeChecker() };
}

function lineOf(source: ts.SourceFile, position: number) {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function callAt(source: ts.SourceFile, line: number, column: number, expression: string) {
  const start = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  const wanted = expression.replace(/\s+/g, '');
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      node.getStart(source) === start &&
      node.expression.getText(source).replace(/\s+/g, '') === wanted
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function importsPackage(content: string, name: string) {
  return [`'${name}'`, `"${name}"`, `'${name}/`, `"${name}/`].some((needle) =>
    content.includes(needle),
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current)
  )
    current = current.expression;
  return current;
}

// The text range of `.name` (or `?.name`) in `object.name`, for deleting it.
function memberRange(access: ts.PropertyAccessExpression) {
  return { start: access.expression.getEnd(), end: access.getEnd() };
}

// The statement holding a declaration, with its line break, for deleting it whole.
function statementRange(statement: ts.Statement, content: string) {
  let end = statement.getEnd();
  while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end++;
  if (content[end] === '\r') end++;
  if (content[end] === '\n') end++;
  let start = statement.getStart();
  while (start > 0 && (content[start - 1] === ' ' || content[start - 1] === '\t')) start--;
  return { start, end };
}

interface Context {
  repository: Repository;
  rules: Map<string, SdkRule>;
  used: Set<string>;
  edits: SdkMajorProposal['edits'];
  stops: SdkMajorStop[];
}

function stop(context: Context, file: string, line: number, rule: string, reason: string) {
  if (context.rules.has(rule)) context.used.add(rule);
  if (
    !context.stops.some(
      (item) => item.file === file && item.line === line && item.reason === reason,
    )
  )
    context.stops.push({ file, line, rule, reason });
}

function edit(
  context: Context,
  file: string,
  start: number,
  end: number,
  text: string,
  rule: string,
) {
  context.used.add(rule);
  context.edits.push({ file, start, end, replacement: text, changeId: rule, rule });
}

const V3_RESPONSE = 'openai-node-v4-response-data';
const V3_CLIENT = 'openai-node-v4-client';
const V3_TYPES = 'openai-node-v4-types';
const V3_ERRORS = 'openai-node-v4-errors';
const V3_OPTIONS = 'openai-node-v4-request-options';

// What v3 code does with a call's result: `.data` reads become reads of the result itself.
function unwrapResponse(
  context: Context,
  file: string,
  program: ReturnType<typeof fileProgram>,
  call: ts.CallExpression,
) {
  const { source, checker } = program;
  const line = lineOf(source, call.getStart());
  let outer: ts.Expression = call;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent))
    outer = outer.parent as ts.Expression;
  const awaited = ts.isAwaitExpression(outer.parent) ? outer.parent : undefined;
  if (!awaited) {
    // A result nobody reads needs no change.
    if (ts.isExpressionStatement(outer.parent)) return true;
    stop(
      context,
      file,
      line,
      V3_RESPONSE,
      'The call is not awaited where it is made, so Refit cannot follow its `.data` reads; v4 returns the response body itself.',
    );
    return false;
  }
  let expression: ts.Expression = awaited;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent)
  )
    expression = expression.parent as ts.Expression;
  const parent = expression.parent;
  if (ts.isExpressionStatement(parent)) return true;
  // `(await openai.createX(...)).data`
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
    if (parent.name.text !== 'data') {
      stop(
        context,
        file,
        line,
        V3_RESPONSE,
        `The result's \`${parent.name.text}\` is read, which v4 does not return.`,
      );
      return false;
    }
    const range = memberRange(parent);
    edit(context, file, range.start, range.end, '', V3_RESPONSE);
    return true;
  }
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== expression) {
    stop(
      context,
      file,
      line,
      V3_RESPONSE,
      'The awaited result is returned or passed on whole, so its `.data` reads cannot be followed.',
    );
    return false;
  }
  const list = parent.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) {
    stop(
      context,
      file,
      line,
      V3_RESPONSE,
      'The result is held in a `let` or `var` that may be reassigned.',
    );
    return false;
  }
  // `const { data } = await …` or `const { data: completion } = await …`
  if (ts.isObjectBindingPattern(parent.name)) {
    const elements = parent.name.elements;
    const element = elements[0];
    const property = element && (element.propertyName ?? element.name);
    if (
      elements.length !== 1 ||
      element.dotDotDotToken ||
      element.initializer ||
      !property ||
      !ts.isIdentifier(property) ||
      property.text !== 'data' ||
      !ts.isIdentifier(element.name)
    ) {
      stop(context, file, line, V3_RESPONSE, 'The result is destructured beyond `data`.');
      return false;
    }
    edit(
      context,
      file,
      parent.name.getStart(),
      parent.name.getEnd(),
      element.name.text,
      V3_RESPONSE,
    );
    return true;
  }
  if (!ts.isIdentifier(parent.name)) {
    stop(
      context,
      file,
      line,
      V3_RESPONSE,
      'The result is bound to a pattern Refit does not follow.',
    );
    return false;
  }
  const symbol = checker.getSymbolAtLocation(parent.name);
  const reads: ts.PropertyAccessExpression[] = [];
  let other = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node !== parent.name && node.text === parent.name.getText()) {
      const resolved =
        ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      if (resolved && resolved === symbol) {
        const access = node.parent;
        if (
          ts.isPropertyAccessExpression(access) &&
          access.expression === node &&
          access.name.text === 'data'
        )
          reads.push(access);
        else other = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (other || !symbol) {
    stop(
      context,
      file,
      line,
      V3_RESPONSE,
      `\`${parent.name.text}\` is used other than through \`${parent.name.text}.data\` (headers, status or the whole response), which v4 does not return.`,
    );
    return false;
  }
  for (const read of reads) {
    const range = memberRange(read);
    edit(context, file, range.start, range.end, '', V3_RESPONSE);
  }
  return true;
}

// `new OpenAIApi(new Configuration({ apiKey }))` and the two-statement form become `new OpenAI(…)`.
function rewriteV3Clients(context: Context, file: string, content: string) {
  const { source, checker } = fileProgram(file, content);
  let ok = true;
  const configurationOptions = (node: ts.NewExpression) => {
    const [argument] = node.arguments ?? [];
    if (node.arguments?.length !== 1 || !argument || !ts.isObjectLiteralExpression(argument))
      return undefined;
    const allowed = Object.keys(
      (context.rules.get(V3_CLIENT)?.data.options as Record<string, string>) ?? {},
    );
    return argument.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        allowed.includes(property.name.text),
    ) && argument.properties.length > 0
      ? argument.getText(source)
      : undefined;
  };
  const isNamed = (expression: ts.Expression, name: string) =>
    ts.isIdentifier(expression) && expression.text === name;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && isNamed(node.expression, 'OpenAIApi')) {
      const line = lineOf(source, node.getStart());
      const [argument] = node.arguments ?? [];
      const inner = argument && unwrap(argument);
      if (node.arguments?.length !== 1 || !inner) {
        ok = false;
        stop(
          context,
          file,
          line,
          V3_CLIENT,
          '`new OpenAIApi` is called without one configuration argument.',
        );
      } else if (ts.isNewExpression(inner) && isNamed(inner.expression, 'Configuration')) {
        const options = configurationOptions(inner);
        if (options)
          edit(context, file, node.getStart(), node.getEnd(), `new OpenAI(${options})`, V3_CLIENT);
        else {
          ok = false;
          stop(
            context,
            file,
            line,
            V3_CLIENT,
            'The Configuration sets options other than `apiKey`, or none; the v4 guide maps only `apiKey`, and a v4 client without one reads OPENAI_API_KEY and throws when it is missing.',
          );
        }
      } else if (ts.isIdentifier(inner)) {
        // `const configuration = new Configuration({…})`, used only here.
        const symbol = checker.getSymbolAtLocation(inner);
        const declaration = symbol?.valueDeclaration;
        const initializer =
          declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
            ? unwrap(declaration.initializer)
            : undefined;
        const statement = declaration?.parent?.parent;
        let uses = 0;
        const count = (child: ts.Node) => {
          if (
            ts.isIdentifier(child) &&
            child.text === inner.text &&
            checker.getSymbolAtLocation(child) === symbol
          )
            uses++;
          ts.forEachChild(child, count);
        };
        count(source);
        const options =
          initializer &&
          ts.isNewExpression(initializer) &&
          isNamed(initializer.expression, 'Configuration')
            ? configurationOptions(initializer)
            : undefined;
        if (
          !options ||
          uses !== 2 ||
          !statement ||
          !ts.isVariableStatement(statement) ||
          statement.declarationList.declarations.length !== 1 ||
          !(statement.declarationList.flags & ts.NodeFlags.Const) ||
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          ok = false;
          stop(
            context,
            file,
            line,
            V3_CLIENT,
            'The Configuration is not one local `const` that sets only `apiKey` and is used only by this client.',
          );
        } else {
          const range = statementRange(statement, content);
          edit(context, file, range.start, range.end, '', V3_CLIENT);
          edit(context, file, node.getStart(), node.getEnd(), `new OpenAI(${options})`, V3_CLIENT);
        }
      } else {
        ok = false;
        stop(
          context,
          file,
          line,
          V3_CLIENT,
          'The OpenAIApi configuration is not a Configuration Refit can read.',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ok;
}

// The `openai` import or require: only `Configuration` and `OpenAIApi` are mapped (to `OpenAI`).
function rewriteV3Imports(context: Context, file: string, content: string) {
  const { source } = fileProgram(file, content);
  const keep = new Set((context.rules.get(V3_TYPES)?.data.keep as string[]) ?? []);
  const rewriteNames = (names: string[], at: number) => {
    const other = names.filter((name) => !keep.has(name));
    if (other.length) {
      stop(
        context,
        file,
        lineOf(source, at),
        V3_TYPES,
        `Imports ${other.map((name) => `\`${name}\``).join(', ')} from openai v3, which v4 does not export and the guide does not map.`,
      );
      return false;
    }
    return true;
  };
  const typeUses: ts.Node[] = [];
  let configurationUses = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'openai'
    ) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (!clause || clause.name || !named || !ts.isNamedImports(named)) {
        stop(
          context,
          file,
          lineOf(source, node.getStart()),
          V3_TYPES,
          'The openai v3 import is not a list of named imports.',
        );
      } else if (
        named.elements.every((element) => !element.propertyName) &&
        rewriteNames(
          named.elements.map((element) => element.name.text),
          node.getStart(),
        )
      ) {
        const typeOnly = clause.isTypeOnly ? 'type ' : '';
        edit(
          context,
          file,
          node.getStart(),
          node.getEnd(),
          `import ${typeOnly}{ OpenAI } from ${node.moduleSpecifier.getText(source)};`,
          V3_CLIENT,
        );
      } else if (named.elements.some((element) => element.propertyName))
        stop(
          context,
          file,
          lineOf(source, node.getStart()),
          V3_TYPES,
          'The openai v3 import renames a binding.',
        );
      return;
    }
    // `const { Configuration, OpenAIApi } = require('openai')`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0]) &&
      node.initializer.arguments[0].text === 'openai'
    ) {
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.name.elements.every(
          (element) =>
            !element.propertyName && !element.initializer && ts.isIdentifier(element.name),
        ) &&
        rewriteNames(
          node.name.elements.map((element) => (element.name as ts.Identifier).text),
          node.getStart(),
        )
      )
        edit(context, file, node.name.getStart(), node.name.getEnd(), '{ OpenAI }', V3_CLIENT);
      else
        stop(
          context,
          file,
          lineOf(source, node.getStart()),
          V3_TYPES,
          'The openai v3 require is not a destructuring Refit maps.',
        );
      return;
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === 'OpenAIApi'
    )
      typeUses.push(node.typeName);
    if (
      ts.isIdentifier(node) &&
      node.text === 'Configuration' &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isBindingElement(node.parent) &&
      !(ts.isNewExpression(node.parent) && node.parent.expression === node)
    )
      configurationUses++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  // `private openai: OpenAIApi` names the client's type; the v4 client class is `OpenAI`.
  for (const use of typeUses)
    edit(context, file, use.getStart(), use.getEnd(), 'OpenAI', V3_CLIENT);
  if (configurationUses)
    stop(context, file, 1, V3_CLIENT, '`Configuration` is used other than to build the client.');
}

function v3Method(context: Context, name: string) {
  return [...context.rules.values()].find(
    (rule) =>
      (rule.family === 'method-rename' ||
        rule.family === 'positional-to-object' ||
        rule.family === 'removed-method') &&
      rule.data.fromMajor === 3 &&
      (rule.data.old === name || (Array.isArray(rule.data.old) && rule.data.old.includes(name))),
  );
}

// Each traced v3 client call: renamed with its arguments, its `.data` reads unwrapped.
function rewriteV3Call(
  context: Context,
  file: string,
  program: ReturnType<typeof fileProgram>,
  call: ts.CallExpression,
) {
  const { source } = program;
  const line = lineOf(source, call.getStart());
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  const name = callee.name.text;
  const rule = v3Method(context, name);
  if (!rule) return;
  if (rule.status !== 'auto') {
    stop(context, file, line, rule.rule, rule.summary);
    return;
  }
  if (rule.family === 'positional-to-object') {
    const parameters = rule.data.parameters as string[];
    if (call.arguments.length !== parameters.length) {
      stop(
        context,
        file,
        line,
        rule.rule,
        `\`${name}\` is called with ${call.arguments.length} arguments; the guide maps only (${parameters.join(', ')}).`,
      );
      return;
    }
    if (!unwrapResponse(context, file, program, call)) return;
    const body = parameters
      .map((parameter, index) => `${parameter}: ${call.arguments[index].getText(source)}`)
      .join(', ');
    edit(
      context,
      file,
      callee.name.getStart(),
      call.getEnd(),
      `${rule.data.new as string}({ ${body} })`,
      rule.rule,
    );
    return;
  }
  if (call.arguments.length > 1) {
    stop(
      context,
      file,
      line,
      V3_OPTIONS,
      `\`${name}\` is called with request options (a second argument), which v4 takes in another form.`,
    );
    return;
  }
  if (!unwrapResponse(context, file, program, call)) return;
  edit(
    context,
    file,
    callee.name.getStart(),
    callee.name.getEnd(),
    rule.data.new as string,
    rule.rule,
  );
}

// v3 error reads (`error.response.status`) in a file whose calls move to v4.
function v3ErrorReads(context: Context, file: string, source: ts.SourceFile) {
  const visit = (node: ts.Node) => {
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      const name = node.variableDeclaration.name.text;
      const find = (child: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(child) &&
          child.name.text === 'response' &&
          ts.isIdentifier(unwrap(child.expression)) &&
          (unwrap(child.expression) as ts.Identifier).text === name
        )
          stop(
            context,
            file,
            lineOf(source, child.getStart()),
            V3_ERRORS,
            context.rules.get(V3_ERRORS)?.summary ?? 'A v3 error read.',
          );
        ts.forEachChild(child, find);
      };
      find(node.block);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const v3Names = (context: Context) =>
  [...context.rules.values()]
    .filter((rule) => rule.data.fromMajor === 3)
    .flatMap((rule) => (Array.isArray(rule.data.old) ? rule.data.old : [rule.data.old]))
    .filter((name): name is string => typeof name === 'string');

// The openai v3 → v4 part: client, imports, calls, `.data` reads, then a safety net for every v3
// method name Refit did not trace in a file that uses the SDK.
function openAiV3(
  context: Context,
  analysisCalls: { file: string; line: number; column: number; expression: string }[],
) {
  const names = new Set(v3Names(context));
  const traced = new Map<string, Set<number>>();
  for (const file of context.repository.files) {
    if (!SOURCE.test(file.path) || DECLARATION.test(file.path)) continue;
    const uses =
      importsPackage(file.content, 'openai') &&
      /\b(?:OpenAIApi|Configuration)\b/.test(file.content);
    const calls = analysisCalls.filter((call) => call.file === file.path);
    if (!uses && !calls.length) continue;
    const program = fileProgram(file.path, file.content);
    if (uses) {
      rewriteV3Clients(context, file.path, file.content);
      rewriteV3Imports(context, file.path, file.content);
    }
    for (const call of calls) {
      const node = callAt(program.source, call.line, call.column, call.expression);
      if (!node) continue;
      if (!traced.has(file.path)) traced.set(file.path, new Set());
      traced.get(file.path)!.add(node.getStart());
      rewriteV3Call(context, file.path, program, node);
    }
    if (calls.length) v3ErrorReads(context, file.path, program.source);
  }
  // A v3 method called on something Refit did not trace as the client would break silently.
  for (const file of context.repository.files) {
    if (!SOURCE.test(file.path) || DECLARATION.test(file.path)) continue;
    if (![...names].some((name) => file.content.includes(`.${name}(`))) continue;
    const { source } = fileProgram(file.path, file.content);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        names.has(node.expression.name.text) &&
        !traced.get(file.path)?.has(node.getStart())
      )
        stop(
          context,
          file.path,
          lineOf(source, node.getStart()),
          'openai-node-untraced-v3-call',
          `\`${node.expression.getText(source)}\` has the name of an openai v3 method, and Refit could not trace its receiver to the client; an upgrade would leave it calling a method v4 does not have.`,
        );
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

// openai v4 and v5 → 6: renamed methods and moved namespaces on traced clients, import paths, and
// the review stops of the v5 guide.
function openAiV4(
  context: Context,
  sdkCalls: {
    file: string;
    line: number;
    column: number;
    expression: string;
    resource: string;
    method: string;
  }[],
  fromMajor: number,
) {
  // A rule describes what changed when leaving major `fromMajor`; it applies to a repository on that
  // major or an older one.
  const applies = (rule: SdkRule) =>
    typeof rule.data.fromMajor === 'number' &&
    rule.data.fromMajor >= 4 &&
    fromMajor <= rule.data.fromMajor;
  const renames = [...context.rules.values()].filter(
    (rule) => rule.family === 'method-rename' && applies(rule),
  );
  const removed = [...context.rules.values()].filter(
    (rule) => rule.family === 'removed-method' && applies(rule),
  );
  const named = [...context.rules.values()].find((rule) => rule.family === 'named-path-parameters');
  const web = [...context.rules.values()].find((rule) => rule.family === 'web-response');
  const tracedStarts = new Map<string, Set<number>>();
  for (const call of sdkCalls) {
    const file = context.repository.files.find((item) => item.path === call.file);
    if (!file) continue;
    const { source } = fileProgram(file.path, file.content);
    const node = callAt(source, call.line, call.column, call.expression);
    if (!node) continue;
    const path = `${call.resource}.${call.method}`;
    const line = lineOf(source, node.getStart());
    if (!tracedStarts.has(file.path)) tracedStarts.set(file.path, new Set());
    tracedStarts.get(file.path)!.add(node.getStart());
    const rename = renames.find((rule) => rule.data.old === path);
    const removal = removed.find((rule) => (rule.data.old as string[]).includes(path));
    if (removal) stop(context, file.path, line, removal.rule, removal.summary);
    else if (rename?.status === 'review')
      stop(context, file.path, line, rename.rule, rename.summary);
    else if (rename) {
      // Replace the renamed tail of the chain: `beta.chat.completions.parse` or `del`.
      const oldParts = (rename.data.old as string).split('.');
      let access = node.expression as ts.Expression;
      let first: ts.PropertyAccessExpression | undefined;
      for (
        let index = 0;
        index < oldParts.length && ts.isPropertyAccessExpression(access);
        index++
      ) {
        first = access;
        access = access.expression;
      }
      if (!first) continue;
      edit(
        context,
        file.path,
        first.name.getStart(),
        (node.expression as ts.PropertyAccessExpression).name.getEnd(),
        rename.data.new as string,
        rename.rule,
      );
    }
    // v4 took every path parameter positionally: two leading ids mean the old form.
    if (
      named &&
      applies(named) &&
      (named.data.methods as string[]).includes(path) &&
      node.arguments.length >= 2 &&
      !ts.isObjectLiteralExpression(node.arguments[1])
    )
      stop(context, file.path, line, named.rule, named.summary);
  }
  if (web && applies(web))
    for (const file of context.repository.files) {
      if (!SOURCE.test(file.path) || !importsPackage(file.content, 'openai')) continue;
      for (const method of web.data.methods as string[])
        if (file.content.includes(`.${method}(`))
          stop(context, file.path, lineOfText(file.content, `.${method}(`), web.rule, web.summary);
    }
  // Leftovers on chains Refit did not trace.
  for (const file of context.repository.files) {
    if (!SOURCE.test(file.path) || DECLARATION.test(file.path)) continue;
    const { source } = fileProgram(file.path, file.content);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && !tracedStarts.get(file.path)?.has(node.getStart())) {
        const text = node.expression.getText(source).replace(/\s+/g, '').replace(/\?\./g, '.');
        const hit = [...renames, ...removed].find((rule) =>
          (Array.isArray(rule.data.old) ? rule.data.old : [rule.data.old]).some((old: string) =>
            text.endsWith(`.${old}`),
          ),
        );
        if (hit)
          stop(
            context,
            file.path,
            lineOf(source, node.getStart()),
            'openai-node-untraced-renamed-call',
            `\`${node.expression.getText(source)}\` ends like a method openai v5 renamed or removed (${hit.rule}), and Refit could not trace its receiver to the client.`,
          );
      }
      ts.forEachChild(node, visit);
    };
    const tails = [...renames, ...removed].flatMap((rule) =>
      (Array.isArray(rule.data.old) ? rule.data.old : [rule.data.old]).map(
        (old: string) => `.${old.split('.').at(-1)!}(`,
      ),
    );
    if (tails.some((tail) => file.content.includes(tail))) visit(source);
  }
  openAiV4Files(context, fromMajor);
}

function lineOfText(content: string, needle: string) {
  return content.slice(0, Math.max(0, content.indexOf(needle))).split('\n').length;
}

// Import paths, removed exports, options and runner events of the v5 guide.
function openAiV4Files(context: Context, fromMajor: number) {
  const rules = [...context.rules.values()].filter(
    (rule) =>
      typeof rule.data.fromMajor === 'number' &&
      rule.data.fromMajor >= 4 &&
      fromMajor <= rule.data.fromMajor,
  );
  const paths = rules.filter((rule) => rule.family === 'import-path');
  const events = rules.filter((rule) => rule.family === 'runner-event');
  const runnerMethods = rules.filter((rule) => rule.family === 'runner-method');
  const removedExports = rules.filter(
    (rule) => rule.family === 'removed-export' && rule.data.fromMajor === 4,
  );
  const removedImports = rules.filter((rule) => rule.family === 'removed-import');
  const removedOptions = rules.filter((rule) => rule.family === 'removed-option');
  for (const file of context.repository.files) {
    if (
      !SOURCE.test(file.path) ||
      DECLARATION.test(file.path) ||
      !importsPackage(file.content, 'openai')
    )
      continue;
    const { source } = fileProgram(file.path, file.content);
    const usesRunner = file.content.includes('.runTools(');
    const visit = (node: ts.Node) => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
                node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
              node.arguments.length === 1 &&
              ts.isStringLiteral(node.arguments[0])
            ? (node.arguments[0] as ts.StringLiteral)
            : undefined;
      if (specifier) {
        const text = specifier.text;
        const line = lineOf(source, specifier.getStart());
        for (const rule of removedImports)
          if (text === rule.data.prefix || text.startsWith(`${rule.data.prefix as string}/`))
            stop(context, file.path, line, rule.rule, rule.summary);
        for (const rule of paths) {
          if (rule.data.old === text)
            edit(
              context,
              file.path,
              specifier.getStart() + 1,
              specifier.getEnd() - 1,
              rule.data.new as string,
              rule.rule,
            );
          else if (
            typeof rule.data.oldPrefix === 'string' &&
            (text === rule.data.oldPrefix || text.startsWith(`${rule.data.oldPrefix}/`))
          )
            edit(
              context,
              file.path,
              specifier.getStart() + 1,
              specifier.getEnd() - 1,
              (rule.data.newPrefix as string) + text.slice((rule.data.oldPrefix as string).length),
              rule.rule,
            );
        }
      }
      if (ts.isIdentifier(node))
        for (const rule of removedExports)
          if ((rule.data.names as string[]).includes(node.text))
            stop(context, file.path, lineOf(source, node.getStart()), rule.rule, rule.summary);
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))
        for (const rule of removedOptions)
          if (node.name.text === rule.data.option && withinOpenAiConstructor(node))
            stop(context, file.path, lineOf(source, node.getStart()), rule.rule, rule.summary);
      if (
        usesRunner &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const [first] = node.arguments;
        if (method === 'on' && first && ts.isStringLiteral(first)) {
          const rule = events.find((item) => item.data.old === first.text);
          if (rule && chainedFromRunTools(node.expression.expression))
            edit(
              context,
              file.path,
              first.getStart() + 1,
              first.getEnd() - 1,
              rule.data.new as string,
              rule.rule,
            );
          else if (rule)
            stop(
              context,
              file.path,
              lineOf(source, node.getStart()),
              rule.rule,
              `\`.on('${first.text}')\` is not chained from \`runTools()\`, so Refit cannot tell it is the runner's event.`,
            );
        }
        const runner = runnerMethods.find((item) => item.data.old === method);
        if (runner) {
          if (chainedFromRunTools(node.expression.expression))
            edit(
              context,
              file.path,
              node.expression.name.getStart(),
              node.expression.name.getEnd(),
              runner.data.new as string,
              runner.rule,
            );
          else
            stop(context, file.path, lineOf(source, node.getStart()), runner.rule, runner.summary);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

function withinOpenAiConstructor(node: ts.Node) {
  const literal = node.parent;
  const call = literal?.parent;
  return Boolean(
    call &&
    ts.isNewExpression(call) &&
    ts.isIdentifier(call.expression) &&
    ['OpenAI', 'AzureOpenAI'].includes(call.expression.text),
  );
}

function chainedFromRunTools(expression: ts.Expression): boolean {
  const current = unwrap(expression);
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression))
    return false;
  if (current.expression.name.text === 'runTools') return true;
  return (
    current.expression.name.text === 'on' && chainedFromRunTools(current.expression.expression)
  );
}

function legacyAdapter(): ProviderAdapter {
  return {
    id: 'openai',
    packageName: 'openai',
    defaultImport: false,
    namedExport: 'OpenAIApi',
    operations: [],
  };
}

function currentAdapter(): ProviderAdapter {
  return {
    id: 'openai',
    packageName: 'openai',
    defaultImport: true,
    namedExport: 'OpenAI',
    operations: [],
  };
}

// The release a project installs, from its root lockfile, else the lowest its range admits;
// `repository` is read for one package (readRepository), so its dependencies are that package.
export function installedRelease(repository: Repository) {
  const root = repository.dependencies.filter((item) => item.file === 'package.json');
  const locked = root.find((item) => item.lock.status === 'locked' && item.lock.version);
  if (locked) return locked.lock.version;
  const declared = root[0]?.version;
  const minimum = declared && /^[~^]?(\d+\.\d+\.\d+)$/.exec(declared.trim());
  return minimum ? minimum[1] : null;
}

export async function proposeOpenAiSdkMajor(
  directory: string,
  tables: AiRuleTable[],
): Promise<SdkMajorProposal | null> {
  const rules = rulesOf(tables, 'openai', 'sdk-major');
  const target = rules.find((rule) => rule.family === 'package-target');
  if (!target) return null;
  const repository = await readRepository(directory, 'openai');
  const installed = installedRelease(repository);
  const major = majorOf(installed);
  const targetMajor = target.data.targetMajor as number;
  if (major === null || major >= targetMajor) return null;
  const context: Context = {
    repository,
    rules: new Map(rules.map((rule) => [rule.rule, rule])),
    used: new Set([target.rule]),
    edits: [],
    stops: [],
  };
  if (major < (target.data.oldestMajor as number)) {
    stop(
      context,
      'package.json',
      1,
      target.rule,
      `openai ${installed} predates the oldest major (${String(target.data.oldestMajor)}) the documented migrations start from.`,
    );
  } else if (major === 3) {
    const analysis = analyzeRepository(repository, [], legacyAdapter(), {}, [], [], [], [], {
      modelFixClients: true,
    });
    openAiV3(context, analysis.clientMethodCalls);
  } else {
    const analysis = analyzeRepository(repository, [], currentAdapter(), {}, [], [], [], [], {
      modelFixClients: true,
    });
    openAiV4(context, analysis.sdkCalls, major);
  }
  return {
    provider: 'openai',
    packageName: 'openai',
    installed,
    major,
    targetMajor,
    edits: dedupe(context.edits),
    stops: context.stops,
    rules: rules.filter((rule) => context.used.has(rule.rule)),
  };
}

// The same edit from two passes is one edit; overlapping different edits cannot both apply.
function dedupe(edits: SdkMajorProposal['edits']) {
  const seen = new Map<string, SdkMajorProposal['edits'][number]>();
  for (const item of edits)
    seen.set(`${item.file}\0${item.start}\0${item.end}\0${item.replacement}`, item);
  const unique = [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.start - b.start,
  );
  for (let index = 1; index < unique.length; index++) {
    const [before, after] = [unique[index - 1], unique[index]];
    if (before.file === after.file && after.start < before.end)
      throw new Error(
        `Overlapping SDK upgrade edits in ${after.file} (${before.rule}, ${after.rule}).`,
      );
  }
  return unique;
}

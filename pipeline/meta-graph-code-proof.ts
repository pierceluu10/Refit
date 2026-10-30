import { posix } from 'node:path';
import { structuredPatch } from 'diff';
import ts from 'typescript-compiler';
import type { GraphCall } from './meta-graph-calls.ts';
import type { Repository } from './types.ts';

// What the code around a Meta patch's requests proves where the repository's own checks prove
// nothing (no tests, no type check, plain JavaScript). Founder instruction (2026-10-29, relayed
// by the coordinating session under "proof decides"):
//
// - Request strings: a patch that changes nothing but the text of strings that build traced Graph
//   requests (versions, `fields=` lists, edge paths, parameter names) changes no logic, so the
//   field-table proof of those requests covers it.
// - checkJs: TypeScript checks the changed JavaScript with `checkJs`. It counts only where it adds
//   no error and types every name on the changed lines; a name it cannot type (`any`, such as a
//   parsed JSON response or an untyped parameter) proves nothing, as in owner decision D2c.

const SOURCE = /\.[cm]?[jt]sx?$/;
const JAVASCRIPT = /\.[cm]?jsx?$/;
const STRING_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);
// Expressions a request string may sit in on its way to the call or constant that sends it.
const CARRIERS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TemplateSpan,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
]);
const MAX_UNTYPED = 10;

export interface CodeProof {
  proven: boolean;
  reasons: string[];
}

const scriptKind = (path: string) =>
  path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : JAVASCRIPT.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

const parse = (path: string, content: string) =>
  ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

// The source files the patch changes, and whether it touches anything else (a manifest, a
// lockfile, an added or deleted file).
function changedFiles(original: Repository, patched: Repository, diff: string) {
  const before = new Map(original.files.map((file) => [file.path, file.content]));
  const after = new Map(patched.files.map((file) => [file.path, file.content]));
  const files = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );
  const listed = [...diff.matchAll(/^\+\+\+ (?:"b\/(.+)"|b\/(.+))$/gm)].map(
    (match) => match[1] ?? match[2],
  );
  const other = [
    ...files.filter((path) => !before.has(path) || !after.has(path) || !SOURCE.test(path)),
    ...listed.filter((path) => !files.includes(path)),
  ];
  return { files: files.filter((path) => !other.includes(path)), other, before, after };
}

// The string nodes of `patched` whose text differs from `original`, when the two trees are
// otherwise the same token for token; undefined when anything else differs. Comments are trivia.
function changedStrings(
  original: ts.Node,
  patched: ts.Node,
  sources: [ts.SourceFile, ts.SourceFile],
) {
  const found: ts.Node[] = [];
  const walk = (a: ts.Node, b: ts.Node): boolean => {
    if (a.kind !== b.kind) return false;
    if (STRING_KINDS.has(a.kind)) {
      if (a.getText(sources[0]) !== b.getText(sources[1])) found.push(b);
      return true;
    }
    const left = a.getChildren(sources[0]);
    const right = b.getChildren(sources[1]);
    if (!left.length && !right.length) return a.getText(sources[0]) === b.getText(sources[1]);
    return left.length === right.length && left.every((child, index) => walk(child, right[index]));
  };
  return walk(original, patched) ? found : undefined;
}

// Whether a changed string builds a traced request: it is written on a changed request's version
// pin, or it reaches a changed request's call (as an argument, through templates, concatenation
// and option objects) or the constant on the call's line.
function requestString(
  source: ts.SourceFile,
  node: ts.Node,
  calls: Set<number>,
  pins: Set<number>,
) {
  if (pins.has(lineOf(source, node))) return true;
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      return (
        (parent.arguments ?? ([] as readonly ts.Expression[])).includes(current as ts.Expression) &&
        calls.has(lineOf(source, parent))
      );
    if (ts.isVariableDeclaration(parent))
      return (
        parent.initializer === current &&
        (calls.has(lineOf(source, parent)) || pins.has(lineOf(source, parent)))
      );
    if (!CARRIERS.has(parent.kind)) return false;
    current = parent;
  }
  return false;
}

// Request-string proof: every edit is to the text of a string that builds a changed request.
export function requestStringProof(
  original: Repository,
  patched: Repository,
  diff: string,
  calls: GraphCall[],
): CodeProof {
  const { files, other, before, after } = changedFiles(original, patched, diff);
  const reasons = other.map(
    (path) => `${path}: the patch changes this file, not only request strings`,
  );
  if (!files.length && !other.length) reasons.push('The patch changes no source file.');
  for (const path of files) {
    const sources: [ts.SourceFile, ts.SourceFile] = [
      parse(path, before.get(path)!),
      parse(path, after.get(path)!),
    ];
    const strings = changedStrings(sources[0], sources[1], sources);
    if (!strings) {
      reasons.push(`${path}: the patch changes code, not only string text`);
      continue;
    }
    const callLines = new Set(calls.filter((call) => call.file === path).map((call) => call.line));
    const pinLines = new Set(
      calls.flatMap((call) => (call.pin?.file === path ? [call.pin.line] : [])),
    );
    for (const node of strings)
      if (!requestString(sources[1], node, callLines, pinLines))
        reasons.push(
          `${path}:${lineOf(sources[1], node)}: the changed string does not build a changed Graph request`,
        );
  }
  return { proven: reasons.length === 0, reasons };
}

const ROOT = '/refit-meta-checkjs';
const OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: [],
};

// A checkJs program over the changed files of one side, reading the repository's files from
// memory; packages are not installed, so what they export stays `any`.
function checkJsProgram(contents: Map<string, string>, roots: string[]) {
  const host = ts.createCompilerHost(OPTIONS);
  const inside = (name: string) => name.startsWith(`${ROOT}/`);
  const read = (name: string) => contents.get(posix.relative(ROOT, name));
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => (inside(name) ? read(name) !== undefined : fileExists(name));
  host.readFile = (name) => (inside(name) ? read(name) : readFile(name));
  host.getSourceFile = (name, language, ...rest) => {
    if (!inside(name)) return getSourceFile(name, language, ...rest);
    const text = read(name);
    return text === undefined
      ? undefined
      : ts.createSourceFile(name, text, language, true, scriptKind(name));
  };
  host.getCurrentDirectory = () => ROOT;
  host.directoryExists = (name) =>
    inside(name) || name === ROOT
      ? [...contents.keys()].some((path) => `${ROOT}/${path}`.startsWith(`${name}/`))
      : true;
  return ts.createProgram(
    roots.map((path) => `${ROOT}/${path}`),
    OPTIONS,
    host,
  );
}

function diagnosticKeys(program: ts.Program, roots: string[]) {
  const keys: string[] = [];
  for (const path of roots) {
    const source = program.getSourceFile(`${ROOT}/${path}`);
    if (!source) continue;
    for (const diagnostic of [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ])
      keys.push(
        `${path} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
  }
  return keys;
}

// Names on the given lines that TypeScript could not type. Declared names, object keys and
// import bindings name things rather than read them, so they are not asked.
function untypedNames(program: ts.Program, path: string, lines: Set<number>) {
  const source = program.getSourceFile(`${ROOT}/${path}`)!;
  const checker = program.getTypeChecker();
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && lines.has(lineOf(source, node))) {
      const parent = node.parent;
      const naming =
        (ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isImportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isBindingElement(parent)) &&
        (parent as { name?: ts.Node }).name === node;
      if (!naming && checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any)
        found.push(`${path}:${lineOf(source, node)}: \`${node.text}\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// checkJs proof: every changed file is JavaScript, the patch adds no checkJs error to it, and
// TypeScript types every name on every changed line.
export function checkJsProof(original: Repository, patched: Repository, diff: string): CodeProof {
  const { files, other, before, after } = changedFiles(original, patched, diff);
  const reasons = other.map(
    (path) => `${path}: the patch changes this file, which checkJs does not check`,
  );
  const typescript = files.filter((path) => !JAVASCRIPT.test(path));
  reasons.push(
    ...typescript.map(
      (path) => `${path}: TypeScript, which the repository's own type check must cover`,
    ),
  );
  const roots = files.filter((path) => JAVASCRIPT.test(path));
  if (!roots.length) return { proven: false, reasons: [...reasons, 'No changed JavaScript file.'] };
  const programs = [checkJsProgram(before, roots), checkJsProgram(after, roots)];
  const [old, next] = programs.map((program) => diagnosticKeys(program, roots));
  const remaining = [...old];
  const introduced = next.filter((key) => {
    const index = remaining.indexOf(key);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
  reasons.push(...introduced.slice(0, 5).map((key) => `checkJs reports a new error: ${key}`));
  const untyped = roots.flatMap((path) => {
    const lines = new Set<number>();
    for (const hunk of structuredPatch(path, path, before.get(path)!, after.get(path)!, '', '', {
      context: 0,
    }).hunks) {
      let line = hunk.newStart;
      for (const text of hunk.lines)
        if (text.startsWith('+')) lines.add(line++);
        else if (!text.startsWith('-')) line++;
    }
    return untypedNames(programs[1], path, lines);
  });
  if (untyped.length)
    reasons.push(
      `checkJs cannot type ${untyped.length} name${untyped.length === 1 ? '' : 's'} on the changed lines, so it proves nothing about them: ${untyped.slice(0, MAX_UNTYPED).join(', ')}`,
    );
  return { proven: reasons.length === 0, reasons };
}

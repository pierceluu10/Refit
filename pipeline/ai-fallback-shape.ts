import ts from 'typescript-compiler';
import type { ProofCall } from './ai-request-proof.ts';
import { changedOldLines } from './ai-surface-lane.ts';

// Static checks on an AI fallback patch that the repository's own checks can miss
// (pipeline/ai-fallback.ts): the request shape each changed provider call really sends, values a
// patch makes required at runtime that no caller supplies, and deprecated code a patch only hid
// from Refit's rules. JavaScript and TypeScript only; Python patches never validate.

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const CALL =
  /(?:^|\.)((?:beta\.)?(?:chat\.completions|responses|messages|completions|models|embeddings)\.(?:create|parse|stream|generateContent|generateContentStream|countTokens|embedContent))$/;
const TOOLS = new Set(['tools', 'tool_choice', 'functions', 'function_call', 'toolConfig']);
const JSON_OUTPUT = new Set([
  'response_format',
  'responseMimeType',
  'responseSchema',
  'responseJsonSchema',
  'output_format',
]);

// What each of Refit's probes (pipeline/ai-request-proof.ts) actually sends. A call shape with a
// feature its probe cannot send is not proven, whatever the probe answers.
export const PROBE_FEATURES: Record<string, Record<string, Array<'stream' | 'tools' | 'json'>>> = {
  openai: { 'chat.completions.create': ['stream', 'tools', 'json'], 'responses.create': [] },
  anthropic: { 'messages.create': ['stream', 'tools'] },
  gemini: { 'models.generateContent': [], 'models.generateContentStream': ['stream'] },
};

export interface RequestShape extends ProofCall {
  // The request argument could not be read (a spread, a variable Refit cannot follow), so its
  // tools, format and streaming are unknown.
  unreadable?: boolean;
  file: string;
  line: number;
}

function source(path: string, content: string) {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : path.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
}

const lineOf = (file: ts.SourceFile, position: number) =>
  file.getLineAndCharacterOfPosition(position).line + 1;

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

// The object literal a request argument is, following one `const` in the same file.
function requestObject(file: ts.SourceFile, argument: ts.Expression | undefined) {
  if (!argument) return null;
  if (ts.isObjectLiteralExpression(argument)) return argument;
  if (!ts.isIdentifier(argument)) return null;
  let found: ts.ObjectLiteralExpression | null = null;
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === argument.text &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      found = node.initializer;
  });
  return found;
}

// Every provider call whose span holds a line the patch added, with the request features its
// argument sends. A spread or an argument Refit cannot follow is unreadable.
export function requestShapes(path: string, before: string, after: string): RequestShape[] {
  if (!SCRIPT.test(path)) return [];
  const added = new Set(changedOldLines(before, after).added);
  const file = source(path, after);
  const shapes: RequestShape[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const match = CALL.exec(node.expression.getText(file).replace(/\s+/g, ''));
    if (!match) return;
    const [start, end] = [lineOf(file, node.getStart()), lineOf(file, node.getEnd())];
    if (![...added].some((line) => line >= start && line <= end)) return;
    const call = match[1].replace(/^beta\./, '');
    const object = requestObject(file, node.arguments[0]);
    const shape: RequestShape = {
      call,
      stream: /\.stream$|Stream$/.test(call),
      tools: false,
      json: false,
      file: path,
      line: start,
    };
    if (!object || object.properties.some((property) => ts.isSpreadAssignment(property)))
      shape.unreadable = true;
    for (const property of object?.properties ?? []) {
      const name = property.name && ts.isIdentifier(property.name) ? property.name.text : null;
      const text = property.name && ts.isStringLiteral(property.name) ? property.name.text : null;
      const key = name ?? text;
      if (!key) continue;
      if (TOOLS.has(key)) shape.tools = true;
      if (JSON_OUTPUT.has(key)) shape.json = true;
      if (key === 'stream') shape.stream = true;
      // Responses' JSON output is text.format; Gemini's is inside config or generationConfig.
      if (
        (key === 'text' || key === 'config' || key === 'generationConfig') &&
        ts.isPropertyAssignment(property) &&
        ts.isObjectLiteralExpression(property.initializer)
      )
        for (const inner of property.initializer.properties) {
          const innerName = inner.name && ts.isIdentifier(inner.name) ? inner.name.text : '';
          if (innerName === 'format' || JSON_OUTPUT.has(innerName)) shape.json = true;
          if (TOOLS.has(innerName)) shape.tools = true;
        }
    }
    shapes.push(shape);
  });
  return shapes;
}

// Why a shape cannot be proven by Refit's probes, or null when it can.
export function unprovable(provider: string, shape: ProofCall & { unreadable?: boolean }) {
  if (shape.unreadable)
    return `Refit could not read the request ${shape.call} sends, so its tools, format and streaming are unknown.`;
  const features = PROBE_FEATURES[provider]?.[shape.call];
  if (!features) return `Refit has no request probe for ${provider} ${shape.call}.`;
  const missing = (['stream', 'tools', 'json'] as const).filter(
    (feature) => shape[feature] && !features.includes(feature),
  );
  return missing.length
    ? `Refit's probe for ${shape.call} cannot send ${missing.join(' or ')} yet, so the call's real shape is unproven.`
    : null;
}

// --- Values the patch makes required at runtime -------------------------------------------------

interface Callable {
  name: string;
  parameters: number;
  constructor: boolean;
}

function callables(file: ts.SourceFile) {
  const found: Callable[] = [];
  walk(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name)
      found.push({ name: node.name.text, parameters: node.parameters.length, constructor: false });
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      found.push({
        name: node.name.text,
        parameters: node.initializer.parameters.length,
        constructor: false,
      });
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name))
      found.push({ name: node.name.text, parameters: node.parameters.length, constructor: false });
    else if (
      ts.isConstructorDeclaration(node) &&
      ts.isClassDeclaration(node.parent) &&
      node.parent.name
    )
      found.push({
        name: node.parent.name.text,
        parameters: node.parameters.length,
        constructor: true,
      });
  });
  return found;
}

// The most arguments any call site of `name` passes in the given files, or null with none.
function mostArguments(files: Array<{ path: string; content: string }>, item: Callable) {
  let most: number | null = null;
  for (const entry of files) {
    if (!SCRIPT.test(entry.path) || !entry.content.includes(item.name)) continue;
    const file = source(entry.path, entry.content);
    walk(file, (node) => {
      const isCall = item.constructor ? ts.isNewExpression(node) : ts.isCallExpression(node);
      if (!isCall) return;
      const callee = (node as ts.CallExpression | ts.NewExpression).expression.getText(file);
      if (callee !== item.name && !callee.endsWith(`.${item.name}`)) return;
      const count = (node as ts.CallExpression | ts.NewExpression).arguments?.length ?? 0;
      most = Math.max(most ?? 0, count);
    });
  }
  return most;
}

const MISSING =
  /^!|(?:===?|!==?)\s*(?:undefined|null)\b|\b(?:undefined|null)\s*(?:===?|!==?)|typeof\s.+===?\s*['"]undefined['"]/;

// Two shapes of one mistake: a function or constructor gains a parameter no call site passes,
// and a new `throw` guarded by a check that a value is missing. Typecheck passes on both (an
// optional parameter, an `options?.x` read), and the code fails at runtime.
export function runtimeRequirements(
  changed: Array<{ path: string; before: string | null; after: string }>,
  repository: Array<{ path: string; content: string }>,
): string[] {
  const problems: string[] = [];
  const patched = new Map(repository.map((file) => [file.path, file.content]));
  for (const file of changed) patched.set(file.path, file.after);
  const all = [...patched].map(([path, content]) => ({ path, content }));
  for (const file of changed) {
    if (!SCRIPT.test(file.path)) continue;
    const after = source(file.path, file.after);
    const before = file.before === null ? null : source(file.path, file.before);
    const old = new Map((before ? callables(before) : []).map((item) => [item.name, item]));
    for (const item of callables(after)) {
      const was = old.get(item.name);
      if (!was || item.parameters <= was.parameters) continue;
      const most = mostArguments(all, item);
      if (most === null || most < item.parameters)
        problems.push(
          `${file.path}: ${item.constructor ? 'the constructor of ' : ''}${item.name} now takes ${item.parameters} parameter${item.parameters === 1 ? '' : 's'}, and ${most === null ? 'no call site calls it' : `no call site passes more than ${most}`}.`,
        );
    }
    const added = new Set(changedOldLines(file.before ?? '', file.after).added);
    walk(after, (node) => {
      if (!ts.isThrowStatement(node) || !added.has(lineOf(after, node.getStart()))) return;
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent)
        if (ts.isIfStatement(parent)) {
          const condition = parent.expression.getText(after).replace(/\s+/g, ' ');
          if (MISSING.test(condition))
            problems.push(
              `${file.path}:${lineOf(after, node.getStart())}: the patch throws when \`${condition.slice(0, 80)}\`; check that every caller supplies the value.`,
            );
          break;
        }
    });
  }
  return problems;
}

// --- Deprecated code a patch hid instead of fixing ----------------------------------------------

// The member chain a finding's code calls, such as `beta.assistants.create` or
// `completions.create`, without the client it is called on.
export function findingChain(text: string) {
  const match = /((?:beta\.)?(?:[a-z][A-Za-z]*\.){1,3}[a-z][A-Za-z]*)\s*\(/.exec(text);
  if (!match) return null;
  const parts = match[1].split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : match[1];
}

// A finding the rescan no longer reports whose deprecated chain or retired model is still in its
// file: a rename or alias hid it from Refit's rules, and nothing was fixed.
export function hiddenFindings(
  items: Array<{ kind: string; ref: string; file: string; text: string; retired?: string[] }>,
  remaining: Array<{ kind: string; ref: string; file: string }>,
  patched: Map<string, string>,
) {
  const hidden: string[] = [];
  for (const item of items) {
    if (
      remaining.some(
        (left) => left.kind === item.kind && left.ref === item.ref && left.file === item.file,
      )
    )
      continue;
    const content = patched.get(item.file);
    if (content === undefined) continue;
    const chain =
      item.kind === 'review' || item.kind === 'sdk-major' ? findingChain(item.text) : null;
    // One identifier, then the chain: `client.chat.completions.create(` is not `completions.create`.
    const called =
      chain &&
      chain.includes('.') &&
      new RegExp(
        `(?:^|[^\\w$.])[A-Za-z_$][\\w$]*\\??\\.${chain.replace(/\./g, '\\.')}\\s*\\(`,
        'm',
      ).test(content);
    if (called)
      hidden.push(
        `${item.file}: \`${chain}\` is still called, but Refit's rule ${item.ref} no longer matches it.`,
      );
    for (const model of item.retired ?? [])
      if (new RegExp(`["'\`]${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`).test(content))
        hidden.push(`${item.file}: the retired model ${model} is still in the file.`);
  }
  return [...new Set(hidden)];
}

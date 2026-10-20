import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { daysUntil } from './deadline-registry.ts';
import { TEST_PATH } from './deadline-exposure.ts';
import { renderPatch } from './patches.ts';
import { readProviderAdapter, type ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import type { SourceEdit } from './types.ts';

// Text-generation calls whose `model` selects a chat or reasoning model. Embeddings, images, audio,
// moderation and legacy completions are left out: their replacements change vector sizes, formats,
// endpoints or parameters.
const MODEL_CALLS: Record<string, Set<string>> = {
  openai: new Set([
    'chat.completions.create',
    'chat.completions.parse',
    'chat.completions.stream',
    'beta.chat.completions.parse',
    'beta.chat.completions.stream',
    'responses.create',
    'responses.parse',
    'responses.stream',
  ]),
  anthropic: new Set([
    'messages.create',
    'messages.stream',
    'messages.countTokens',
    'beta.messages.create',
    'beta.messages.stream',
    'beta.messages.countTokens',
  ]),
};

// The OpenAI v3 SDK and openai-edge, which keeps its API: methods on an `OpenAIApi` client.
function legacyOpenAi(packageName: string): ProviderAdapter {
  return {
    id: 'openai',
    packageName,
    defaultImport: false,
    namedExport: 'OpenAIApi',
    operations: [],
  };
}

// How each provider's model-bearing calls are traced. The Anthropic adapter is not in the agent
// catalog yet (Anthropic publishes no contract for `refit run`), but it traces the same calls.
const TRACERS: {
  provider: DeadlineEntry['provider'];
  adapter: URL | ProviderAdapter;
  resourceCalls?: Set<string>;
  clientCalls?: Set<string>;
}[] = [
  {
    provider: 'openai',
    adapter: new URL('../examples/openai.provider.json', import.meta.url),
    resourceCalls: MODEL_CALLS.openai,
  },
  ...['openai', 'openai-edge'].map((packageName) => ({
    provider: 'openai' as const,
    adapter: legacyOpenAi(packageName),
    clientCalls: new Set(['createChatCompletion']),
  })),
  {
    provider: 'anthropic',
    adapter: new URL('../examples/anthropic.provider.json', import.meta.url),
    resourceCalls: MODEL_CALLS.anthropic,
  },
];
// Request parameters a newer model may reject or treat differently. Anthropic returns a 400 for
// non-default temperature, top_p and top_k on Claude 4.7 and later models (Anthropic model
// deprecations page, 2026-10-20). OpenAI reasoning models' support for the sampling and length
// parameters below: unverified, so they stop for review too.
const SENSITIVE_PARAMETERS: Record<string, Set<string>> = {
  openai: new Set([
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
  ]),
  anthropic: new Set(['temperature', 'top_p', 'top_k']),
};
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const MAX_CHAIN = 8;

export interface ModelReplacement {
  deadline: string;
  provider: DeadlineEntry['provider'];
  date: string;
  days: number;
  file: string;
  line: number;
  call: string;
  from: string;
  to: string;
  // Registry deadlines followed from `from` to `to`, when a replacement retires too.
  via: string[];
}

export interface ModelReplacementStop {
  deadline: string;
  provider: DeadlineEntry['provider'];
  file: string;
  line: number;
  call: string;
  model: string;
  reason: string;
}

export interface ModelReplacementProposal {
  replacements: ModelReplacement[];
  stops: ModelReplacementStop[];
  // A unified diff of every replacement; null when there is none. Never applied by Refit.
  patch: string | null;
}

// The model a retiring one should become: the registry replacement, followed while it retires
// too. Null when an entry names no concrete model ID or the chain loops.
function finalReplacement(
  entry: DeadlineEntry,
  byModel: Map<string, DeadlineEntry>,
): { to: string; via: string[] } | null {
  const via = [entry.id];
  let current = entry;
  for (let step = 0; step < MAX_CHAIN; step += 1) {
    const next = current.replacement?.trim();
    if (!next || !MODEL_ID.test(next)) return null;
    const retiring = byModel.get(next);
    if (!retiring) return { to: next, via };
    if (via.includes(retiring.id)) return null;
    via.push(retiring.id);
    current = retiring;
  }
  return null;
}

function propertyName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// The `const NAME = …` declaration a reference resolves to, looked up through the enclosing
// blocks of the same file. Anything else (parameters, `let`, imports) is not followed.
function constDeclaration(from: ts.Node, name: string) {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) continue;
    for (const statement of scope.statements)
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          )
            return {
              declaration,
              initializer: unwrap(declaration.initializer),
              exported: Boolean(
                statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword),
              ),
            };
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

// Uses of a name in a file other than its declaration and property names. A const used once is
// safe to edit where it is declared; one used more often may feed other code.
function referenceCount(source: ts.SourceFile, name: string) {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    )
      count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

// A const declared once in the file, not exported, and used only at this one place.
function usedOnce(source: ts.SourceFile, found: ReturnType<typeof constDeclaration>) {
  return Boolean(
    found &&
    !found.exported &&
    referenceCount(source, found.declaration.name.getText(source)) === 1,
  );
}

// The traced call at an analyzer location: the call whose callee matches the traced expression.
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

// Proposes replacing a retiring model ID with its registry replacement, only where the ID is a
// literal `model` in a traced SDK call (or the default of an `??` or `||` fallback there), outside
// tests. Anything less certain stops for review with a reason. Nothing is written, applied,
// validated or sent to a provider: the proposal is a patch for a person to review.
export async function proposeModelReplacements(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
): Promise<ModelReplacementProposal> {
  const replacements: ModelReplacement[] = [];
  const stops: ModelReplacementStop[] = [];
  const edits: SourceEdit[] = [];
  let patched: Awaited<ReturnType<typeof readRepository>> | undefined;
  for (const tracer of TRACERS) {
    const { provider } = tracer;
    const byModel = new Map<string, DeadlineEntry>();
    for (const entry of registry.deadlines)
      if (entry.provider === provider && entry.kind === 'model')
        for (const version of entry.versions) byModel.set(version, entry);
    if (!byModel.size) continue;
    const adapter =
      tracer.adapter instanceof URL
        ? await readProviderAdapter(fileURLToPath(tracer.adapter))
        : tracer.adapter;
    const repository = await readRepository(directory, adapter.packageName);
    const analysis = analyzeRepository(repository, [], adapter);
    const traced = [
      ...analysis.sdkCalls
        .map((sdk) => ({ ...sdk, call: `${sdk.resource}.${sdk.method}` }))
        .filter((sdk) => tracer.resourceCalls?.has(sdk.call)),
      ...analysis.clientMethodCalls
        .map((sdk) => ({ ...sdk, call: sdk.method }))
        .filter((sdk) => tracer.clientCalls?.has(sdk.call)),
    ];
    const sources = new Map<string, ts.SourceFile>();
    for (const sdk of traced) {
      const { call } = sdk;
      const file = repository.files.find((item) => item.path === sdk.file);
      if (!file) continue;
      const source =
        sources.get(file.path) ??
        ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
      sources.set(file.path, source);
      const node = callAt(source, sdk.line, sdk.column, sdk.expression);
      const argument = node?.arguments[0] && unwrap(node.arguments[0]);
      if (!node || !argument) continue;
      // The request object: inline, or a const declared in scope, such as `const params = {…}`.
      let request: ts.ObjectLiteralExpression | undefined;
      let sharedRequest: string | undefined;
      if (ts.isObjectLiteralExpression(argument)) request = argument;
      else if (ts.isIdentifier(argument)) {
        const found = constDeclaration(node, argument.text);
        if (found && ts.isObjectLiteralExpression(found.initializer)) {
          request = found.initializer;
          if (!usedOnce(source, found)) sharedRequest = argument.text;
        }
      }
      if (!request) continue;
      const model = request.properties.find(
        (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          propertyName(property.name) === 'model',
      );
      if (!model) continue;
      let literal: ts.StringLiteralLike | undefined;
      let sharedConstant: string | undefined;
      const value = unwrap(ts.isPropertyAssignment(model) ? model.initializer : model.name);
      if (ts.isStringLiteralLike(value)) literal = value;
      else if (
        ts.isBinaryExpression(value) &&
        [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
          value.operatorToken.kind,
        ) &&
        ts.isStringLiteralLike(value.right)
      )
        literal = value.right;
      else if (ts.isIdentifier(value)) {
        const found = constDeclaration(value, value.text);
        if (found && ts.isStringLiteralLike(found.initializer)) {
          literal = found.initializer;
          if (!usedOnce(source, found)) sharedConstant = value.text;
        }
      }
      const entry = literal && byModel.get(literal.text);
      if (!literal || !entry) continue;
      const stop = (reason: string) =>
        stops.push({
          deadline: entry.id,
          provider: entry.provider,
          file: file.path,
          line: sdk.line,
          call,
          model: literal.text,
          reason,
        });
      if (TEST_PATH.test(file.path)) continue;
      const resolved = finalReplacement(entry, byModel);
      if (!resolved) {
        stop('The registry names no concrete replacement model ID.');
        continue;
      }
      const declaredAt = (node: ts.Node) =>
        `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
      if (sharedConstant) {
        stop(
          `The model comes from the constant ${sharedConstant} (${declaredAt(literal)}), which is exported or used elsewhere; change it by hand to ${resolved.to}.`,
        );
        continue;
      }
      if (sharedRequest) {
        stop(
          `The request object ${sharedRequest} (${declaredAt(request)}) is exported or used elsewhere; change its model by hand to ${resolved.to}.`,
        );
        continue;
      }
      if (request.properties.some((property) => ts.isSpreadAssignment(property))) {
        stop(
          'The request spreads other options, which may set parameters the replacement rejects.',
        );
        continue;
      }
      const sensitive = request.properties
        .map((property) => (property.name ? propertyName(property.name) : undefined))
        .filter((name): name is string =>
          Boolean(name && SENSITIVE_PARAMETERS[provider].has(name)),
        );
      if (sensitive.length) {
        stop(
          `The request sets ${sensitive.join(', ')}, which ${resolved.to} may reject or treat differently.`,
        );
        continue;
      }
      const start = literal.getStart(source);
      if (edits.some((edit) => edit.file === file.path && edit.start === start)) continue;
      const quote = file.content[start];
      edits.push({
        file: file.path,
        start,
        end: literal.end,
        replacement: `${quote}${resolved.to}${quote}`,
        changeId: entry.id,
        rule: 'model-retirement',
      });
      replacements.push({
        deadline: entry.id,
        provider: entry.provider,
        date: entry.date,
        days: daysUntil(entry.date, now),
        file: file.path,
        line: sdk.line,
        call,
        from: literal.text,
        to: resolved.to,
        via: resolved.via,
      });
      patched = repository;
    }
  }
  // Both adapters read the same source files, so one repository renders every edit.
  return {
    replacements,
    stops,
    patch: patched && edits.length ? renderPatch(patched, edits) : null,
  };
}

import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { daysUntil } from './deadline-registry.ts';
import { TEST_PATH } from './deadline-exposure.ts';
import { renderPatch } from './patches.ts';
import { readProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import type { SourceEdit } from './types.ts';

// Adapters whose SDK calls carry a model argument. The Anthropic adapter is not in the agent
// catalog yet (Anthropic publishes no contract for `refit run`), but it traces the same calls.
const MODEL_ADAPTERS: Record<string, URL> = {
  openai: new URL('../examples/openai.provider.json', import.meta.url),
  anthropic: new URL('../examples/anthropic.provider.json', import.meta.url),
};
// Text-generation calls whose `model` selects a chat or reasoning model. Embeddings, images, audio
// and moderation are left out: their replacements change vector sizes, formats or parameters.
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

// A top-level `const NAME = 'literal'` in the same file, the one indirection a model argument
// commonly has. It is reported, never edited.
function constantLiteral(source: ts.SourceFile, name: string) {
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer &&
          ts.isStringLiteralLike(declaration.initializer)
        )
          return declaration.initializer;
  return undefined;
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
  for (const [provider, adapterPath] of Object.entries(MODEL_ADAPTERS)) {
    const byModel = new Map<string, DeadlineEntry>();
    for (const entry of registry.deadlines)
      if (entry.provider === provider && entry.kind === 'model')
        for (const version of entry.versions) byModel.set(version, entry);
    if (!byModel.size) continue;
    const adapter = await readProviderAdapter(fileURLToPath(adapterPath));
    const repository = await readRepository(directory, adapter.packageName);
    const { sdkCalls } = analyzeRepository(repository, [], adapter);
    const sources = new Map<string, ts.SourceFile>();
    for (const sdk of sdkCalls) {
      const call = `${sdk.resource}.${sdk.method}`;
      if (!MODEL_CALLS[provider].has(call)) continue;
      const file = repository.files.find((item) => item.path === sdk.file);
      if (!file) continue;
      const source =
        sources.get(file.path) ??
        ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
      sources.set(file.path, source);
      const node = callAt(source, sdk.line, sdk.column, sdk.expression);
      const request = node?.arguments[0];
      if (!request || !ts.isObjectLiteralExpression(request)) continue;
      const model = request.properties.find(
        (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          propertyName(property.name) === 'model',
      );
      if (!model) continue;
      let literal: ts.StringLiteralLike | undefined;
      let constant: string | undefined;
      const value = ts.isPropertyAssignment(model) ? model.initializer : model.name;
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
        literal = constantLiteral(source, value.text);
        constant = value.text;
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
      if (constant) {
        const line = source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1;
        stop(
          `The model comes from the constant ${constant} (${file.path}:${line}), which may feed other code; change it by hand to ${resolved.to}.`,
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

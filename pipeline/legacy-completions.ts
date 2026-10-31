import { dirname } from 'node:path';
import ts from 'typescript-compiler';
import type { AiRule, AiRuleTable } from './ai-rules.ts';
import type { Repository } from './types.ts';

// The two retired completion APIs, moved to their provider's current API together with a model
// swap: OpenAI legacy Completions (`completions.create`) to Responses (`responses.create`), and
// Anthropic Text Completions (`completions.create` with a `\n\nHuman:` … `\n\nAssistant:` prompt)
// to Messages (`messages.create`). Every mapping is an `auto` rule in
// data/rules/<provider>/api-surfaces.json quoting a saved provider page; without all of them the
// call stops as before. A request is rewritten only when its parameters, its prompt and every read
// of its response have a mapping; anything else stops with what Refit could not follow, so the AI
// fallback gets the site with that reason. Nothing here claims the new API answers the same.

export const LEGACY_COMPLETION_CALLS: Record<string, ReadonlySet<string>> = {
  openai: new Set(['completions.create', 'createCompletion']),
  anthropic: new Set(['completions.create']),
};

const RULES = {
  openai: {
    call: 'openai-legacy-completions-to-responses',
    release: 'openai-legacy-completions-sdk-release',
    input: 'openai-legacy-completions-input',
    length: 'openai-legacy-completions-max-output-tokens',
    kept: 'openai-legacy-completions-kept-parameters',
    read: 'openai-legacy-completions-output-text',
    stream: 'openai-legacy-completions-stream-delta',
  },
  anthropic: {
    call: 'anthropic-text-completions-to-messages',
    release: 'anthropic-text-completions-sdk-release',
    input: 'anthropic-text-completions-prompt-turns',
    turns: 'anthropic-text-completions-messages-turns',
    length: 'anthropic-text-completions-max-tokens',
    kept: 'anthropic-text-completions-kept-parameters',
    read: 'anthropic-text-completions-content',
    stream: 'anthropic-text-completions-stream-delta',
  },
} as const;

export type LegacyProvider = keyof typeof RULES;

export interface LegacyRewrite {
  // The call the request becomes, for request proof and the draft.
  to: 'responses.create' | 'messages.create';
  // Every rule the rewrite applied, in order.
  rules: string[];
  // Edits in the request's own file, beside the model swap.
  edits: { start: number; end: number; replacement: string }[];
  // Request parameters under their new names, so the model-parameter rules judge the new request.
  renamed: ReadonlyMap<string, string>;
}

export type LegacyPlan = { rewrite: LegacyRewrite } | { reason: string };

// What the planner needs from the analysis: symbols as resolved and as written, and every use.
export interface LegacyProgram {
  symbolOf: (node: ts.Node) => ts.Symbol | undefined;
  bindingOf: (node: ts.Node) => ts.Symbol | undefined;
  usesOf: (symbol: ts.Symbol) => readonly ts.Node[];
}

// The rewrite rules of a provider, or why the rewrite is off: every rule must be `auto`.
export function legacyRules(tables: AiRuleTable[], provider: LegacyProvider) {
  const rules = new Map<string, AiRule>();
  for (const table of tables)
    if (table.provider === provider && table.kind === 'api-surface')
      for (const rule of table.rules) rules.set(rule.rule, rule);
  const missing = Object.values(RULES[provider]).filter((id) => rules.get(id)?.status !== 'auto');
  return missing.length
    ? { reason: `The rewrite rule ${missing[0]} is not an auto rule in Refit's tables` }
    : { rules };
}

// The SDK release the file's own project installs: the nearest package.json that
// declares it, locked version first, else an exact or caret/tilde minimum.
// readRepository(directory, packageName) lists only that package's declarations.
export function installedSdkRelease(repository: Repository, file: string) {
  let best: (typeof repository.dependencies)[number] | undefined;
  for (const item of repository.dependencies) {
    const folder = dirname(item.file);
    const holds = folder === '.' || file.startsWith(`${folder}/`);
    if (holds && (!best || dirname(item.file).length > dirname(best.file).length)) best = item;
  }
  if (!best) return null;
  if (best.lock.status === 'locked' && best.lock.version) return best.lock.version;
  const minimum = /^[~^]?(\d+\.\d+\.\d+)$/.exec(best.version.trim());
  return minimum ? minimum[1] : null;
}

function atLeast(version: string, minimum: string) {
  const parse = (text: string) => text.split(/[-+]/)[0].split('.').map(Number);
  const [a, b] = [parse(version), parse(minimum)];
  for (let index = 0; index < 3; index++)
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

function nameOf(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return undefined;
}

const API = { openai: 'Responses', anthropic: 'Messages' } as const;

export function planLegacyCompletion(options: {
  provider: LegacyProvider;
  call: string;
  node: ts.CallExpression;
  program: LegacyProgram;
  rules: Map<string, AiRule>;
  // The installed SDK release, or null when Refit cannot tell.
  release: string | null;
}): LegacyPlan {
  const { provider, call, node, program, rules } = options;
  const ids = RULES[provider];
  const api = API[provider];
  const packageName = rules.get(ids.release)!.data.package as string;
  if (provider === 'openai' && call === 'createCompletion')
    return {
      reason: `\`createCompletion\` is on an openai v3-style client (openai 3 or openai-edge), which has no ${api} API; upgrade the SDK, then move this call by hand.`,
    };
  const minimum = rules.get(ids.release)!.data.minRelease as string;
  if (!options.release)
    return {
      reason: `Refit cannot tell which ${packageName} release this file's project installs, and the ${api} API needs ${minimum} or later; move this call by hand.`,
    };
  if (!atLeast(options.release, minimum))
    return {
      reason: `${packageName} ${options.release} predates ${minimum}, the first release with the ${api} API; upgrade the SDK, then move this call by hand.`,
    };
  // `<client>.completions.create(…)`: the resource name is what changes.
  const callee = node.expression;
  const resource =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'create' &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'completions'
      ? callee.expression.name
      : undefined;
  if (!resource || node.arguments.length > 2 || node.questionDotToken)
    return {
      reason: `The call is not written as \`<client>.completions.create(request)\`, which is the only form Refit rewrites.`,
    };
  const argument = node.arguments[0] && unwrap(node.arguments[0]);
  if (!argument || !ts.isObjectLiteralExpression(argument))
    return {
      reason: `The request is not an object literal written in the call, so Refit cannot rewrite its parameters.`,
    };
  const quote = preferredQuote(argument);
  const edits: LegacyRewrite['edits'] = [
    {
      start: resource.getStart(),
      end: resource.end,
      replacement: provider === 'openai' ? 'responses' : 'messages',
    },
  ];
  const applied: string[] = [ids.call, ids.release];
  const renamed = new Map<string, string>();
  const kept = new Set(rules.get(ids.kept)!.data.keep as string[]);
  const inputRule = rules.get(ids.input)!.data;
  const lengthRule = rules.get(ids.length)!.data;
  const promptName = provider === 'openai' ? (inputRule.from as string) : 'prompt';
  const lengthName = lengthRule.from as string;
  let stream = false;
  let prompt: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined;
  for (const item of argument.properties) {
    if (!(ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)))
      return {
        reason: `The request spreads or computes properties, so Refit cannot see every parameter it sends to ${api}.`,
      };
    const name = nameOf(item.name);
    if (name === undefined || ts.isComputedPropertyName(item.name))
      return {
        reason: `The request sets a computed property, which may be a parameter ${api} does not take.`,
      };
    if (name === promptName) {
      prompt = item;
      continue;
    }
    if (name === lengthName) {
      const value = ts.isPropertyAssignment(item) ? unwrap(item.initializer) : undefined;
      const least = lengthRule.minimum as number | undefined;
      if (least !== undefined) {
        if (!value || !ts.isNumericLiteral(value))
          return {
            reason: `\`${name}\` is not written as a number, and ${api}'s \`${lengthRule.to as string}\` takes no value below ${least}; move this call by hand.`,
          };
        if (Number(value.text) < least)
          return {
            reason: `\`${name}\` is ${value.text}, below the minimum of ${least} for ${api}'s \`${lengthRule.to as string}\`; move this call by hand.`,
          };
      }
      edits.push(renameProperty(item, lengthRule.to as string));
      renamed.set(name, lengthRule.to as string);
      applied.push(ids.length);
      continue;
    }
    if (!kept.has(name))
      return {
        reason: `The request sets \`${name}\`, which the ${api} API has no parameter for; move this call by hand.`,
      };
    if (name === 'stream') {
      const value = ts.isPropertyAssignment(item) ? unwrap(item.initializer) : undefined;
      if (value?.kind === ts.SyntaxKind.TrueKeyword) stream = true;
      else if (value?.kind !== ts.SyntaxKind.FalseKeyword)
        return {
          reason: `\`stream\` is not written as true or false, so Refit cannot tell which ${api} response shape to read.`,
        };
    }
  }
  if (!prompt) return { reason: `The request sets no \`${promptName}\` Refit can see.` };
  if (provider === 'openai') {
    const value = ts.isPropertyAssignment(prompt) ? prompt.initializer : prompt.name;
    if (!oneString(value, program))
      return {
        reason: `Refit cannot show that \`${promptName}\` is one string (legacy Completions also takes arrays of prompts or tokens, which \`input\` does not); move this call by hand.`,
      };
    edits.push(renameProperty(prompt, inputRule.to as string));
    renamed.set(promptName, inputRule.to as string);
    applied.push(ids.input);
  } else {
    const turns = anthropicTurns(prompt, program, quote);
    if ('reason' in turns) return turns;
    edits.push(...turns.edits);
    renamed.set('prompt', 'messages');
    applied.push(ids.input, RULES.anthropic.turns);
  }
  const reads = responseReads(node, provider, stream, program);
  if ('reason' in reads) return reads;
  edits.push(...reads.edits);
  if (reads.edits.length) applied.push(stream ? ids.stream : ids.read);
  return {
    rewrite: {
      to: provider === 'openai' ? 'responses.create' : 'messages.create',
      rules: applied,
      edits,
      renamed,
    },
  };
}

function renameProperty(item: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, to: string) {
  if (ts.isShorthandPropertyAssignment(item))
    return {
      start: item.name.getStart(),
      end: item.name.end,
      replacement: `${to}: ${item.name.text}`,
    };
  const text = item.getSourceFile().text;
  const quote = ts.isStringLiteral(item.name) ? text[item.name.getStart()] : '';
  return { start: item.name.getStart(), end: item.name.end, replacement: `${quote}${to}${quote}` };
}

// The quote the request writes its strings with, so new strings read like the code around them.
function preferredQuote(object: ts.ObjectLiteralExpression) {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (!found && ts.isStringLiteral(node)) found = node.getSourceFile().text[node.getStart()];
    if (!found) ts.forEachChild(node, visit);
  };
  visit(object);
  return found ?? "'";
}

// Whether an expression is one string as written: a string or template literal, a `+` with one,
// or a `const` (or a `string`-annotated variable or required parameter) that is.
function oneString(expression: ts.Expression, program: LegacyProgram, depth = 0): boolean {
  if (depth > 4) return false;
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return true;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return oneString(value.left, program, depth + 1) || oneString(value.right, program, depth + 1);
  if (ts.isAsExpression(expression) && expression.type.kind === ts.SyntaxKind.StringKeyword)
    return true;
  if (ts.isCallExpression(value)) {
    const callee = value.expression;
    if (ts.isIdentifier(callee) && callee.text === 'String') return true;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') return true;
    if (
      ts.isPropertyAccessExpression(callee) &&
      [
        'trim',
        'trimStart',
        'trimEnd',
        'toLowerCase',
        'toUpperCase',
        'replace',
        'replaceAll',
      ].includes(callee.name.text)
    )
      return oneString(callee.expression, program, depth + 1);
    return false;
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = program.symbolOf(value)?.valueDeclaration;
  if (!declaration) return false;
  if (ts.isParameter(declaration))
    return (
      declaration.type?.kind === ts.SyntaxKind.StringKeyword &&
      !declaration.questionToken &&
      !declaration.dotDotDotToken
    );
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  if (declaration.type) return declaration.type.kind === ts.SyntaxKind.StringKeyword;
  const list = declaration.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    Boolean(list.flags & ts.NodeFlags.Const) &&
    Boolean(declaration.initializer) &&
    oneString(declaration.initializer!, program, depth + 1)
  );
}

const HUMAN = '\n\nHuman:';
const ASSISTANT = '\n\nAssistant:';
type Token = { text: string } | { marker: 'Human' | 'Assistant' } | { expression: ts.Expression };

// `HUMAN_PROMPT` or `AI_PROMPT` imported from the SDK, or read off its default export.
function promptMarker(node: ts.Expression, program: LegacyProgram): string | undefined {
  const value = unwrap(node);
  const name = ts.isIdentifier(value)
    ? value
    : ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
      ? value.name
      : undefined;
  if (!name || (name.text !== 'HUMAN_PROMPT' && name.text !== 'AI_PROMPT')) return undefined;
  const root = ts.isPropertyAccessExpression(value) ? value.expression : value;
  const declaration = program.bindingOf(root)?.declarations?.[0];
  let statement: ts.Node | undefined = declaration;
  while (statement && !ts.isImportDeclaration(statement)) statement = statement.parent;
  const specifier =
    statement && ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
  if (specifier !== '@anthropic-ai/sdk') return undefined;
  return name.text === 'HUMAN_PROMPT' ? HUMAN : ASSISTANT;
}

// The prompt as text pieces, SDK markers and interpolated expressions, or undefined when it is
// not written as a string or template literal, or a `+` chain starting with one.
function promptTokens(expression: ts.Expression, program: LegacyProgram): Token[] | undefined {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return [{ text: value.text }];
  if (ts.isTemplateExpression(value)) {
    const tokens: Token[] = [{ text: value.head.text }];
    for (const span of value.templateSpans) {
      const marker = promptMarker(span.expression, program);
      tokens.push(marker ? { text: marker } : { expression: span.expression });
      tokens.push({ text: span.literal.text });
    }
    return tokens;
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const operands: ts.Expression[] = [];
    const flatten = (node: ts.Expression) => {
      const inner = unwrap(node);
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(inner.left);
        flatten(inner.right);
      } else operands.push(node);
    };
    flatten(value);
    const tokens: Token[] = [];
    for (const [index, operand] of operands.entries()) {
      const marker = promptMarker(operand, program);
      const inner = unwrap(operand);
      if (marker) tokens.push({ text: marker });
      else if (ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner))
        tokens.push(...promptTokens(inner, program)!);
      // A `+` chain is a string only from its first string operand on.
      else if (index === 0) return undefined;
      else tokens.push({ expression: operand });
    }
    return tokens;
  }
  return undefined;
}

// A Text Completions prompt split into Messages turns: `\n\nHuman:` and `\n\nAssistant:` markers
// in the written text (a leading `Human:` counts), alternating from Human and ending with an empty
// Assistant turn. The edits replace `prompt` with `messages`.
function anthropicTurns(
  item: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  program: LegacyProgram,
  quote: string,
): { edits: LegacyRewrite['edits'] } | { reason: string } {
  const written = ts.isPropertyAssignment(item) ? unwrap(item.initializer) : item.name;
  let tokens = promptTokens(written, program);
  // A `const` prompt used only by this request: its value becomes the user message.
  let constant: ts.VariableDeclaration | undefined;
  if (!tokens && ts.isIdentifier(written)) {
    const symbol = program.symbolOf(written);
    const declaration = symbol?.valueDeclaration;
    if (
      symbol &&
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      !declaration.type &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.getSourceFile() === item.getSourceFile() &&
      program.usesOf(symbol).length === 1
    ) {
      tokens = promptTokens(declaration.initializer, program);
      constant = declaration;
    }
  }
  if (!tokens)
    return {
      reason: `The prompt is not written as a string or template literal Refit can split into Human and Assistant turns (or a constant used only here), so the conversation it sends is unknown; move this call by hand.`,
    };
  // Split the written text at the markers.
  const pieces: Token[] = [];
  for (const token of tokens) {
    if (!('text' in token)) {
      pieces.push(token);
      continue;
    }
    for (const part of token.text.split(/(\n\nHuman:|\n\nAssistant:)/))
      if (part === HUMAN) pieces.push({ marker: 'Human' });
      else if (part === ASSISTANT) pieces.push({ marker: 'Assistant' });
      else if (part) pieces.push({ text: part });
  }
  // A prompt that opens with `Human:` without the blank lines still starts a Human turn.
  const first = pieces[0];
  if (first && 'text' in first && /^\s*Human:/.test(first.text)) {
    const rest = first.text.replace(/^\s*Human:/, '');
    pieces.splice(0, 1, { marker: 'Human' }, ...(rest ? [{ text: rest }] : []));
  }
  const blank = (token: Token) => 'text' in token && !token.text.trim();
  const opening = pieces.findIndex((token) => 'marker' in token);
  const before = opening < 0 ? pieces : pieces.slice(0, opening);
  if (opening < 0 || before.some((token) => !blank(token)))
    return {
      reason:
        opening < 0 || before.some((token) => 'expression' in token)
          ? 'The prompt does not open with a `\\n\\nHuman:` turn Refit can see; the markers may be inside a value it cannot read, so move this call by hand.'
          : 'The prompt has text before its first Human turn, which no saved Anthropic page maps to a Messages field; move this call by hand.',
    };
  const turns: { role: 'Human' | 'Assistant'; content: Token[] }[] = [];
  for (const token of pieces.slice(opening))
    if ('marker' in token) turns.push({ role: token.marker, content: [] });
    else turns.at(-1)!.content.push(token);
  const last = turns.at(-1)!;
  if (last.role !== 'Assistant' || last.content.some((token) => !blank(token)))
    return {
      reason:
        last.role !== 'Assistant'
          ? 'The prompt does not end with an `\\n\\nAssistant:` turn, so Refit cannot tell where the conversation ends; move this call by hand.'
          : 'The prompt puts words in the Assistant turn (prefill), which newer Claude models reject with a 400 error; move this call by hand.',
    };
  turns.pop();
  for (const [index, turn] of turns.entries())
    if (turn.role !== (index % 2 ? 'Assistant' : 'Human'))
      return {
        reason:
          'The prompt does not alternate Human and Assistant turns, which Messages requires; move this call by hand.',
      };
  if (constant && turns.length !== 1)
    return {
      reason:
        'The prompt constant holds several turns; Refit moves only a single Human turn kept in a constant, so move this call by hand.',
    };
  const multiline = /\n/.test(
    (constant?.initializer ?? (ts.isPropertyAssignment(item) ? item.initializer : item)).getText(),
  );
  const contents: string[] = [];
  for (const turn of turns) {
    const content = trimTurn(turn.content);
    if (!content.length)
      return {
        reason: `The prompt has an empty ${turn.role} turn, which Messages rejects; move this call by hand.`,
      };
    contents.push(renderContent(content, quote, multiline));
  }
  const role = (index: number) => `${quote}${index % 2 ? 'assistant' : 'user'}${quote}`;
  if (constant)
    return {
      edits: [
        {
          start: constant.initializer!.getStart(),
          end: constant.initializer!.end,
          replacement: contents[0],
        },
        {
          start: item.getStart(),
          end: item.end,
          replacement: `messages: [{ role: ${role(0)}, content: ${(item as ts.PropertyAssignment).initializer?.getText() ?? item.name.getText()} }]`,
        },
      ],
    };
  return {
    edits: [
      {
        start: item.getStart(),
        end: item.end,
        replacement: `messages: [${contents.map((content, index) => `{ role: ${role(index)}, content: ${content} }`).join(', ')}]`,
      },
    ],
  };
}

// A turn's text without the space after its marker and the blank lines before the next one.
function trimTurn(tokens: Token[]) {
  const content = tokens.map((token) => ({ ...token }));
  while (content.length && 'text' in content[0] && !content[0].text.trim()) content.shift();
  while (
    content.length &&
    'text' in content.at(-1)! &&
    !(content.at(-1) as { text: string }).text.trim()
  )
    content.pop();
  if (content.length && 'text' in content[0])
    content[0] = { text: (content[0] as { text: string }).text.replace(/^\s+/, '') };
  const end = content.length - 1;
  if (end >= 0 && 'text' in content[end])
    content[end] = { text: (content[end] as { text: string }).text.replace(/\s+$/, '') };
  return content.filter((token) => !('text' in token) || token.text);
}

function renderContent(tokens: Token[], quote: string, multiline: boolean) {
  const escape = (text: string, delimiter: string) => {
    let out = text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    out =
      delimiter === '`'
        ? out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        : out.split(delimiter).join(`\\${delimiter}`);
    return delimiter === '`' && multiline ? out : out.replace(/\n/g, '\\n');
  };
  if (tokens.length === 1 && 'text' in tokens[0]) {
    const text = tokens[0].text;
    return multiline && text.includes('\n')
      ? `\`${escape(text, '`')}\``
      : `${quote}${escape(text, quote)}${quote}`;
  }
  return `\`${tokens
    .map((token) =>
      'text' in token
        ? escape(token.text, '`')
        : 'expression' in token
          ? `\${${token.expression.getText()}}`
          : '',
    )
    .join('')}\``;
}

// Every read of the call's response, mapped to the new shape: `const r = await …` read only as
// `r.choices[0].text` (OpenAI) or `r.completion` (Anthropic), `(await …).<read>`, or a streamed
// response consumed only by one `for await` loop whose chunks are read that way.
function responseReads(
  node: ts.CallExpression,
  provider: LegacyProvider,
  stream: boolean,
  program: LegacyProgram,
): { edits: LegacyRewrite['edits'] } | { reason: string } {
  const what = provider === 'openai' ? '`choices[0].text`' : '`completion`';
  let awaited: ts.Node = node;
  while (ts.isParenthesizedExpression(awaited.parent)) awaited = awaited.parent;
  if (!ts.isAwaitExpression(awaited.parent))
    return {
      reason: `The request's promise is not awaited where it is made (it is returned, chained or passed on), so Refit cannot follow every read of the response; move this call by hand.`,
    };
  let outer: ts.Node = awaited.parent;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const holder = outer.parent;
  const edits: LegacyRewrite['edits'] = [];
  // `for await (const chunk of await openai.completions.create({ stream: true }))`
  if (stream && ts.isForOfStatement(holder) && holder.awaitModifier && holder.expression === outer)
    return chunkReads(holder, provider, program);
  // `(await openai.completions.create(…)).choices[0].text`
  if (!stream && outer !== awaited.parent) {
    const chain = readChain(outer as ts.Expression, provider);
    if (!chain)
      return {
        reason: `The response is read as something other than ${what}, which has no mapping; move this call by hand.`,
      };
    return { edits: [tailEdit(outer as ts.Expression, chain, provider)] };
  }
  if (!ts.isVariableDeclaration(holder) || holder.initializer !== outer)
    return {
      reason: `The response is ${ts.isReturnStatement(holder) ? 'returned' : 'passed on'} rather than kept in a constant, so Refit cannot follow every read of it; move this call by hand.`,
    };
  if (!ts.isIdentifier(holder.name))
    return {
      reason: `The response is destructured, so Refit cannot follow every read of it; move this call by hand.`,
    };
  if (!(holder.parent.flags & ts.NodeFlags.Const))
    return {
      reason: `The response is kept in a \`let\` or \`var\`, which may be reassigned; move this call by hand.`,
    };
  if (holder.type)
    return {
      reason: `The response's variable is declared with a type, which the ${API[provider]} response does not have; move this call by hand.`,
    };
  const symbol = program.symbolOf(holder.name);
  if (!symbol) return { reason: 'Refit cannot resolve the response variable.' };
  const uses = program.usesOf(symbol);
  if (stream) {
    const loop = uses.length === 1 ? uses[0].parent : undefined;
    if (!loop || !ts.isForOfStatement(loop) || !loop.awaitModifier || loop.expression !== uses[0])
      return {
        reason: `The streamed response is ${uses.length === 1 ? 'handed to code Refit does not follow' : 'used in more than one place'} rather than read in one \`for await\` loop, so Refit cannot map its events; move this call by hand.`,
      };
    return chunkReads(loop, provider, program);
  }
  for (const use of uses) {
    const chain = readChain(use as ts.Expression, provider);
    if (!chain)
      return {
        reason: `The response \`${holder.name.text}\` is read as something other than ${what} (${use.parent.getText().slice(0, 60)}), which has no mapping; move this call by hand.`,
      };
    edits.push(tailEdit(use as ts.Expression, chain, provider));
  }
  return { edits };
}

// `<base>.choices[0].text` or `<base>.completion`, with optional chaining and non-null marks; the
// whole read, unless it is written to.
function readChain(base: ts.Expression, provider: LegacyProvider) {
  const skip = (node: ts.Node) => {
    while (ts.isNonNullExpression(node.parent)) node = node.parent;
    return node.parent;
  };
  let read: ts.Node | undefined;
  const first = skip(base);
  if (provider === 'anthropic') {
    read =
      ts.isPropertyAccessExpression(first) && first.name.text === 'completion' ? first : undefined;
  } else if (ts.isPropertyAccessExpression(first) && first.name.text === 'choices') {
    const index = skip(first);
    const element =
      ts.isElementAccessExpression(index) &&
      ts.isNumericLiteral(index.argumentExpression) &&
      index.argumentExpression.text === '0'
        ? index
        : undefined;
    const text = element && skip(element);
    read =
      text && ts.isPropertyAccessExpression(text) && text.name.text === 'text' ? text : undefined;
  }
  if (!read) return undefined;
  const parent = read.parent;
  if (
    (ts.isBinaryExpression(parent) &&
      parent.left === read &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ts.isDeleteExpression(parent)
  )
    return undefined;
  return read as ts.Expression;
}

// Replaces what follows the response in a read: `r.choices[0].text` → `r.output_text`.
function tailEdit(base: ts.Expression, read: ts.Expression, provider: LegacyProvider) {
  return {
    start: base.end,
    end: read.end,
    replacement:
      provider === 'openai'
        ? '.output_text'
        : ".content.map((block) => (block.type === 'text' ? block.text : '')).join('')",
  };
}

// A `for await` loop over the streamed response: each chunk read becomes the text of the new
// API's text delta events, and '' for every other event.
function chunkReads(
  loop: ts.ForOfStatement,
  provider: LegacyProvider,
  program: LegacyProgram,
): { edits: LegacyRewrite['edits'] } | { reason: string } {
  const list = loop.initializer;
  const declaration =
    ts.isVariableDeclarationList(list) && list.declarations.length === 1
      ? list.declarations[0]
      : undefined;
  if (!declaration || !ts.isIdentifier(declaration.name) || declaration.type)
    return {
      reason:
        'The stream loop does not name each chunk with one untyped variable, so Refit cannot map its reads; move this call by hand.',
    };
  const name = declaration.name.text;
  const symbol = program.symbolOf(declaration.name);
  if (!symbol) return { reason: 'Refit cannot resolve the stream chunk variable.' };
  const edits: LegacyRewrite['edits'] = [];
  for (const use of program.usesOf(symbol)) {
    const read = readChain(use as ts.Expression, provider);
    if (!read)
      return {
        reason: `A stream chunk is read as something other than its text (${use.parent.getText().slice(0, 60)}), which has no mapping to ${API[provider]} events; move this call by hand.`,
      };
    edits.push({
      start: use.getStart(),
      end: read.end,
      replacement:
        provider === 'openai'
          ? `(${name}.type === 'response.output_text.delta' ? ${name}.delta : '')`
          : `(${name}.type === 'content_block_delta' && ${name}.delta.type === 'text_delta' ? ${name}.delta.text : '')`,
    });
  }
  return { edits };
}

// `HUMAN_PROMPT` and `AI_PROMPT` imports the moved prompts used and nothing uses after the patch:
// left in place they would fail `noUnusedLocals` or a lint rule, and v1 of the SDK drops them.
// Removed from the original file's import of the SDK; a name already unused stays.
export function unusedMarkerImports(original: ts.SourceFile, patched: string) {
  const after = ts.createSourceFile(original.fileName, patched, ts.ScriptTarget.Latest, true);
  const used = (source: ts.SourceFile, name: string) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found || ts.isImportDeclaration(node)) return;
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      )
        found = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const edits: LegacyRewrite['edits'] = [];
  for (const statement of original.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@anthropic-ai/sdk'
    )
      continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (!clause || !named || !ts.isNamedImports(named)) continue;
    const dropped = named.elements.filter(
      (element) =>
        ['HUMAN_PROMPT', 'AI_PROMPT'].includes((element.propertyName ?? element.name).text) &&
        used(original, element.name.text) &&
        !used(after, element.name.text),
    );
    if (!dropped.length) continue;
    const kept = named.elements.filter((element) => !dropped.includes(element));
    if (kept.length)
      edits.push({
        start: named.getStart(),
        end: named.end,
        replacement: `{ ${kept.map((element) => element.getText()).join(', ')} }`,
      });
    else if (clause.name) edits.push({ start: clause.name.end, end: named.end, replacement: '' });
    else {
      const text = original.text;
      const end = text[statement.end] === '\n' ? statement.end + 1 : statement.end;
      edits.push({ start: statement.getStart(), end, replacement: '' });
    }
  }
  return edits;
}

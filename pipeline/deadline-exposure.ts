import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { AGENT_CATALOG, builtInPackage } from './agent-catalog.ts';
import { daysUntil, type DeadlineEntry, type DeadlineRegistry } from './deadline-registry.ts';
import { cloudflareEndpointUses } from './cloudflare-calls.ts';
import { githubDeadlineUses } from './github-api-calls.ts';
import { detectModelHosts, hostDeadlineMatches } from './model-hosts.ts';
import { modelWrapperSites } from './model-wrappers.ts';
import { repositoryApiVersionPins } from './commerce-api-versions.ts';
import { manifestSdkDeclarations } from './package-manifests-deadlines.ts';
import { declaredPackageNames, readRepository } from './repository.ts';
import {
  featureMatches,
  installedVersion,
  literalTextAt,
  markerInProse,
  satisfiesRange,
  sdkTarget,
} from './sdk-deadlines.ts';
import { slackMethodUses } from './slack-calls.ts';
import { TEST_PATH } from './source-paths.ts';
import { placeFinding, readWorkspaceLayout, type FindingPlace } from './workspace-attribution.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

export const META_SDK = 'facebook-nodejs-business-sdk';
const MAX_EVIDENCE = 20;
const MAX_CONFIGURATION_BYTES = 128 * 1024;
const MAX_EVIDENCE_TEXT = 160;
const QUARTER_MONTHS: Record<string, string> = {
  January: '01',
  April: '04',
  July: '07',
  October: '10',
};
const SHOPIFY_CONTEXT = [
  ...AGENT_CATALOG.find((agent) => agent.id === 'shopify')!.packages,
  'myshopify.com',
];
const META_CONTEXT = [META_SDK, 'graph.facebook.com'];

// How a match is used. Only `live` evidence makes a repository exposed or opens an alert; the
// rest is listed separately so nothing is hidden:
// - catalog: one entry in a model list (an array, enum, tuple or constant-case object naming three
//   or more models), an HTML or JSX `<option>`, any type position, a table keyed or indexed by
//   model, such as pricing or context windows, a model record's `id` or `name` beside a metadata
//   field such as `contextWindow`, a model reference's `versions` list, one model's IDs on several
//   platforms (`{ firstParty: 'claude-…', bedrock: 'anthropic.claude-…', vertex: 'claude-…@…' }`),
//   or a membership collection (`new Set([...])`, the keys of `new Map([...])`) of any size;
// - test: test, spec, story, fixture and example files;
// - comment: comments, which the parser keeps out of every source token, and, for model providers
//   only, a model ID quoted inside a longer plain string, such as a description or an error message;
// - tokenizer: a local tokenizer argument, such as `encoding_for_model('gpt-4')`;
// - check: a comparison or prefix check, such as `model.startsWith('o1')` or `case 'gpt-4':`.
// Comments and the tokenizer and prefix calls apply to every provider; the rest apply to model
// providers (OpenAI and Anthropic) only.
export type DeadlineUse = 'live' | 'catalog' | 'test' | 'comment' | 'tokenizer' | 'check';

export interface DeadlineEvidence {
  file: string;
  line: number;
  kind: 'source' | 'dependency' | 'refit-configuration';
  use: DeadlineUse;
  version: string;
  text: string;
  // The monorepo package the match is in, and why its path is not product code, if it is not.
  workspace?: FindingPlace['workspace'];
  excluded?: FindingPlace['excluded'];
  // For a model sent through an AI wrapper SDK, the call that sends it (pipeline/model-wrappers.ts).
  via?: string;
}

export interface DeadlineExposure {
  deadline: DeadlineEntry;
  days: number;
  // Live evidence only.
  evidence: DeadlineEvidence[];
  // Live matches beyond the evidence limit, counted but not listed.
  more: number;
  // Matches that are not live, with their own limit and count.
  nonLive: DeadlineEvidence[];
  nonLiveMore: number;
  // The exact number of non-live matches by use, counted before the limit above. Always set by the
  // scan, and optional only so a hand-built exposure need not repeat it.
  nonLiveCounts?: Partial<Record<DeadlineUse, number>>;
}

// An exposure as alerts and reports read it: stored inventories drop each match's source line.
export type ReportedEvidence = Omit<DeadlineEvidence, 'text'> & { text?: string };
export type ReportedExposure = Omit<DeadlineExposure, 'evidence' | 'nonLive'> & {
  evidence: ReportedEvidence[];
  nonLive: ReportedEvidence[];
};

// Deadlines found in a repository: exposures have live evidence; mentions are deadlines the
// repository names only outside live code, with `evidence` empty.
export interface DeadlineScan {
  exposures: DeadlineExposure[];
  mentions: DeadlineExposure[];
}

function excerpt(line: string) {
  const text = line.trim();
  return text.length > MAX_EVIDENCE_TEXT ? `${text.slice(0, MAX_EVIDENCE_TEXT - 1)}…` : text;
}

// Pinned versions a source line names, per provider, with no code executed. `column` is where the
// version starts in the line, so the caller can tell code from comments.
function sourceMatches(
  line: string,
  shopifyFile: boolean,
  metaFile: boolean,
  models: Map<string, DeadlineEntry['provider']>,
) {
  const found: { provider: DeadlineEntry['provider']; version: string; column: number }[] = [];
  const add = (
    provider: DeadlineEntry['provider'],
    version: string,
    match: RegExpExecArray,
    group: number,
  ) => found.push({ provider, version, column: match.indices![group]![0] });
  for (const match of line.matchAll(/graph\.facebook\.com\/(v\d+\.\d+)\b/dg))
    add('meta-graph', match[1], match, 1);
  if (metaFile)
    for (const match of line.matchAll(/(['"`])(v\d+\.\d+)\1/dg))
      add('meta-graph', match[2], match, 2);
  // The version may end the URL, as in an axios `baseURL`.
  for (const match of line.matchAll(/\/admin\/api\/(\d{4}-\d{2})(?![\w.-])/dg))
    add('shopify', match[1], match, 1);
  for (const match of line.matchAll(/\bApiVersion\.(January|April|July|October)(\d{2})\b/dg))
    found.push({
      provider: 'shopify',
      version: `20${match[2]}-${QUARTER_MONTHS[match[1]]}`,
      column: match.indices![1]![0],
    });
  if (shopifyFile)
    for (const match of line.matchAll(/\bapiVersion\s*[:=]\s*(['"`])(\d{4}-(?:01|04|07|10))\1/dg))
      add('shopify', match[2], match, 2);
  for (const match of line.matchAll(/(['"`])([a-z0-9][a-z0-9.-]*)\1/dg))
    if (models.has(match[2])) add(models.get(match[2])!, match[2], match, 2);
  // Both Gemini SDKs send `models/gemini-2.0-flash` and `gemini-2.0-flash` to the Gemini API as the
  // same model: @google/generative-ai prefixes a name without a slash, and @google/genai's
  // `tModel` does the same, so the prefixed form names the registry model too.
  for (const match of line.matchAll(/(['"`])models\/([a-z0-9][a-z0-9.-]*)\1/dg))
    if (models.get(match[2]) === 'gemini') add('gemini', match[2], match, 2);
  return found;
}

// Calls whose string argument names a model without selecting one: local tokenizers, and prefix or
// membership checks such as `model.startsWith('o1')`.
const TOKENIZER_CALLS = new Set(['encoding_for_model', 'encodingForModel']);
const CHECK_CALLS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf']);
const CHECK_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
export { TEST_PATH };
// Providers whose deadlines retire models rather than API versions. Their matches get every use
// class below; API-version providers get only comments, tokenizers and prefix checks.
const MODEL_PROVIDERS = new Set<DeadlineEntry['provider']>(['openai', 'anthropic', 'gemini']);
// Strings shaped like OpenAI or Anthropic model IDs, counted with registry models to recognize a
// model list, which often mixes providers. Router IDs such as `openai/o1` and
// `anthropic/claude-3-opus` count too. Gemini-shaped IDs count only when the match being
// classified is a Gemini model, so OpenAI and Anthropic classification is unchanged.
const ANTHROPIC_MODEL = /^(?:anthropic\/)?claude-/;
const GEMINI_MODEL = /^(?:google\/|models\/)?gemini-/;
const OPENAI_MODEL =
  /^(?:openai\/)?(?:gpt-|chatgpt-|o\d(?:-|$)|text-(?:davinci|curie|babbage|ada|embedding|moderation)-|(?:davinci|curie|babbage|ada)(?:-|$)|dall-e-|tts-|whisper-|codex-|computer-use-|omni-moderation-|sora-)/;
const CATALOG_SIZE = 3;
// Cloud-platform forms of a Claude model ID: Bedrock (`anthropic.claude-…`, optionally with a region
// prefix such as `us.`) and Vertex AI (`claude-…@20250514`).
const PLATFORM_MODEL = /^(?:[a-z]{2,4}\.)?anthropic\.claude-|^claude-[\w.-]+@\d{8}$/;
const MEMBERSHIP_COLLECTIONS = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);
const OPTION_ELEMENT = /<option\b/i;
// Fields of a model metadata record, such as `{ id: 'gpt-4', contextWindow: 8192 }`. None of them
// is a request parameter, so an object that has one describes a model rather than calling it.
const MODEL_METADATA = new Set([
  'contextWindow',
  'context_window',
  'contextLength',
  'context_length',
  'maxOutputTokens',
  'max_output_tokens',
  'maxInputTokens',
  'max_input_tokens',
  'inputTokenLimit',
  'outputTokenLimit',
  'knowledgeCutoff',
  'knowledge_cutoff',
  'pricing',
  'cost',
  'owned_by',
]);
// The names of a model record's identifying field.
const RECORD_NAME = new Set(['id', 'name']);
const CONSTANT_KEY = /^[A-Z][A-Z0-9_]*$/;

function isCollection(node: ts.Node) {
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isUnionTypeNode(node) ||
    ts.isTupleTypeNode(node) ||
    ts.isEnumDeclaration(node)
  );
}

// Nodes a literal climbs through while it is still part of the same list or table.
function isLiteralStructure(node: ts.Node) {
  return (
    isCollection(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isEnumMember(node) ||
    ts.isLiteralTypeNode(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function keyText(name: ts.PropertyName | undefined) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function stripped(node: ts.Node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}

// A model record, such as `{ id: 'gpt-4', contextWindow: 8192 }`: the literal is its `id` or
// `name`, beside a metadata field.
function modelRecord(node: ts.Node) {
  const property = node.parent;
  return (
    ts.isPropertyAssignment(property) &&
    property.initializer === node &&
    RECORD_NAME.has(keyText(property.name) ?? '') &&
    ts.isObjectLiteralExpression(property.parent) &&
    property.parent.properties.some((item) => MODEL_METADATA.has(keyText(item.name) ?? ''))
  );
}

// One model's IDs across platforms: an object with two or more model-shaped string values, at least
// one of them a Bedrock or Vertex AI form. It lists where a model is available; the code picks one
// entry elsewhere.
function platformVariants(node: ts.Node, isModel: (value: string) => boolean) {
  const property = node.parent;
  if (!ts.isPropertyAssignment(property) || property.initializer !== node) return false;
  const values = property.parent.properties.flatMap((item) => {
    if (!ts.isPropertyAssignment(item)) return [];
    const value = stripped(item.initializer);
    return ts.isStringLiteralLike(value) ? [value.text] : [];
  });
  return (
    values.some((value) => PLATFORM_MODEL.test(value)) &&
    values.filter((value) => isModel(value) || PLATFORM_MODEL.test(value)).length >= 2
  );
}

// A list handed to `new Set(...)` or `new Map(...)`: membership or lookup, as in
// `new Set(['claude-3-opus', 'claude-3-haiku']).has(model)`. In a Map it is an entry's key.
function membershipEntry(node: ts.Node) {
  let list = node.parent;
  if (
    ts.isArrayLiteralExpression(list) &&
    list.elements[0] === node &&
    ts.isArrayLiteralExpression(list.parent)
  )
    list = list.parent;
  const owner = list.parent;
  return (
    ts.isArrayLiteralExpression(list) &&
    ts.isNewExpression(owner) &&
    owner.arguments?.[0] === list &&
    ts.isIdentifier(owner.expression) &&
    MEMBERSHIP_COLLECTIONS.has(owner.expression.text)
  );
}

// An object used like an enum: constant-case keys, such as `{ GPT_4: 'gpt-4', O3: 'o3' }`.
function constantObject(node: ts.Node): node is ts.ObjectLiteralExpression {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.length > 0 &&
    node.properties.every(
      (item) => ts.isPropertyAssignment(item) && CONSTANT_KEY.test(keyText(item.name) ?? ''),
    )
  );
}

// `as`, `satisfies`, parentheses, a `<T>` assertion and `!` change an expression's type, not its
// value.
function isTypeWrapper(
  node: ts.Node,
): node is
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.ParenthesizedExpression
  | ts.TypeAssertion
  | ts.NonNullExpression {
  return (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

// The outermost wrapper around an expression, or the expression itself.
function unwrapUp(node: ts.Node) {
  while (node.parent && isTypeWrapper(node.parent)) node = node.parent;
  return node;
}

// A string joined to other text with `+` or `+=` may build the value the code sends.
function concatenated(node: ts.Node) {
  const parent = unwrapUp(node).parent;
  return (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
  );
}

// Text that sets a model right before a match: a key (`{"model": "gpt-4"}`, `model_id`, `modelName`,
// `OPENAI_MODEL=`) followed by `:` or `=`, a CLI flag (`--model gpt-4`, `-m gpt-4`), or an
// upper-case `...MODEL` name. `before` stops one character short of the ID, so a flag's trailing
// space or an opening quote is already cut.
const MODEL_KEYS = [
  /(?:^|[^a-z0-9_-])[a-z0-9_-]*model(?:[_-]?(?:id|name))?["'\s]*[:=]\s*$/i,
  /(?:^|\s)(?:--[a-z-]*model(?:[_-]?(?:id|name))?|-m)["'=\s]*$/i,
  /(?:^|[^A-Z0-9_])[A-Z0-9_]*MODEL["'\s]*$/,
];

// A string that starts with `{` or `[`, or holds a quoted key such as `"engine":`.
const DATA_TEXT = /^\s*[{[]|["'][\w.-]+["']\s*:/;

// Whether a model ID quoted inside a plain string is prose (a description, an error message,
// embedded markdown) and not what the code sends. The ID alone as the string is a request, so is
// config text that sets a model key or flag right before it, and so is a string joined to other text.
// `before` is the string's own source text up to the ID's opening quote.
function isProse(node: ts.StringLiteralLike, version: string, before: string) {
  return (
    node.text !== version &&
    // Prose has words around the ID; a path-like value such as `models/gemini-1.5-pro` does not.
    /\s/.test(node.text) &&
    !MODEL_KEYS.some((key) => key.test(before)) &&
    // A string that looks like JSON or holds a quoted key is data, whatever precedes the ID.
    !DATA_TEXT.test(node.text) &&
    !concatenated(node)
  );
}

function propertyKey(node: ts.Node) {
  return (
    node.parent &&
    (ts.isPropertyAssignment(node.parent) ||
      ts.isPropertySignature(node.parent) ||
      ts.isPropertyDeclaration(node.parent) ||
      ts.isMethodDeclaration(node.parent)) &&
    node.parent.name === node
  );
}

function calleeName(call: ts.CallExpression) {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : '';
}

// How a string literal naming a model or version is used, from its place in the syntax tree.
function literalUse(
  node: ts.StringLiteralLike,
  file: string,
  model: boolean,
  isModel: (value: string) => boolean,
): DeadlineUse {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const callee = calleeName(parent);
    if (TOKENIZER_CALLS.has(callee)) return 'tokenizer';
    if (CHECK_CALLS.has(callee)) return 'check';
  }
  if (!model) return 'live';
  if (ts.isBinaryExpression(parent) && CHECK_OPERATORS.has(parent.operatorToken.kind))
    return 'check';
  if (ts.isCaseClause(parent) && parent.expression === node) return 'check';
  if (TEST_PATH.test(file)) return 'test';
  // A model used as a property key or index names a table entry (a price, a context window); it
  // is not what the code sends. So is everything inside that entry, such as its `id`. A key whose
  // value is a plain string is an alias map, and the value is what the code sends.
  if (propertyKey(node)) return 'catalog';
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return 'catalog';
  if (modelRecord(node)) return 'catalog';
  if (platformVariants(node, isModel) || membershipEntry(node)) return 'catalog';
  // The versions a model reference accepts, as in genkit's `versions: ['gpt-4o-2024-05-13']`.
  if (
    ts.isArrayLiteralExpression(parent) &&
    ts.isPropertyAssignment(unwrapUp(parent).parent) &&
    keyText((unwrapUp(parent).parent as ts.PropertyAssignment).name) === 'versions'
  )
    return 'catalog';
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const up = current.parent;
    if (ts.isTypeNode(up) && !ts.isLiteralTypeNode(up)) return 'catalog';
    if (ts.isTypeAliasDeclaration(up) || ts.isInterfaceDeclaration(up)) return 'catalog';
    if (!isLiteralStructure(up)) break;
    if (
      ts.isPropertyAssignment(up) &&
      up.initializer === current &&
      ts.isObjectLiteralExpression(stripped(current)) &&
      ts.isStringLiteralLike(up.name) &&
      isModel(up.name.text)
    )
      return 'catalog';
    if ((isCollection(up) || constantObject(up)) && countModels(up, isModel) >= CATALOG_SIZE)
      return 'catalog';
  }
  // A literal type, as in `model: 'gpt-4'` in an interface, never reaches a request.
  if (ts.isLiteralTypeNode(parent)) return 'catalog';
  return 'live';
}

function countModels(node: ts.Node, isModel: (value: string) => boolean) {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteralLike(child) && isModel(child.text)) found.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found.size;
}

// Every token in a source file where a pin can sit, with how it is used: identifiers, string and
// template pieces and other leaf nodes. Comments are trivia between tokens, so a version found
// there has no token and is reported as a comment.
function tokenUses(path: string, content: string, models: Map<string, unknown>) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const ranges: [number, number, ts.Node][] = [];
  const visit = (node: ts.Node) => {
    let leaf = true;
    ts.forEachChild(node, (child) => {
      leaf = false;
      visit(child);
    });
    if (leaf) ranges.push([node.getStart(source), node.end, node]);
  };
  visit(source);
  const isModel = (value: string) =>
    models.has(value) || OPENAI_MODEL.test(value) || ANTHROPIC_MODEL.test(value);
  const isGeminiListModel = (value: string) => isModel(value) || GEMINI_MODEL.test(value);
  return (
    offset: number,
    provider: DeadlineEntry['provider'],
    line: string,
    version: string,
  ): DeadlineUse => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end, node] = ranges[middle];
      if (offset < start) high = middle - 1;
      else if (offset >= end) low = middle + 1;
      else {
        const model = MODEL_PROVIDERS.has(provider);
        const use = ts.isStringLiteralLike(node)
          ? literalUse(node, path, model, provider === 'gemini' ? isGeminiListModel : isModel)
          : 'live';
        if (use !== 'live' || !model) return use;
        // An HTML or JSX `<option>` is one choice in a picker.
        if (OPTION_ELEMENT.test(line)) return 'catalog';
        // Prose comes last: it only reclassifies a match that is live so far. Template pieces and
        // JSX text never get here as strings, so they stay live.
        const before = content.slice(Math.max(start, offset - 41), offset - 1);
        return ts.isStringLiteralLike(node) && isProse(node, version, before) ? 'comment' : use;
      }
    }
    return 'comment';
  };
}

// The Graph API version an SDK release targets: facebook-nodejs-business-sdk majors track Graph
// API versions (20.x calls v20.0). A locked version wins over the declared range.
export function metaSdkVersion(declared: string, locked: string | null) {
  const major = /^\D*(\d+)\./.exec(locked ?? declared)?.[1];
  return major ? `v${major}.0` : undefined;
}

async function lineOf(root: string, file: string, needle: string) {
  const lines = (await readFile(join(root, file), 'utf8')).split('\n');
  return Math.max(1, lines.findIndex((line) => line.includes(needle)) + 1);
}

// Matches the versions and models a repository names against the registry and classifies each
// match. Each deadline lists file:line evidence; nothing is installed, executed or sent to a
// provider.
export async function scanDeadlines(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
): Promise<DeadlineScan> {
  const root = resolve(directory);
  const byVersion = new Map<string, DeadlineEntry>();
  for (const entry of registry.deadlines)
    if (!entry.ecosystem)
      for (const version of entry.versions) byVersion.set(`${entry.provider}:${version}`, entry);
  const models = new Map(
    registry.deadlines
      .filter((entry) => entry.kind === 'model' && MODEL_PROVIDERS.has(entry.provider))
      .flatMap((entry) => entry.versions.map((version) => [version, entry.provider] as const)),
  );
  const found = new Map<string, DeadlineExposure>();
  const seen = new Set<string>();
  const layout = await readWorkspaceLayout(root);
  const record = (
    provider: string,
    version: string,
    evidence: Omit<DeadlineEvidence, 'version'>,
    entry?: DeadlineEntry,
  ) => {
    const deadline = entry ?? byVersion.get(`${provider}:${version}`);
    if (!deadline) return;
    // The place is reported only: a live match on an excluded path stays live (owner decision).
    evidence = { ...evidence, ...placeFinding(layout, evidence.file) };
    const exposure = found.get(deadline.id) ?? {
      deadline,
      days: daysUntil(deadline.date, now),
      evidence: [],
      more: 0,
      nonLive: [],
      nonLiveMore: 0,
    };
    found.set(deadline.id, exposure);
    const key = `${evidence.use === 'live'}\t${evidence.file}\t${evidence.line}\t${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (evidence.use !== 'live') exposure.nonLive.push({ ...evidence, version });
    else if (exposure.evidence.length < MAX_EVIDENCE)
      exposure.evidence.push({ ...evidence, version });
    else exposure.more += 1;
  };

  const features = registry.deadlines
    .filter((entry) => entry.kind === 'feature')
    .flatMap((entry) => entry.versions.map((marker) => ({ provider: entry.provider, marker })));
  const repository = await readRepository(root, META_SDK);
  // Models sent through AI wrapper SDKs: each match names the call that sends it, and gateway or
  // registry IDs such as `'openai/gpt-4o'`, which the exact match below cannot see, are added.
  const wrapped = modelWrapperSites(repository);
  const via = new Map(
    wrapped.map((site) => [`${site.file}:${site.line}:${site.version}`, site.via]),
  );
  for (const file of repository.files) {
    const shopifyFile = SHOPIFY_CONTEXT.some((name) => file.content.includes(name));
    const metaFile = META_CONTEXT.some((name) => file.content.includes(name));
    let useAt: ReturnType<typeof tokenUses> | undefined;
    let literalAt: ReturnType<typeof literalTextAt> | undefined;
    let offset = 0;
    for (const [index, line] of file.content.split('\n').entries()) {
      for (const match of sourceMatches(line, shopifyFile, metaFile, models)) {
        useAt ??= tokenUses(file.path, file.content, models);
        record(match.provider, match.version, {
          file: file.path,
          line: index + 1,
          kind: 'source',
          use: useAt(offset + match.column, match.provider, line, match.version),
          text: excerpt(line),
          ...(via.has(`${file.path}:${index + 1}:${match.version}`)
            ? { via: via.get(`${file.path}:${index + 1}:${match.version}`) }
            : {}),
        });
      }
      // A product that shuts down: each marker in code, with test and example files kept apart and
      // a variable name inside prose listed as a comment.
      for (const match of featureMatches(line, features)) {
        useAt ??= tokenUses(file.path, file.content, models);
        literalAt ??= literalTextAt(file.path, file.content);
        const use = markerInProse(match.marker, literalAt(offset + match.column))
          ? 'comment'
          : useAt(offset + match.column, match.provider, line, match.marker);
        record(match.provider, match.marker, {
          file: file.path,
          line: index + 1,
          kind: 'source',
          use: use === 'live' && TEST_PATH.test(file.path) ? 'test' : use,
          text: excerpt(line),
        });
      }
      offset += line.length + 1;
    }
  }
  // Models called through Amazon Bedrock, Azure OpenAI or OpenRouter (pipeline/model-hosts.ts).
  for (const match of hostDeadlineMatches(detectModelHosts(repository), (provider, version) =>
    byVersion.has(`${provider}:${version}`),
  ))
    record(match.provider, match.version, {
      file: match.site.file,
      line: match.site.line,
      kind: 'source',
      use: TEST_PATH.test(match.site.file) ? 'test' : 'live',
      text: excerpt(match.text),
    });
  for (const site of wrapped)
    if (site.model !== site.version)
      record(site.provider, site.version, {
        file: site.file,
        line: site.line,
        kind: 'source',
        use: TEST_PATH.test(site.file) ? 'test' : 'live',
        text: site.model,
        via: site.via,
      });
  // API versions pinned by header, SDK option or URL path, for providers that version that way.
  if (registry.deadlines.some((entry) => entry.kind === 'api-version'))
    for (const pin of repositoryApiVersionPins(repository))
      record(pin.provider, pin.version, {
        file: pin.file,
        line: pin.line,
        kind: 'source',
        use: pin.use,
        text: pin.text,
      });
  for (const dependency of repository.dependencies) {
    const version = metaSdkVersion(dependency.version, dependency.lock.version);
    if (version)
      record('meta-graph', version, {
        file: dependency.file,
        line: await lineOf(root, dependency.file, `"${META_SDK}"`),
        kind: 'dependency',
        use: 'live',
        text: `${META_SDK} ${dependency.lock.version ?? dependency.version}${dependency.lock.version ? ` (locked in ${dependency.lock.file})` : ''} targets Graph API ${version}`,
      });
  }
  // A package whose support ended: each manifest that declares it. A repository whose source never
  // names the package is not read a second time. Manifests in test and example paths are not live.
  // An entry narrowed to a range matches only a release Refit can place in it: the locked version,
  // or the lowest release a bounded declared range allows.
  // Each package is read once, and only when a manifest declares it.
  const declared = await declaredPackageNames(root);
  const declarations = new Map<string, Promise<Awaited<ReturnType<typeof readRepository>>>>();
  for (const entry of registry.deadlines)
    if (entry.kind === 'sdk' && !entry.ecosystem)
      for (const version of entry.versions) {
        const { name, range } = sdkTarget(version);
        if (declared && !declared.has(name)) continue;
        if (!repository.files.some((file) => file.content.includes(name))) continue;
        if (!declarations.has(name)) declarations.set(name, readRepository(root, name));
        for (const dependency of (await declarations.get(name)!).dependencies) {
          const installed = installedVersion(dependency.version, dependency.lock.version);
          if (range && !(installed && satisfiesRange(installed, range))) continue;
          record(entry.provider, version, {
            file: dependency.file,
            line: await lineOf(root, dependency.file, `"${name}"`),
            kind: 'dependency',
            use: TEST_PATH.test(dependency.file) ? 'test' : 'live',
            text: `${name} ${dependency.lock.version ?? dependency.version}${dependency.lock.version ? ` (locked in ${dependency.lock.file})` : ''} is declared in ${dependency.section}${range ? `, inside ${range}` : ''}`,
          });
        }
      }
  // The same for other ecosystems' manifests (pipeline/package-manifests-deadlines.ts).
  for (const declaration of await manifestSdkDeclarations(root, registry))
    record(
      declaration.deadline.provider,
      declaration.name,
      {
        file: declaration.file,
        line: declaration.line,
        kind: 'dependency',
        use: TEST_PATH.test(declaration.file) ? 'test' : 'live',
        text: declaration.text,
      },
      declaration.deadline,
    );
  // Retired API methods: each call site that sends one, from the provider's call scanner.
  if (registry.deadlines.some((entry) => entry.kind === 'method' && entry.provider === 'slack'))
    for (const use of await slackMethodUses(root, repository))
      record('slack', use.method, { ...use, kind: 'source' });
  // Retired endpoints: each request that reaches one, from the provider's call scanner.
  const endpoints = registry.deadlines.filter(
    (entry) => entry.kind === 'endpoint' && entry.provider === 'cloudflare',
  );
  if (endpoints.length)
    for (const use of await cloudflareEndpointUses(
      root,
      endpoints.flatMap((entry) => entry.versions),
      repository,
    ))
      record('cloudflare', use.version, { ...use, kind: 'source' });
  // GitHub: pinned X-GitHub-Api-Version headers, requests to removed endpoints and GraphQL fields,
  // from the GitHub API call scanner.
  const github = registry.deadlines.filter((entry) => entry.provider === 'github');
  if (github.length)
    for (const use of await githubDeadlineUses(
      root,
      github.flatMap((entry) => entry.versions),
      repository,
    ))
      record('github', use.version, { ...use, kind: 'source' });
  for (const pin of await configuredApiVersions(root))
    record(pin.provider, pin.version, {
      file: REPOSITORY_CONFIGURATION,
      line: pin.line,
      kind: 'refit-configuration',
      use: 'live',
      text: `apiVersion "${pin.version}" in the ${pin.integration ?? 'repository'} integration`,
    });
  const all = [...found.values()].sort(
    (a, b) =>
      a.deadline.date.localeCompare(b.deadline.date) || a.deadline.id.localeCompare(b.deadline.id),
  );
  for (const exposure of all) {
    // A line that also has a live match of the same version is listed once, as live. Non-live
    // matches are capped after that, like live ones.
    const live = new Set(
      exposure.evidence.map((item) => `${item.file}:${item.line}:${item.version}`),
    );
    const rest = exposure.nonLive.filter(
      (item) => !live.has(`${item.file}:${item.line}:${item.version}`),
    );
    const counts: Partial<Record<DeadlineUse, number>> = {};
    for (const item of rest) counts[item.use] = (counts[item.use] ?? 0) + 1;
    exposure.nonLiveCounts = counts;
    exposure.nonLive = rest.slice(0, MAX_EVIDENCE);
    exposure.nonLiveMore = rest.length - exposure.nonLive.length;
  }
  return {
    exposures: all.filter((exposure) => exposure.evidence.length),
    mentions: all.filter((exposure) => !exposure.evidence.length),
  };
}

// Deadlines a repository is exposed to: only live evidence counts.
export async function findDeadlineExposures(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
): Promise<DeadlineExposure[]> {
  return (await scanDeadlines(directory, registry, now)).exposures;
}

interface ConfiguredIntegration {
  agent: string;
  integration: string | null;
  apiVersion: string | null;
}

// Reads a regular file of the repository, refusing a link anywhere on its path, a path outside the
// repository and a file over the size cap, so a checkout cannot make Refit read the worker's files.
async function readRepositoryFile(directory: string, name: string) {
  const root = await realpath(directory);
  const path = resolve(root, name);
  const inside = relative(root, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || (await realpath(path)) !== path)
    throw new PipelineInputError(`${name} must be a file inside the repository, not a link.`);
  const stats = await stat(path);
  if (!stats.isFile() || stats.size > MAX_CONFIGURATION_BYTES)
    throw new PipelineInputError(
      `${name} must be a regular file of at most ${MAX_CONFIGURATION_BYTES / 1024} KiB.`,
    );
  return readFile(path, 'utf8');
}

// Integrations in a committed .refit.json and the catalog agent each adapter covers. A v1 file
// without providerConfig uses the built-in Stripe adapter. Unreadable adapters are skipped rather
// than failing the deadline check.
export async function configuredIntegrations(directory: string): Promise<ConfiguredIntegration[]> {
  if (!existsSync(join(directory, REPOSITORY_CONFIGURATION))) return [];
  const configuration = parseObject(
    await readRepositoryFile(directory, REPOSITORY_CONFIGURATION),
    REPOSITORY_CONFIGURATION,
  );
  const integrations = (
    configuration.formatVersion === 2 && Array.isArray(configuration.integrations)
      ? configuration.integrations
      : [configuration]
  ).filter(isObject);
  const result: ConfiguredIntegration[] = [];
  for (const integration of integrations) {
    let packageName = builtInPackage(integration);
    if (typeof integration.providerConfig === 'string')
      try {
        const adapter = parseObject(
          await readRepositoryFile(directory, integration.providerConfig),
          'Provider adapter',
        );
        if (typeof adapter.packageName !== 'string') continue;
        packageName = adapter.packageName;
      } catch {
        continue;
      }
    const agent = AGENT_CATALOG.find((entry) => entry.packages.includes(packageName));
    if (agent)
      result.push({
        agent: agent.id,
        integration: typeof integration.id === 'string' ? integration.id : null,
        apiVersion: typeof integration.apiVersion === 'string' ? integration.apiVersion : null,
      });
  }
  return result;
}

async function configuredApiVersions(root: string) {
  const integrations = await configuredIntegrations(root);
  const pins: { provider: string; version: string; integration: string | null; line: number }[] =
    [];
  for (const integration of integrations)
    if (integration.apiVersion)
      pins.push({
        provider: integration.agent,
        version: integration.apiVersion,
        integration: integration.integration,
        line: await lineOf(root, REPOSITORY_CONFIGURATION, `"${integration.apiVersion}"`),
      });
  return pins;
}

export type AgentStatus =
  { state: 'configured'; integration: string | null } | { state: 'available' } | { state: 'none' };

// Whether a migration can follow from this deadline: an integration already covers the provider,
// Refit ships an agent that could be added, or no reviewed agent exists yet.
export function agentStatus(provider: string, integrations: ConfiguredIntegration[]): AgentStatus {
  const configured = integrations.find((entry) => entry.agent === provider);
  if (configured) return { state: 'configured', integration: configured.integration };
  return AGENT_CATALOG.find((agent) => agent.id === provider)?.adapter
    ? { state: 'available' }
    : { state: 'none' };
}

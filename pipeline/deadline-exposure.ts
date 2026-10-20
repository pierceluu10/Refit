import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { AGENT_CATALOG, builtInPackage } from './agent-catalog.ts';
import { daysUntil, type DeadlineEntry, type DeadlineRegistry } from './deadline-registry.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

export const META_SDK = 'facebook-nodejs-business-sdk';
const MAX_EVIDENCE = 20;
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
// - catalog: one entry in a model list (an array, enum or tuple naming three or more models), an
//   HTML or JSX `<option>`, any type position, or a table keyed or indexed by model, such as
//   pricing or context windows;
// - test: test, spec, story, fixture and example files;
// - comment: comments, which the parser keeps out of every source token;
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
}

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
// Test, spec, story, fixture and example files, by directory or name.
export const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
// Providers whose deadlines retire models rather than API versions. Their matches get every use
// class below; API-version providers get only comments, tokenizers and prefix checks.
const MODEL_PROVIDERS = new Set<DeadlineEntry['provider']>(['openai', 'anthropic']);
// Strings shaped like OpenAI or Anthropic model IDs, counted with registry models to recognize a
// model list, which often mixes providers. Router IDs such as `openai/o1` and
// `anthropic/claude-3-opus` count too.
const ANTHROPIC_MODEL = /^(?:anthropic\/)?claude-/;
const OPENAI_MODEL =
  /^(?:openai\/)?(?:gpt-|chatgpt-|o\d(?:-|$)|text-(?:davinci|curie|babbage|ada|embedding|moderation)-|(?:davinci|curie|babbage|ada)(?:-|$)|dall-e-|tts-|whisper-|codex-|computer-use-|omni-moderation-|sora-)/;
const CATALOG_SIZE = 3;
const OPTION_ELEMENT = /<option\b/i;

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
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const up = current.parent;
    if (ts.isTypeNode(up) && !ts.isLiteralTypeNode(up)) return 'catalog';
    if (ts.isTypeAliasDeclaration(up) || ts.isInterfaceDeclaration(up)) return 'catalog';
    if (!isLiteralStructure(up)) break;
    if (
      ts.isPropertyAssignment(up) &&
      up.initializer === current &&
      ts.isObjectLiteralExpression(current) &&
      ts.isStringLiteralLike(up.name) &&
      isModel(up.name.text)
    )
      return 'catalog';
    if (isCollection(up) && countModels(up, isModel) >= CATALOG_SIZE) return 'catalog';
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
  return (offset: number, provider: DeadlineEntry['provider'], line: string): DeadlineUse => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end, node] = ranges[middle];
      if (offset < start) high = middle - 1;
      else if (offset >= end) low = middle + 1;
      else {
        const model = MODEL_PROVIDERS.has(provider);
        const use = ts.isStringLiteralLike(node) ? literalUse(node, path, model, isModel) : 'live';
        // An HTML or JSX `<option>` is one choice in a picker.
        return use === 'live' && model && OPTION_ELEMENT.test(line) ? 'catalog' : use;
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
    for (const version of entry.versions) byVersion.set(`${entry.provider}:${version}`, entry);
  const models = new Map(
    registry.deadlines
      .filter((entry) => MODEL_PROVIDERS.has(entry.provider))
      .flatMap((entry) => entry.versions.map((version) => [version, entry.provider] as const)),
  );
  const found = new Map<string, DeadlineExposure>();
  const seen = new Set<string>();
  const record = (
    provider: string,
    version: string,
    evidence: Omit<DeadlineEvidence, 'version'>,
  ) => {
    const deadline = byVersion.get(`${provider}:${version}`);
    if (!deadline) return;
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

  const repository = await readRepository(root, META_SDK);
  for (const file of repository.files) {
    const shopifyFile = SHOPIFY_CONTEXT.some((name) => file.content.includes(name));
    const metaFile = META_CONTEXT.some((name) => file.content.includes(name));
    let useAt: ReturnType<typeof tokenUses> | undefined;
    let offset = 0;
    for (const [index, line] of file.content.split('\n').entries()) {
      for (const match of sourceMatches(line, shopifyFile, metaFile, models)) {
        useAt ??= tokenUses(file.path, file.content, models);
        record(match.provider, match.version, {
          file: file.path,
          line: index + 1,
          kind: 'source',
          use: useAt(offset + match.column, match.provider, line),
          text: excerpt(line),
        });
      }
      offset += line.length + 1;
    }
  }
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

// Integrations in a committed .refit.json and the catalog agent each adapter covers. A v1 file
// without providerConfig uses the built-in Stripe adapter. Unreadable adapters are skipped rather
// than failing the deadline check.
export async function configuredIntegrations(directory: string): Promise<ConfiguredIntegration[]> {
  const path = join(directory, REPOSITORY_CONFIGURATION);
  if (!existsSync(path)) return [];
  const configuration = parseObject(await readFile(path, 'utf8'), REPOSITORY_CONFIGURATION);
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
          await readFile(resolve(directory, integration.providerConfig), 'utf8'),
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

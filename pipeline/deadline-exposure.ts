import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { AGENT_CATALOG, builtInPackage } from './agent-catalog.ts';
import { daysUntil, type DeadlineEntry, type DeadlineRegistry } from './deadline-registry.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';

const META_SDK = 'facebook-nodejs-business-sdk';
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

export interface DeadlineEvidence {
  file: string;
  line: number;
  kind: 'source' | 'dependency' | 'refit-configuration';
  version: string;
  text: string;
}

export interface DeadlineExposure {
  deadline: DeadlineEntry;
  days: number;
  evidence: DeadlineEvidence[];
  // Matches beyond the evidence limit, counted but not listed.
  more: number;
}

function excerpt(line: string) {
  const text = line.trim();
  return text.length > MAX_EVIDENCE_TEXT ? `${text.slice(0, MAX_EVIDENCE_TEXT - 1)}…` : text;
}

// Pinned versions a source line names, per provider, with no code executed. `column` is where the
// version starts in the line, so the caller can tell code from comments.
function sourceMatches(line: string, shopifyFile: boolean, metaFile: boolean, models: Set<string>) {
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
    if (models.has(match[2])) add('openai', match[2], match, 2);
  return found;
}

// Calls whose string argument names a model without selecting one: local tokenizers and prefix or
// membership checks such as `model.startsWith('o1')`.
const NON_PIN_CALLS = new Set([
  'encoding_for_model',
  'encodingForModel',
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
]);

// Offsets of the tokens in a source file where a pin can sit: identifiers, string and template
// pieces and other leaf nodes. Comments are trivia between tokens, so a version found there has no
// token. String arguments of NON_PIN_CALLS are left out.
function pinTokens(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node) => {
    let leaf = true;
    ts.forEachChild(node, (child) => {
      leaf = false;
      visit(child);
    });
    if (!leaf) return;
    const call = node.parent;
    if (
      ts.isStringLiteralLike(node) &&
      call &&
      ts.isCallExpression(call) &&
      call.arguments.includes(node as ts.Expression)
    ) {
      const callee = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : ts.isIdentifier(call.expression)
          ? call.expression.text
          : '';
      if (NON_PIN_CALLS.has(callee)) return;
    }
    ranges.push([node.getStart(source), node.end]);
  };
  visit(source);
  return (offset: number) => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end] = ranges[middle];
      if (offset < start) high = middle - 1;
      else if (offset >= end) low = middle + 1;
      else return true;
    }
    return false;
  };
}

// The Graph API version an SDK release targets: facebook-nodejs-business-sdk majors track Graph
// API versions (20.x calls v20.0). A locked version wins over the declared range.
function metaSdkVersion(declared: string, locked: string | null) {
  const major = /^\D*(\d+)\./.exec(locked ?? declared)?.[1];
  return major ? `v${major}.0` : undefined;
}

async function lineOf(root: string, file: string, needle: string) {
  const lines = (await readFile(join(root, file), 'utf8')).split('\n');
  return Math.max(1, lines.findIndex((line) => line.includes(needle)) + 1);
}

// Matches the versions and models a repository pins against the registry. Each exposure lists
// file:line evidence; nothing is installed, executed or sent to a provider.
export async function findDeadlineExposures(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
): Promise<DeadlineExposure[]> {
  const root = resolve(directory);
  const byVersion = new Map<string, DeadlineEntry>();
  for (const entry of registry.deadlines)
    for (const version of entry.versions) byVersion.set(`${entry.provider}:${version}`, entry);
  const models = new Set(
    registry.deadlines
      .filter((entry) => entry.provider === 'openai')
      .flatMap((entry) => entry.versions),
  );
  const exposures = new Map<string, DeadlineExposure>();
  const record = (
    provider: string,
    version: string,
    evidence: Omit<DeadlineEvidence, 'version'>,
  ) => {
    const deadline = byVersion.get(`${provider}:${version}`);
    if (!deadline) return;
    const exposure = exposures.get(deadline.id) ?? {
      deadline,
      days: daysUntil(deadline.date, now),
      evidence: [],
      more: 0,
    };
    exposures.set(deadline.id, exposure);
    if (
      exposure.evidence.some(
        (item) =>
          item.file === evidence.file && item.line === evidence.line && item.version === version,
      )
    )
      return;
    if (exposure.evidence.length < MAX_EVIDENCE) exposure.evidence.push({ ...evidence, version });
    else exposure.more += 1;
  };

  const repository = await readRepository(root, META_SDK);
  for (const file of repository.files) {
    const shopifyFile = SHOPIFY_CONTEXT.some((name) => file.content.includes(name));
    const metaFile = META_CONTEXT.some((name) => file.content.includes(name));
    let inToken: ((offset: number) => boolean) | undefined;
    let offset = 0;
    for (const [index, line] of file.content.split('\n').entries()) {
      for (const match of sourceMatches(line, shopifyFile, metaFile, models)) {
        inToken ??= pinTokens(file.path, file.content);
        if (!inToken(offset + match.column)) continue;
        record(match.provider, match.version, {
          file: file.path,
          line: index + 1,
          kind: 'source',
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
        text: `${META_SDK} ${dependency.lock.version ?? dependency.version}${dependency.lock.version ? ` (locked in ${dependency.lock.file})` : ''} targets Graph API ${version}`,
      });
  }
  for (const pin of await configuredApiVersions(root))
    record(pin.provider, pin.version, {
      file: REPOSITORY_CONFIGURATION,
      line: pin.line,
      kind: 'refit-configuration',
      text: `apiVersion "${pin.version}" in the ${pin.integration ?? 'repository'} integration`,
    });
  return [...exposures.values()].sort(
    (a, b) =>
      a.deadline.date.localeCompare(b.deadline.date) || a.deadline.id.localeCompare(b.deadline.id),
  );
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

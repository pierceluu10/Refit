import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphCall, GraphSpan } from './meta-graph-calls.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError, type Repository, type SourceEdit } from './types.ts';

// Documented Graph API migration rules, one file per version in data/rules/meta-graph. A rule
// applies to a request whose version move crosses the rule's version. Only `auto` rules edit code,
// and only field and metric renames, which change one literal item a request sends; every other
// family, and every `review` rule, stops the move with the rule's source so a person or AI repair
// can make the change.

export const DEFAULT_META_GRAPH_RULES = new URL('../data/rules/meta-graph/', import.meta.url);

const VERSION = /^v\d+\.\d+$/;
const NAME = /^[A-Za-z_][\w]*$/;
const SOURCE = /^https:\/\/developers\.facebook\.com\/\S*$/;
export const RULE_FAMILIES = [
  'field-rename',
  'metric-rename',
  'edge-rename',
  'parameter-rename',
  'parameter-required',
] as const;

export interface MetaGraphRule {
  rule: string;
  // The version that introduces the change.
  version: string;
  family: (typeof RULE_FAMILIES)[number];
  // Limits the rule to requests on this edge; null for every request.
  edge: string | null;
  node: string | null;
  name: string;
  replacement: string | null;
  // The value a newly required parameter takes, when the documentation gives one.
  value: string | null;
  source: string;
  quote: string;
  checkedAt: string;
  status: 'auto' | 'review';
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Every rule in the directory; none when it does not exist yet. A malformed file rejects the load.
export async function loadMetaGraphRules(
  directory: string | URL = DEFAULT_META_GRAPH_RULES,
): Promise<MetaGraphRule[]> {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  let names: string[];
  try {
    names = (await readdir(path)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rules: MetaGraphRule[] = [];
  for (const name of names) {
    const file = parseObject(await readFile(join(path, name), 'utf8'), `Meta Graph rules ${name}`);
    const version = text(file.version);
    if (
      file.formatVersion !== 1 ||
      !version ||
      !VERSION.test(version) ||
      !Array.isArray(file.rules)
    )
      throw new PipelineInputError(
        `${name}: Meta Graph rules need formatVersion 1, a version such as v22.0 and rules.`,
      );
    for (const [index, entry] of file.rules.entries()) {
      const where = `${name} rule ${index + 1}`;
      const rule = entry as Record<string, unknown>;
      const family = RULE_FAMILIES.find((item) => item === rule.family);
      const ruleName = text(rule.name);
      const replacement = text(rule.replacement);
      if (!text(rule.rule) || !family || !ruleName || !NAME.test(ruleName))
        throw new PipelineInputError(`${where}: needs rule, a known family and a name.`);
      if (family.endsWith('-rename') && (!replacement || !NAME.test(replacement)))
        throw new PipelineInputError(`${where}: a rename needs a replacement name.`);
      if (!SOURCE.test(String(rule.source)) || !text(rule.quote) || !text(rule.checkedAt))
        throw new PipelineInputError(
          `${where}: needs a developers.facebook.com source, the quote and checkedAt.`,
        );
      if (rule.status !== 'auto' && rule.status !== 'review')
        throw new PipelineInputError(`${where}: status must be auto or review.`);
      rules.push({
        rule: String(rule.rule),
        version,
        family,
        edge: text(rule.edge),
        node: text(rule.node),
        name: ruleName,
        replacement,
        value: text(rule.value),
        source: String(rule.source),
        quote: String(rule.quote),
        checkedAt: String(rule.checkedAt),
        status: rule.status,
      });
    }
  }
  return rules;
}

// A field or metric name as an item of a literal list: after the start, a separator, a brace, a
// quote or `=`, and before a separator, a brace, a modifier, a quote or `&`. `picture.type(large)`
// does not name `type`.
function itemPattern(name: string) {
  return new RegExp(`(?<=^|[,{='"\`\\s])${name}(?=$|[,{}.'"\`&\\s])`, 'g');
}

export interface RuleOutcome {
  edits: SourceEdit[];
  reasons: string[];
  // Changes the rule settles, as `kind name` pairs, so they no longer stop the move.
  covers: string[];
}

// Applies the in-range rules a request matches. `others` are every scanned request outside the
// move, whose literals an edit must not touch; `moving` is the requests the move covers.
export function applyRules(
  call: GraphCall,
  rules: MetaGraphRule[],
  repository: Repository,
  moving: GraphCall[],
  others: GraphCall[],
): RuleOutcome {
  const where = `${call.file}:${call.line}`;
  const outcome: RuleOutcome = { edits: [], reasons: [], covers: [] };
  for (const rule of rules) {
    if (rule.edge !== null && rule.edge !== call.edge) continue;
    const cite = `${rule.version} rule ${rule.rule} (${rule.source})`;
    if (rule.family === 'field-rename' || rule.family === 'metric-rename') {
      const metric = rule.family === 'metric-rename';
      const values = metric ? call.metrics : call.fields;
      const named = metric
        ? values?.some((item) => item.toLowerCase() === rule.name.toLowerCase())
        : values?.some((item) => itemPattern(rule.name).test(item));
      if (!named) continue;
      outcome.covers.push(
        ...(metric
          ? [`metric-removed ${rule.name}`, `metric-changed ${rule.name}`]
          : [`field-removed ${rule.name}`, `field-changed ${rule.name}`]),
      );
      const spans = (metric ? call.literals?.metrics : call.literals?.fields) ?? [];
      if (rule.status === 'review') {
        outcome.reasons.push(
          `${where}: ${cite} renames \`${rule.name}\` to \`${rule.replacement}\` and is marked for review`,
        );
        continue;
      }
      const result = renameItem(repository, spans, rule.name, rule.replacement!, moving, others);
      if ('reason' in result) outcome.reasons.push(`${where}: ${cite}: ${result.reason}`);
      else
        outcome.edits.push(
          ...result.edits.map((edit) => ({
            ...edit,
            changeId: `meta-graph-rule-${rule.rule}`,
            rule: rule.rule,
          })),
        );
      continue;
    }
    if (rule.family === 'edge-rename' && call.edge === rule.name)
      outcome.reasons.push(
        `${where}: ${cite} moves the \`${rule.name}\` edge to \`${rule.replacement}\`; edges are not edited automatically`,
      );
    if (rule.family === 'parameter-rename' && call.parameters?.includes(rule.name))
      outcome.reasons.push(
        `${where}: ${cite} renames the \`${rule.name}\` parameter to \`${rule.replacement}\`; parameters are not edited automatically`,
      );
    if (
      rule.family === 'parameter-required' &&
      rule.edge !== null &&
      !(call.parameters?.includes(rule.name) ?? false)
    )
      outcome.reasons.push(
        `${where}: ${cite} requires the \`${rule.name}\` parameter${rule.value ? ` (documented value \`${rule.value}\`)` : ''}, which this request does not send`,
      );
  }
  return outcome;
}

// Renames one item in the literals a request's list is written in. It stops when the item is not
// written there exactly once, when another request outside the move reads the same literal, or
// when the old name appears anywhere else in the repository's code, where it may be a read of the
// response field the rename changes.
function renameItem(
  repository: Repository,
  spans: GraphSpan[],
  name: string,
  replacement: string,
  moving: GraphCall[],
  others: GraphCall[],
): { edits: Omit<SourceEdit, 'changeId'>[] } | { reason: string } {
  const found: { file: string; start: number }[] = [];
  for (const span of spans) {
    const content = repository.files.find((file) => file.path === span.file)?.content ?? '';
    for (const match of content.slice(span.start, span.end).matchAll(itemPattern(name)))
      found.push({ file: span.file, start: span.start + match.index });
  }
  if (found.length !== 1)
    return {
      reason: found.length
        ? `\`${name}\` is written ${found.length} times in the requested list`
        : `\`${name}\` is not written in a literal the request reads`,
    };
  const [item] = found;
  const overlaps = (call: GraphCall) =>
    [...(call.literals?.fields ?? []), ...(call.literals?.metrics ?? [])].some(
      (span) => span.file === item.file && span.start <= item.start && item.start < span.end,
    );
  const shared = others.find((call) => !moving.includes(call) && overlaps(call));
  if (shared)
    return {
      reason: `the list is shared with ${shared.file}:${shared.line}, which this move does not cover`,
    };
  const reads: string[] = [];
  const word = new RegExp(`\\b${name}\\b`, 'g');
  for (const file of repository.files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    for (const match of file.content.matchAll(word))
      if (!(file.path === item.file && match.index === item.start)) {
        const line = file.content.slice(0, match.index).split('\n').length;
        reads.push(`${file.path}:${line}`);
      }
  }
  if (reads.length)
    return {
      reason: `\`${name}\` also appears at ${reads.slice(0, 5).join(', ')}${reads.length > 5 ? ` and ${reads.length - 5} more` : ''}, which may read the renamed response field`,
    };
  return {
    edits: [{ file: item.file, start: item.start, end: item.start + name.length, replacement }],
  };
}

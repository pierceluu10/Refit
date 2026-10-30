import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { GraphCall, GraphSpan } from './meta-graph-calls.ts';
import type { MetaGraphChanges } from './meta-graph-changes.ts';
import { META_RULES, type MetaGraphRule } from './meta-graph-rules.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError, type Repository, type SourceEdit } from './types.ts';

// What ME2's documented rules (data/rules/meta-graph, checked by `refit rules check`) do to a
// request whose version move crosses them. A rule answers one change in the table, so its version
// and edge are the change's. Only an `auto` field or metric replacement edits code: it renames the
// one literal item a request sends, in the same patch as the move. Every other rule that a request
// uses, and every rule still marked `review` (all of them today), stops the move with the
// documented replacement and its source, for a person or AI repair.

export interface AppliedRule {
  rule: string;
  change: string;
  // The version that introduces the change; null for an out-of-cycle change, which applies to
  // every version and so is never crossed by a move.
  version: string | null;
  // `field`, `metric`, `edge`, `parameter`, `endpoint`, `error`, `permission`, `webhook` or
  // `product`, and whether `to` is an identifier (`replacement`) or a plan (`migration`).
  subject: string;
  replacement: boolean;
  edge: string | null;
  from: string;
  to: string;
  source: string;
  status: 'auto' | 'review';
}

// Every rule, joined to the change it answers. A rule naming a change the table lacks rejects the
// load, since its version would be unknown.
export async function loadMetaGraphRules(
  changes: MetaGraphChanges,
  directory: string | URL = META_RULES,
): Promise<AppliedRule[]> {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  let names: string[];
  try {
    names = (await readdir(path)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const byId = new Map(changes.changes.map((change) => [change.id, change]));
  const rules: AppliedRule[] = [];
  for (const name of names) {
    const table = parseObject(
      await readFile(`${path}/${name}`, 'utf8'),
      `Meta Graph rules ${name}`,
    );
    if (table.formatVersion !== 1 || !Array.isArray(table.rules))
      throw new PipelineInputError(`${name}: Meta Graph rules need formatVersion 1 and rules.`);
    for (const entry of table.rules as MetaGraphRule[]) {
      const change = byId.get(entry.change);
      const family = /^([a-z]+)-(replacement|migration)$/.exec(String(entry.family));
      if (!change || !family)
        throw new PipelineInputError(
          `${name}: rule ${entry.rule} needs a family and a change in the change table.`,
        );
      rules.push({
        rule: entry.rule,
        change: change.id,
        version: change.version,
        subject: family[1],
        replacement: family[2] === 'replacement',
        edge: change.edge,
        from: entry.from,
        to: entry.to,
        source: entry.source,
        status: (entry.status as string) === 'auto' ? 'auto' : 'review',
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
  // IDs of the changes an applied rule settles, so they no longer stop the move.
  covers: string[];
}

// Applies the in-range rules a request uses. `others` are every scanned request, whose literals an
// edit outside the move must not touch; `moving` is the requests the move covers.
export function applyRules(
  call: GraphCall,
  rules: AppliedRule[],
  repository: Repository,
  moving: GraphCall[],
  others: GraphCall[],
): RuleOutcome {
  const where = `${call.file}:${call.line}`;
  const outcome: RuleOutcome = { edits: [], reasons: [], covers: [] };
  for (const rule of rules) {
    if (rule.edge !== null && rule.edge !== call.edge && rule.subject !== 'edge') continue;
    const cite = `${rule.version ?? 'out-of-cycle'} rule ${rule.rule} (${rule.source})`;
    const metric = rule.subject === 'metric';
    const listed = metric ? call.metrics : rule.subject === 'field' ? call.fields : null;
    const uses = listed
      ? metric
        ? listed.some((item) => item.toLowerCase() === rule.from.toLowerCase())
        : listed.some((item) => itemPattern(rule.from).test(item))
      : rule.subject === 'parameter'
        ? (call.parameters?.includes(rule.from) ?? false)
        : rule.subject === 'edge'
          ? call.edge === rule.from
          : false;
    if (!uses) continue;
    if (rule.status !== 'auto' || !rule.replacement || !listed) {
      outcome.reasons.push(
        `${where}: ${cite} documents ${rule.replacement ? `\`${rule.to}\` in place of` : `a migration from`} \`${rule.from}\`${rule.replacement ? '' : ` to ${rule.to}`}; ${rule.status === 'auto' ? 'only fields and metrics are edited automatically' : 'the rule is marked for review'}`,
      );
      continue;
    }
    const spans = (metric ? call.literals?.metrics : call.literals?.fields) ?? [];
    const result = renameItem(repository, spans, rule.from, rule.to, moving, others);
    if ('reason' in result) outcome.reasons.push(`${where}: ${cite}: ${result.reason}`);
    else {
      outcome.covers.push(rule.change);
      outcome.edits.push(
        ...result.edits.map((edit) => ({
          ...edit,
          changeId: `meta-graph-rule-${rule.rule}`,
          rule: rule.rule,
        })),
      );
    }
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

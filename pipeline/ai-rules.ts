import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validDate } from './deadline-registry.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Rule tables for the AI providers' SDK and API changes, in the D3 pattern of Stripe's generated
// rules: every rule names the provider page it comes from and quotes it verbatim. The pages are
// saved under docs/ai-docs/pages, so `refit ai-rules --check` proves each quote offline, and
// `--live` reads every page again to show the provider still says it.

export const AI_RULE_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type AiRuleProvider = (typeof AI_RULE_PROVIDERS)[number];
export const AI_RULE_KINDS = [
  'sdk-major',
  'api-surface',
  'response-format',
  'beta-feature',
] as const;
export type AiRuleKind = (typeof AI_RULE_KINDS)[number];

// `auto`: Refit may apply the rule under every gate. `review`: the rule finds and explains, and its
// sites are listed for review, never edited. `report`: the provider or language is report only
// (Gemini and Python, AGENTS.md), so the rule only names the finding.
export type AiRuleStatus = 'auto' | 'review' | 'report';

export interface AiRulePage {
  url: string;
  // Where `--live` reads the page's text when `url` serves HTML: a Markdown copy the provider
  // publishes, or GitHub's API for a discussion (its `body`).
  raw?: string;
  // Repository-relative path of the saved copy.
  file: string;
  capturedAt: string;
  // Set when the saved file is one section of the page; says which.
  excerpt?: string;
}

export interface AiRule {
  rule: string;
  family: string;
  status: AiRuleStatus;
  page: string;
  quote: string;
  checkedAt: string;
  // `docs`: written from the page by hand; `generated`: proposed by a model and verified.
  origin: 'docs' | 'generated';
  // What the rule does, for drafts and stops.
  summary: string;
  // Family-specific data (method names, packages, ranges).
  data: Record<string, unknown>;
  generatedBy?: { model: string; responseId: string };
}

export interface AiRuleTable {
  formatVersion: 1;
  provider: AiRuleProvider;
  kind: AiRuleKind;
  pages: Record<string, AiRulePage>;
  rules: AiRule[];
}

const OFFICIAL_HOSTS: Record<AiRuleProvider, string[]> = {
  openai: ['github.com', 'raw.githubusercontent.com', 'api.github.com', 'developers.openai.com'],
  anthropic: ['platform.claude.com', 'docs.anthropic.com', 'github.com', 'api.github.com'],
  gemini: ['ai.google.dev', 'github.com', 'raw.githubusercontent.com', 'api.github.com'],
};
// GitHub pages count only from the provider's own organizations.
const GITHUB_OWNERS: Record<AiRuleProvider, string[]> = {
  openai: ['openai'],
  anthropic: ['anthropics'],
  gemini: ['google-gemini', 'googleapis'],
};
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9.]+)*$/;
const STATUSES = new Set<AiRuleStatus>(['auto', 'review', 'report']);

export const AI_RULES_DIRECTORY = new URL('../data/rules/', import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

function officialPage(provider: AiRuleProvider, value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (!OFFICIAL_HOSTS[provider].includes(url.hostname)) return false;
    const owner = url.pathname.split('/')[url.hostname === 'api.github.com' ? 2 : 1] ?? '';
    if (url.hostname.endsWith('github.com') || url.hostname === 'raw.githubusercontent.com')
      return GITHUB_OWNERS[provider].includes(owner);
    return true;
  } catch {
    return false;
  }
}

// Whitespace never decides whether a quote is on a page: Markdown renderers rewrap lines.
export function collapse(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

export function parseAiRuleTable(value: unknown, label: string): AiRuleTable {
  const errors: string[] = [];
  if (!isObject(value)) throw new PipelineInputError(`${label} is not a JSON object.`);
  if (value.formatVersion !== 1) errors.push('formatVersion must be 1');
  const provider = value.provider as AiRuleProvider;
  if (!AI_RULE_PROVIDERS.includes(provider)) errors.push(`unknown provider ${String(provider)}`);
  if (!AI_RULE_KINDS.includes(value.kind as AiRuleKind))
    errors.push(`unknown kind ${String(value.kind)}`);
  const pages: Record<string, AiRulePage> = {};
  if (!isObject(value.pages)) errors.push('pages must be an object');
  else
    for (const [id, page] of Object.entries(value.pages)) {
      if (
        !isObject(page) ||
        !officialPage(provider, page.url) ||
        (page.raw !== undefined && !officialPage(provider, page.raw)) ||
        typeof page.file !== 'string' ||
        !page.file.startsWith('docs/ai-docs/pages/') ||
        page.file.includes('..') ||
        !validDate(page.capturedAt) ||
        (page.excerpt !== undefined && typeof page.excerpt !== 'string')
      ) {
        errors.push(
          `page ${id} needs an official ${provider} https url, a docs/ai-docs/pages file and capturedAt`,
        );
        continue;
      }
      pages[id] = page as unknown as AiRulePage;
    }
  const rules: AiRule[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value.rules)) errors.push('rules must be an array');
  else
    for (const [index, rule] of value.rules.entries()) {
      const at = `rules[${index}]`;
      if (!isObject(rule)) {
        errors.push(`${at} is not an object`);
        continue;
      }
      const problems = [
        typeof rule.rule !== 'string' || !RULE_ID.test(rule.rule) ? 'rule id' : '',
        typeof rule.family !== 'string' || !rule.family ? 'family' : '',
        !STATUSES.has(rule.status as AiRuleStatus) ? 'status' : '',
        typeof rule.page !== 'string' || !(rule.page in pages) ? 'page' : '',
        typeof rule.quote !== 'string' || collapse(rule.quote).length < 12 ? 'quote' : '',
        !validDate(rule.checkedAt) ? 'checkedAt' : '',
        rule.origin !== 'docs' && rule.origin !== 'generated' ? 'origin' : '',
        typeof rule.summary !== 'string' || !rule.summary ? 'summary' : '',
        !isObject(rule.data) ? 'data' : '',
        rule.origin === 'generated' &&
        !(
          isObject(rule.generatedBy) &&
          typeof rule.generatedBy.model === 'string' &&
          typeof rule.generatedBy.responseId === 'string'
        )
          ? 'generatedBy'
          : '',
        // Report-only providers never get rules that edit (AGENTS.md: Gemini is report only).
        provider === 'gemini' && rule.status === 'auto' ? 'status (Gemini is report only)' : '',
      ].filter(Boolean);
      if (problems.length) {
        errors.push(`${at} (${String(rule.rule)}): invalid ${problems.join(', ')}`);
        continue;
      }
      if (seen.has(rule.rule as string)) errors.push(`${at}: duplicate rule ${String(rule.rule)}`);
      seen.add(rule.rule as string);
      rules.push(rule as unknown as AiRule);
    }
  if (errors.length) throw new PipelineInputError(`${label}: ${errors.join('; ')}.`);
  return {
    formatVersion: 1,
    provider,
    kind: value.kind as AiRuleKind,
    pages,
    rules,
  };
}

export async function loadAiRuleTables(directory = AI_RULES_DIRECTORY) {
  const tables: AiRuleTable[] = [];
  for (const provider of AI_RULE_PROVIDERS) {
    const folder = fileURLToPath(new URL(`${provider}/`, directory));
    const files = await readdir(folder).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
      const label = `data/rules/${provider}/${file}`;
      const table = parseAiRuleTable(
        parseObject(await readFile(join(folder, file), 'utf8'), label),
        label,
      );
      if (table.provider !== provider)
        throw new PipelineInputError(`${label} names provider ${table.provider}.`);
      tables.push(table);
    }
  }
  return tables;
}

export const rulesOf = (tables: AiRuleTable[], provider: AiRuleProvider, kind: AiRuleKind) =>
  tables
    .filter((table) => table.provider === provider && table.kind === kind)
    .flatMap((table) => table.rules.map((rule) => ({ ...rule, source: table.pages[rule.page] })));

export interface AiRuleProblem {
  table: string;
  rule: string;
  problem: string;
}

// Every quote must be on its saved page. With `live`, each page is read again and every quote
// must still be on it; a page that cannot be read is a problem, never a pass.
export async function checkAiRuleTables(
  tables: AiRuleTable[],
  options: { live?: (url: string) => Promise<string>; root?: string } = {},
): Promise<AiRuleProblem[]> {
  const problems: AiRuleProblem[] = [];
  const saved = new Map<string, string | null>();
  const live = new Map<string, string | null>();
  for (const table of tables) {
    const label = `${table.provider}/${table.kind}`;
    for (const rule of table.rules) {
      const page = table.pages[rule.page];
      if (!saved.has(page.file))
        saved.set(
          page.file,
          await readFile(join(options.root ?? REPOSITORY_ROOT, page.file), 'utf8')
            .then(collapse)
            .catch(() => null),
        );
      const text = saved.get(page.file);
      if (text === null)
        problems.push({ table: label, rule: rule.rule, problem: `${page.file} is missing` });
      else if (!text!.includes(collapse(rule.quote)))
        problems.push({
          table: label,
          rule: rule.rule,
          problem: `the quote is not on the saved page ${page.file}`,
        });
      if (!options.live) continue;
      if (!live.has(page.url))
        live.set(
          page.url,
          await options
            .live(page.raw ?? page.url)
            .then(collapse)
            .catch(() => null),
        );
      const current = live.get(page.url);
      if (current === null)
        problems.push({
          table: label,
          rule: rule.rule,
          problem: `${page.raw ?? page.url} could not be read`,
        });
      else if (!current!.includes(collapse(rule.quote)))
        problems.push({
          table: label,
          rule: rule.rule,
          problem: `the quote is no longer on ${page.url}`,
        });
    }
  }
  return problems;
}

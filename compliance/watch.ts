// watchRegulations: an agent reads official texts per rule family and writes Obligations, each with
// an exact quote from the source. Quotes are checked against the fetched text; a quote that isn't
// found is kept and flagged for a person, never silently dropped or silently trusted.

import type { Obligation, WatchRegulations } from '../shared/types.ts';
import { RULE_FAMILIES, type RuleFamily } from './families.ts';
import { containsQuote, httpFetcher, normalize, type Fetcher, type Page } from './fetch.ts';
import { errorText, runLoop, type LoopTool, type Submit } from './loop.ts';
import { createComplianceModel, type ModelClient } from './model.ts';
import { findClaims, scrubClaims } from './wording.ts';

export const WATCH_PROMPT_VERSION = 'compliance-watch/1';

export const WATCH_SYSTEM = `You are Refit's rules reader. Refit keeps codebases current as the world outside them changes, including laws and industry rules.

You read official texts and official guidance (the law itself, the regulator's or standards body's own pages), not blogs, law-firm summaries or vendor marketing. Use read_page to read a source and find_in_page to check that a passage is there word for word before you quote it.

For the rule family you are given, write one obligation per distinct duty that touches software. Each obligation has:
- rule: the rule's name, its jurisdiction, the URL you read it at, and an exact quote copied word for word from that page. The quote must be the passage that creates the duty.
- requirement: what the rule asks for, in plain words.
- appliesTo: which code it likely touches (e.g. "checkout pages", "sign-up forms", "chat interfaces").
- inCode: what the rule's text points to in code, concretely (e.g. "every input has a programmatic label").
- effectiveDate: YYYY-MM-DD when the source states one; leave it out when it doesn't. Never guess a date.
- checkable: what a tool can check (e.g. "axe accessibility scan of the sign-up page", "list of scripts loaded on the checkout page").
- needsHuman: what a person or lawyer must confirm (e.g. "whether the business is in scope", "whether the consent wording is adequate").

How you write:
- Refit never gives legal advice and never says code is compliant, meets, satisfies or conforms to a law. Describe what the text says and what code it points to; leave the conclusion to people.
- Scope questions (does this law apply to this business?) always go in needsHuman.
- When a source can't be read, say so in unread with the reason, and use what you could read. Never fill a gap from memory and present it as quoted text.
- When you are unsure whether a duty touches code, include it and say what is uncertain in needsHuman.

Finish by calling submit_obligations.`;

const OBLIGATION_SCHEMA = {
  type: 'object',
  required: ['slug', 'rule', 'requirement', 'appliesTo', 'inCode', 'checkable', 'needsHuman'],
  properties: {
    slug: { type: 'string', description: 'Short id, e.g. "wcag22-3.3.2-labels".' },
    rule: {
      type: 'object',
      required: ['name', 'url', 'quote'],
      properties: {
        name: { type: 'string' },
        jurisdiction: { type: 'string' },
        url: { type: 'string' },
        quote: { type: 'string' },
      },
    },
    requirement: { type: 'string' },
    appliesTo: { type: 'string' },
    inCode: { type: 'string' },
    effectiveDate: { type: 'string' },
    checkable: { type: 'array', items: { type: 'string' } },
    needsHuman: { type: 'array', items: { type: 'string' } },
  },
};

type Draft = {
  slug: string;
  rule: { name: string; jurisdiction?: string; url: string; quote: string };
  requirement: string;
  appliesTo: string;
  inCode: string;
  effectiveDate?: string;
  checkable: string[];
  needsHuman: string[];
};

export type FamilyRead = {
  family: RuleFamily['id'];
  obligations: Obligation[];
  unread: { url: string; reason: string }[];
  errors: string[];
};

export type RegulationsRead = {
  obligations: Obligation[];
  families: FamilyRead[];
  errors: string[];
  costUsd: number;
};

export type WatchOptions = {
  model?: ModelClient;
  fetcher?: Fetcher;
  families?: RuleFamily[];
  now?: () => Date;
};

const PAGE_CHUNK = 20_000;

function pageTools(fetcher: Fetcher, pages: Map<string, Page>): LoopTool[] {
  const load = async (url: string) => {
    const cached = pages.get(url);
    if (cached) return cached;
    const page = await fetcher.fetch(url);
    pages.set(url, page);
    return page;
  };
  return [
    {
      name: 'read_page',
      description: `Read a page as text, ${PAGE_CHUNK} characters at a time. Pass offset to read further.`,
      input_schema: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' }, offset: { type: 'integer' } },
      },
      async run(input) {
        const page = await load(String(input.url));
        if (!page.ok) return `Could not read ${page.url}: ${page.error ?? `HTTP ${page.status}`}`;
        const offset = Math.max(Number(input.offset ?? 0) || 0, 0);
        const chunk = page.text.slice(offset, offset + PAGE_CHUNK);
        const end = offset + chunk.length;
        return `${page.url} (characters ${offset}-${end} of ${page.text.length})\n\n${chunk}${
          end < page.text.length ? `\n\n[more: read_page with offset ${end}]` : ''
        }`;
      },
    },
    {
      name: 'find_in_page',
      description:
        'Check whether a passage appears word for word in a page (ignoring whitespace and quote-mark style), and show where.',
      input_schema: {
        type: 'object',
        required: ['url', 'text'],
        properties: { url: { type: 'string' }, text: { type: 'string' } },
      },
      async run(input) {
        const page = await load(String(input.url));
        if (!page.ok) return `Could not read ${page.url}: ${page.error ?? `HTTP ${page.status}`}`;
        const text = String(input.text);
        if (containsQuote(page.text, text)) return `Found word for word in ${page.url}.`;
        // Help the model find the right passage: show lines that share the most words.
        const words = new Set(
          normalize(text)
            .split(' ')
            .filter((w) => w.length > 3),
        );
        const near = page.text
          .split('\n')
          .map((line) => ({
            line,
            score: normalize(line)
              .split(' ')
              .filter((w) => words.has(w)).length,
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((entry) => `- ${entry.line.trim().slice(0, 400)}`);
        return `Not found word for word in ${page.url}.${near.length ? ` Closest lines:\n${near.join('\n')}` : ''}`;
      },
    },
  ];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((s) => s.trim()) : [];
}

function toDraft(raw: unknown): Draft | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const o = raw as Record<string, unknown>;
  const rule = (o.rule ?? {}) as Record<string, unknown>;
  for (const [key, value] of [
    ['rule.name', rule.name],
    ['rule.url', rule.url],
    ['rule.quote', rule.quote],
    ['requirement', o.requirement],
    ['appliesTo', o.appliesTo],
    ['inCode', o.inCode],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) return `${key} is missing`;
  }
  const date = typeof o.effectiveDate === 'string' ? o.effectiveDate.trim() : '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return `effectiveDate "${date}" is not YYYY-MM-DD`;
  return {
    slug: typeof o.slug === 'string' && o.slug.trim() ? o.slug.trim() : String(rule.name),
    rule: {
      name: String(rule.name),
      jurisdiction: typeof rule.jurisdiction === 'string' ? rule.jurisdiction : undefined,
      url: String(rule.url),
      quote: String(rule.quote),
    },
    requirement: String(o.requirement),
    appliesTo: String(o.appliesTo),
    inCode: String(o.inCode),
    effectiveDate: date || undefined,
    checkable: asStrings(o.checkable),
    needsHuman: asStrings(o.needsHuman),
  };
}

// The text fields Refit writes itself (the quote is the source's own words and is never changed).
const writtenFields = (d: Draft) => [
  d.requirement,
  d.appliesTo,
  d.inCode,
  ...d.checkable,
  ...d.needsHuman,
];

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'obligation'
  );
}

function submitTool(): Submit<{ drafts: Draft[]; unread: { url: string; reason: string }[] }> {
  let rewrites = 0;
  return {
    name: 'submit_obligations',
    description: 'Submit the obligations for this rule family, and any sources you could not read.',
    input_schema: {
      type: 'object',
      required: ['obligations'],
      properties: {
        obligations: { type: 'array', items: OBLIGATION_SCHEMA },
        unread: {
          type: 'array',
          items: {
            type: 'object',
            required: ['url', 'reason'],
            properties: { url: { type: 'string' }, reason: { type: 'string' } },
          },
        },
      },
    },
    accept(input) {
      const raw = Array.isArray(input.obligations) ? input.obligations : [];
      const drafts: Draft[] = [];
      const problems: string[] = [];
      raw.forEach((item, index) => {
        const draft = toDraft(item);
        if (typeof draft === 'string') problems.push(`obligation ${index}: ${draft}`);
        else drafts.push(draft);
      });
      const claims = drafts.flatMap((d) => writtenFields(d).flatMap(findClaims));
      if ((problems.length || claims.length) && rewrites < 2) {
        rewrites++;
        return {
          ok: false,
          feedback: [
            problems.length ? `Fix these and submit again:\n- ${problems.join('\n- ')}` : '',
            claims.length
              ? `Rewrite without compliance claims or legal conclusions (Refit never says code is compliant or meets a law): ${claims.map((c) => `"${c}"`).join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
      const unread = (Array.isArray(input.unread) ? input.unread : []).map((u) => ({
        url: String((u as Record<string, unknown>)?.url ?? ''),
        reason: String((u as Record<string, unknown>)?.reason ?? ''),
      }));
      if (problems.length)
        unread.push({ url: '', reason: `dropped malformed: ${problems.join('; ')}` });
      return { ok: true, value: { drafts, unread } };
    },
  };
}

// Turns an accepted draft into an Obligation, checking its quote against what was fetched.
function finish(family: RuleFamily, draft: Draft, pages: Map<string, Page>): Obligation {
  const page = pages.get(draft.rule.url);
  const needsHuman = draft.needsHuman.map(scrubClaims);
  if (!page?.ok) {
    needsHuman.unshift(
      `Refit did not read ${draft.rule.url} in this run, so the quote was not checked against it. Check the quote against the source.`,
    );
  } else if (!containsQuote(page.text, draft.rule.quote)) {
    needsHuman.unshift(
      `The quote was not found word for word in the text Refit read from ${draft.rule.url}. Check it against the source before relying on it.`,
    );
  }
  return {
    id: `${family.id}:${slugify(draft.slug)}`,
    rule: draft.rule,
    requirement: scrubClaims(draft.requirement),
    appliesTo: scrubClaims(draft.appliesTo),
    inCode: scrubClaims(draft.inCode),
    effectiveDate: draft.effectiveDate,
    checkable: draft.checkable.map(scrubClaims),
    needsHuman,
  };
}

export async function readFamily(
  family: RuleFamily,
  options: { model: ModelClient; fetcher: Fetcher; since?: string; today: string },
): Promise<FamilyRead> {
  const pages = new Map<string, Page>();
  const prompt = [
    `Rule family: ${family.name}`,
    `Today: ${options.today}`,
    options.since
      ? `Report what is in force or changed since ${options.since}, and anything that takes effect later. Duties already in force before then are still listed if code may not handle them yet.`
      : '',
    `What to look for: ${family.focus}`,
    'Official sources to start from (you may follow links to other official pages):',
    ...family.sources.map((s) => `- ${s.title}: ${s.url}${s.note ? ` (${s.note})` : ''}`),
  ]
    .filter(Boolean)
    .join('\n');
  const result = await runLoop({
    model: options.model,
    system: WATCH_SYSTEM,
    prompt,
    tools: pageTools(options.fetcher, pages),
    submit: submitTool(),
  });
  const errors: string[] = [];
  let drafts: Draft[] = [];
  let unread: { url: string; reason: string }[] = [];
  if (result.value) {
    drafts = result.value.drafts;
    unread = result.value.unread.filter((u) => u.url || u.reason);
  } else {
    errors.push(`${family.id}: ${result.error ?? 'no result'}`);
    // Keep whatever the model last submitted, flagged, rather than losing it.
    const raw = result.lastSubmitted?.obligations;
    if (Array.isArray(raw)) {
      drafts = raw.map(toDraft).filter((d): d is Draft => typeof d !== 'string');
    }
  }
  for (const source of family.sources) {
    const page = pages.get(source.url);
    if (page && !page.ok && !unread.some((u) => u.url === source.url)) {
      unread.push({ url: source.url, reason: page.error ?? `HTTP ${page.status}` });
    }
    if (!page && !unread.some((u) => u.url === source.url)) {
      unread.push({ url: source.url, reason: 'the agent did not open this source' });
    }
  }
  const seen = new Set<string>();
  const obligations: Obligation[] = [];
  for (const draft of drafts) {
    const obligation = finish(family, draft, pages);
    let id = obligation.id;
    for (let n = 2; seen.has(id); n++) id = `${obligation.id}-${n}`;
    seen.add(id);
    obligations.push({ ...obligation, id });
  }
  if (!obligations.length) errors.push(`${family.id}: no obligations were written`);
  return { family: family.id, obligations, unread, errors };
}

// Reads every family and reports what was found, what couldn't be read and what it cost.
export async function readRegulations(
  since?: string,
  options: WatchOptions = {},
): Promise<RegulationsRead> {
  let model = options.model;
  const errors: string[] = [];
  if (!model) {
    try {
      model = createComplianceModel();
    } catch (error) {
      return {
        obligations: [],
        families: [],
        errors: [`No rule sources were read: ${errorText(error)}`],
        costUsd: 0,
      };
    }
  }
  const budget = (model as { budget?: { spentUsd: number } }).budget;
  const before = budget?.spentUsd ?? 0;
  const fetcher = options.fetcher ?? httpFetcher();
  const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const families: FamilyRead[] = [];
  // One family at a time, so the run budget is spent in order and a cap hit is reported per family.
  for (const family of options.families ?? RULE_FAMILIES) {
    try {
      families.push(await readFamily(family, { model, fetcher, since, today }));
    } catch (error) {
      families.push({ family: family.id, obligations: [], unread: [], errors: [errorText(error)] });
    }
  }
  for (const family of families) {
    errors.push(...family.errors);
    for (const u of family.unread) {
      errors.push(`${family.family}: could not read ${u.url || 'a source'}: ${u.reason}`);
    }
  }
  return {
    obligations: families.flatMap((f) => f.obligations),
    families,
    errors,
    costUsd: (budget?.spentUsd ?? 0) - before,
  };
}

export function createWatchRegulations(options: WatchOptions = {}): WatchRegulations {
  return async (since) => {
    const read = await readRegulations(since, options);
    for (const error of read.errors) console.warn(`[compliance] ${error}`);
    return read.obligations;
  };
}

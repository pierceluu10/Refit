// Turns a day's changelog read into proposed list entries, in plain code, and lets a proposal go live
// only when the provider's own page backs it: the quote is on the page and says the names and date the
// proposal claims, the host is official, the replacement is on the page, and the list still passes.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG } from '../inventory/catalog.ts';
import {
  containsQuote,
  normaliseForQuote,
  type FetchedPage,
  type Fetcher,
} from '../providers/core/fetch.ts';
import type {
  DeadApiEntry,
  DeadApiMatcher,
  FutureShutdown,
  MigrationKind,
  ProviderChange,
  ProviderHints,
} from '../shared/types.ts';
import {
  DATA_DIR,
  listProblems,
  matcherKey,
  readProviderFiles,
  type ProviderFile,
} from './list.ts';
import { escapeRegex, textMatches, tokenMatches, tokensOf, urlMatches } from './match.ts';

export const PROPOSED_DIR = path.join(import.meta.dirname, 'proposed');

// `noted`: a read's change that isn't a removal, kept so it's visible. `refused`: a person took it off
// the list for good, so no later read puts it back.
export type ProposalStatus = 'pending' | 'live' | 'rejected' | 'noted' | 'refused';

export type Proposal = {
  id: string;
  provider: string;
  changeId: string;
  status: ProposalStatus;
  reason: string;
  proposedOn: string;
  quote: string;
  change?: ProviderChange; // what a pending proposal is proposed from again on the next settle
} & (
  | { entry: DeadApiEntry; future?: undefined }
  | { future: FutureShutdown; entry?: undefined }
  | { entry?: undefined; future?: undefined }
);

export class UnknownEntryError extends Error {
  constructor(id: string) {
    super(`Nothing on the list or in the store has the id ${id}`);
    this.name = 'UnknownEntryError';
  }
}

// A renamed field is gone under its old name, and a webhook or REST change names what stopped
// arriving. Every other kind can leave the old call working, so it's noted rather than listed.
const REMOVAL_KINDS: ReadonlySet<MigrationKind> = new Set([
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'model-retirement',
  'product-shutdown',
  'webhook-payload',
  'rest-to-graphql',
]);
// Hand-written groups count up from 1; proposed entries share a group of their own.
const PROPOSED_GROUP = 100;
const PENDING_REASON = 'not checked yet';
const PASSED_DRY_RUN = 'passed every check; a dry run never goes live';
const REPLACEMENT_NOT_NAMED = "The changelog read named no replacement: check the entry's source";
const REQUIRES_UNCHECKED =
  "Not checked yet: read the replacement's migration page for what else moving to it needs.";
const HTTP_CALL =
  /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[^\s?#]*|https:\/\/[^\s?#]+)(?:[?#]\S*)?$/i;
const PATH_PARAM = /\{[^}/]+\}|<[^>/]+>|:[A-Za-z_]\w*/g;
const PATH_PARAM_REGEX = '[^/\\s]+';
const WHOLE_RESOURCE = '/*';
const PATH_PARAM_SAMPLE = 'id';
const OPERATION_NAME = /^[\w.:@/-]+$/;
const FIELD_NAME = /^\w+$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;
const USE = String.raw`use\b(?!\s+of\b)`;
const REPLACEMENT_CUE = new RegExp(
  String.raw`(?:(?:^|[;:,.(—–])\s*${USE}|\b(?:please|should|must|can)\s+${USE}|\b(?:migrate|move|switch|upgrade)\s+(?:to|onto)|\breplaced?\s+(?:by|with)|\bsuperseded\s+by|\bsuccessor(?:\s+is|:)|\bin\s+favou?r\s+of)\s+(.+)$`,
  'i',
);
const SENTENCE_END = /[.;]\s/;
const TRAILING_PUNCTUATION = /[.,;:)]+$/;
const REPLACEMENT_FILLER = new Set([
  'a',
  'an',
  'and',
  'or',
  'the',
  'to',
  'of',
  'for',
  'with',
  'instead',
  'new',
  'either',
]);
const NAME_SHAPE = /[A-Z\d_/-]/;
const DEPRECATED = /\bdeprecat/i;
const ENDS =
  /\b(?:remov|no longer|end[- ]of[- ]life|eol|sunset|shut|retir|stop|discontinu|unsupported|fail|4\d\d\b)/i;
const EARLIEST_WORDING = /\b(?:earliest|no earlier than|not before)\b/i;
const GITHUB_RELEASES = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\b/;
const FEED_URL = /(?:\.(?:xml|rss|atom)|\/feed\/?)(?:[?#]|$)/i;
const MONTH_NAME =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_PREFIXES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const ORDINAL = '(?:st|nd|rd|th)?';
const WRITTEN_DATE = new RegExp(
  String.raw`\b(?:(${MONTH_NAME})\.?\s+(\d{1,2})${ORDINAL},?\s+(\d{4})|(\d{1,2})${ORDINAL}\s+(${MONTH_NAME})\.?,?\s+(\d{4})|(${MONTH_NAME})\.?,?\s+(\d{4}))\b`,
  'gi',
);
// A day that isn't part of a longer name: 2025-03-31.basil is an API version, not a date.
const ISO_DAY = /(?<![\w-])(\d{4}-\d{2}-\d{2})(?![\w.-])/g;
// A provider's dated API version: Stripe's 2025-03-31.basil, Shopify's 2026-04.
const DATED_VERSION = /^\d{4}-\d{2}(?:-\d{2}(?:\.\w+)?)?$/;

export const providerId = (provider: string) => provider.trim().toLowerCase();
export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const fileName = (provider: string) => `${provider.replace(/[^\w.-]+/g, '_')}.json`;

/** Temp file plus rename, so a reader never sees half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJsonOr<T>(file: string, missing: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw error;
  }
}

// A matcher, and how a person would write what it looks for: a regex for /v1/x/{id} reads as that path.
type Named = { matcher: DeadApiMatcher; label: string };

// A trailing /* means everything under the path, so longer paths match too, and a bare one doesn't stop at it.
function templateMatcher(address: string): DeadApiMatcher {
  const whole = address.endsWith(WHOLE_RESOURCE);
  const base = whole ? address.slice(0, -WHOLE_RESOURCE.length) : address;
  const pattern = base.split(PATH_PARAM).map(escapeRegex).join(PATH_PARAM_REGEX);
  return { kind: 'regex', value: `${pattern}${whole ? '(?![\\w-])' : '(?![\\w/-])'}` };
}

function operationMatcher(operation: string): Named | undefined {
  const name = operation.trim().replace(/\(\)$/, '');
  const address = HTTP_CALL.exec(name)?.[1]?.replace(/^https:\/\//, '');
  if (address) {
    const matcher: DeadApiMatcher =
      address.search(PATH_PARAM) >= 0 ? templateMatcher(address) : { kind: 'url', value: address };
    return { matcher, label: address };
  }
  if (!OPERATION_NAME.test(name)) return undefined; // prose: nothing to match on
  // A plain word (an SDK method, a GraphQL operation) is the same shape as the app's own code.
  const ambiguous = /[\d-]/.test(name) ? {} : { ambiguous: true };
  return { matcher: { kind: 'string', value: name, ...ambiguous }, label: name };
}

function fieldMatcher(field: string): Named | undefined {
  const parts = field.trim().split('.');
  const value = parts.at(-1) ?? '';
  if (!FIELD_NAME.test(value)) return undefined;
  const owner = parts.at(-2);
  const on = owner ? { on: [owner] } : {};
  return { matcher: { kind: 'field', value, ...on, ambiguous: true }, label: value };
}

/** The same field on two owners is one matcher on both; one with no owner already means any. */
function mergedOwners(first: DeadApiMatcher, second: DeadApiMatcher): DeadApiMatcher {
  if (first.kind !== 'field' || second.kind !== 'field') return first;
  const { on: _left, ...rest } = first;
  return first.on && second.on ? { ...rest, on: [...new Set([...first.on, ...second.on])] } : rest;
}

function matchersOf(change: ProviderChange): Named[] {
  const { operations = [], fields = [], sdk } = change.affects;
  const found = [...operations.map(operationMatcher), ...fields.map(fieldMatcher)];
  // Only a shutdown means the package itself is going; a removal inside an SDK leaves it installed.
  if (sdk && change.kind === 'product-shutdown') {
    found.push({ matcher: { kind: 'package', value: sdk }, label: sdk });
  }
  const merged = new Map<string, Named>();
  for (const one of found) {
    if (!one) continue;
    const key = `${one.matcher.kind}|${one.matcher.value}`;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, matcher: mergedOwners(prior.matcher, one.matcher) } : one);
  }
  return [...merged.values()];
}

/** Whether a matcher already on the list covers this one, by its owner and any wildcard. */
function holds(held: DeadApiMatcher, { matcher, label }: Named): boolean {
  const address = label.replace(PATH_PARAM, PATH_PARAM_SAMPLE);
  if (held.kind === 'field' && matcher.kind === 'field') {
    if (held.value !== matcher.value) return false;
    return !held.on || !matcher.on || held.on.some((owner) => matcher.on?.includes(owner));
  }
  if (held.kind === 'url' && matcher.kind !== 'field') return urlMatches(held, address);
  if (held.kind === 'string' && matcher.kind === 'string') return tokenMatches(held, label);
  if (held.kind === 'regex' && matcher.kind !== 'field')
    return new RegExp(held.value).test(address);
  return held.value === matcher.value;
}

/** Whether a read adds nothing to a shutdown already held: no date, or the date it has, still ahead. */
function saysNothingNew(shutdown: FutureShutdown, change: ProviderChange, today: string): boolean {
  const said = change.effectiveDate;
  if (!said) return true;
  if (!shutdown.diesOn.startsWith(said)) return false;
  // The provider still only calls this date the earliest, so its passing proves nothing.
  if (shutdown.earliest && EARLIEST_WORDING.test(`${change.title} ${change.source.quote}`)) {
    return true;
  }
  return latestDay(said) > today;
}

// ProviderChange has no replacement field, so it's read from the words the watcher is told to put it
// in: the title, then the quote.
function replacementOf(change: ProviderChange): string | undefined {
  for (const text of [change.title, change.source.quote]) {
    const named = REPLACEMENT_CUE.exec(text)?.[1];
    if (named) return named.split(SENTENCE_END)[0].trim().replace(TRAILING_PUNCTUATION, '');
  }
  return undefined;
}

// A model id, a path or a camelCase name, not a plain word. A hyphenated word reads as a name too:
// failing a real "drop-in" costs a hand-check, and passing a made-up "super-model" costs a wrong fix.
const isNamedId = (token: string) =>
  token.startsWith('/') || (/[a-z]/i.test(token) && /[\d_-]|[a-z][A-Z]/.test(token));

/** The words of a replacement the page has to hold: its names, or with no name, its plain words. */
function replacementWords(named: string): string[] {
  const words = tokensOf(named).filter((word) => !REPLACEMENT_FILLER.has(word.toLowerCase()));
  const names = words.filter((word) => NAME_SHAPE.test(word));
  return names.length > 0 ? names : words;
}

/** The latest day a date can mean: a month-only date (YYYY-MM) may run to the month's end. */
function latestDay(date: string): string {
  const month = MONTH_ONLY.exec(date);
  if (!month || Number(month[2]) < 1 || Number(month[2]) > 12) return date;
  return utcDay(new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)));
}

function idOf(provider: string, change: ProviderChange): string {
  const prefix = provider
    .replace(/[^a-z]/gi, '')
    .slice(0, 2)
    .toUpperCase()
    .padEnd(2, 'X');
  const name = change.id.replace(/^[^:]*:/, '').replace(/[^\w.-]+/g, '-');
  return `${prefix}-${PROPOSED_GROUP}.${name}`;
}

/** An id another entry has (a retry naming more, or a provider with the same two letters) gets a number. */
function freeId(id: string, taken: ReadonlySet<string>): string {
  let free = id;
  for (let count = 2; taken.has(free); count++) free = `${id}-${count}`;
  return free;
}

const appliesToOf = (versions: string | undefined, only: string | undefined) =>
  versions
    ? { describe: versions, ...(only && DATED_VERSION.test(only) ? { apiVersionSince: only } : {}) }
    : undefined;

type ProposeContext = {
  provider: string;
  file: ProviderFile | undefined;
  takenIds: ReadonlySet<string>;
  refused: DeadApiMatcher[];
  today: string;
};

/** What a read's change proposes: nothing for what the list already holds or a person refused. */
function proposeChange(change: ProviderChange, context: ProposeContext): Proposal | undefined {
  const { provider, file, takenIds, refused, today } = context;
  const quote = change.source.quote.trim();
  const base = {
    provider,
    changeId: change.id,
    status: 'pending' as const,
    reason: PENDING_REASON,
    proposedOn: today,
    quote,
    change,
  };
  if (!REMOVAL_KINDS.has(change.kind)) {
    const reason = `a ${change.kind} change can leave the old call working, so it isn't listed: read it at ${change.source.url}`;
    return { ...base, id: idOf(provider, change), status: 'noted', reason };
  }

  const all = matchersOf(change);
  const fresh = all.filter(
    (named) =>
      !refused.some((one) => holds(one, named)) &&
      !file?.entries.some((entry) => entry.matchers.some((one) => holds(one, named))) &&
      !file?.future.some(
        (shutdown) =>
          shutdown.matchers.some((one) => holds(one, named)) &&
          saysNothingNew(shutdown, change, today),
      ),
  );
  if (all.length > 0 && fresh.length === 0) return undefined;

  // A shutdown this change fully covers moves in place, keeping its id and what a person wrote on it.
  const key = (matcher: DeadApiMatcher) => matcherKey(provider, matcher);
  const freshKeys = new Set(fresh.map((named) => key(named.matcher)));
  const moved = file?.future.find((shutdown) =>
    shutdown.matchers.every((one) => freshKeys.has(key(one))),
  );
  const handWritten = new Map(
    (file?.future ?? []).flatMap((shutdown) => shutdown.matchers.map((one) => [key(one), one])),
  );
  // 15 of 20 read matchers failed a hand-check, so until a person writes one, a hit gets the small AI
  // check and never goes straight to a fix.
  const matchers = fresh.map(
    (named) =>
      handWritten.get(key(named.matcher)) ??
      (named.matcher.kind === 'package' ? named.matcher : { ...named.matcher, ambiguous: true }),
  );

  const named = replacementOf(change);
  const replacement = named ?? moved?.replacement ?? REPLACEMENT_NOT_NAMED;
  const replacementIds = named ? tokensOf(named).filter(isNamedId) : (moved?.replacementIds ?? []);
  const { versions: versionList, sdk } = change.affects;
  const versions = versionList?.join(', ');
  const appliesTo = appliesToOf(versions, versionList?.length === 1 ? versionList[0] : undefined);
  const scope = appliesTo ?? moved?.appliesTo;
  const where = sdk && change.kind !== 'product-shutdown' ? { packages: [sdk] } : moved?.context;
  const id = moved?.id ?? freeId(idOf(provider, change), takenIds);
  const common = {
    id,
    provider,
    what: moved ? `${moved.what} A later read: ${change.title}.` : change.title,
    matchers,
    ...(replacementIds.length ? { replacementIds } : {}),
    ...(scope ? { appliesTo: scope } : {}),
    ...(where ? { context: where } : {}),
    replacement,
    requires: moved?.requires?.length ? moved.requires : [REQUIRES_UNCHECKED],
  };
  // The quote has to travel with a shutdown, because entriesInForce turns this source into a live entry's on its day.
  const source = { url: change.source.url, checkedOn: today, ...(quote ? { quote } : {}) };
  const date = latestDay(change.effectiveDate ?? '');
  const earliest = EARLIEST_WORDING.test(`${change.title} ${quote}`);
  // A past date the provider only calls the earliest stays a shutdown, and the list's checks reject it.
  if (date > today || (date && earliest)) {
    const future: FutureShutdown = {
      ...common,
      diesOn: date,
      // A month-only date doesn't say which day, so it waits for a source read to turn on.
      ...(date !== change.effectiveDate || earliest ? { earliest: true } : {}),
      source,
    };
    return { ...base, id, future };
  }
  // No date stays empty and fails the list's checks: a date is never guessed.
  const entry: DeadApiEntry = {
    ...common,
    diedOn: date,
    source,
    lookFor: fresh.map((one) => one.label),
    ...(scope?.describe ? { versions: scope.describe } : {}),
  };
  return { ...base, id, entry };
}

const registrable = (host: string) => host.split('.').slice(-2).join('.');

const hostOf = (url: string) => (URL.canParse(url) ? [new URL(url).hostname] : []);

// shortcut: the last two labels, so co.uk vouches too widely and a docs URL on a shared host such as
// github.com vouches for all of it, use a public suffix list once a queued provider needs one.
function vouchedHosts(provider: string, hints: ProviderHints): Set<string> {
  const known = CATALOG.find((one) => one.provider === provider);
  const hosts = [
    ...(hints.hosts ?? []),
    ...(known?.hosts ?? []),
    ...[...(hints.docsUrls ?? []), ...(known?.docsUrls ?? [])].flatMap(hostOf),
  ];
  return new Set(hosts.map(registrable));
}

/** Why a new provider's source can't be trusted yet: nothing it doesn't itself name vouches for it. */
function unvouched(proposal: Proposal, url: string, files: ProviderFile[], hints: ProviderHints) {
  if (files.some((file) => file.provider === proposal.provider)) return undefined;
  const [host] = hostOf(url);
  if (!host || vouchedHosts(proposal.provider, hints).has(registrable(host))) return undefined;
  return `nothing vouches for ${host} as ${proposal.provider}'s own site: add a ${fileName(proposal.provider)} with its officialHosts by hand, or name its docs in the queue's hints`;
}

/** The list with this proposal in: its names leave any shutdown, and chains that ended on them move. */
function withProposal(
  files: ProviderFile[],
  draft: DeadApiEntry | FutureShutdown,
  isEntry: boolean,
) {
  const existing = files.find((file) => file.provider === draft.provider);
  const file: ProviderFile = existing ?? {
    provider: draft.provider,
    officialHosts: hostOf(draft.source.url).map(registrable),
    entries: [],
    future: [],
  };
  const keys = new Set(draft.matchers.map((one) => matcherKey(file.provider, one)));
  const going = new Set(
    draft.matchers
      .filter((one) => one.kind === 'string' || one.kind === 'url')
      .map((one) => one.value),
  );
  const chained: string[] = [];
  const repoint = <T extends DeadApiEntry | FutureShutdown>(one: T): T => {
    const gone = (one.replacementIds ?? []).filter((name) => going.has(name));
    if (gone.length === 0) return one;
    chained.push(one.id);
    const kept = (one.replacementIds ?? []).filter((name) => !going.has(name));
    return {
      ...one,
      replacement:
        `${one.replacement ?? ''} ${gone.join(', ')} has its own entry now (${draft.id}). Its replacement: ${draft.replacement}`.trim(),
      replacementIds: [...new Set([...kept, ...(draft.replacementIds ?? [])])],
    };
  };
  const remaining = file.future
    .map((shutdown) => ({
      ...shutdown,
      matchers: shutdown.matchers.filter((one) => !keys.has(matcherKey(file.provider, one))),
    }))
    .filter((shutdown) => shutdown.matchers.length > 0)
    .map(repoint);
  const updated: ProviderFile = {
    ...file,
    entries: [...file.entries.map(repoint), ...(isEntry ? [draft as DeadApiEntry] : [])],
    future: [...remaining, ...(isEntry ? [] : [draft as FutureShutdown])],
  };
  return { file: updated, files: [...files.filter((one) => one !== existing), updated], chained };
}

function nameIn(name: string, text: string): boolean {
  if (name.startsWith('/')) return urlMatches({ kind: 'url', value: name }, text);
  const matcher = { kind: 'string', value: name, caseSensitive: false } as const;
  return tokensOf(text).some((token) => tokenMatches(matcher, token));
}

function namedIn(matcher: DeadApiMatcher, text: string): boolean {
  if (matcher.kind === 'url' || matcher.kind === 'regex') {
    return matcher.kind === 'url' ? urlMatches(matcher, text) : textMatches(matcher, text);
  }
  // A field is read as owner.field, which is one token.
  return nameIn(matcher.value, matcher.kind === 'field' ? text.replace(/\./g, ' ') : text);
}

/** Every date a piece of text states, as YYYY-MM-DD or YYYY-MM. */
function statedDates(text: string): string[] {
  const written = [...text.matchAll(WRITTEN_DATE)].map((found) => {
    const [month, day, year] = found[1]
      ? [found[1], found[2], found[3]]
      : found[5]
        ? [found[5], found[4], found[6]]
        : [found[7], undefined, found[8]];
    const number = MONTH_PREFIXES.indexOf(month.slice(0, 3).toLowerCase()) + 1;
    const days = day ? `-${day.padStart(2, '0')}` : '';
    return `${year}-${String(number).padStart(2, '0')}${days}`;
  });
  return [...[...text.matchAll(ISO_DAY)].map((found) => found[1]), ...written];
}

/** Why the source doesn't back the date, which alone decides dead or future. */
function dateProblem(said: string, quote: string, page: FetchedPage): string | undefined {
  const agrees = (stated: string) => stated.startsWith(said) || said.startsWith(stated);
  const inQuote = statedDates(normaliseForQuote(quote));
  if (inQuote.length > 0) {
    return inQuote.some(agrees) ? undefined : `the quote says ${inQuote.join(', ')}, not ${said}`;
  }
  // A changelog's date is often its heading, so a quote with no date of its own needs it on the page.
  const onPage = page.text.includes(said) || statedDates(page.text).some(agrees);
  return onPage ? undefined : `${said} isn't on ${page.url}`;
}

/** Why a proposal can't go live on this page, or undefined when the page backs it. */
function pageProblem(
  draft: DeadApiEntry | FutureShutdown,
  change: ProviderChange,
  quote: string,
  page: FetchedPage,
): string | undefined {
  if (!containsQuote(page.text, quote)) return `the quote isn't on ${page.url}`;
  // Deprecated can go on working for years, and dated from the notice it would flag working code.
  if (DEPRECATED.test(quote) && !ENDS.test(quote)) {
    return `the quote says deprecated with no end: ${quote}`;
  }
  // A name the model made up, or a live one beside the dead one, would flag working code: the quote
  // has to name it. A package comes from the change's sdk, so the page is enough for that.
  const keys = new Set(draft.matchers.map((one) => matcherKey(draft.provider, one)));
  const claimed = matchersOf(change).filter((one) =>
    keys.has(matcherKey(draft.provider, one.matcher)),
  );
  const absent = claimed.filter(({ matcher }) =>
    matcher.kind === 'package' ? !nameIn(matcher.value, page.text) : !namedIn(matcher, quote),
  );
  if (absent.length > 0) {
    return `${absent.map((one) => one.label).join(', ')} isn't in the quote from ${page.url}`;
  }
  const named = replacementOf(change);
  const made = named ? replacementWords(named).filter((word) => !nameIn(word, page.text)) : [];
  if (made.length > 0) return `replacement ${made.join(', ')} isn't on ${page.url}`;
  return change.effectiveDate ? dateProblem(change.effectiveDate, quote, page) : undefined;
}

function formatOf(url: string): Parameters<Fetcher['fetch']>[1] {
  if (GITHUB_RELEASES.test(url)) return 'github-releases';
  return FEED_URL.test(url) ? 'rss' : undefined;
}

export type SettleOptions = {
  provider: string;
  changes: ProviderChange[];
  today: string;
  fetcher: Fetcher;
  storeDir?: string;
  dataDir?: string;
  dryRun?: boolean;
  hints?: ProviderHints; // what the read was led by: for a new provider, what vouches for its host
};

/**
 * Proposes, checks and stores a read's changes and any still pending from before, writing each that
 * passes to the list. A verdict is stored before the list changes: a crash between the two is repaired
 * by the next read, where the other order would leave a live entry with no record for good.
 */
export async function settleChanges({
  provider: providerName,
  changes,
  today,
  fetcher,
  storeDir = PROPOSED_DIR,
  dataDir = DATA_DIR,
  dryRun = false,
  hints = {},
}: SettleOptions): Promise<Proposal[]> {
  const provider = providerId(providerName);
  let files = readProviderFiles(dataDir);
  const pages = new Map<string, Promise<FetchedPage>>();
  const fetchPage = (url: string) => {
    const page = pages.get(url) ?? fetcher.fetch(url, formatOf(url));
    pages.set(url, page);
    return page;
  };
  const stored = await readJsonOr<Proposal[]>(storeFile(storeDir, provider), []);
  const refusedRecords = stored.filter((one) => one.status === 'refused');
  const refused = refusedRecords.flatMap((one) => (one.entry ?? one.future)?.matchers ?? []);
  const readNow = new Set(changes.map((change) => change.id));
  const waiting = stored.filter(
    (one) => one.status === 'pending' && one.change && !readNow.has(one.change.id),
  );

  const settled: Proposal[] = [];
  const decide = async (verdict: Proposal) => {
    settled.push(verdict);
    await recordVerdict(storeDir, provider, verdict);
  };
  const settleOne = async (change: ProviderChange, waited?: Proposal) => {
    const takenIds = new Set([
      ...files.flatMap((file) => [...file.entries, ...file.future].map((one) => one.id)),
      ...refusedRecords.map((one) => one.id),
    ]);
    const file = files.find((one) => one.provider === provider);
    const proposal = proposeChange(change, { provider, file, takenIds, refused, today });
    if (!proposal) {
      if (waited) await forgetProposal(storeDir, provider, waited.id); // the list holds it now
      return;
    }
    const draft = proposal.entry ?? proposal.future;
    if (!draft) return decide(proposal);
    const rejected = (reason: string) => decide({ ...proposal, status: 'rejected', reason });
    if (!proposal.quote) return rejected('no source quote');
    const waitingOn = unvouched(proposal, draft.source.url, files, hints);
    if (waitingOn) return decide({ ...proposal, reason: waitingOn });
    const next = withProposal(files, draft, Boolean(proposal.entry));
    // The list's checks come first: they hold the official-host check, so no other host is fetched.
    const problems = listProblems(next.files);
    if (problems.length > 0) return rejected(problems.join('; '));
    const page = await fetchPage(draft.source.url);
    if (!page.ok) {
      const reason = `couldn't read ${page.url}: ${page.error ?? page.status}; checked again next settle`;
      return decide({ ...proposal, reason });
    }
    const problem = pageProblem(draft, change, proposal.quote, page);
    if (problem) return rejected(problem);
    if (dryRun) return decide({ ...proposal, reason: PASSED_DRY_RUN });
    const moved = next.chained.length
      ? `; moved ${next.chained.join(', ')} on along the chain`
      : '';
    await decide({ ...proposal, status: 'live', reason: `backed by ${page.url}${moved}` });
    await writeJson(path.join(dataDir, fileName(provider)), next.file);
    files = next.files;
  };

  for (const change of changes) await settleOne(change);
  for (const one of waiting) if (one.change) await settleOne(one.change, one);
  return settled;
}

const storeFile = (storeDir: string, provider: string) => path.join(storeDir, fileName(provider));

// A new verdict replaces the old one for the same proposal, so a pending one settles on the next read.
// Only another live one replaces a live one, and only a person's refusal lasts against a later read.
async function recordVerdict(storeDir: string, provider: string, verdict: Proposal) {
  const file = storeFile(storeDir, provider);
  const stored = await readJsonOr<Proposal[]>(file, []);
  const prior = stored.find((one) => one.id === verdict.id);
  if (verdict.status !== 'refused') {
    if (prior?.status === 'refused') return;
    if (prior?.status === 'live' && verdict.status !== 'live') return;
  }
  await writeJson(file, [...stored.filter((one) => one.id !== verdict.id), verdict]);
}

async function forgetProposal(storeDir: string, provider: string, id: string) {
  const file = storeFile(storeDir, provider);
  const stored = await readJsonOr<Proposal[]>(file, []);
  await writeJson(
    file,
    stored.filter((one) => one.id !== id),
  );
}

export type RefuseOptions = {
  id: string;
  reason: string;
  storeDir?: string;
  dataDir?: string;
  today?: string;
};

/** A person's verdict that an entry is wrong: it leaves the list, and no later read puts it back. */
export async function refuseEntry({
  id,
  reason,
  storeDir = PROPOSED_DIR,
  dataDir = DATA_DIR,
  today = utcDay(new Date()),
}: RefuseOptions): Promise<Proposal> {
  const files = readProviderFiles(dataDir);
  const file = files.find((one) => [...one.entries, ...one.future].some((held) => held.id === id));
  const record = (await readProposals(storeDir)).find((one) => one.id === id);
  const entry = file?.entries.find((one) => one.id === id) ?? record?.entry;
  const future = file?.future.find((one) => one.id === id) ?? record?.future;
  const provider = file?.provider ?? record?.provider;
  if (!provider || (!entry && !future)) throw new UnknownEntryError(id);
  const refused: Proposal = {
    id,
    provider,
    changeId: record?.changeId ?? id,
    status: 'refused',
    reason,
    proposedOn: record?.proposedOn ?? today,
    quote: record?.quote ?? entry?.source.quote ?? '',
    ...(entry ? { entry } : { future: future as FutureShutdown }),
  };
  await recordVerdict(storeDir, provider, refused);
  if (file) {
    await writeJson(path.join(dataDir, fileName(provider)), {
      ...file,
      entries: file.entries.filter((one) => one.id !== id),
      future: file.future.filter((one) => one.id !== id),
    });
  }
  return refused;
}

/** Every stored proposal in a store folder, by provider then in the order they were made. */
export async function readProposals(storeDir = PROPOSED_DIR): Promise<Proposal[]> {
  const names = await readdir(storeDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const files = names.filter((name) => name.endsWith('.json')).sort();
  const stored = await Promise.all(
    files.map((name) => readJsonOr<Proposal[]>(path.join(storeDir, name), [])),
  );
  return stored.flat();
}

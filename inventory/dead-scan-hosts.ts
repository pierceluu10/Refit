// The hosts a repo's code calls. A provider nobody listed can't match an entry, and a raw HTTP call to
// it leaves no dependency to name it by, so this is what sends such a provider to the queue.
import type { DeadApiEntry } from '../shared/types.ts';
import { CATALOG, catalogEntry, hostProvider } from './catalog.ts';
import { spanAt, type Source } from './dead-scan-lex.ts';

// The scheme, any part of the host a template fills in, then the host: https://${region}.api.x.com.
const URL_AT_START =
  /\b(?:https?|wss?):\/\/(?:\$?\{[^}]*\}\.?)*((?:[a-z0-9-]+\.)+[a-z]{2,})([^\s'"`]*)/gi;
const LOOK_BACK_CHARS = 60;
const STRING_PREFIX = '[a-zA-Z]{0,2}';
const HTTP_CALL = new RegExp(
  `(?:\\b(?:fetch|got|axios|ky|superagent|needle|urlopen|urlretrieve|WebSocket|\\w*url)|\\.(?:get|post|put|patch|delete|head|request|ajax|fetch|urlopen))(?:<[^>]*>)?\\s*\\(\\s*${STRING_PREFIX}$`,
  'i',
);
const ADDRESS_HOLDER = new RegExp(
  `([\\w$.]*(?:url|uri|endpoint|host|base|server)[\\w$]*)["'\\]]?\\s*[:=]\\s*${STRING_PREFIX}$`,
  'i',
);
// What a link or a picture is held under, as opposed to what a client talks to.
const PAGE_HOLDER =
  /image|img|logo|avatar|icon|photo|thumb|canonical|site|home|link|website|blog|docs?|repo|github|twitter|redirect|callback|webhook|manifest|asset|cdn|script/i;
const MARKUP_ATTRIBUTE = /\b(?:href|src|action|xmlns)\s*=\s*\{?\s*$/i;
const API_HOST = /(?:^|\.)api\./;
const API_PATH = /^\/(?:api|v\d+(?:\.\d+)*|\d+\.\d+|graphql|rest)(?:[/?.]|$)/i;
const STATIC_PATH = /\.(?:png|jpe?g|svg|gif|webp|ico|css|js|woff2?|mp[34]|pdf|html?)(?:[?#]|$)/i;
// Places nobody's API lives: examples, schemas, and hosting where the host is the app's own deploy.
const NOT_A_PROVIDER =
  /(?:^|\.)(?:localhost|example\.(?:com|org|net)|w3\.org|json-schema\.org|schema\.org|vercel\.app|herokuapp\.com|onrender\.com|netlify\.app|railway\.app|fly\.dev|ngrok\.io|ngrok-free\.app|amazonaws\.com|cloudfunctions\.net|run\.app|github\.io|pages\.dev|workers\.dev)$|^schemas\./i;
const S3_HOST = /(?:^|\.)s3[\w.-]*\.amazonaws\.com$/i;
const S3_DOMAIN_BUCKET = /^\/((?:[a-z0-9-]+\.)+[a-z]{2,})\//i;
// An environment key a provider's own name opens, read by code that takes its address from there.
const PROVIDER_ENV_KEY =
  /\b([A-Z][A-Z0-9]*)_(?:URL|API_?URL|BASE_?URL|API_?KEY|CLIENT_(?:ID|SECRET)|ANON_KEY|SERVICE_ROLE_KEY|TOKEN|SECRET(?:_KEY)?)\b/g;
// The OpenAI SDK's own client for Azure, which leaves no package or host of Azure's to go by.
const AZURE_OPENAI = /\bAzureOpenAI\b|\bAZURE_OPENAI_[A-Z]+\b/;
const AZURE_OPENAI_PROVIDER = 'azure-openai';
// HTML attributes aren't strings to the lexer, so a tag's host is read from the text.
const SCRIPT_TAG_HOST = /<script\b[^>]*\bsrc=["'](?:https?:)?\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
const WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\//;
const USES_ACTION = /\buses:\s*["']?([\w.-]+\/[\w.-]+)/g;
// A sign-in provider leaves no host in the repo: Auth.js holds it. Its local kinds call nobody.
const AUTH_PROVIDER_IMPORT = /["'](?:next-auth|@auth\/core)\/providers\/([\w-]+)["']/g;
const LOCAL_AUTH = /^(?:credentials|passkey|email|nodemailer)$/;
const TWO_PART_SUFFIX = /\.(?:ac|co|com|edu|gov|net|org)\.[a-z]{2}$/;

const domainOf = (host: string) =>
  host
    .split('.')
    .slice(TWO_PART_SUFFIX.test(host) ? -3 : -2)
    .join('.');

const looksCalled = (ahead: string, host: string, rest: string) => {
  // A catalog host in a tag is the provider's SDK loading: <script src="https://accounts.google.com/gsi/client">.
  if (MARKUP_ATTRIBUTE.test(ahead)) return hostProvider(host) !== undefined;
  if (STATIC_PATH.test(rest)) return false;
  if (HTTP_CALL.test(ahead)) return true;
  const holder = ADDRESS_HOLDER.exec(ahead)?.[1];
  if (holder && !PAGE_HOLDER.test(holder)) return true;
  return API_HOST.test(host) || API_PATH.test(rest);
};

// Copied-in code, which calls its own hosts and isn't the repo's to fix. A walk skips the rest.
const VENDORED_PATH = /(?:^|\/)third_party\//;

/** The hosts `source` reaches: a URL that opens a string and that a call or an address holder takes. */
function hostsCalledIn(source: Source): string[] {
  const hosts: string[] = [];
  if (VENDORED_PATH.test(source.file)) return hosts;
  for (const [, host] of source.text.matchAll(SCRIPT_TAG_HOST)) {
    if (hostProvider(host)) hosts.push(host.toLowerCase());
  }
  for (const match of source.text.matchAll(URL_AT_START)) {
    const span = spanAt(source.spans, match.index);
    // A URL partway through a string is prose, such as an error message or a prompt.
    if (span?.kind !== 'string' || source.text.slice(span.innerStart, match.index).trim()) continue;
    const ahead = source.text.slice(Math.max(0, span.start - LOOK_BACK_CHARS), span.start);
    // S3's path style puts the owner's domain first: s3.amazonaws.com/download.acme.gov/data.zip.
    const bucket = S3_HOST.test(match[1]) ? S3_DOMAIN_BUCKET.exec(match[2])?.[1] : undefined;
    const host = (bucket ?? match[1]).toLowerCase();
    if (!NOT_A_PROVIDER.test(host) && looksCalled(ahead, host, match[2])) hosts.push(host);
  }
  return hosts;
}

const hostIsWithin = (host: string, known: string) => host === known || host.endsWith(`.${known}`);

export type ListedHosts = { provider: string; officialHosts: string[]; entries: DeadApiEntry[] };

/**
 * The providers the code calls that the list doesn't cover, by the catalog's name or else the host's
 * domain, each with the hosts seen. A listed provider's own hosts and its own domain don't count.
 */
export function calledProviders(
  sources: Source[],
  listed: ListedHosts[],
  listedIds: ReadonlySet<string>,
): Map<string, string[]> {
  const contextHosts = listed.flatMap((file) =>
    file.entries.flatMap((entry) => entry.context?.hosts ?? []),
  );
  const ownDomains = listed.flatMap((file) =>
    file.officialHosts
      .map((official) => domainOf(official.split('/')[0]))
      .filter((domain) => domain.includes(file.provider)),
  );
  const isListed = (host: string) =>
    contextHosts.some((known) => hostIsWithin(host, known)) || ownDomains.includes(domainOf(host));
  const found = new Map<string, string[]>();
  for (const host of new Set(sources.flatMap(hostsCalledIn))) {
    const known = hostProvider(host)?.provider;
    if (known ? listedIds.has(known) : isListed(host)) continue;
    const provider = known ?? domainOf(host);
    found.set(provider, [...(found.get(provider) ?? []), host]);
  }
  return found;
}

/** Catalog providers named with no host to see: an environment key in code, or a workflow's action. */
export function namedProviders(sources: Source[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    if (WORKFLOW_PATH.test(source.file)) {
      for (const [, action] of source.code.matchAll(USES_ACTION)) {
        const entry = CATALOG.find((one) => one.ciActions?.includes(action));
        if (entry) names.add(entry.provider);
      }
    } else if (!['hash', 'json', 'prose'].includes(source.mode)) {
      for (const [, word] of source.text.matchAll(PROVIDER_ENV_KEY)) {
        if (catalogEntry(word.toLowerCase())) names.add(word.toLowerCase());
      }
      if (AZURE_OPENAI.test(source.text)) names.add(AZURE_OPENAI_PROVIDER);
      for (const [, word] of source.text.matchAll(AUTH_PROVIDER_IMPORT)) {
        if (!LOCAL_AUTH.test(word)) names.add(catalogEntry(word) ? word : `${word}-oauth`);
      }
    }
  }
  return [...names];
}

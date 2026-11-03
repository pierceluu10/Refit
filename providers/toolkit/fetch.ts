// Network access for tools. Every tool takes an injectable fetch so unit tests never hit the network.
// The agent (and the repo it reads) picks many of the URLs these tools open, and tools run on the
// host, so only public http(s) hosts are fetched and every redirect hop is checked again.

import { lookup } from 'node:dns/promises';

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'manual' | 'follow';
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export type NetworkOptions = {
  /** Injected fetch. Defaults to the global fetch. Pass `null` to run offline. */
  fetch?: FetchLike | null;
  timeoutMs?: number;
};

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };

/** One fetched page: the final URL after redirects, the status, the content type and the raw text. */
export type PageResult =
  | { ok: true; url: string; status: number; contentType: string; text: string }
  | { ok: false; url: string; status: number; contentType?: string; text?: string; error: string };

export type PageRequest = NetworkOptions & {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

const USER_AGENT = 'aptitude-toolpack/0.1';
const MAX_REDIRECTS = 5;

const cache = new Map<string, PageResult>();

export function resolveFetch(options?: NetworkOptions): FetchLike | null {
  if (options && options.fetch !== undefined) return options.fetch;
  if (process.env.APTITUDE_OFFLINE === '1') return null;
  return typeof globalThis.fetch === 'function'
    ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
    : null;
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return /^(f[cd]|fe[89ab]|ff)/.test(lower) || lower.startsWith('::ffff:');
}

/** Why a URL may not be fetched, or undefined when it is a public http(s) URL. */
export function urlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `only http and https URLs are fetched (got ${parsed.protocol})`;
  }
  if (parsed.username || parsed.password) return 'URLs with credentials in them are not fetched';
  const host = parsed.hostname.toLowerCase();
  const local =
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host.startsWith('[') ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host));
  return local ? `only public hosts are fetched (${host} is local or private)` : undefined;
}

export function isPublicUrl(url: string): boolean {
  return urlProblem(url) === undefined;
}

// A public name can still point at a private address, so the live fetch resolves it first.
async function addressProblem(host: string): Promise<string | undefined> {
  try {
    const addresses = await lookup(host, { all: true });
    const bad = addresses.find(({ address, family }) =>
      family === 6 ? isPrivateIpv6(address) : isPrivateIpv4(address),
    );
    return bad ? `only public hosts are fetched (${host} resolves to ${bad.address})` : undefined;
  } catch (error) {
    return `could not resolve ${host} (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Fetch one page. Redirects are followed by hand so each hop is checked as a public URL.
 * Successful responses are cached for the process, keyed by method, URL, headers and body.
 */
export async function fetchPage(url: string, options: PageRequest = {}): Promise<PageResult> {
  const fetcher = resolveFetch(options);
  if (!fetcher) return { ok: false, url, status: 0, error: 'offline (no fetch available)' };
  const method = options.method ?? 'GET';
  const key = `${method} ${url} ${JSON.stringify(options.headers ?? {})} ${options.body ?? ''}`;
  const cached = cache.get(key);
  if (cached?.ok) return cached;
  // An injected fetch (tests, recorded responses) never reaches DNS, so only the live one resolves.
  const live = options.fetch === undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let target = url;
  let currentMethod = method;
  let body = options.body;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem =
        urlProblem(target) ?? (live ? await addressProblem(new URL(target).hostname) : undefined);
      if (problem) return { ok: false, url: target, status: 0, error: problem };
      const response = await fetcher(target, {
        method: currentMethod,
        headers: { 'user-agent': USER_AGENT, ...options.headers },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const location = response.headers?.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = new URL(location, target).toString();
        if (response.status === 303) {
          currentMethod = 'GET';
          body = undefined;
        }
        continue;
      }
      const text = await response.text();
      const contentType = response.headers?.get('content-type') ?? '';
      const result: PageResult = response.ok
        ? { ok: true, url: target, status: response.status, contentType, text }
        : {
            ok: false,
            url: target,
            status: response.status,
            contentType,
            text,
            error: `HTTP ${response.status}`,
          };
      if (result.ok) cache.set(key, result);
      return result;
    }
    return { ok: false, url: target, status: 0, error: 'too many redirects' };
  } catch (error) {
    return {
      ok: false,
      url: target,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(
  url: string,
  options?: NetworkOptions & { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResult> {
  const page = await fetchPage(url, options);
  return page.ok ? { ok: true, text: page.text } : { ok: false, error: page.error };
}

export function clearFetchCache(): void {
  cache.clear();
}

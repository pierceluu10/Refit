// Network access for tools. Every tool takes an injectable fetch so unit tests never hit the network.

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type NetworkOptions = {
  /** Injected fetch. Defaults to the global fetch. Pass `null` to run offline. */
  fetch?: FetchLike | null;
  timeoutMs?: number;
};

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };

const cache = new Map<string, FetchResult>();

export function resolveFetch(options?: NetworkOptions): FetchLike | null {
  if (options && options.fetch !== undefined) return options.fetch;
  if (process.env.APTITUDE_OFFLINE === '1') return null;
  return typeof globalThis.fetch === 'function'
    ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
    : null;
}

export async function fetchText(
  url: string,
  options?: NetworkOptions & { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResult> {
  const fetcher = resolveFetch(options);
  if (!fetcher) return { ok: false, error: 'offline (no fetch available)' };
  const key = `${options?.method ?? 'GET'} ${url} ${options?.body ?? ''}`;
  const cached = cache.get(key);
  if (cached && cached.ok) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15_000);
  try {
    const response = await fetcher(url, {
      method: options?.method,
      headers: { 'user-agent': 'aptitude-toolpack/0.1', ...options?.headers },
      body: options?.body,
      signal: controller.signal,
    });
    const text = await response.text();
    const result: FetchResult = response.ok
      ? { ok: true, text }
      : { ok: false, error: `HTTP ${response.status}` };
    cache.set(key, result);
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function clearFetchCache(): void {
  cache.clear();
}

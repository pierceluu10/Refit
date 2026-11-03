// Test helpers: replay the real responses recorded in fixtures/recorded, by method and URL.
// fixtures/recorded/manifest.json says where each one came from, when, and how it was trimmed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './fetch.ts';

export const RECORDED_DIR = fileURLToPath(new URL('./fixtures/recorded/', import.meta.url));

type RecordedEntry = {
  file: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
};

export type FakeResponse = {
  status: number;
  body: string;
  contentType?: string;
  location?: string;
};

export function recorded(file: string): string {
  return readFileSync(join(RECORDED_DIR, file), 'utf8');
}

/**
 * A fetch that serves recorded responses. `extra` adds or replaces responses, keyed by URL or by
 * "METHOD URL". Anything else answers 404, so a test sees exactly which URLs a tool asked for.
 */
export function recordedFetch(
  extra: Record<string, FakeResponse> = {},
): FetchLike & { calls: string[] } {
  const manifest = JSON.parse(recorded('manifest.json')) as { entries: RecordedEntry[] };
  const calls: string[] = [];
  const fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const override = extra[`${method} ${url}`] ?? extra[url];
    const entry = manifest.entries.find((e) => e.url === url && e.method === method);
    const status = override?.status ?? entry?.status ?? 404;
    const body = override ? override.body : entry ? recorded(entry.file) : 'not recorded';
    const headers = new Map<string, string>([
      ['content-type', override?.contentType ?? entry?.contentType ?? 'text/plain'],
    ]);
    if (override?.location) headers.set('location', override.location);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    };
  }) as FetchLike & { calls: string[] };
  fetch.calls = calls;
  return fetch;
}

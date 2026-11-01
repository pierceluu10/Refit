// Checks the shape of the hints the agent records for watchers: bare hostnames, absolute http(s)
// URLs, package names without spaces. It never judges whether a hint is relevant: that is the
// agent's call. Rejections carry a reason the agent can act on.
import type { ProviderHints } from '../shared/types.ts';

export type HintKind = keyof ProviderHints;
export type RejectedHint = { kind: HintKind; value: string; reason: string };

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// npm, pip, gem, Go module and Maven names; only whitespace, quotes and brackets are never valid.
const PACKAGE_NAME = /^[^\s'"`<>]{1,214}$/;
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function checkHost(value: string): string | { reason: string } {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (HOSTNAME.test(host)) return host;
  const asUrl = URL.canParse(host) ? new URL(host).hostname : undefined;
  const suggestion = asUrl && HOSTNAME.test(asUrl) ? ` Did you mean "${asUrl}"?` : '';
  return {
    reason: `not a bare hostname such as "api.stripe.com": no scheme, port, path, wildcard or template.${suggestion}`,
  };
}

function checkUrl(value: string): string | { reason: string } {
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : undefined;
  if (!url || !WEB_PROTOCOLS.has(url.protocol) || !HOSTNAME.test(url.hostname)) {
    return { reason: 'not an absolute http(s) URL such as "https://docs.stripe.com/changelog"' };
  }
  if (url.username || url.password) return { reason: 'URLs must not carry credentials' };
  url.hash = '';
  return url.href;
}

function checkPackage(value: string): string | { reason: string } {
  const name = value.trim();
  if (PACKAGE_NAME.test(name)) return name;
  return {
    reason:
      'not a package name as it appears in the manifest, such as "stripe", "@stripe/stripe-js" or "github.com/stripe/stripe-go/v76"',
  };
}

const CHECKS: Record<HintKind, (value: string) => string | { reason: string }> = {
  packages: checkPackage,
  hosts: checkHost,
  docsUrls: checkUrl,
};

// Returns the well-formed hints normalised and de-duplicated, and the rest with a reason.
export function checkHints(hints: ProviderHints): {
  accepted: ProviderHints;
  rejected: RejectedHint[];
} {
  const accepted: ProviderHints = {};
  const rejected: RejectedHint[] = [];
  for (const kind of Object.keys(CHECKS) as HintKind[]) {
    for (const value of hints[kind] ?? []) {
      const checked = CHECKS[kind](value);
      if (typeof checked === 'string') accepted[kind] = [...(accepted[kind] ?? []), checked];
      else rejected.push({ kind, value, reason: checked.reason });
    }
  }
  return { accepted: mergeHints(undefined, accepted) ?? {}, rejected };
}

export function mergeHints(
  existing: ProviderHints | undefined,
  added: ProviderHints,
): ProviderHints | undefined {
  const merged: ProviderHints = {};
  for (const kind of Object.keys(CHECKS) as HintKind[]) {
    const values = [...new Set([...(existing?.[kind] ?? []), ...(added[kind] ?? [])])];
    if (values.length > 0) merged[kind] = values;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

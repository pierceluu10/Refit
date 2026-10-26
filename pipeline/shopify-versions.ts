import { constantValue, membersSince, releaseDefines, SHOPIFY_PACK } from './rule-pack.ts';

// Shopify Admin API versions are quarterly `YYYY-MM` strings; @shopify/shopify-api exposes them as
// `ApiVersion.<Month><YY>` enum members.
const MONTHS: Record<string, string> = {
  January: '01',
  April: '04',
  July: '07',
  October: '10',
};
const VERSION = /^(\d{4})-(01|04|07|10)$/;
const ENUM_MEMBER = /^(January|April|July|October)(\d{2})$/;

export const SHOPIFY_API = '@shopify/shopify-api';
// First @shopify/shopify-api release whose ApiVersion enum has each member (data/packs/shopify.json).
// Older members are omitted: 13.0.0 removed them, and none is a supported Admin API version.
export const SHOPIFY_API_ENUM_SINCE = membersSince(SHOPIFY_PACK, SHOPIFY_API, 'ApiVersion');

export function isShopifyVersion(value: string) {
  return VERSION.test(value);
}

export function versionFromEnum(member: string) {
  const match = ENUM_MEMBER.exec(member);
  return match ? `20${match[2]}-${MONTHS[match[1]]}` : undefined;
}

export function enumFromVersion(version: string) {
  const match = VERSION.exec(version);
  if (!match) return undefined;
  const month = Object.entries(MONTHS).find(([, number]) => number === match[2])![0];
  return `${month}${match[1].slice(2)}`;
}

// Whether an installed @shopify/shopify-api release defines `ApiVersion.<member>`. Unknown members
// and unparseable releases answer false, so a version bump stops for review instead of guessing.
export function sdkHasEnumMember(release: string, member: string) {
  return releaseDefines(SHOPIFY_API_ENUM_SINCE, release, member);
}

// The Admin API version LATEST_API_VERSION names in an @shopify/shopify-api release; 12.0.0
// removed the constant.
export function latestApiVersion(release: string) {
  const member = constantValue(SHOPIFY_PACK, SHOPIFY_API, 'LATEST_API_VERSION', release);
  return member && versionFromEnum(member);
}

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

// First @shopify/shopify-api release whose ApiVersion enum has each member, read from the published
// package types (dist/ts/lib/types.d.ts) on 2026-10-16. Older members are omitted: 13.0.0 removed
// them, and none is a supported Admin API version.
export const SHOPIFY_API_ENUM_SINCE: Record<string, string> = {
  October24: '11.5.0',
  January25: '11.7.0',
  April25: '11.11.0',
  July25: '11.12.0',
  October25: '11.14.0',
  January26: '12.1.0',
  April26: '12.3.0',
  July26: '13.1.0',
  October26: '14.0.0',
};

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

function compareReleases(left: string, right: string) {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// Whether an installed @shopify/shopify-api release defines `ApiVersion.<member>`. Unknown members
// and unparseable releases answer false, so a version bump stops for review instead of guessing.
export function sdkHasEnumMember(release: string, member: string) {
  const since = SHOPIFY_API_ENUM_SINCE[member];
  if (!since || !/^\d+\.\d+\.\d+/.test(release)) return false;
  return compareReleases(release, since) >= 0;
}

import type { DeadlineEntry } from './deadline-registry.ts';

// Source patterns for the data and productivity providers' deadlines (docs/DATA-APIS.md). Each
// returns the registry version a line names, per provider, with no code executed.

// Files that can use a provider's SDK, so a generic token such as `apiKey` counts only there.
export interface DataApiContext {
  zoom: boolean;
  airtable: boolean;
}

export function dataApiContext(content: string): DataApiContext {
  return {
    zoom: /@zoom\/meetingsdk|@zoomus\/websdk|\bZoomMtg\b/.test(content),
    airtable: /(?:from\s+|require\(\s*)['"]airtable['"]/.test(content),
  };
}

type Match = { provider: DeadlineEntry['provider']; version: string; column: number };

export function dataApiMatches(line: string, context: DataApiContext) {
  const found: Match[] = [];
  const add = (provider: Match['provider'], version: string, match: RegExpExecArray) =>
    found.push({ provider, version, column: match.indices![0]![0] });
  // Mailchimp retired the Export API 1.0 and API 2.0 on 2023-06-01:
  // `https://us1.api.mailchimp.com/export/1.0/…` and `https://us1.api.mailchimp.com/2.0/…`.
  for (const match of line.matchAll(/api\.mailchimp\.com\/(?:export\/[12]\.0|2\.0)(?![\w.])/dg))
    add('mailchimp', 'export-api', match);
  // HubSpot ends support for numbered v4 paths: `https://api.hubapi.com/crm/v4/objects/…`.
  for (const match of line.matchAll(
    /api\.(?:hubapi|hubspot)\.com\/[^\s'"`?#]*?\/v4(?=[/'"`?#]|$)/dg,
  ))
    add('hubspot', 'api-v4', match);
  // Zoom enforces the Client ID and Secret for Meeting SDK signatures; the `sdkKey: …` property of
  // a join call or a signature payload is the legacy key. A bare `sdkKey` variable or type is not
  // matched: it may only carry the value to that property.
  if (context.zoom)
    for (const match of line.matchAll(/\bsdkKey\s*:(?!\s*(?:string|number)\b)/dg))
      add('zoom', 'meeting-sdk-key', match);
  // Airtable user API keys stopped working on 2024-02-01. `new Airtable({ apiKey })` takes personal
  // access tokens too, so only a key written in the file is matched: a literal `key` plus 14
  // letters or digits.
  if (context.airtable)
    for (const match of line.matchAll(/(['"`])key[A-Za-z0-9]{14}\1/dg))
      add('airtable', 'api-key', match);
  return found;
}

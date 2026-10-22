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
  // Mailchimp retired the Export API on 2023-06-01: `https://us1.api.mailchimp.com/export/1.0/…`.
  for (const match of line.matchAll(/api\.mailchimp\.com\/export\/[12]\.0(?![\w.])/dg))
    add('mailchimp', 'export-api', match);
  // HubSpot ends support for numbered v4 paths: `https://api.hubapi.com/crm/v4/objects/…`.
  for (const match of line.matchAll(
    /api\.(?:hubapi|hubspot)\.com\/[^\s'"`?#]*?\/v4(?=[/'"`?#]|$)/dg,
  ))
    add('hubspot', 'api-v4', match);
  // Zoom enforces the Client ID and Secret for Meeting SDK signatures; the web SDK's `sdkKey`
  // argument is the legacy key.
  if (context.zoom)
    for (const match of line.matchAll(/\bsdkKey\b/dg)) add('zoom', 'meeting-sdk-key', match);
  // Airtable user API keys stopped working on 2024-02-01: `new Airtable({ apiKey })`.
  if (context.airtable)
    for (const match of line.matchAll(/\bapiKey\s*[:=]/dg)) add('airtable', 'api-key', match);
  return found;
}

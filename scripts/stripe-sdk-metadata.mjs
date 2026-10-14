// Regenerates pipeline/stripe-sdk-metadata.json from Stripe's SDK spec (stripe/openapi spec3.sdk.json).
// Usage: node scripts/stripe-sdk-metadata.mjs <spec3.sdk.json> <stripe/openapi release tag>
import { readFileSync, writeFileSync } from 'node:fs';

const [path, release] = process.argv.slice(2);
if (!path || !release)
  throw new Error('Usage: node scripts/stripe-sdk-metadata.mjs <spec3.sdk.json> <release>');
const spec = JSON.parse(readFileSync(path, 'utf8'));
const classes = {};
const events = {};
for (const [schema, definition] of Object.entries(spec.components.schemas)) {
  const resource = definition['x-stripeResource'];
  if (resource?.class_name) {
    const name = [resource.in_package, resource.class_name].filter(Boolean).join('.');
    classes[name] ??= schema;
  }
  const event = definition['x-stripeEvent'];
  const reference = definition.properties?.object?.$ref;
  if (event?.type && typeof reference === 'string')
    events[event.type] = reference.slice('#/components/schemas/'.length);
}
const sorted = (value) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  new URL('../pipeline/stripe-sdk-metadata.json', import.meta.url),
  `${JSON.stringify({ source: `stripe/openapi ${release} openapi/spec3.sdk.json (${spec.info.version})`, generated: new Date().toISOString().slice(0, 10), classes: sorted(classes), events: sorted(events) }, null, 2)}\n`,
);
console.log(Object.keys(classes).length, 'classes,', Object.keys(events).length, 'events');

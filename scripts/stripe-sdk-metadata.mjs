// Regenerates pipeline/stripe-sdk-metadata.json from Stripe's SDK spec (stripe/openapi spec3.sdk.json).
// Usage: node scripts/stripe-sdk-metadata.mjs <spec3.sdk.json> <stripe/openapi release tag> [<older spec3.sdk.json> ...]
// Classes and events come from the first (newest) spec. Operations are every stripe-node service
// method any given spec declares, so applications pinned to an older API version keep their methods.
// SOURCE_DATE_EPOCH (seconds) fixes `generated`, so a rerun on the same specs is byte-identical.
import { readFileSync, writeFileSync } from 'node:fs';

const [path, release, ...older] = process.argv.slice(2);
if (!path || !release)
  throw new Error(
    'Usage: node scripts/stripe-sdk-metadata.mjs <spec3.sdk.json> <release> [<older spec3.sdk.json> ...]',
  );
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
const operations = new Map();
const versions = [];
for (const source of [spec, ...older.map((file) => JSON.parse(readFileSync(file, 'utf8')))]) {
  versions.push(source.info.version);
  for (const [schema, definition] of Object.entries(source.components.schemas))
    for (const entry of definition['x-stripeOperations'] ?? []) {
      if (entry.method_on !== 'service') continue;
      const operation = {
        schema,
        method: entry.method_name,
        operation: entry.operation,
        path: entry.path,
      };
      operations.set(JSON.stringify(operation), operation);
    }
}
const sorted = (value) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const key = (operation) =>
  `${operation.path} ${operation.operation} ${operation.schema} ${operation.method}`;
writeFileSync(
  new URL('../pipeline/stripe-sdk-metadata.json', import.meta.url),
  `${JSON.stringify(
    {
      source: `stripe/openapi ${release} openapi/spec3.sdk.json (${spec.info.version})`,
      generated: (process.env.SOURCE_DATE_EPOCH
        ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
        : new Date()
      )
        .toISOString()
        .slice(0, 10),
      operationVersions: [...new Set(versions)].sort(),
      classes: sorted(classes),
      events: sorted(events),
      operations: [...operations.values()].sort((a, b) => key(a).localeCompare(key(b))),
    },
    null,
    2,
  )}\n`,
);
console.log(
  Object.keys(classes).length,
  'classes,',
  Object.keys(events).length,
  'events,',
  operations.size,
  'operations from',
  versions.length,
  'specs',
);

import ts from 'typescript-compiler';
import { STRIPE_PACK } from './rule-pack.ts';
import {
  newSigningSecret,
  routeHandler,
  type SignedEvent,
  type SignedEventAdapter,
  type SignedEventSite,
} from './signed-events.ts';
import { EVENT_SCHEMAS } from './stripe-webhook-payloads.ts';
import type { Finding, Repository } from './types.ts';

// Stripe's adapter for signed webhook checks (signed-events.ts).
//
// Signature: Stripe-Signature is `t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<payload>"
// keyed with the endpoint secret>` (https://docs.stripe.com/webhooks#verify-manually, read
// 2026-10-28); stripe-node's constructEvent accepts it within 300 seconds of the timestamp.
//
// Payloads: each event's object is the fixture stripe/openapi publishes for that API version
// (fixtures3.json, the file stripe-mock serves). The new-version object carries the old one's values
// wherever both versions have the field, and the rule pack's field moves (data/packs/stripe.json)
// carry a moved value to its new location, so the two events differ only in shape.

const CONSTRUCT = /\.webhooks\s*\.\s*constructEvent(?:Async)?\s*\(/;
const MAX_EVENT_TYPES = 8;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
    ? unwrap(expression.expression)
    : ts.isBinaryExpression(expression) &&
        [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
          expression.operatorToken.kind,
        )
      ? unwrap(expression.left)
      : expression;
}

// The environment variable a signing secret expression reads: `process.env.NAME`, with `!`, a cast
// or a `?? ''` default, directly or through a `const` in the same file.
export function secretVariable(
  source: ts.SourceFile,
  expression: ts.Expression,
  depth = 0,
): string | undefined {
  const value = unwrap(expression);
  if (
    (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'process' &&
    value.expression.name.text === 'env'
  ) {
    if (ts.isPropertyAccessExpression(value)) return value.name.text;
    if (ts.isStringLiteralLike(value.argumentExpression)) return value.argumentExpression.text;
  }
  if (!ts.isIdentifier(value) || depth > 3) return;
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === value.text &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      found = secretVariable(source, node.initializer, depth + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function eventSchema(type: string, resources: Record<string, unknown>) {
  if (Object.hasOwn(EVENT_SCHEMAS, type)) return EVENT_SCHEMAS[type];
  const prefix = type.slice(0, type.lastIndexOf('.'));
  return Object.hasOwn(resources, prefix) ? prefix : undefined;
}

// Keys the handler reads off `metadata`, which a fixture leaves empty: the handler looks up the
// application's own records by them and stops early without them.
function metadataKeys(source: ts.SourceFile) {
  const keys = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'metadata'
    )
      keys.add(node.name.text);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'metadata' &&
      ts.isStringLiteralLike(node.argumentExpression)
    )
      keys.add(node.argumentExpression.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(unwrap(node.initializer)) &&
      (unwrap(node.initializer) as ts.PropertyAccessExpression).name.text === 'metadata'
    )
      for (const element of node.name.elements)
        keys.add(((element.propertyName ?? element.name) as ts.Identifier).text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...keys].sort();
}

// The new-version object keeps the old object's value for every field both versions have, where
// the value has the same kind; a field whose shape changed keeps the new version's fixture.
export function overlay(after: Json, before: Json): Json {
  if (isObject(after) && isObject(before)) {
    for (const key of Object.keys(after))
      if (Object.hasOwn(before, key)) after[key] = overlay(after[key], before[key]);
    return after;
  }
  if (Array.isArray(after) && Array.isArray(before))
    return before.map((item, index) =>
      index < after.length ? overlay(clone(after[index]), item) : clone(item),
    );
  const kind = (value: Json) => (Array.isArray(value) ? 'array' : typeof value);
  return after === null || before === null || kind(after) === kind(before) ? clone(before) : after;
}

function setPath(object: JsonObject, path: string[], value: Json) {
  let node = object;
  for (const part of path.slice(0, -1)) {
    if (!isObject(node[part])) node[part] = {};
    node = node[part] as JsonObject;
  }
  node[path.at(-1)!] = value;
}

// Carries each moved value to where the new version keeps it, for every object (by its `object`
// name) that both events hold at the same place.
export function carryMoves(before: Json, after: Json, schema: string) {
  if (Array.isArray(before) && Array.isArray(after))
    before.forEach((item, index) => carryMoves(item, after[index], schema));
  if (!isObject(before) || !isObject(after)) return;
  const name = typeof after.object === 'string' ? after.object : schema;
  for (const move of STRIPE_PACK.fieldMoves as {
    family: string;
    schemas: string[];
    property?: string;
    helpers?: Record<string, string>;
    targets: string[][];
  }[]) {
    if (!move.schemas.includes(name)) continue;
    if (move.family === 'period-helper') {
      const items =
        isObject(after.items) && Array.isArray(after.items.data) ? after.items.data : [];
      for (const field of Object.keys(move.helpers ?? {}))
        if (before[field] !== undefined)
          for (const item of items) if (isObject(item)) item[field] = before[field];
      continue;
    }
    const property = move.property;
    if (!property || before[property] === undefined) continue;
    const old = before[property];
    const value = move.family === 'moved-id' && isObject(old) ? (old.id ?? null) : old;
    for (const target of move.targets.filter((path) => path[0] === name))
      setPath(after, target.slice(1), clone(value));
  }
  for (const key of Object.keys(after))
    if (key !== 'object' && Object.hasOwn(before, key)) carryMoves(before[key], after[key], key);
}

export function stripeSignedEventAdapter(options: {
  beforeFixtures: unknown;
  afterFixtures: unknown;
  beforeVersion: string;
  afterVersion: string;
  // The before contract: expandable references its fixture leaves null get placeholder IDs.
  beforeSpecification?: unknown;
}): SignedEventAdapter {
  const resources = (fixtures: unknown) =>
    (isObject(fixtures) && isObject(fixtures.resources) ? fixtures.resources : {}) as Record<
      string,
      Json
    >;
  const before = resources(options.beforeFixtures);
  const after = resources(options.afterFixtures);
  const schemas = (
    isObject(options.beforeSpecification) &&
    isObject(options.beforeSpecification.components) &&
    isObject(options.beforeSpecification.components.schemas)
      ? options.beforeSpecification.components.schemas
      : {}
  ) as Record<string, Json>;
  const metadata = new Map<string, string[]>();
  // An expandable reference the old fixture leaves null (a Checkout Session's subscription) gets a
  // placeholder ID, so handlers that retrieve it reach their code; stripe-mock serves any ID.
  const references = (schema: string, object: JsonObject) => {
    const properties =
      isObject(schemas[schema]) && isObject((schemas[schema] as JsonObject).properties)
        ? ((schemas[schema] as JsonObject).properties as JsonObject)
        : {};
    for (const [key, property] of Object.entries(properties))
      if (object[key] === null && isObject(property) && property['x-expansionResources'])
        object[key] = `${key}_refit_check`;
  };
  return {
    provider: 'stripe',
    sdkPackages: ['stripe'],
    signatureHeader: 'stripe-signature',
    signer:
      "(payload, secret, timestamp) => 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.' + payload, 'utf8').digest('hex')",
    newSecret: () => newSigningSecret('whsec_refit_'),
    // The behaviour sandbox's redirect to stripe-mock records each request (generated-checks.ts).
    requestRecorder: 'globalThis.__refitStripe',
    idPattern: '\\b[a-z]{2,8}_[A-Za-z0-9]{6,}\\b',
    sites(repository: Repository, findings: readonly Finding[], changedFiles: readonly string[]) {
      const webhookFiles = new Set(
        findings.flatMap((finding) =>
          finding.webhook ? [finding.file, finding.webhook.origin.file] : [],
        ),
      );
      const sites: SignedEventSite[] = [];
      const skipped: { file: string; reason: string }[] = [];
      for (const file of repository.files) {
        if (!CONSTRUCT.test(file.content)) continue;
        if (!webhookFiles.has(file.path) && !changedFiles.includes(file.path)) continue;
        const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
        let secret: string | undefined;
        let call = false;
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            /^constructEvent(?:Async)?$/.test(node.expression.name.text) &&
            node.arguments.length >= 3
          ) {
            call = true;
            secret ??= secretVariable(source, node.arguments[2]);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        const exportName = routeHandler(file.content, file.path);
        const types = new Set<string>();
        const literals = (node: ts.Node) => {
          // Only a literal the code compares an event type with: a `case`, `===`/`!==`, or an
          // element of a list (`[...].includes(event.type)`), never any dotted string.
          const parent = node.parent;
          const compared =
            parent &&
            ((ts.isCaseClause(parent) && parent.expression === node) ||
              (ts.isBinaryExpression(parent) &&
                [
                  ts.SyntaxKind.EqualsEqualsEqualsToken,
                  ts.SyntaxKind.ExclamationEqualsEqualsToken,
                  ts.SyntaxKind.EqualsEqualsToken,
                  ts.SyntaxKind.ExclamationEqualsToken,
                ].includes(parent.operatorToken.kind)) ||
              ts.isArrayLiteralExpression(parent));
          if (
            compared &&
            ts.isStringLiteralLike(node) &&
            /^[a-z_]+(?:\.[a-z_]+)+$/.test(node.text)
          ) {
            const schema = eventSchema(node.text, before);
            if (schema && Object.hasOwn(before, schema) && Object.hasOwn(after, schema))
              types.add(node.text);
          }
          ts.forEachChild(node, literals);
        };
        literals(source);
        const reason = !call
          ? 'Refit found no constructEvent call with a signing secret argument.'
          : !secret
            ? 'The signing secret is not read from an environment variable Refit can trace.'
            : !exportName
              ? 'The handler is not a Next.js App Router route (no exported POST); Refit cannot build the request it expects.'
              : !types.size
                ? 'The handler names no event type whose payload Refit can build from the fixtures.'
                : undefined;
        if (reason) {
          skipped.push({ file: file.path, reason });
          continue;
        }
        metadata.set(file.path, metadataKeys(source));
        sites.push({
          file: file.path,
          exportName: exportName!,
          secretEnv: secret!,
          eventTypes: [...types].sort().slice(0, MAX_EVENT_TYPES),
        });
      }
      return { sites, skipped };
    },
    events(site: SignedEventSite): SignedEvent[] {
      return site.eventTypes.map((type, index) => {
        const schema = eventSchema(type, before)!;
        // The same placeholders on both versions, so they differ only in shape.
        const fill = (object: JsonObject) => {
          references(schema, object);
          for (const key of metadata.get(site.file) ?? [])
            if (isObject(object.metadata)) object.metadata[key] ??= `refit_${key}`;
          return object;
        };
        const old = fill(clone(before[schema]) as JsonObject);
        const current = fill(overlay(clone(after[schema]), old) as JsonObject);
        carryMoves(old, current, schema);
        // One ID per delivery, the same length in both versions, so a handler that drops an
        // event it has already seen still handles each one.
        const envelope = (object: JsonObject, version: string) =>
          JSON.stringify({
            id: `evt_refit_check_${String(index).padStart(2, '0')}${version === options.afterVersion ? 'n' : 'o'}`,
            object: 'event',
            api_version: version,
            created: 1700000000,
            data: { object },
            livemode: false,
            pending_webhooks: 1,
            request: { id: null, idempotency_key: null },
            type,
          });
        return {
          type,
          before: envelope(old, options.beforeVersion),
          after: envelope(current, options.afterVersion),
        };
      });
    },
  };
}

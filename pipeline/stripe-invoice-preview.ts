import ts from 'typescript-compiler';
import { listOpenApiOperations } from './openapi-operations.ts';
import { local } from './request-removals.ts';
import { formatsEqual } from './schema-equivalence.ts';
import { isObject } from './specifications.ts';

// Stripe 2025-03-31.basil removed GET /v1/invoices/upcoming (stripe-node
// `invoices.retrieveUpcoming`) in favour of POST /v1/invoices/create_preview
// (`invoices.createPreview`), with equivalent parameters, and stopped previewing a customer's next
// invoice across all subscriptions. Read 2026-10-22:
// https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations
export const INVOICE_PREVIEW_RULE = 'stripe-invoice-create-preview';
export const INVOICE_PREVIEW_SOURCE =
  'https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations';
export const INVOICE_PREVIEW_WARNING =
  'invoices.retrieveUpcoming becomes invoices.createPreview with the same parameters; subscription_* parameters move under subscription_details. It needs the stripe-node release of the new API version, which this patch upgrades to.';
const REMOVED =
  'Stripe 2025-03-31.basil removed the upcoming invoice API (invoices.retrieveUpcoming) in favour of invoices.createPreview.';

// How each parameter of the removed call is sent to create_preview: under the same name, or under
// subscription_details (for `subscription_<name>`). `details` lists the subscription_details keys
// the new body accepts as they were.
export interface InvoicePreviewMove {
  keys: Map<string, string[]>;
  details: Set<string>;
}

type Document = Record<string, unknown>;

// Whether every value the old schema accepts is still accepted by the new one, so a request that
// was valid stays valid. Unknown shapes are refused.
function accepts(
  old: unknown,
  next: unknown,
  before: Document,
  after: Document,
  depth = 0,
): boolean {
  const a = local(old, before);
  const b = local(next, after);
  if (!a || !b || depth > 16) return false;
  if (Array.isArray(a.anyOf))
    return a.anyOf.every((option) => accepts(option, next, before, after, depth + 1));
  if (Array.isArray(b.anyOf))
    return b.anyOf.some((option) => accepts(old, option, before, after, depth + 1));
  // A format that only names the rule the field already had (owner decision D4, such as endive's
  // `currency` on items' price_data.currency) accepts the same values.
  if (a.type !== b.type || !formatsEqual(a, b)) return false;
  if (Array.isArray(a.enum) || Array.isArray(b.enum))
    return (
      Array.isArray(a.enum) &&
      (!Array.isArray(b.enum) || a.enum.every((value) => (b.enum as unknown[]).includes(value)))
    );
  if (
    typeof b.maxLength === 'number' &&
    !(typeof a.maxLength === 'number' && a.maxLength <= b.maxLength)
  )
    return false;
  if (a.type === 'array') return accepts(a.items, b.items, before, after, depth + 1);
  if (a.type !== 'object') return true;
  const oldProperties = isObject(a.properties) ? a.properties : {};
  const newProperties = isObject(b.properties) ? b.properties : {};
  const oldRequired = Array.isArray(a.required) ? a.required : [];
  const newRequired = Array.isArray(b.required) ? b.required : [];
  if (!newRequired.every((name) => oldRequired.includes(name))) return false;
  if (a.additionalProperties !== undefined || b.additionalProperties !== undefined)
    if (
      !isObject(a.additionalProperties) ||
      !accepts(a.additionalProperties, b.additionalProperties, before, after, depth + 1)
    )
      return false;
  return Object.entries(oldProperties).every(
    ([name, schema]) =>
      name in newProperties && accepts(schema, newProperties[name], before, after, depth + 1),
  );
}

function operation(document: Document, path: string, method: string) {
  return listOpenApiOperations(document).find(
    (entry) => entry.path === path && entry.httpMethod === method,
  )?.operation;
}

function invoiceResponse(entry: Record<string, unknown> | undefined, document: Document) {
  const responses = entry && isObject(entry.responses) ? entry.responses : {};
  const ok = local(responses['200'], document);
  const json = ok && isObject(ok.content) ? ok.content['application/json'] : undefined;
  return (
    isObject(json) && isObject(json.schema) && json.schema.$ref === '#/components/schemas/invoice'
  );
}

// The move, when the before contract has the upcoming invoice endpoint, the after contract only
// create_preview, both return an Invoice, and customer and subscription are sent unchanged.
export function invoicePreviewMove(
  before: Document,
  after: Document,
): InvoicePreviewMove | undefined {
  const upcoming = operation(before, '/v1/invoices/upcoming', 'GET');
  const preview = operation(after, '/v1/invoices/create_preview', 'POST');
  if (!upcoming || !preview || operation(after, '/v1/invoices/upcoming', 'GET')) return;
  if (!invoiceResponse(upcoming, before) || !invoiceResponse(preview, after)) return;
  const body = local(preview.requestBody, after);
  const content = body && isObject(body.content) ? Object.values(body.content) : [];
  const schema =
    content.length === 1 && isObject(content[0]) ? local(content[0].schema, after) : undefined;
  const target = schema && isObject(schema.properties) ? schema.properties : undefined;
  if (!target) return;
  const detailsSchema = local(target.subscription_details, after);
  const details =
    detailsSchema && isObject(detailsSchema.properties) ? detailsSchema.properties : {};
  const move: InvoicePreviewMove = { keys: new Map(), details: new Set() };
  for (const parameter of Array.isArray(upcoming.parameters) ? upcoming.parameters : []) {
    const entry = local(parameter, before);
    if (!entry || entry.in !== 'query' || typeof entry.name !== 'string') continue;
    const name = entry.name;
    if (name === 'subscription_details') {
      const old = local(entry.schema, before);
      for (const [key, value] of Object.entries(
        old && isObject(old.properties) ? old.properties : {},
      ))
        if (key in details && accepts(value, details[key], before, after)) move.details.add(key);
      continue;
    }
    if (name in target && accepts(entry.schema, target[name], before, after))
      move.keys.set(name, [name]);
    else if (name.startsWith('subscription_')) {
      const key = name.slice('subscription_'.length);
      if (key in details && accepts(entry.schema, details[key], before, after))
        move.keys.set(name, ['subscription_details', key]);
    }
  }
  return move.keys.has('customer') && move.keys.has('subscription') ? move : undefined;
}

function staticName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

// Static keys of a plain object literal, or undefined when it spreads, computes or repeats one.
function plainKeys(literal: ts.ObjectLiteralExpression) {
  const keys = new Map<string, ts.PropertyAssignment | ts.ShorthandPropertyAssignment>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const name = staticName(property.name);
    if (name === undefined || keys.has(name)) return;
    if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer) return;
    keys.set(name, property);
  }
  return keys;
}

const valueText = (property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) =>
  ts.isShorthandPropertyAssignment(property)
    ? property.name.getText()
    : property.initializer.getText();

// The edits that turn `invoices.retrieveUpcoming(params)` into `invoices.createPreview(params)`, or
// why the call stays for review.
export function invoicePreviewEdits(
  call: ts.CallExpression,
  move: InvoicePreviewMove,
): { start: number; end: number; replacement: string }[] | { reason: string } {
  const method = call.expression;
  const literal = call.arguments[0];
  if (!ts.isPropertyAccessExpression(method) || !literal || !ts.isObjectLiteralExpression(literal))
    return {
      reason: `${REMOVED} The call's parameters are not a direct object literal, so it needs review.`,
    };
  const keys = plainKeys(literal);
  if (!keys) return { reason: `${REMOVED} Spreads, computed or repeated parameters need review.` };
  // create_preview gives `currency` the `currency` format, a lowercase three-letter ISO code
  // (https://docs.stripe.com/currencies); a literal the call visibly sends outside it stays (D4).
  const invalidCurrency = (node: ts.Node): boolean =>
    (ts.isPropertyAssignment(node) &&
      staticName(node.name) === 'currency' &&
      ts.isStringLiteralLike(node.initializer) &&
      !/^[a-z]{3}$/.test(node.initializer.text)) ||
    Boolean(ts.forEachChild(node, (child) => invalidCurrency(child) || undefined));
  if (invalidCurrency(literal))
    return {
      reason: `${REMOVED} It sends a currency create_preview does not accept as written (a lowercase three-letter ISO code, https://docs.stripe.com/currencies); it needs review.`,
    };
  const detailsLiteral = keys.get('subscription_details');
  const detailKeys =
    detailsLiteral &&
    ts.isPropertyAssignment(detailsLiteral) &&
    ts.isObjectLiteralExpression(detailsLiteral.initializer)
      ? plainKeys(detailsLiteral.initializer)
      : undefined;
  if (
    detailsLiteral &&
    (!detailKeys || [...detailKeys.keys()].some((key) => !move.details.has(key)))
  )
    return {
      reason: `${REMOVED} Its subscription_details are not ones create_preview accepts as they are; they need review.`,
    };
  const unmapped = [...keys.keys()].filter(
    (key) => key !== 'subscription_details' && !move.keys.has(key),
  );
  if (unmapped.length)
    return {
      reason: `${REMOVED} ${unmapped.join(', ')} ${unmapped.length === 1 ? 'has' : 'have'} no equivalent create_preview parameter; the call needs review.`,
    };
  if (!keys.has('customer') || !keys.has('subscription'))
    return {
      reason: `${REMOVED} Stripe no longer previews a customer's next invoice across all subscriptions; the call must name the subscription (or schedule) to preview, so it needs review.`,
    };
  const nested = [...keys].filter(([key]) => (move.keys.get(key)?.length ?? 1) > 1);
  if (nested.length && detailsLiteral)
    return {
      reason: `${REMOVED} It sends subscription_details and subscription_* parameters; merging them needs review.`,
    };
  const edits = [
    { start: method.name.getStart(), end: method.name.getEnd(), replacement: 'createPreview' },
  ];
  if (!nested.length) return edits;
  // The direct parameters as written, then the moved ones together under subscription_details.
  const parts: string[] = [];
  let placed = false;
  for (const [key, property] of keys) {
    if ((move.keys.get(key)?.length ?? 1) === 1) parts.push(property.getText());
    else if (!placed) {
      placed = true;
      parts.push(
        `subscription_details: { ${nested.map(([name, entry]) => `${move.keys.get(name)![1]}: ${valueText(entry)}`).join(', ')} }`,
      );
    }
  }
  const source = literal.getSourceFile().text;
  const multiline = literal.getText().includes('\n');
  const lineStart = (position: number) => source.lastIndexOf('\n', position - 1) + 1;
  const indent = source.slice(
    lineStart(literal.properties[0].getStart()),
    literal.properties[0].getStart(),
  );
  const closing = source.slice(lineStart(literal.getEnd() - 1), literal.getEnd() - 1);
  const trailing = literal.properties.hasTrailingComma ? ',' : '';
  edits.push({
    start: literal.getStart(),
    end: literal.getEnd(),
    replacement:
      multiline && /^\s*$/.test(indent) && /^\s*$/.test(closing)
        ? `{\n${parts.map((part) => `${indent}${part}`).join(',\n')}${trailing}\n${closing}}`
        : `{ ${parts.join(', ')} }`,
  });
  return edits;
}

import ts from 'typescript-compiler';
import { isObject, resolvableComponentSchema } from './specifications.ts';
import type { Removal, SourceEdit } from './types.ts';
import { STRIPE_PACK } from './rule-pack.ts';

// A receiver that can be repeated without side effects: `invoice`, `this.invoice`, `data.items[0]`.
function plainReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
    return plainReceiver(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) return plainReceiver(expression.expression);
  if (ts.isElementAccessExpression(expression))
    return (
      ts.isLiteralExpression(expression.argumentExpression) && plainReceiver(expression.expression)
    );
  return false;
}

// Rewrites a direct `receiver.property` or `receiver?.property` read; longer optional chains,
// element access and destructuring stay with review or AI. A cast receiver,
// `(subscription as any).current_period_end`, goes to the helper as written; under `as any` the
// result stays `any`, as the read was, since the generic helpers would type it `unknown`.
export function movedReadEdit(
  node: ts.Node,
  file: string,
  changeId: string,
  rule: NonNullable<SourceEdit['rule']>,
  replacement: (receiver: string) => string,
): SourceEdit | undefined {
  if (!ts.isPropertyAccessExpression(node)) return;
  const cast =
    ts.isParenthesizedExpression(node.expression) &&
    (ts.isAsExpression(node.expression.expression) ||
      ts.isTypeAssertionExpression(node.expression.expression) ||
      ts.isSatisfiesExpression(node.expression.expression))
      ? node.expression.expression
      : undefined;
  if (!plainReceiver(cast ? cast.expression : node.expression)) return;
  if (!node.questionDotToken && node.flags & ts.NodeFlags.OptionalChain) return;
  const receiver = (cast ?? node.expression).getText();
  const value =
    cast && !ts.isSatisfiesExpression(cast) && cast.type.kind === ts.SyntaxKind.AnyKeyword
      ? `${replacement(receiver)} as any`
      : replacement(receiver);
  return {
    file,
    start: node.getStart(),
    end: node.getEnd(),
    replacement: node.questionDotToken
      ? `(${cast ? `(${receiver})` : receiver} == null ? undefined : ${value})`
      : `(${value})`,
    changeId,
    rule,
  };
}

export function propertyExists(schemas: Record<string, unknown>, path: string[]) {
  let schema: string | undefined = path[0];
  for (const property of path.slice(1)) {
    const name: string | undefined = schema && resolvableComponentSchema(schemas, schema);
    const definition: unknown = name ? schemas[name] : undefined;
    const value: unknown =
      isObject(definition) && isObject(definition.properties)
        ? definition.properties[property]
        : undefined;
    if (!isObject(value)) return false;
    const reference: unknown = Array.isArray(value.anyOf) ? value.anyOf[0] : value;
    schema =
      isObject(reference) && typeof reference.$ref === 'string'
        ? reference.$ref.replace('#/components/schemas/', '')
        : undefined;
  }
  return true;
}

// Removed Stripe reads whose new location is not a behaviour-preserving read; they stay unresolved
// with the pack's reason and, where the code must decide, the question it must answer.
export const STRIPE_MOVE_REVIEW: Record<string, string> = STRIPE_PACK.readReviews;

// Stripe schema names reused for a different object, whose old object lives on under a new name.
// 2024-04-10 renamed Product `features` to `marketing_features`: its items, `product_feature`
// ({ name }) until then, are `product_marketing_feature` from then on, and `product_feature` names
// the Entitlements attachment. Source, read 2026-10-24:
// https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object
const RENAMED_SCHEMAS = [
  {
    schema: 'product_feature',
    renamed: 'product_marketing_feature',
    owner: 'product',
    from: 'features',
    to: 'marketing_features',
  },
];

function itemsRef(schemas: Record<string, unknown>, schema: string, property: string) {
  const owner = schemas[schema];
  const value =
    isObject(owner) && isObject(owner.properties) ? owner.properties[property] : undefined;
  const items = isObject(value) && isObject(value.items) ? value.items : undefined;
  return items && typeof items.$ref === 'string' ? items.$ref : undefined;
}

// Without descriptions, which change between versions without changing the value.
function shape(schema: unknown): string {
  return JSON.stringify(schema, (key, value: unknown) =>
    key === 'description' ? undefined : value,
  );
}

// Drops removals that only follow a reused schema name: the field still exists, with the same shape,
// on the renamed schema that the same owner field (renamed with it) now lists. The owner field's
// own removal stays, so reads of it are still reported.
export function withoutRenamedSchemaRemovals(
  changes: Removal[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return changes.filter((change) => {
    const rename = RENAMED_SCHEMAS.find((entry) => entry.schema === change.schema);
    if (
      !rename ||
      itemsRef(before, rename.owner, rename.from) !== `#/components/schemas/${rename.schema}` ||
      itemsRef(after, rename.owner, rename.to) !== `#/components/schemas/${rename.renamed}`
    )
      return true;
    const old = before[rename.schema];
    const current = after[rename.renamed];
    const property = (schema: unknown) =>
      isObject(schema) && isObject(schema.properties)
        ? schema.properties[change.property]
        : undefined;
    return !(property(old) !== undefined && shape(property(old)) === shape(property(current)));
  });
}

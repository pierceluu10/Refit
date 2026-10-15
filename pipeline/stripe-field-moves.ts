import ts from 'typescript-compiler';
import { isObject, resolvableComponentSchema } from './specifications.ts';
import type { SourceEdit } from './types.ts';

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
// element access and destructuring stay with review or AI.
export function movedReadEdit(
  node: ts.Node,
  file: string,
  changeId: string,
  rule: NonNullable<SourceEdit['rule']>,
  replacement: (receiver: string) => string,
): SourceEdit | undefined {
  if (!ts.isPropertyAccessExpression(node) || !plainReceiver(node.expression)) return;
  if (!node.questionDotToken && node.flags & ts.NodeFlags.OptionalChain) return;
  const receiver = node.expression.getText();
  const value = replacement(receiver);
  return {
    file,
    start: node.getStart(),
    end: node.getEnd(),
    replacement: node.questionDotToken
      ? `(${receiver} == null ? undefined : ${value})`
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

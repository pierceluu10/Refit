import {
  GraphQLError,
  isInputObjectType,
  Kind,
  NoUnusedFragmentsRule,
  parse,
  specifiedRules,
  validate,
  visit,
  type DocumentNode,
  type FieldNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import ts from 'typescript-compiler';
import type { AdminDocument } from './shopify-analysis.ts';
import type { ShopifyLiveCase } from './shopify-live-proof.ts';
import { loadShopifyRuleTables } from './shopify-rules.ts';
import { pinnedShopifySchema, pinnedShopifyVersions } from './shopify-schemas.ts';
import type { SourceEdit } from './types.ts';

// Documented migrations that change a document's shape (docs/SHOPIFY-RULES.md, family
// `graphql-migration`), and the GraphQL validity fix for unused variables. Unlike the in-place
// renames of pipeline/shopify-document-rules.ts, a migration also edits the code around the document:
// the variables the call sends and the reads of its response. Each one is a fixed transform that
// refuses anything outside the shape it proves, and the rewritten document must validate on the
// target schema. Where the variables change shape, the migration also writes the development store
// case that sends them, because schema validation cannot see what the code sends
// (pipeline/shopify-proof.ts requires that case to pass).

export interface ShopifyMigrationRule {
  rule: string;
  migration: 'variants-bulk-update';
  coordinate: string;
  replacement: string;
  source: string;
}

// Every `auto` Admin migration rule of a table whose version is at most the target version.
export function loadShopifyMigrationRules(target: string): ShopifyMigrationRule[] {
  return loadShopifyRuleTables()
    .filter((table) => table.api === 'admin' && String(table.version) <= target)
    .flatMap((table) => table.rules)
    .flatMap((rule) =>
      rule.family === 'graphql-migration' && rule.status === 'auto'
        ? [
            {
              rule: rule.rule,
              migration: rule.migration,
              coordinate: rule.coordinate,
              replacement: rule.replacement,
              source: rule.source,
            },
          ]
        : [],
    );
}

// The built-in fix for a variable a document declares but never uses, which the GraphQL
// specification forbids ("All Variables Used", https://spec.graphql.org/October2021/#sec-All-Variables-Used),
// so Shopify rejects the document on every version.
export const UNUSED_VARIABLE_RULE = 'graphql-unused-variable';
const SPEC = 'https://spec.graphql.org/October2021/#sec-All-Variables-Used';

export interface DocumentMigration {
  text: string;
  edits: SourceEdit[];
  // What each edit does, for the findings.
  notes: { rule: string; offset: number; expression: string; reason: string }[];
  // Live cases for operations whose variables changed, without the document id the proof assigns.
  liveCases: Omit<ShopifyLiveCase, 'document'>[];
  // Operations whose variables changed but no case could be written for.
  uncovered: string[];
}

const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
// Fields of ProductVariantsBulkInput the old ProductVariantInput also had with the same meaning.
const BULK_KEYS = new Set([
  'id',
  'price',
  'compareAtPrice',
  'barcode',
  'taxable',
  'taxCode',
  'inventoryPolicy',
]);

function errorsOn(schema: GraphQLSchema, text: string): readonly GraphQLError[] {
  try {
    return validate(schema, parse(text), RULES);
  } catch (error) {
    if (error instanceof GraphQLError) return [error];
    throw error;
  }
}

const singleSegment = (document: AdminDocument) => {
  const [segment] = document.segments;
  return document.segments.length === 1 &&
    segment.documentStart === 0 &&
    segment.documentEnd === document.text.length &&
    segment.sourceText.slice(segment.sourceStart, segment.sourceStart + document.text.length) ===
      document.text
    ? segment
    : undefined;
};

// Removes every variable definition no operation uses. The variable the code still sends is not
// declared any more, which GraphQL servers ignore; the development store case sends it to show it.
export function removeUnusedVariables(text: string) {
  const ast = parse(text);
  const edits: { start: number; end: number; replacement: string; name: string }[] = [];
  for (const operation of ast.definitions) {
    if (operation.kind !== Kind.OPERATION_DEFINITION || !operation.variableDefinitions?.length)
      continue;
    const used = new Set<string>();
    visit(operation.selectionSet, {
      Variable(node) {
        used.add(node.name.value);
      },
    });
    // Variables a fragment spread uses count as used: leave such documents alone.
    let spreads = false;
    visit(operation.selectionSet, {
      FragmentSpread() {
        spreads = true;
      },
    });
    if (spreads) continue;
    const definitions = operation.variableDefinitions;
    const unused = definitions.filter((entry) => !used.has(entry.variable.name.value));
    if (!unused.length) continue;
    const first = definitions[0].loc!;
    const last = definitions.at(-1)!.loc!;
    const open = text.lastIndexOf('(', first.start);
    const close = text.indexOf(')', last.end);
    const kept = definitions
      .filter((entry) => used.has(entry.variable.name.value))
      .map((entry) => text.slice(entry.loc!.start, entry.loc!.end));
    edits.push({
      start: open,
      end: close + 1,
      replacement: kept.length ? `(${kept.join(', ')})` : '',
      name: unused.map((entry) => `$${entry.variable.name.value}`).join(', '),
    });
  }
  return edits;
}

// --- Code around the document ------------------------------------------------------------------

function nodeAt(file: ts.SourceFile, position: number) {
  let found: ts.Node | undefined;
  const visitNode = (node: ts.Node) => {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visitNode);
  };
  visitNode(file);
  return found;
}

const skipParentheses = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)
    ? skipParentheses(node.expression)
    : node;

// The `const name = await <expression>` an awaited expression initializes.
function awaitedInto(expression: ts.Node) {
  let node: ts.Node = expression;
  while (
    node.parent &&
    (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent))
  )
    node = node.parent;
  if (!ts.isAwaitExpression(node.parent)) return undefined;
  const declaration = node.parent.parent;
  return ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const
    ? declaration
    : undefined;
}

// Every identifier in the file named `name`, other than the declaration itself; undefined when the
// file declares the name more than once (shadowing Refit does not follow).
function references(file: ts.SourceFile, declaration: ts.VariableDeclaration) {
  const name = (declaration.name as ts.Identifier).text;
  let declarations = 0;
  const found: ts.Identifier[] = [];
  const visitNode = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      if (
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.name === node
      )
        declarations++;
      else if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(ts.isPropertyAssignment(parent) && parent.name === node)
      )
        found.push(node);
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(file);
  return declarations === 1 ? found : undefined;
}

// The chain of property names read from an identifier (`json.data!.x?.y` → data, x, y), with the
// outermost access, the name nodes and whether each access is optional.
function accessChain(identifier: ts.Identifier) {
  const names: { name: ts.MemberName | ts.Expression; text: string; optional: boolean }[] = [];
  let node: ts.Node = identifier;
  for (;;) {
    const parent = node.parent;
    if (ts.isNonNullExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      names.push({
        name: parent.name,
        text: parent.name.text,
        optional: Boolean(parent.questionDotToken),
      });
      node = parent;
      continue;
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === node &&
      ts.isNumericLiteral(parent.argumentExpression)
    ) {
      names.push({
        name: parent.argumentExpression,
        text: parent.argumentExpression.text,
        optional: Boolean(parent.questionDotToken),
      });
      node = parent;
      continue;
    }
    return { names, outer: node };
  }
}

// The document text a `const name = await (await <call>(<literal>, …)).json()`-style response comes
// from: `name` must be `const name = await response.json()` with `response` initialized by awaiting
// a call whose first argument is a template or string literal with no substitutions.
function responseDocument(file: ts.SourceFile, json: ts.VariableDeclaration) {
  const initializer = json.initializer && skipParentheses(json.initializer);
  if (!initializer || !ts.isAwaitExpression(initializer)) return undefined;
  const call = skipParentheses(initializer.expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'json' ||
    !ts.isIdentifier(call.expression.expression)
  )
    return undefined;
  const responseName = call.expression.expression.text;
  let found: string | undefined;
  let count = 0;
  const visitNode = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === responseName
    ) {
      count++;
      const value = node.initializer && skipParentheses(node.initializer);
      const sent =
        value && ts.isAwaitExpression(value) ? skipParentheses(value.expression) : undefined;
      const literal = sent && ts.isCallExpression(sent) ? sent.arguments[0] : undefined;
      if (literal && ts.isNoSubstitutionTemplateLiteral(literal)) found = literal.text;
      else if (literal && ts.isStringLiteral(literal)) found = literal.text;
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(file);
  return count === 1 ? found : undefined;
}

// Whether the document selects `id` (unaliased) at the end of a response-key path.
function selectsId(text: string, path: string[]) {
  let ast: DocumentNode;
  try {
    ast = parse(text);
  } catch {
    return false;
  }
  const operations = ast.definitions.filter(
    (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1) return false;
  let set: SelectionSetNode | undefined = operations[0].selectionSet;
  for (const key of [...path, 'id']) {
    const field: FieldNode | undefined = set?.selections.find(
      (entry): entry is FieldNode =>
        entry.kind === Kind.FIELD && (entry.alias ?? entry.name).value === key,
    );
    if (!field) return false;
    if (key === 'id') return !field.alias && field.name.value === 'id';
    set = field.selectionSet;
  }
  return false;
}

// The product whose variant an ID expression names: `<product>.variants.edges[n].node.id` or
// `<product>.variants.nodes[n].id`, written directly or through one `const`. Returns the source text
// of `<product>.id`, only where `<product>` is read from a response whose document selects its `id`.
function productIdFor(file: ts.SourceFile, expression: ts.Expression): string | undefined {
  let value = skipParentheses(expression);
  if (ts.isIdentifier(value)) {
    const declarations: ts.VariableDeclaration[] = [];
    const visitNode = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === (value as ts.Identifier).text
      )
        declarations.push(node);
      ts.forEachChild(node, visitNode);
    };
    visitNode(file);
    const [declaration] = declarations;
    if (
      declarations.length !== 1 ||
      !declaration.initializer ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return undefined;
    value = skipParentheses(declaration.initializer);
  }
  // Walk the access chain from the outside in: id, node, [n], edges, variants (or id, [n], nodes,
  // variants), leaving the product expression.
  const steps: string[] = [];
  let node: ts.Node = value;
  while (steps.length < 5) {
    node = skipParentheses(node);
    if (ts.isPropertyAccessExpression(node)) {
      steps.push(node.name.text);
      node = node.expression;
    } else if (ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression)) {
      steps.push('[]');
      node = node.expression;
    } else break;
    const shape = steps.join('.');
    if (shape === 'id.node.[].edges.variants' || shape === 'id.[].nodes.variants') break;
  }
  const shape = steps.join('.');
  if (shape !== 'id.node.[].edges.variants' && shape !== 'id.[].nodes.variants') return undefined;
  const product = node as ts.Expression;
  // The product expression is a chain of response keys from a JSON response, possibly through
  // `const product = json.data.x.product`.
  let root: ts.Node = skipParentheses(product);
  const path: string[] = [];
  for (;;) {
    if (ts.isPropertyAccessExpression(root)) {
      path.unshift(root.name.text);
      root = skipParentheses(root.expression);
      continue;
    }
    if (ts.isIdentifier(root)) {
      const name = root.text;
      const declarations: ts.VariableDeclaration[] = [];
      const visitNode = (child: ts.Node) => {
        if (
          ts.isVariableDeclaration(child) &&
          ts.isIdentifier(child.name) &&
          child.name.text === name
        )
          declarations.push(child);
        ts.forEachChild(child, visitNode);
      };
      visitNode(file);
      if (declarations.length !== 1 || !(declarations[0].parent.flags & ts.NodeFlags.Const))
        return undefined;
      const document = responseDocument(file, declarations[0]);
      if (document !== undefined) {
        if (path[0] !== 'data' || !selectsId(document, path.slice(1))) return undefined;
        return `${product.getText(file)}.id`;
      }
      // `const product = json.data.x.product`: follow it once more.
      if (!declarations[0].initializer || path.length) return undefined;
      root = skipParentheses(declarations[0].initializer);
      if (!ts.isPropertyAccessExpression(root)) return undefined;
      continue;
    }
    return undefined;
  }
}

// A stand-in for a value the development store case sends where the code computes it: the code's
// literal where it writes one, a number where it computes one by arithmetic or Math.
function caseValue(expression: ts.Expression): unknown {
  const value = skipParentheses(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  const numeric = (node: ts.Node): boolean => {
    const inner = skipParentheses(node);
    return (
      ts.isNumericLiteral(inner) ||
      (ts.isBinaryExpression(inner) &&
        [
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PlusToken,
        ].includes(inner.operatorToken.kind) &&
        numeric(inner.left) &&
        numeric(inner.right)) ||
      (ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        ts.isIdentifier(inner.expression.expression) &&
        inner.expression.expression.text === 'Math')
    );
  };
  return numeric(value) ? 42.5 : undefined;
}

const LIVE_PRODUCT = `mutation RefitLiveProductCreate($product: ProductCreateInput!) {
  productCreate(product: $product) { product { id variants(first: 1) { nodes { id } } } }
}`;
const LIVE_PRODUCT_DELETE = `mutation RefitLiveProductDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId }
}`;

// `productVariantUpdate(input: $input) { productVariant {…} userErrors {…} }` sent with
// `{ variables: { input: { id, …fields } } }` becomes
// `productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants {…} … }`
// sent with `{ productId: <product>.id, variants: [{ id, …fields }] }`, as Shopify's own app
// template made the change; reads of `.productVariantUpdate.productVariant` read the first (only)
// variant of `.productVariantsBulkUpdate.productVariants`.
function variantsBulkUpdate(
  text: string,
  document: AdminDocument,
  source: string,
  after: GraphQLSchema,
  rule: ShopifyMigrationRule,
):
  | { text: string; edits: SourceEdit[]; liveCase?: DocumentMigration['liveCases'][number] }
  | string {
  const ast = parse(text);
  const operations = ast.definitions.filter(
    (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
  );
  if (
    ast.definitions.length !== 1 ||
    operations.length !== 1 ||
    operations[0].operation !== 'mutation'
  )
    return 'the document is not a single mutation';
  const operation = operations[0];
  const [root] = operation.selectionSet.selections;
  if (
    operation.selectionSet.selections.length !== 1 ||
    root.kind !== Kind.FIELD ||
    root.alias ||
    root.name.value !== 'productVariantUpdate'
  )
    return 'productVariantUpdate is not the mutation’s only, unaliased field';
  const argument = root.arguments?.[0];
  if (
    root.arguments?.length !== 1 ||
    argument!.name.value !== 'input' ||
    argument!.value.kind !== Kind.VARIABLE
  )
    return 'productVariantUpdate does not take its input from one variable';
  const variable = argument!.value.name.value;
  const definitions = operation.variableDefinitions ?? [];
  if (definitions.length !== 1 || definitions[0].variable.name.value !== variable)
    return 'the mutation declares variables other than its input';
  const payload = root.selectionSet?.selections ?? [];
  const variantField = payload.find(
    (entry): entry is FieldNode =>
      entry.kind === Kind.FIELD && entry.name.value === 'productVariant',
  );
  if (
    !variantField ||
    variantField.alias ||
    payload.some(
      (entry) =>
        entry.kind !== Kind.FIELD ||
        entry.alias ||
        !['productVariant', 'userErrors'].includes(entry.name.value),
    )
  )
    return 'the payload selects something other than productVariant and userErrors';
  const bulkInput = after.getType('ProductVariantsBulkInput');
  if (!bulkInput || !isInputObjectType(bulkInput))
    return 'the target schema has no ProductVariantsBulkInput';
  // The code around the document.
  const file = ts.createSourceFile(document.segments[0].file, source, ts.ScriptTarget.Latest, true);
  const literal = nodeAt(file, document.segments[0].sourceStart);
  if (!literal || !(ts.isNoSubstitutionTemplateLiteral(literal) || ts.isStringLiteral(literal)))
    return 'the document is not written as one literal';
  const call = literal.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== literal)
    return 'the document is not passed straight to the call that sends it';
  const options = call.arguments[1] && skipParentheses(call.arguments[1]);
  if (!options || !ts.isObjectLiteralExpression(options))
    return 'the call’s options are not an object literal';
  const variablesProperty = options.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && entry.name.getText(file) === 'variables',
  );
  const variables = variablesProperty && skipParentheses(variablesProperty.initializer);
  if (!variables || !ts.isObjectLiteralExpression(variables) || variables.properties.length !== 1)
    return 'the call does not send its variables as an object literal with the input alone';
  const inputProperty = variables.properties[0];
  if (
    !ts.isPropertyAssignment(inputProperty) ||
    inputProperty.name.getText(file) !== variable ||
    !ts.isObjectLiteralExpression(skipParentheses(inputProperty.initializer))
  )
    return `the call does not send $${variable} as an object literal`;
  const input = skipParentheses(inputProperty.initializer) as ts.ObjectLiteralExpression;
  const fields = bulkInput.getFields();
  const values = new Map<string, ts.Expression>();
  for (const property of input.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      return 'the input spreads or computes a property';
    const key = property.name.getText(file).replace(/^['"]|['"]$/g, '');
    if (!BULK_KEYS.has(key) || !fields[key])
      return `the input sends ${key}, which ProductVariantsBulkInput does not take with the same meaning`;
    values.set(
      key,
      ts.isPropertyAssignment(property) ? property.initializer : (property.name as ts.Identifier),
    );
  }
  const id = values.get('id');
  if (!id) return 'the input does not name the variant’s id';
  const productId = productIdFor(file, id);
  if (!productId)
    return 'Refit cannot tell which product the variant belongs to from the response the code read it from';
  // Reads of the response.
  const responseDeclaration = awaitedInto(call);
  if (!responseDeclaration) return 'the call’s response is not kept in one const';
  const responseUses = references(file, responseDeclaration);
  if (!responseUses || responseUses.length !== 1) return 'the response is used more than once';
  const jsonCall = responseUses[0].parent;
  if (
    !ts.isPropertyAccessExpression(jsonCall) ||
    jsonCall.name.text !== 'json' ||
    !ts.isCallExpression(jsonCall.parent)
  )
    return 'the response is not read with .json()';
  const jsonDeclaration = awaitedInto(jsonCall.parent);
  if (!jsonDeclaration) return 'the response body is not kept in one const';
  const reads = references(file, jsonDeclaration);
  if (!reads) return 'the response body’s name is declared more than once';
  const codeEdits: SourceEdit[] = [];
  const edit = (start: number, end: number, replacement: string): SourceEdit => ({
    file: document.segments[0].file,
    start,
    end,
    replacement,
    changeId: rule.rule,
    rule: rule.rule,
  });
  for (const read of reads) {
    const { names } = accessChain(read);
    if (names[0]?.text !== 'data' || names[1]?.text !== 'productVariantUpdate')
      return 'the code reads the response body other than through data.productVariantUpdate';
    const next = names[2];
    if (!next || !['productVariant', 'userErrors'].includes(next.text))
      return 'the code reads the whole productVariantUpdate payload';
    codeEdits.push(
      edit(names[1].name.getStart(file), names[1].name.getEnd(), 'productVariantsBulkUpdate'),
    );
    if (next.text === 'productVariant')
      codeEdits.push(
        edit(
          next.name.getStart(file),
          next.name.getEnd(),
          next.optional ? 'productVariants?.[0]' : 'productVariants[0]',
        ),
      );
  }
  // The variables the call sends.
  const indent = (node: ts.Node) => {
    const lineStart = source.lastIndexOf('\n', node.getStart(file)) + 1;
    return /^\s*/.exec(source.slice(lineStart))![0];
  };
  const inputText = source.slice(input.getStart(file), input.getEnd());
  codeEdits.push(
    edit(
      inputProperty.getStart(file),
      inputProperty.getEnd(),
      `productId: ${productId},\n${indent(inputProperty)}variants: [${inputText}]`,
    ),
  );
  // The document.
  const documentEdits = [
    {
      start: definitions[0].loc!.start,
      end: definitions[0].loc!.end,
      replacement: '$productId: ID!, $variants: [ProductVariantsBulkInput!]!',
    },
    {
      start: root.name.loc!.start,
      end: argument!.loc!.end,
      replacement: 'productVariantsBulkUpdate(productId: $productId, variants: $variants',
    },
    {
      start: variantField.name.loc!.start,
      end: variantField.name.loc!.end,
      replacement: 'productVariants',
    },
  ];
  const rewritten = [...documentEdits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, entry) => result.slice(0, entry.start) + entry.replacement + result.slice(entry.end),
      text,
    );
  // A case for the development store: a product it creates, its default variant, and the fields
  // the code sends (stand-ins where the code computes them).
  const variant: Record<string, unknown> = {
    id: { $ref: 'setup.0.productCreate.product.variants.nodes.0.id' },
  };
  let caseable = true;
  for (const [key, expression] of values) {
    if (key === 'id') continue;
    const value = caseValue(expression);
    if (value === undefined) caseable = false;
    else variant[key] = value;
  }
  return {
    text: rewritten,
    edits: [
      ...documentEdits.map((entry) => ({
        ...edit(
          document.segments[0].sourceStart + entry.start,
          document.segments[0].sourceStart + entry.end,
          entry.replacement,
        ),
      })),
      ...codeEdits,
    ],
    ...(caseable
      ? {
          liveCase: {
            operationName: operation.name?.value ?? null,
            variables: {
              productId: { $ref: 'setup.0.productCreate.product.id' },
              variants: [variant],
            },
            setup: [
              { document: LIVE_PRODUCT, variables: { product: { title: 'Refit live proof' } } },
            ],
            cleanup: [
              {
                document: LIVE_PRODUCT_DELETE,
                variables: { input: { id: { $ref: 'setup.0.productCreate.product.id' } } },
              },
            ],
          },
        }
      : {}),
  };
}

// Admin members Shopify removed with no replacement a document edit can make, each quoting the
// saved page it was read from (docs/benchmarks/shopify-changelog/pages). A document that sends one
// stops with this reason instead of a generic "already fails".
export const DOCUMENTED_REMOVALS = [
  {
    coordinate: 'Mutation.metafieldDelete',
    source:
      'https://shopify.dev/changelog/posts/remove-metafielddelete-in-favor-of-metafieldsdelete',
    quote: 'Note that the Metafield GID is not an option in `metafieldsDelete`.',
    checkedAt: '2026-10-30',
    reason:
      'Shopify removed it in 2025-01 for metafieldsDelete, which takes ownerId, namespace and key instead of the metafield GID this document sends, so the call needs those values from the code',
  },
  {
    coordinate: 'Mutation.discountsAllocatorFunctionRegister',
    source:
      'https://shopify.dev/changelog/posts/discounts-allocator-function-api-developer-preview-has-ended',
    quote: 'They were never available in a stable version.',
    checkedAt: '2026-10-30',
    reason:
      'Shopify ended the Discounts Allocator Function API developer preview with no replacement; the mutation was only ever on the unstable version',
  },
] as const;

// Every pinned Admin schema and the newest pinned Storefront schema, read once.
let loadedSchemas:
  | { admin: string[]; schemas: GraphQLSchema[]; storefront: string; shop: GraphQLSchema }
  | undefined;
function referenceSchemas() {
  if (!loadedSchemas) {
    const admin = pinnedShopifyVersions('admin');
    const storefront = pinnedShopifyVersions('storefront').at(-1)!;
    loadedSchemas = {
      admin,
      schemas: admin.map((version) => pinnedShopifySchema('admin', version).schema),
      storefront,
      shop: pinnedShopifySchema('storefront', storefront).schema,
    };
  }
  return loadedSchemas;
}

const hasMember = (schema: GraphQLSchema, type: string, member?: string) => {
  const named = schema.getType(type);
  if (!named) return false;
  if (!member) return true;
  return 'getFields' in named && Object.hasOwn(named.getFields(), member);
};

// Why no documented migration fixes a document, one sentence per member its errors name: a
// documented removal, or a member no pinned Admin schema has and no saved Shopify page replaces. A
// document that validates whole on the pinned Storefront schema is a Storefront document sent to the
// Admin API; a member that only shares a Storefront field's name proves nothing, since Admin had
// many of the same names before it removed them. Errors about anything else name nothing.
export function unmigratedReasons(
  text: string,
  errors: readonly GraphQLError[],
  target: GraphQLSchema,
) {
  const { admin, schemas, storefront, shop } = referenceSchemas();
  const pinned = `every pinned Admin schema (${admin[0]} to ${admin.at(-1)})`;
  if (!errorsOn(shop, text).length)
    return [
      `The document validates on the Storefront API ${storefront} schema and fails on the Admin API: it is a Storefront document sent with an Admin client.`,
    ];
  const reasons = new Map<string, string>();
  for (const error of errors) {
    const field = /^Cannot query field "(\w+)" on type "(\w+)"\./.exec(error.message);
    const type = /^Unknown type "(\w+)"\./.exec(error.message);
    const [owner, member] = field ? [field[2], field[1]] : type ? [type[1], undefined] : [];
    if (!owner) continue;
    const coordinate = member ? `${owner}.${member}` : owner;
    if (reasons.has(coordinate)) continue;
    const documented = DOCUMENTED_REMOVALS.find((entry) => entry.coordinate === coordinate);
    if (documented)
      reasons.set(coordinate, `${coordinate}: ${documented.reason} (${documented.source}).`);
    else if (![...schemas, target].some((schema) => hasMember(schema, owner, member)))
      reasons.set(
        coordinate,
        `${coordinate} is absent from ${pinned}, and no saved Shopify page names its replacement.`,
      );
  }
  // An input type goes with the field that takes it; it is named only when no field is.
  const fields = [...reasons.keys()].filter((coordinate) => coordinate.includes('.'));
  return (fields.length ? fields : [...reasons.keys()]).map((coordinate) =>
    reasons.get(coordinate)!,
  );
}

// Applies the unused-variable fix and the documented migrations a failing document needs, or says
// why it cannot. Undefined when nothing applies. `source` is the content of the document's file.
export function migrateDocument(options: {
  document: AdminDocument;
  source: string | undefined;
  after: GraphQLSchema;
  rules: ShopifyMigrationRule[];
}): DocumentMigration | { refusal: string } | undefined {
  const { document, after } = options;
  const segment = singleSegment(document);
  let text = document.text;
  const errors = errorsOn(after, text);
  if (!errors.length) return undefined;
  const unused = errors.some((error) => /^Variable "\$\w+" is never used/.test(error.message));
  const variantRule = options.rules.find(
    (rule) =>
      rule.migration === 'variants-bulk-update' &&
      errors.some((error) =>
        error.message.startsWith('Cannot query field "productVariantUpdate" on type "Mutation".'),
      ),
  );
  const named = unmigratedReasons(text, errors, after);
  if (!unused && !variantRule)
    return named.length
      ? { refusal: `no documented migration covers this document. ${named.join(' ')}` }
      : undefined;
  if (!segment || options.source === undefined)
    return { refusal: 'the document is assembled from several pieces of source' };
  const migration: DocumentMigration = { text, edits: [], notes: [], liveCases: [], uncovered: [] };
  const operationName = () => {
    const operation = parse(text).definitions.find(
      (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
    );
    return operation?.name?.value ?? null;
  };
  if (variantRule) {
    const result = variantsBulkUpdate(text, document, options.source, after, variantRule);
    if (typeof result === 'string') return { refusal: `${variantRule.rule}: ${result}.` };
    text = result.text;
    migration.edits.push(...result.edits);
    migration.notes.push({
      rule: variantRule.rule,
      offset: 0,
      expression: 'productVariantUpdate(input:) → productVariantsBulkUpdate(productId:, variants:)',
      reason: `Shopify replaced productVariantUpdate with productVariantsBulkUpdate (${variantRule.source}); the call now sends the variant's product and the variant as a one-element list, and reads of productVariant read the first returned variant.`,
    });
    if (result.liveCase) migration.liveCases.push(result.liveCase);
    else migration.uncovered.push(operationName() ?? 'anonymous mutation');
  } else {
    const removed = removeUnusedVariables(text);
    if (!removed.length) return undefined;
    for (const entry of removed) {
      migration.edits.push({
        file: segment.file,
        start: segment.sourceStart + entry.start,
        end: segment.sourceStart + entry.end,
        replacement: entry.replacement,
        changeId: UNUSED_VARIABLE_RULE,
        rule: UNUSED_VARIABLE_RULE,
      });
      migration.notes.push({
        rule: UNUSED_VARIABLE_RULE,
        offset: entry.start,
        expression: `unused ${entry.name}`,
        reason: `The document declares ${entry.name} but never uses it, which GraphQL forbids (${SPEC}), so Shopify rejects it on every version; the declaration is removed and the value the code still sends is ignored.`,
      });
    }
    text = [...removed]
      .sort((a, b) => b.start - a.start)
      .reduce(
        (result, entry) =>
          result.slice(0, entry.start) + entry.replacement + result.slice(entry.end),
        text,
      );
    const operation = parse(text).definitions.find(
      (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
    );
    // A query is sent with the removed variables to show Shopify ignores them; a mutation needs a
    // case that creates what it changes, which Refit cannot write here.
    if (operation?.operation === 'query' && !operation.variableDefinitions?.length)
      migration.liveCases.push({
        operationName: operation.name?.value ?? null,
        variables: Object.fromEntries(
          removed
            .flatMap((entry) => entry.name.split(', '))
            .map((name) => [name.slice(1), 'unused']),
        ),
        setup: [],
        cleanup: [],
      });
    else migration.uncovered.push(operation?.name?.value ?? 'anonymous operation');
  }
  const remaining = errorsOn(after, text);
  if (remaining.length)
    return {
      refusal: [
        `After the migration the document still fails on the target schema: ${remaining[0].message}`,
        ...unmigratedReasons(text, remaining, after),
      ].join(' '),
    };
  // Every variable type of the rewritten document exists on the target.
  for (const definition of parse(text).definitions)
    if (definition.kind === Kind.OPERATION_DEFINITION)
      for (const entry of definition.variableDefinitions ?? []) {
        let type = entry.type;
        while (type.kind !== Kind.NAMED_TYPE) type = type.type;
        if (!after.getType(type.name.value))
          return { refusal: `${type.name.value} is not on the target` };
      }
  return { ...migration, text };
}

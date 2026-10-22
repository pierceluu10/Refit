// The API versions a repository pins for providers that version their API by header, SDK option
// or URL path (docs/COMMERCE-APIS.md). Each form comes from the provider's published SDK code or
// README, read on 2026-10-22. Only literals are reported, directly or through a `const` in the same
// file; a computed value is not a pin Refit can read. Nothing is installed, run or sent.
import ts from 'typescript-compiler';
import { readRepository } from './repository.ts';
import { TEST_PATH } from './source-paths.ts';
import type { Repository } from './types.ts';

export interface ApiVersionPin {
  provider: string;
  version: string;
  file: string;
  line: number;
  form: 'header' | 'option' | 'path';
  use: 'live' | 'test';
  text: string;
}

// Version headers, by lower-case name, from each SDK's request code: plaid-node, square
// (`Square-Version`), braintree_node GraphQL, paddle (Billing API), shippo, lob-node and
// coinbase-commerce-node.
const HEADERS = new Map([
  ['plaid-version', 'plaid'],
  ['square-version', 'square'],
  ['braintree-version', 'braintree'],
  ['paddle-version', 'paddle'],
  ['shippo-api-version', 'shippo'],
  ['lob-version', 'lob'],
  ['x-cc-version', 'coinbase-commerce'],
]);
// SDK options that set the version header, with the package whose client takes them: the legacy
// Square client's `squareVersion`, the Square SDK's per-request `version`, Shippo's
// `shippoApiVersion` and lob-node's `apiVersion`. `direct` options count only in an argument of a
// call or `new` on a name the file binds to that package, since `apiVersion` and `version` are
// common keys; the others count anywhere in a file that imports the package.
const OPTIONS: { provider: string; key: string; module: string; direct: boolean }[] = [
  { provider: 'square', key: 'squareVersion', module: 'square', direct: false },
  { provider: 'square', key: 'version', module: 'square', direct: false },
  { provider: 'shippo', key: 'shippoApiVersion', module: 'shippo', direct: false },
  { provider: 'lob', key: 'apiVersion', module: 'lob', direct: true },
];
// Every header and option above takes a dated version, except Paddle's, which takes an integer.
// A Square `version: 1` is a catalog object's version, not the API's.
const DATED_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_VERSION = /^\d{1,2}$/;

function versionValue(provider: string, value: string | undefined) {
  return (
    value !== undefined &&
    (DATED_VERSION.test(value) || (provider === 'paddle' && INTEGER_VERSION.test(value)))
  );
}
// Versioned URL paths. Adyen versions each API separately, so its version names the API: the path
// segment before the version (`/checkout/v71`, `/pal/servlet/Payment/v68`, `/bcl/v2`) or the
// host's API name (`checkout-test.adyen.com/v71`, `management-live.adyen.com/v3`).
const PATHS: { provider: string; pattern: RegExp }[] = [
  {
    provider: 'adyen',
    pattern:
      /\b(?:([a-z]+)-(?:test|live)\.adyen\.com|[\w{}$-]*adyenpayments\.com)((?:\/[\w-]+)*?)\/v(\d+)(?![\w.])/g,
  },
  { provider: 'easypost', pattern: /\bapi\.easypost\.com\/(v\d+)(?![\w.])/g },
  { provider: 'lemon-squeezy', pattern: /\bapi\.lemonsqueezy\.com\/(v\d+)(?![\w.])/g },
  { provider: 'lob', pattern: /\bapi\.lob\.com\/(v\d+)(?![\w.])/g },
];

// A cheap test for any versioned host above, before a file is parsed.
const PATH_HOSTS =
  /adyen(?:payments)?\.com|api\.easypost\.com|api\.lemonsqueezy\.com|api\.lob\.com/;

function pathVersion(provider: string, match: RegExpExecArray) {
  if (provider !== 'adyen') return match[1];
  const segments = (match[2] ?? '').split('/').filter(Boolean);
  const api = segments.at(-1) ?? match[1] ?? 'checkout';
  return `${api}/v${match[3]}`;
}

function keyText(name: ts.PropertyName | ts.Expression | undefined) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

// Names a file binds to an imported or required module: default, namespace and named imports, and
// `const x = require('m')` or `const { a } = require('m')`.
function boundNames(source: ts.SourceFile, module: string) {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === module &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) names.add(element.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isRequire(node.initializer, module)) {
      if (ts.isIdentifier(node.name)) names.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name)) names.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isRequire(node: ts.Expression, module: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text === module
  );
}

function rootName(node: ts.Expression): string | undefined {
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) node = node.expression;
  return ts.isIdentifier(node) ? node.text : undefined;
}

// The string a literal or a same-file `const` initialized with one holds.
function literalValue(node: ts.Expression, constants: Map<string, string>) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  return undefined;
}

function fileConstants(source: ts.SourceFile) {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      node.flags & ts.NodeFlags.Const &&
      node.declarations.length
    )
      for (const declaration of node.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isStringLiteralLike(declaration.initializer)
        )
          constants.set(declaration.name.text, declaration.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

// Every pin in one source file.
export function fileApiVersionPins(path: string, content: string): ApiVersionPin[] {
  const lower = content.toLowerCase();
  const headerNames = [...HEADERS.keys()].filter((name) => lower.includes(name));
  const options = OPTIONS.filter(
    (option) => content.includes(option.key) && content.includes(option.module),
  );
  if (!headerNames.length && !options.length && !PATH_HOSTS.test(content)) return [];
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const constants = fileConstants(source);
  const lines = content.split('\n');
  const use = TEST_PATH.test(path) ? 'test' : 'live';
  const pins: ApiVersionPin[] = [];
  const add = (provider: string, version: string, node: ts.Node, form: ApiVersionPin['form']) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const text = lines[line].trim();
    pins.push({
      provider,
      version,
      file: path,
      line: line + 1,
      form,
      use,
      text: text.length > 160 ? `${text.slice(0, 159)}…` : text,
    });
  };
  const importsOf = new Map<string, boolean>();
  const imports = (module: string) => {
    if (!importsOf.has(module))
      importsOf.set(
        module,
        new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)['"]${module}(?:/[^'"]*)?['"]`).test(
          content,
        ),
      );
    return importsOf.get(module)!;
  };
  const bound = new Map<string, Set<string>>();
  const boundTo = (module: string) => {
    if (!bound.has(module)) bound.set(module, boundNames(source, module));
    return bound.get(module)!;
  };
  // Whether an object literal is an argument of a call or `new` on a name bound to the module, or
  // of `require('module')(…)` itself.
  const directArgument = (object: ts.ObjectLiteralExpression, module: string) => {
    const call = object.parent;
    if (!(ts.isCallExpression(call) || ts.isNewExpression(call))) return false;
    if (!call.arguments?.includes(object)) return false;
    if (isRequire(call.expression, module)) return true;
    const root = rootName(call.expression);
    return root !== undefined && boundTo(module).has(root);
  };
  const visit = (node: ts.Node) => {
    // `{ 'Plaid-Version': '2020-09-14' }` and SDK options in object literals.
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const key = keyText(node.name);
      const value = literalValue(node.initializer, constants);
      if (key && value !== undefined) {
        const header = HEADERS.get(key.toLowerCase());
        if (header && versionValue(header, value)) add(header, value, node, 'header');
        for (const option of options)
          if (
            option.key === key &&
            versionValue(option.provider, value) &&
            imports(option.module) &&
            (!option.direct || directArgument(node.parent, option.module))
          )
            add(option.provider, value, node, 'option');
      }
    }
    // `headers.set('Plaid-Version', '2020-09-14')` and `.append(…)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['set', 'append'].includes(node.expression.name.text) &&
      node.arguments.length >= 2
    ) {
      const key = keyText(node.arguments[0]);
      const value = literalValue(node.arguments[1], constants);
      const header = key ? HEADERS.get(key.toLowerCase()) : undefined;
      if (header && versionValue(header, value)) add(header, value!, node, 'header');
    }
    // `headers['Plaid-Version'] = '2020-09-14'`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left)
    ) {
      const key = keyText(node.left.argumentExpression);
      const value = literalValue(node.right, constants);
      const header = key ? HEADERS.get(key.toLowerCase()) : undefined;
      if (header && versionValue(header, value)) add(header, value!, node, 'header');
    }
    // Versioned URL paths in strings and template pieces.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      for (const { provider, pattern } of PATHS)
        for (const match of node.text.matchAll(pattern))
          add(provider, pathVersion(provider, match), node, 'path');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return pins;
}

export function repositoryApiVersionPins(repository: Pick<Repository, 'files'>) {
  return repository.files.flatMap((file) => fileApiVersionPins(file.path, file.content));
}

// The pinned API versions in a repository's JS/TS source, for the inventory.
export async function detectApiVersionPins(directory: string) {
  return repositoryApiVersionPins(await readRepository(directory));
}

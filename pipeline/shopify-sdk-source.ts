import ts from 'typescript-compiler';
import { SHOPIFY_PACK } from './rule-pack.ts';
import type { Location, Repository, SourceEdit } from './types.ts';

export const SHOPIFY_SDK_RULE = 'shopify-sdk-upgrade';
// Entry points that exported LATEST_API_VERSION before @shopify/shopify-api 12.0.0 (48d3631),
// @shopify/shopify-app-remix 4.0.0 (762224d) and @shopify/shopify-app-react-router 0.2.0
// (c02018f) removed it, and that export ApiVersion after.
const SDK_ENTRIES = new Set([
  '@shopify/shopify-api',
  '@shopify/shopify-app-remix/server',
  '@shopify/shopify-app-react-router/server',
]);
const SHOPIFY_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@shopify\/[^'"]+['"]/;
const CONFIG_CALL = /(?:^|\.)shopify(?:App|Api)$/;
const LINE_REST = /^,?[ \t]*(?:\/\/[^\n]*)?(?:\r?\n|$)/;
// Future flags the upgraded releases accept, read from their published types on 2026-10-22:
// shopify-api 12.3.0, shopify-app-remix 4.1.1 and shopify-app-react-router 1.1.1. shopify-app-express
// 6.0.5 has none of its own; its `api.future` goes to shopify-api.
const API_FUTURE_FLAGS = ['unstable_managedPricingSupport', 'customerAddressDefaultFix'];
const FUTURE_FLAGS: Record<string, string[]> = {
  '@shopify/shopify-api': API_FUTURE_FLAGS,
  '@shopify/shopify-app-express': API_FUTURE_FLAGS,
  '@shopify/shopify-app-remix': ['unstable_newEmbeddedAuthStrategy', 'expiringOfflineAccessTokens'],
  '@shopify/shopify-app-react-router': ['expiringOfflineAccessTokens'],
};
const BILLING_CHANGE =
  'Billing changed in @shopify/shopify-api 12.0.0: the lineItemBilling future flags and the billing config they changed were removed (a5be0d0), and billing.check returns an object (docs/migrating-to-v12.md).';
// Uses the majors changed (data/packs/shopify.json symbolReviews). Each stops for review.
const CHANGED_APIS = new Map(
  Object.entries(SHOPIFY_PACK.symbolReviews).map(([symbol, review]) => [symbol, review.reason]),
);
const API_VERSION_REQUIRED =
  'apiVersion is required from @shopify/shopify-api 12.0.0 (48d3631), and this shopifyApp or shopifyApi config sets none Refit can see; choose a dated ApiVersion member.';
const REMOVED_FLAGS = new Map([
  ['lineItemBilling', BILLING_CHANGE],
  ['v10_lineItemBilling', BILLING_CHANGE],
]);

// Breaking changes of @shopify/shopify-api 13.0.0 and 14.0.0 and @shopify/shopify-app-react-router
// 2.0.0 (each package's CHANGELOG.md in the shopify-app-js repository, read 2026-10-29) that code shows.
const CUSTOM_SHOP_DOMAINS =
  '@shopify/shopify-api 13.0.0 removed customShopDomains for domainTransformations, which takes { match, transform } rules (78c8968); rewrite it by hand.';
const SUB_TOPIC =
  '@shopify/shopify-api 14.0.0 removed subTopic (84397d9): webhook registrations filter with `filter`, and metaobjects webhooks require one.';
const EMBEDDED =
  '@shopify/shopify-app-react-router 2.0.0 serves embedded apps only (0dbb90c): AppProvider has no embedded prop and shopifyApp rejects isEmbeddedApp; a non-embedded app needs review.';

// The majors an upgrade crosses: each package's locked and upgraded release.
export type SdkMoves = { name: string; from: string | null; to: string }[];

const crosses = (moves: SdkMoves, name: string, major: number) =>
  moves.some(
    (move) =>
      move.name === name &&
      Number((move.from ?? '0').split('.')[0]) < major &&
      Number(move.to.split('.')[0]) >= major,
  );

export interface ShopifySdkSourceChanges {
  edits: SourceEdit[];
  stops: (Location & { reason: string })[];
}

// The source edits the Shopify SDK upgrade can confirm in files that import a Shopify package:
// LATEST_API_VERSION, removed in the target majors, becomes ApiVersion.`member` where it sets
// `apiVersion`, and the removed `removeRest: true` future flag of a shopifyApp or shopifyApi config
// is dropped. Every other use of a removed or changed API stops for review.
export function shopifySdkSourceChanges(
  repository: Repository,
  primary: string,
  member: string,
  moves: SdkMoves = [],
): ShopifySdkSourceChanges {
  const v13 = crosses(moves, '@shopify/shopify-api', 13);
  const v14 = crosses(moves, '@shopify/shopify-api', 14);
  const embeddedOnly = crosses(moves, '@shopify/shopify-app-react-router', 2);
  const edits: SourceEdit[] = [];
  const stops: ShopifySdkSourceChanges['stops'] = [];
  for (const { path, content } of repository.files) {
    if (!SHOPIFY_IMPORT.test(content)) continue;
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const reasons = new Set<string>();
    const stop = (node: ts.Node, reason: string) => {
      if (reasons.has(reason)) return;
      reasons.add(reason);
      const position = file.getLineAndCharacterOfPosition(node.getStart());
      stops.push({ file: path, line: position.line + 1, column: position.character + 1, reason });
    };
    const edit = (start: number, end: number, replacement = '') =>
      edits.push({ file: path, start, end, replacement, changeId: SHOPIFY_SDK_RULE });
    // Removes a list element: its whole line when it stands alone there, else it and a separator.
    const remove = (node: ts.Node, list: readonly ts.Node[], container: ts.Node) => {
      const lineStart = content.lastIndexOf('\n', node.getStart() - 1) + 1;
      const after = LINE_REST.exec(content.slice(node.getEnd()));
      const index = list.indexOf(node);
      if (!content.slice(lineStart, node.getStart()).trim() && after)
        edit(lineStart, node.getEnd() + after[0].length);
      else if (index < list.length - 1) edit(node.getStart(), list[index + 1].getStart());
      else if (index > 0) edit(list[index - 1].getEnd(), node.getEnd());
      else edit(container.getStart(), container.getEnd(), '{}');
    };
    const inConfig = (node: ts.Node) => {
      let current: ts.Node = node;
      while (
        ts.isPropertyAssignment(current.parent) ||
        ts.isObjectLiteralExpression(current.parent)
      )
        current = current.parent;
      const call = current.parent;
      return (
        ts.isCallExpression(call) &&
        call.arguments.some((argument) => argument === current) &&
        CONFIG_CALL.test(call.expression.getText())
      );
    };
    const latestImports: {
      element: SdkBinding;
      elements: readonly SdkBinding[];
      statement: ts.Statement;
    }[] = [];
    const stopped: ts.Node[] = [];
    let apiVersionImported = false;
    for (const statement of file.statements) {
      const elements = sdkBindings(statement);
      for (const element of elements) {
        const { plain, removable } = bindingForm(element);
        const imported = (element.propertyName ?? element.name).getText();
        if (imported === 'ApiVersion' && plain) apiVersionImported = true;
        if (imported !== 'LATEST_API_VERSION') continue;
        if (removable) latestImports.push({ element, elements, statement });
        else {
          stopped.push(element.name, ...(element.propertyName ? [element.propertyName] : []));
          stop(
            element,
            'LATEST_API_VERSION is imported under another name, as a type, with a default value or beside a default import; replace it with a dated ApiVersion member by hand.',
          );
        }
      }
    }
    const handled = new Set<ts.Node>([
      ...stopped,
      ...latestImports.map(({ element }) => element.name),
    ]);
    const future = (property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) => {
      const flags = ts.isPropertyAssignment(property) ? property.initializer : undefined;
      if (!flags || !ts.isObjectLiteralExpression(flags))
        return stop(property, 'The future flags are not an object literal Refit can check.');
      for (const flag of flags.properties) {
        const name =
          flag.name && (ts.isIdentifier(flag.name) || ts.isStringLiteral(flag.name))
            ? flag.name.text
            : undefined;
        if (!ts.isPropertyAssignment(flag) || name === undefined) {
          stop(flag, 'A future flag is a spread, shorthand or computed name Refit cannot check.');
          continue;
        }
        if (name !== 'removeRest') {
          if (!FUTURE_FLAGS[primary].includes(name))
            stop(
              flag,
              `future.${name} is not a flag of the upgraded ${primary}.${REMOVED_FLAGS.has(name) ? ` ${REMOVED_FLAGS.get(name)}` : ''}`,
            );
          continue;
        }
        handled.add(flag.name);
        if (flag.initializer.kind === ts.SyntaxKind.TrueKeyword)
          remove(flag, flags.properties, flags);
        else
          stop(
            flag,
            `future.removeRest is ${flag.initializer.getText()}; @shopify/shopify-app-remix 4.0.0 (d7bd799) removed REST and the flag, so REST use needs review.`,
          );
      }
    };
    const latestUses: ts.Identifier[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText() === 'future' &&
        inConfig(node)
      )
        future(node);
      if (ts.isCallExpression(node) && CONFIG_CALL.test(node.expression.getText())) {
        // @shopify/shopify-app-express takes the @shopify/shopify-api settings under `api`.
        const [config] = node.arguments;
        const api =
          config && ts.isObjectLiteralExpression(config) ? property(config, 'api') : undefined;
        const settings = api
          ? ts.isPropertyAssignment(api)
            ? api.initializer
            : undefined
          : config;
        if (
          !settings ||
          !ts.isObjectLiteralExpression(settings) ||
          !property(settings, 'apiVersion')
        )
          stop(node, API_VERSION_REQUIRED);
      }
      // `isEmbeddedApp: true` goes; any other value stops.
      if (
        embeddedOnly &&
        ts.isPropertyAssignment(node) &&
        node.name.getText().replace(/['"]/g, '') === 'isEmbeddedApp' &&
        inConfig(node) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        handled.add(node.name);
        if (node.initializer.kind === ts.SyntaxKind.TrueKeyword)
          remove(node, node.parent.properties, node.parent);
        else stop(node, EMBEDDED);
      }
      // `<AppProvider embedded>` and `embedded={true}` lose the prop; any other value stops.
      if (
        embeddedOnly &&
        ts.isJsxAttribute(node) &&
        node.name.getText() === 'embedded' &&
        /(?:^|\.)AppProvider$/.test(node.parent.parent.tagName.getText())
      ) {
        const value = node.initializer;
        if (
          !value ||
          (ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.TrueKeyword)
        )
          edit(node.getFullStart(), node.getEnd());
        else stop(node, EMBEDDED);
      }
      if (ts.isIdentifier(node) && !handled.has(node)) {
        if (v13 && node.text === 'customShopDomains') stop(node, CUSTOM_SHOP_DOMAINS);
        if (v14 && node.text === 'subTopic') stop(node, SUB_TOPIC);
        if (embeddedOnly && node.text === 'isEmbeddedApp') stop(node, EMBEDDED);
        if (node.text === 'LATEST_API_VERSION') latestUses.push(node);
        else if (CHANGED_APIS.has(node.text)) stop(node, CHANGED_APIS.get(node.text)!);
        else if (node.text === 'removeRest')
          stop(
            node,
            'removeRest appears outside the shopifyApp future flags Refit edits; @shopify/shopify-app-remix 4.0.0 (d7bd799) removed it with REST.',
          );
      }
      if (
        (ts.isPropertyAccessExpression(node) && node.name.text === 'billing') ||
        (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === 'billing') ||
        ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          node.name.getText() === 'billing' &&
          inConfig(node))
      )
        stop(node, BILLING_CHANGE);
      ts.forEachChild(node, visit);
    };
    visit(file);
    const settable = latestUses.filter(
      (use) =>
        ts.isPropertyAssignment(use.parent) &&
        use.parent.initializer === use &&
        use.parent.name.getText().replace(/['"]/g, '') === 'apiVersion',
    );
    if (latestUses.length && (!latestImports.length || settable.length < latestUses.length)) {
      stop(
        latestUses.find((use) => !settable.includes(use)) ?? latestUses[0],
        'LATEST_API_VERSION, removed in the upgraded SDK, is used where Refit cannot pin a dated ApiVersion (outside an apiVersion setting, or without its import).',
      );
      continue;
    }
    for (const use of settable) edit(use.getStart(), use.getEnd(), `ApiVersion.${member}`);
    latestImports.forEach(({ element, elements, statement }, index) => {
      if (index === 0 && !apiVersionImported && settable.length)
        edit(element.name.getStart(), element.name.getEnd(), 'ApiVersion');
      else if (elements.length > 1) remove(element, elements, statement);
      else remove(statement, file.statements, file);
    });
  }
  return { edits, stops };
}

const property = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find((entry) => entry.name?.getText().replace(/['"]/g, '') === name);

type SdkBinding = ts.ImportSpecifier | ts.BindingElement;

// The named imports of an SDK entry point, or the names destructured from its require() call.
function sdkBindings(statement: ts.Statement): readonly SdkBinding[] {
  if (ts.isImportDeclaration(statement)) {
    const named = statement.importClause?.namedBindings;
    return ts.isStringLiteral(statement.moduleSpecifier) &&
      SDK_ENTRIES.has(statement.moduleSpecifier.text) &&
      named &&
      ts.isNamedImports(named)
      ? named.elements
      : [];
  }
  if (!ts.isVariableStatement(statement)) return [];
  const [declaration, ...others] = statement.declarationList.declarations;
  const call = declaration.initializer;
  return !others.length &&
    ts.isObjectBindingPattern(declaration.name) &&
    call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'require' &&
    call.arguments.length === 1 &&
    ts.isStringLiteral(call.arguments[0]) &&
    SDK_ENTRIES.has(call.arguments[0].text)
    ? declaration.name.elements
    : [];
}

// `plain` binds a value under its exported name; `removable` can also be renamed or dropped alone.
function bindingForm(element: SdkBinding) {
  if (ts.isImportSpecifier(element)) {
    const clause = element.parent.parent;
    const plain = !element.propertyName && !element.isTypeOnly && !clause.isTypeOnly;
    return { plain, removable: plain && !clause.name };
  }
  const plain = !element.propertyName && !element.initializer && !element.dotDotDotToken;
  return { plain, removable: plain };
}

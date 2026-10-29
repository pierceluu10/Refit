import { parse, validate, type GraphQLSchema } from 'graphql';
import ts from 'typescript-compiler';
import { SHOPIFY_PACK } from './rule-pack.ts';
import { STOREFRONT_CLIENT_FACTORY, type ShopifyScan } from './shopify-analysis.ts';
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
const REFRESH_TOKENS =
  '@shopify/shopify-app-session-storage-prisma 8.0.0 stores refresh tokens (700377f), and this app turns on expiringOfflineAccessTokens: add refreshToken String? and refreshTokenExpires DateTime? to the Prisma Session model and run a migration first.';
const PRISMA_NOT_FOUND =
  'Prisma 6 removed NotFoundError: catch PrismaClientKnownRequestError with code P2025 instead (prisma.io upgrade guide to Prisma 6).';
const EMBEDDED =
  '@shopify/shopify-app-react-router 2.0.0 serves embedded apps only (0dbb90c): AppProvider has no embedded prop and shopifyApp rejects isEmbeddedApp; a non-embedded app needs review.';
// The Shopify app templates' line, which @shopify/shopify-api 13 still accepts and ignores.
const CUSTOM_DOMAIN_TEMPLATE =
  /^\.\.\.\(((?:process\.)?env)(\.SHOP_CUSTOM_DOMAIN|\[(["'])SHOP_CUSTOM_DOMAIN\3\])\?\{customShopDomains:\[\1\2\],?\}:\{\}\)$/;
const CUSTOM_DOMAIN_NOTE =
  "@shopify/shopify-api 13.0.0 removed customShopDomains and no longer supports the SHOP_CUSTOM_DOMAIN environment variable (78c8968), so the template's `customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN]` line no longer has an effect. Shopify's own React Router template keeps the same line on @shopify/shopify-app-react-router 3 (its app/shopify.server.ts at commit fa091e35), so Refit leaves it. Where SHOP_CUSTOM_DOMAIN is set, add a domainTransformations rule as the 13.0.0 changelog shows.";
// What <AppProvider embedded={false}> rendered in @shopify/shopify-app-react-router 1.x
// (dist/esm/react/components/AppProvider/AppProvider.mjs, 1.1.1): the Polaris script and the
// children. 2.0.0 (0dbb90c) says to remove it; the template does exactly this (89f43482).
const POLARIS_SCRIPT = '<script src="https://cdn.shopify.com/shopifycloud/polaris.js" />';
// The remix and React Router adapters' billing context passes returnObject: true to
// @shopify/shopify-api (server/authenticate/admin/billing/*.mjs, remix 3.8.2), so 12.0.0's
// billing.check change leaves it as it is; their own majors to 5 and 2 change no billing API.
const ADAPTERS = new Set(['@shopify/shopify-app-remix', '@shopify/shopify-app-react-router']);

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
  // Changes Refit leaves in place on purpose, for the draft.
  notes: string[];
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
  // Optional new columns, backward-compatible unless the app asks for refresh tokens.
  const refreshTokens = crosses(moves, '@shopify/shopify-app-session-storage-prisma', 8);
  const prismaSix = crosses(moves, 'prisma', 6);
  const edits: SourceEdit[] = [];
  const stops: ShopifySdkSourceChanges['stops'] = [];
  const notes = new Set<string>();
  for (const { path, content } of repository.files) {
    // NotFoundError lives in Prisma code, which need not import a Shopify package.
    if (!SHOPIFY_IMPORT.test(content) && !(prismaSix && /\bNotFoundError\b/.test(content)))
      continue;
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
    const remove = (node: ts.Node, list: readonly ts.Node[], container: ts.Node) =>
      edit(...removal(content, node, list, container));
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
        // a5be0d0: "If you have already adopted either of these flags you only need to remove the
        // flags"; in 11.x they only gate a log line (future/flags.mjs, 11.12.0).
        if (REMOVED_FLAGS.has(name) && flag.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          handled.add(flag.name);
          remove(flag, flags.properties, flags);
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
    // Tag names of the <AppProvider embedded={false}> elements replaced above.
    const providers: ts.Node[] = [];
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
        const opening = node.parent.parent;
        if (
          !value ||
          (ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.TrueKeyword)
        )
          edit(node.getFullStart(), node.getEnd());
        else if (
          ts.isJsxExpression(value) &&
          value.expression?.kind === ts.SyntaxKind.FalseKeyword &&
          opening.attributes.properties.length === 1 &&
          ts.isJsxOpeningElement(opening) &&
          ts.isJsxElement(opening.parent)
        ) {
          const indent = /[ \t]*$/.exec(content.slice(0, opening.getStart()))![0];
          edit(opening.getStart(), opening.getEnd(), `<>\n${indent}  ${POLARIS_SCRIPT}`);
          const closing = opening.parent.closingElement;
          edit(closing.getStart(), closing.getEnd(), '</>');
          providers.push(opening.tagName, closing.tagName);
        } else stop(node, EMBEDDED);
      }
      if (
        v13 &&
        ts.isSpreadAssignment(node) &&
        CUSTOM_DOMAIN_TEMPLATE.test(node.getText().replace(/\s/g, '')) &&
        ts.isObjectLiteralExpression(node.parent) &&
        inConfig(node.parent)
      ) {
        notes.add(CUSTOM_DOMAIN_NOTE);
        const mark = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && child.text === 'customShopDomains') handled.add(child);
          ts.forEachChild(child, mark);
        };
        mark(node);
      }
      if (ts.isIdentifier(node) && !handled.has(node)) {
        if (v13 && node.text === 'customShopDomains') stop(node, CUSTOM_SHOP_DOMAINS);
        if (v14 && node.text === 'subTopic') stop(node, SUB_TOPIC);
        if (prismaSix && node.text === 'NotFoundError') stop(node, PRISMA_NOT_FOUND);
        if (refreshTokens && node.text === 'expiringOfflineAccessTokens')
          stop(node, REFRESH_TOKENS);
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
        (!ADAPTERS.has(primary) &&
          ((ts.isPropertyAccessExpression(node) && node.name.text === 'billing') ||
            (ts.isBindingElement(node) &&
              (node.propertyName ?? node.name).getText() === 'billing'))) ||
        ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          node.name.getText() === 'billing' &&
          inConfig(node) &&
          !lineItemPlans(node))
      )
        stop(node, BILLING_CHANGE);
      ts.forEachChild(node, visit);
    };
    visit(file);
    // AppProvider goes from the import once no element uses it.
    if (providers.length)
      for (const statement of file.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== '@shopify/shopify-app-react-router/react'
        )
          continue;
        const named = statement.importClause?.namedBindings;
        const specifier =
          named && ts.isNamedImports(named)
            ? named.elements.find((element) => element.name.text === 'AppProvider')
            : undefined;
        if (!named || !ts.isNamedImports(named) || !specifier) continue;
        const uses: ts.Node[] = [];
        const find = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && child.text === 'AppProvider') uses.push(child);
          ts.forEachChild(child, find);
        };
        find(file);
        if (uses.every((use) => use === specifier.name || providers.includes(use)))
          named.elements.length > 1 || statement.importClause?.name
            ? remove(specifier, named.elements, named)
            : remove(statement, file.statements, file);
      }
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
    // A Storefront client or codegen project keeps its own version, which no Admin check covers.
    const storefront = settable.find((use) => {
      const options = use.parent.parent as ts.ObjectLiteralExpression;
      const factory = options.parent;
      return (
        ((ts.isCallExpression(factory) || ts.isNewExpression(factory)) &&
          STOREFRONT_CLIENT_FACTORY.test(factory.expression.getText())) ||
        options.properties.some(
          (property) =>
            property.name?.getText() === 'apiType' && /Storefront/.test(property.getText()),
        )
      );
    });
    if (storefront) {
      stop(
        storefront,
        'LATEST_API_VERSION, removed in the upgraded SDK, sets a Storefront API version here; Refit checks only Admin documents, so it does not choose a Storefront version.',
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
  return { edits, stops, notes: [...notes] };
}

// A billing config every plan of which @shopify/shopify-api 12 reads the same way: line-item plans
// and one-time plans (a5be0d0 moved only recurring plans into lineItems).
function lineItemPlans(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) {
  const plans = ts.isPropertyAssignment(node) ? node.initializer : undefined;
  return (
    plans !== undefined &&
    ts.isObjectLiteralExpression(plans) &&
    plans.properties.every((plan) => {
      const config =
        ts.isPropertyAssignment(plan) && ts.isObjectLiteralExpression(plan.initializer)
          ? plan.initializer
          : undefined;
      const interval = config && property(config, 'interval');
      return (
        config !== undefined &&
        config.properties.every((entry) => ts.isPropertyAssignment(entry)) &&
        (property(config, 'lineItems')
          ? !interval
          : interval !== undefined &&
            /(?:^|\.)OneTime$/.test((interval as ts.PropertyAssignment).initializer.getText()))
      );
    })
  );
}

// Removes a list element: its whole line when it stands alone there, else it and a separator.
function removal(
  content: string,
  node: ts.Node,
  list: readonly ts.Node[],
  container: ts.Node,
): [number, number, string?] {
  const lineStart = content.lastIndexOf('\n', node.getStart() - 1) + 1;
  const after = LINE_REST.exec(content.slice(node.getEnd()));
  const index = list.indexOf(node);
  if (!content.slice(lineStart, node.getStart()).trim() && after)
    return [lineStart, node.getEnd() + after[0].length];
  if (index < list.length - 1) return [node.getStart(), list[index + 1].getStart()];
  if (index > 0) return [list[index - 1].getEnd(), node.getEnd()];
  return [container.getStart(), container.getEnd(), '{}'];
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

export const SHOPIFY_VERSION_STRING_RULE = 'shopify-version-string';
// @shopify/shopify-api majors whose source Refit read for a dated apiVersion string the ApiVersion
// enum lacks (8.1.1, 9.7.2, 10.0.0, 11.12.0, 12.3.0 and 13.1.0, read 2026-10-29): validateConfig
// checks at most that apiVersion is set, and the value goes into request URLs
// (/admin/api/<version>/graphql.json, through @shopify/admin-api-client from 9.x, whose
// graphql-client 0.10.4 and 1.4.2 only warn outside a date-based list), log lines and
// utils.versionCompatible's numeric comparison. The remix 3.8.2 and 4.1.1, React Router 1.1.1 and
// express 5.0.17 and 6.0.5 adapters pass it through. 7.7.0's webhook registration reads
// privateMetafieldNamespaces, so 7.x is out. docs/SHOPIFY-SDK-UPGRADE.md has the reading.
const STRING_PIN_MAJORS = new Set([8, 9, 10, 11, 12, 13]);
// The GraphQL documents shopify.webhooks.register sends (lib/webhooks/register, identical in 8.1.1
// to 13.1.0), with sample arguments. They run at the pinned version too.
const WEBHOOK_DOCUMENTS = [
  'query { webhookSubscriptions(first: 250, after: null) { edges { node { id topic includeFields metafieldNamespaces endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } ... on WebhookEventBridgeEndpoint { arn } ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic } } } } pageInfo { endCursor hasNextPage } } }',
  'mutation { webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: {callbackUrl: "https://a.example/b", includeFields: ["id"], metafieldNamespaces: ["c"]}) { userErrors { field message } } }',
  'mutation { webhookSubscriptionUpdate(id: "gid://shopify/WebhookSubscription/1", webhookSubscription: {callbackUrl: "https://a.example/b"}) { userErrors { field message } } }',
  'mutation { webhookSubscriptionDelete(id: "gid://shopify/WebhookSubscription/1") { userErrors { field message } } }',
  'mutation { eventBridgeWebhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: {arn: "a"}) { userErrors { field message } } }',
  'mutation { pubSubWebhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: {pubSubProject: "a", pubSubTopic: "b"}) { userErrors { field message } } }',
];
const WEBHOOK_REGISTRATION = /^(?:registerWebhooks|register|addHandlers)$/;
const TYPESCRIPT = /\.[cm]?tsx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

// The smaller fix for apps that send only GraphQL: every ApiVersion member and LATEST_API_VERSION
// becomes the dated `version` string, with the locked SDK kept. Refused, with the reason, where the
// SDK could use the version for anything but GraphQL request URLs Refit validates: REST, billing,
// Storefront clients, or webhook topics the target does not have.
export function shopifyVersionStringPins(
  repository: Repository,
  scan: Pick<ShopifyScan, 'rest' | 'versions'>,
  sdkRelease: string | undefined,
  version: string,
  schema: GraphQLSchema,
): { edits: SourceEdit[] } | { reason: string } {
  const major = Number(sdkRelease?.split('.')[0]);
  if (!sdkRelease || !STRING_PIN_MAJORS.has(major))
    return {
      reason: `Refit read the @shopify/shopify-api source for a dated apiVersion string in majors 8 to 13 only${sdkRelease ? `, and the lockfile has ${sdkRelease}` : ''}.`,
    };
  if (scan.rest.length)
    return {
      reason: `The app sends REST Admin requests, whose resources the locked @shopify/shopify-api ${sdkRelease} has only for older versions.`,
    };
  if (scan.versions.some((entry) => entry.api === 'storefront'))
    return { reason: 'A Storefront client sets its own version.' };
  const topics = new Set(
    (schema.getType('WebhookSubscriptionTopic') as { getValues?: () => { name: string }[] })
      ?.getValues?.()
      .map((value) => value.name) ?? [],
  );
  const edits: SourceEdit[] = [];
  let registers = false;
  for (const { path, content } of repository.files) {
    // Billing, Storefront and webhook code often imports only the app's own shopify.server file.
    if (!SOURCE.test(path)) continue;
    const shopify = SHOPIFY_IMPORT.test(content);
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const typed = TYPESCRIPT.test(path);
    const literal = `'${version}'${typed ? ' as ApiVersion' : ''}`;
    let reason: string | undefined;
    let apiVersionImported = false;
    const latest: {
      element: SdkBinding;
      elements: readonly SdkBinding[];
      statement: ts.Statement;
    }[] = [];
    for (const statement of file.statements)
      for (const element of sdkBindings(statement)) {
        const { plain, removable } = bindingForm(element);
        const imported = (element.propertyName ?? element.name).getText();
        if (imported === 'ApiVersion' && plain) apiVersionImported = true;
        if (imported !== 'LATEST_API_VERSION') continue;
        if (!removable)
          reason ??= 'LATEST_API_VERSION is imported in a form Refit does not rewrite.';
        latest.push({ element, elements: sdkBindings(statement), statement });
      }
    const imports = new Set(latest.map(({ element }) => element.name));
    let replaced = 0;
    const visit = (node: ts.Node): void => {
      if (reason) return;
      if (
        ts.isIdentifier(node) &&
        ['billing', 'storefront', 'Storefront'].includes(node.text) &&
        !ts.isImportSpecifier(node.parent)
      )
        reason = `${path} uses ${node.text}, which sends requests at this version through @shopify/shopify-api ${sdkRelease}'s own code.`;
      if (
        ts.isIdentifier(node) &&
        WEBHOOK_REGISTRATION.test(node.text) &&
        (ts.isPropertyAccessExpression(node.parent) || ts.isCallExpression(node.parent))
      )
        registers = true;
      // Webhook topics the SDK registers: the keys of a config's `webhooks` and of addHandlers.
      const handlers =
        ts.isPropertyAssignment(node) && node.name.getText() === 'webhooks'
          ? node.initializer
          : ts.isCallExpression(node) && /(?:^|\.)addHandlers$/.test(node.expression.getText())
            ? node.arguments[0]
            : undefined;
      if (handlers) {
        if (!ts.isObjectLiteralExpression(handlers))
          reason = `${path} registers webhooks Refit cannot read.`;
        else
          for (const handler of handlers.properties) {
            const name =
              handler.name && (ts.isIdentifier(handler.name) || ts.isStringLiteral(handler.name))
                ? handler.name.text.toUpperCase().replace(/[/.]/g, '_')
                : undefined;
            if (!name || !topics.has(name))
              reason = `${path} registers the webhook topic ${handler.name?.getText() ?? handler.getText()}, which is not a ${version} WebhookSubscriptionTopic.`;
          }
      }
      const pin =
        (ts.isIdentifier(node) && node.text === 'LATEST_API_VERSION' && !imports.has(node)) ||
        (ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'ApiVersion' &&
          node.name.text !== 'Unstable');
      if (
        pin &&
        shopify &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isBindingElement(node.parent)
      ) {
        if (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent))
          reason = `${path} uses ${node.getText()} as a type.`;
        edits.push({
          file: path,
          start: node.getStart(),
          end: node.getEnd(),
          replacement: literal,
          changeId: SHOPIFY_VERSION_STRING_RULE,
        });
        replaced++;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (reason) return { reason };
    if (typed && replaced && !apiVersionImported && !latest.length)
      return { reason: `${path} pins a version without importing ApiVersion where Refit can see.` };
    // The cast names ApiVersion: a file that imported only LATEST_API_VERSION imports it instead.
    latest.forEach(({ element, elements, statement }, index) => {
      const [start, end, replacement = ''] =
        index === 0 && typed && !apiVersionImported
          ? [element.name.getStart(), element.name.getEnd(), 'ApiVersion']
          : elements.length > 1
            ? removal(content, element, elements, statement)
            : removal(content, statement, file.statements, file);
      edits.push({ file: path, start, end, replacement, changeId: SHOPIFY_VERSION_STRING_RULE });
    });
  }
  if (registers)
    for (const document of WEBHOOK_DOCUMENTS) {
      const errors = validate(schema, parse(document));
      if (errors.length)
        return {
          reason: `@shopify/shopify-api ${sdkRelease}'s webhook registration does not validate on ${version}: ${errors[0].message}`,
        };
    }
  if (!edits.length) return { reason: 'No pinned version to replace.' };
  return { edits };
}

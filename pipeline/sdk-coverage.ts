import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { typedStripeClients, type TraceSource } from './type-clients.ts';
import type { Repository } from './types.ts';

export type CoverageProvider = 'openai' | 'anthropic' | 'stripe';

// Top-level SDK resources used to recognize candidate call sites by shape alone.
// Source: openai-node, anthropic-sdk-typescript and stripe-node resource lists, 2026-10-14.
export const COVERAGE_SDKS: Record<
  CoverageProvider,
  { adapter: ProviderAdapter; resources: Set<string>; hint: RegExp }
> = {
  openai: {
    adapter: {
      id: 'openai',
      packageName: 'openai',
      defaultImport: true,
      namedExport: 'OpenAI',
      operations: [],
    },
    resources: new Set([
      'chat',
      'completions',
      'responses',
      'embeddings',
      'images',
      'audio',
      'files',
      'models',
      'moderations',
      'beta',
      'batches',
      'fineTuning',
      'vectorStores',
      'uploads',
      'realtime',
      'conversations',
      'evals',
      'containers',
      'webhooks',
    ]),
    hint: /openai|client|sdk|llm|\bai\b/i,
  },
  anthropic: {
    adapter: {
      id: 'anthropic',
      packageName: '@anthropic-ai/sdk',
      defaultImport: true,
      namedExport: 'Anthropic',
      operations: [],
    },
    resources: new Set(['messages', 'completions', 'models', 'beta']),
    hint: /anthropic|claude|client|sdk|llm|\bai\b/i,
  },
  stripe: {
    adapter: STRIPE,
    resources: new Set([
      'accounts',
      'accountLinks',
      'balance',
      'balanceTransactions',
      'billingPortal',
      'charges',
      'checkout',
      'coupons',
      'customers',
      'customerSessions',
      'disputes',
      'events',
      'files',
      'invoiceItems',
      'invoices',
      'paymentIntents',
      'paymentLinks',
      'paymentMethods',
      'payouts',
      'prices',
      'products',
      'promotionCodes',
      'refunds',
      'setupIntents',
      'subscriptionItems',
      'subscriptionSchedules',
      'subscriptions',
      'taxRates',
      'transfers',
      'webhooks',
      'webhookEndpoints',
      'tax',
      'terminal',
      'identity',
      'issuing',
      'treasury',
    ]),
    hint: /stripe|client|sdk/i,
  },
};

// Array, string and collection methods on values that merely share an SDK resource name.
const BUILTIN_METHODS = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'forEach',
  'reduce',
  'some',
  'every',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'includes',
  'indexOf',
  'sort',
  'reverse',
  'flat',
  'flatMap',
  'at',
  'fill',
  'keys',
  'values',
  'entries',
  'toString',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'split',
  'replace',
  'startsWith',
  'endsWith',
  'get',
  'set',
  'has',
  'add',
  'clear',
  'then',
  'catch',
  'finally',
]);

export type MissReason =
  | 'commonjs-require'
  | 'class-field'
  | 'object-property'
  | 'parameter'
  | 'imported-from-local-module'
  | 'local-default-import'
  | 'path-alias-import'
  | 'destructured'
  | 'factory-call'
  | 'inline-factory-call'
  | 'mutable-binding'
  | 'direct-client-not-traced'
  | 'other-variable'
  | 'unresolved';

export interface CallSite {
  file: string;
  line: number;
  column: number;
  expression: string;
  traced: boolean;
  traceSource?: TraceSource;
  likelySdk: boolean;
  reason?: MissReason;
}

// Splits `client.chat.completions.create` at the first SDK resource name, so receivers
// such as `this.client` or `ctx.openai` stay whole.
function chain(node: ts.CallExpression, resources: Set<string>) {
  const accesses: ts.PropertyAccessExpression[] = [];
  let current: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(current)) {
    accesses.unshift(current);
    current = current.expression;
  }
  const start = accesses.findIndex(
    (access, index) => index < accesses.length - 1 && resources.has(access.name.text),
  );
  if (start < 0) return undefined;
  return {
    names: accesses.slice(start).map((access) => access.name.text),
    root: accesses[start].expression,
  };
}

function sdkModule(specifier: string, packageName: string) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function requiresSdk(node: ts.Node | undefined, packageName: string): boolean {
  if (!node) return false;
  if (ts.isAwaitExpression(node)) return requiresSdk(node.expression, packageName);
  if (ts.isPropertyAccessExpression(node)) return requiresSdk(node.expression, packageName);
  if (ts.isNewExpression(node)) return requiresSdk(node.expression, packageName);
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    sdkModule(node.arguments[0].text, packageName)
  );
}

function classifyMiss(
  root: ts.Expression,
  checker: ts.TypeChecker,
  packageName: string,
  usesRequire: boolean,
): MissReason {
  if (ts.isCallExpression(root) || ts.isAwaitExpression(root)) return 'inline-factory-call';
  if (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
    return root.expression.kind === ts.SyntaxKind.ThisKeyword ? 'class-field' : 'object-property';
  if (!ts.isIdentifier(root)) return 'unresolved';
  const declaration = checker.getSymbolAtLocation(root)?.declarations?.[0];
  if (!declaration) return usesRequire ? 'commonjs-require' : 'unresolved';
  if (ts.isParameter(declaration)) return 'parameter';
  if (ts.isBindingElement(declaration)) {
    let parent: ts.Node = declaration.parent;
    while (
      ts.isObjectBindingPattern(parent) ||
      ts.isArrayBindingPattern(parent) ||
      ts.isBindingElement(parent)
    )
      parent = parent.parent;
    return ts.isParameter(parent) ? 'parameter' : 'destructured';
  }
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
    const module = ts.isImportSpecifier(declaration)
      ? declaration.parent.parent.parent.moduleSpecifier
      : declaration.parent.moduleSpecifier;
    if (!ts.isStringLiteral(module)) return 'unresolved';
    // Common tsconfig/bundler aliases such as `@/lib/stripe`, `~/stripe` and `#lib/ai`.
    if (/^(?:@\/|~\/|#)/.test(module.text)) return 'path-alias-import';
    if (!module.text.startsWith('.')) return 'unresolved';
    return ts.isImportClause(declaration) ? 'local-default-import' : 'imported-from-local-module';
  }
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    if (requiresSdk(initializer, packageName)) return 'commonjs-require';
    const list = declaration.parent;
    if (ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.Const))
      return 'mutable-binding';
    if (initializer && ts.isNewExpression(initializer))
      return usesRequire ? 'commonjs-require' : 'direct-client-not-traced';
    const unwrapped =
      initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
    if (unwrapped && ts.isCallExpression(unwrapped)) return 'factory-call';
    return 'other-variable';
  }
  if (ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
    return 'object-property';
  return 'unresolved';
}

// `typeTracing`: also trace Stripe calls by the receiver's type (type-clients.ts).
export function measureCoverage(
  repository: Repository,
  provider: CoverageProvider,
  options: { typeTracing?: boolean; stripePackage?: string } = {},
) {
  const sdk = COVERAGE_SDKS[provider];
  const typed =
    options.typeTracing && provider === 'stripe'
      ? typedStripeClients(repository, options.stripePackage)
      : undefined;
  const analysis = analyzeRepository(repository, [], sdk.adapter, {}, [], [], [], [], {
    typedClients: typed?.clients,
  });
  const traced = new Map(
    analysis.sdkCalls.map((call) => [
      `${call.file}\0${call.line}\0${call.column}`,
      call.traceSource,
    ]),
  );
  const sites: CallSite[] = [];
  for (const file of repository.files) {
    const program = ts.createProgram(
      [file.path],
      { allowJs: true, noLib: true },
      {
        ...ts.createCompilerHost({}),
        fileExists: (name) => name === file.path,
        readFile: (name) => (name === file.path ? file.content : undefined),
        getSourceFile: (name, version) =>
          name === file.path ? ts.createSourceFile(name, file.content, version, true) : undefined,
        writeFile: () => undefined,
      },
    );
    const source = program.getSourceFile(file.path);
    if (!source) continue;
    const checker = program.getTypeChecker();
    const imports = new RegExp(
      `(?:from\\s+|require\\(\\s*)['"]${sdk.adapter.packageName.replace(/[/.@-]/g, '\\$&')}(?:/[^'"]*)?['"]`,
    );
    const importsSdk = imports.test(file.content);
    const usesRequire = /require\(\s*['"]/.test(file.content) && importsSdk;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const split = chain(node, sdk.resources);
        if (split && !BUILTIN_METHODS.has(split.names.at(-1)!)) {
          const { names, root } = split;
          const position = source.getLineAndCharacterOfPosition(node.getStart());
          const site = {
            file: file.path,
            line: position.line + 1,
            column: position.character + 1,
            expression: `${root.getText(source).slice(0, 60)}.${names.join('.')}`,
          };
          const traceSource = traced.get(`${site.file}\0${site.line}\0${site.column}`);
          const isTraced = Boolean(traceSource);
          sites.push({
            ...site,
            traced: isTraced,
            ...(traceSource ? { traceSource } : {}),
            likelySdk: isTraced || importsSdk || sdk.hint.test(root.getText(source)),
            ...(isTraced
              ? {}
              : {
                  reason: classifyMiss(root, checker, sdk.adapter.packageName, usesRequire),
                }),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

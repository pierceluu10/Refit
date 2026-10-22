import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { AGENT_CATALOG, detectProviders, type AgentDetection } from './agent-catalog.ts';
import { TEST_PATH } from './deadline-exposure.ts';
import { loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import { installedVersion, satisfiesRange, sdkTarget } from './sdk-deadlines.ts';
import { excerpt, lineOf, requiredModule, sourceOf, unwrap } from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';

// Review-only detection for messaging APIs (Twilio, SendGrid, Resend, Postmark, Mailgun), read from
// source without running it: SDK members the SDK's own declarations mark deprecated
// (`client.verify.services` in twilio, `mg.domains.getTracking` in mailgun.js), raw calls to
// endpoints a provider's changelog names as removed, and declared packages that are retired or out
// of support. Nothing is edited and no provider is contacted.

export const MESSAGING_DEPRECATIONS = new URL(
  '../data/messaging-deprecations.json',
  import.meta.url,
);
export const MESSAGING_ENDPOINTS = new URL('../data/messaging-endpoints.json', import.meta.url);
export const MESSAGING_PROVIDERS = ['twilio', 'sendgrid', 'resend', 'postmark', 'mailgun'] as const;
export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];
// The SDK each generated member list belongs to, and the provider it is for.
const SDK_PROVIDERS: Record<string, MessagingProvider> = {
  twilio: 'twilio',
  'mailgun.js': 'mailgun',
};
// A chain's receiver names the provider when the SDK is loaded elsewhere: `this.twilioClient`,
// `mailgunClient`, `mg`.
const RECEIVER_NAMES: Record<MessagingProvider, RegExp> = {
  twilio: /twilio/i,
  sendgrid: /sendgrid|sgMail/i,
  resend: /resend/i,
  postmark: /postmark/i,
  mailgun: /mailgun|(?:^|\.)mg$/i,
};

export interface MessagingCall {
  provider: MessagingProvider;
  kind: 'deprecated-member' | 'removed-endpoint';
  file: string;
  line: number;
  // `test` for test, spec, story, fixture and example files.
  use: 'live' | 'test';
  // `verify.services`, `domains.getTracking`, or the endpoint path.
  member: string;
  // The member chain or URL as written: `client.verify.services`.
  call: string;
  message: string;
  replacement: string | null;
  // The page the fact comes from: the SDK release whose declarations mark it, or the changelog.
  source: string;
  // The date the endpoint was removed; null for deprecated members, which have no announced date.
  date: string | null;
  text: string;
}

export interface MessagingPackage {
  provider: MessagingProvider;
  name: string;
  file: string;
  declared: string;
  locked: string | null;
  // npm's notice for a retired package (`sendgrid`, `mailgun-js`).
  deprecated: string | null;
  // The registry deadline this declaration falls under, such as twilio below 6.0.0.
  deadline: { id: string; date: string } | null;
}

export interface MessagingScan {
  providers: AgentDetection[];
  packages: MessagingPackage[];
  calls: MessagingCall[];
  warnings: string[];
}

interface Member {
  path: string;
  message: string;
  replacement: string | null;
}

export interface MessagingData {
  sdks: Map<string, { provider: MessagingProvider; version: string; members: Member[] }>;
  retired: Map<string, string | null>;
  endpoints: {
    provider: MessagingProvider;
    host: string;
    path: string;
    date: string;
    message: string;
    replacement: string | null;
    source: string;
  }[];
  registry: DeadlineRegistry;
}

let cached: Promise<MessagingData> | undefined;
export function loadMessagingData(): Promise<MessagingData> {
  const load = async (): Promise<MessagingData> => {
    const deprecations = JSON.parse(await readFile(MESSAGING_DEPRECATIONS, 'utf8'));
    const endpoints = JSON.parse(await readFile(MESSAGING_ENDPOINTS, 'utf8'));
    return {
      sdks: new Map(
        Object.entries(
          deprecations.sdks as Record<string, { version: string; members: Member[] }>,
        ).map(([name, sdk]) => [name, { provider: SDK_PROVIDERS[name], ...sdk }]),
      ),
      retired: new Map(
        Object.entries(deprecations.retired as Record<string, { deprecated: string | null }>).map(
          ([name, item]) => [name, item.deprecated],
        ),
      ),
      endpoints: endpoints.endpoints,
      registry: await loadDeadlineRegistry(),
    };
  };
  cached ??= load();
  return cached;
}

// Whether a file loads one of these modules: import, require, `import =` or `import()`.
function loadsModule(source: ts.SourceFile, names: string[]) {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    const specifier =
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression)
          ? node.moduleReference.expression.text
          : ts.isCallExpression(node)
            ? (requiredModule(node) ??
              (node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              node.arguments[0] &&
              ts.isStringLiteral(node.arguments[0])
                ? node.arguments[0].text
                : undefined))
            : undefined;
    if (specifier && names.some((name) => specifier === name || specifier.startsWith(`${name}/`)))
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// `a.b.c` -> ['a', 'b', 'c'] for a property chain, with the receiver before the first name.
function chain(node: ts.PropertyAccessExpression, length: number) {
  const names: string[] = [];
  let current: ts.Expression = node;
  while (names.length < length && ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  return names.length === length ? { names, receiver: current } : undefined;
}

// The SDK classes and the globals that hold them. A member read straight off one of these is a
// static access, not a client: `Twilio.sync.services` on the Functions runtime global.
const SDK_CLASSES = new Set(['Twilio', 'Mailgun']);

// Whether a chain's receiver can be a client of the provider. `this` alone never is: in
// `this.api.messages`, `this.api` is the client and `messages` its own getter. A receiver whose name
// does not name the provider still counts when it is a local initialized from a call or `new` whose
// callee does, such as `const client = getTwilioClient()` or `context.getTwilioClient()`.
function clientReceiver(
  receiver: ts.Expression,
  provider: MessagingProvider,
  loaded: boolean,
  source: ts.SourceFile,
) {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword || receiver.kind === ts.SyntaxKind.SuperKeyword)
    return false;
  const last = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver)
      ? receiver.text
      : undefined;
  if (last && SDK_CLASSES.has(last)) return false;
  const named = RECEIVER_NAMES[provider];
  if (loaded || named.test(receiver.getText(source))) return true;
  if (!ts.isIdentifier(receiver)) return false;
  let factory = false;
  const visit = (node: ts.Node) => {
    if (factory) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text &&
      node.initializer
    ) {
      let value = unwrap(node.initializer);
      if (ts.isAwaitExpression(value)) value = unwrap(value.expression);
      if (
        (ts.isCallExpression(value) || ts.isNewExpression(value)) &&
        named.test(value.expression.getText(source))
      )
        factory = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return factory;
}

function fileCalls(path: string, content: string, data: MessagingData): MessagingCall[] {
  const source = sourceOf(path, content);
  const use = TEST_PATH.test(path) ? 'test' : 'live';
  const calls: MessagingCall[] = [];
  const sdks = [...data.sdks].filter(
    ([name, sdk]) => content.includes(name) || RECEIVER_NAMES[sdk.provider].test(content),
  );
  // Every deprecated member of the SDKs this file may use, longest paths first.
  const members = sdks
    .flatMap(([name, sdk]) => {
      const loaded = loadsModule(source, [name]);
      return sdk.members.map((member) => ({
        ...member,
        name,
        sdk,
        names: member.path.split('.'),
        loaded,
      }));
    })
    .sort((a, b) => b.names.length - a.names.length);
  const endpoints = data.endpoints.filter((item) => content.includes(item.host));
  const visit = (node: ts.Node) => {
    // `a.verify.services.list()` matches once, at the access that ends in `.verify.services`.
    if (members.length && ts.isPropertyAccessExpression(node))
      for (const member of members) {
        const found = chain(node, member.names.length);
        if (!found || found.names.join('.') !== member.path) continue;
        if (!clientReceiver(found.receiver, member.sdk.provider, member.loaded, source)) continue;
        const receiver = found.receiver.getText(source);
        calls.push({
          provider: member.sdk.provider,
          kind: 'deprecated-member',
          file: path,
          line: lineOf(source, node),
          use,
          member: member.path,
          call: `${receiver}.${member.path}`,
          message: member.message,
          replacement: member.replacement,
          source: `${member.name}@${member.sdk.version} type declarations`,
          date: null,
          text: excerpt(source, node),
        });
        break;
      }
    if (
      endpoints.length &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node))
    )
      for (const endpoint of endpoints) {
        const url = `${endpoint.host}${endpoint.path}`;
        const index = node.text.indexOf(url);
        if (index < 0 || /[\w-]/.test(node.text[index + url.length] ?? '')) continue;
        calls.push({
          provider: endpoint.provider,
          kind: 'removed-endpoint',
          file: path,
          line: lineOf(source, node),
          use,
          member: endpoint.path,
          call: url,
          message: endpoint.message,
          replacement: endpoint.replacement,
          source: endpoint.source,
          date: endpoint.date,
          text: excerpt(source, node),
        });
      }
    ts.forEachChild(node, visit);
  };
  if (members.length || endpoints.length) visit(source);
  return calls;
}

// Lists the messaging providers a repository uses, its retired or unsupported SDK declarations, and
// the deprecated SDK members and removed endpoints it calls.
export async function scanMessagingCalls(
  directory: string,
  options: { data?: MessagingData } = {},
): Promise<MessagingScan> {
  const data = options.data ?? (await loadMessagingData());
  const root = resolve(directory);
  const providers = (await detectProviders(root)).filter((item) =>
    (MESSAGING_PROVIDERS as readonly string[]).includes(item.agent.id),
  );
  const packages: MessagingPackage[] = [];
  for (const detection of providers)
    for (const item of detection.packages) {
      const entry = data.registry.deadlines.find(
        (deadline) =>
          deadline.kind === 'sdk' &&
          deadline.versions.some((version) => {
            const { name, range } = sdkTarget(version);
            if (name !== item.name) return false;
            if (range === null) return true;
            const installed = installedVersion(item.version, item.locked);
            return installed !== null && satisfiesRange(installed, range);
          }),
      );
      packages.push({
        provider: detection.agent.id as MessagingProvider,
        name: item.name,
        file: item.file,
        declared: item.version,
        locked: item.locked,
        deprecated: data.retired.get(item.name) ?? null,
        deadline: entry ? { id: entry.id, date: entry.date } : null,
      });
    }
  const repository = await readRepository(root, 'twilio');
  const names = [
    ...data.sdks.keys(),
    ...AGENT_CATALOG.filter((agent) =>
      (MESSAGING_PROVIDERS as readonly string[]).includes(agent.id),
    ).flatMap((agent) => agent.hostnames),
  ];
  const calls: MessagingCall[] = [];
  for (const file of repository.files) {
    if (
      !names.some((name) => file.content.includes(name)) &&
      !Object.values(RECEIVER_NAMES).some((pattern) => pattern.test(file.content))
    )
      continue;
    calls.push(...fileCalls(file.path, file.content, data));
  }
  calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { providers, packages, calls, warnings: repository.warnings };
}

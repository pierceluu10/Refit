import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { TEST_PATH } from './deadline-exposure.ts';
import { loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import {
  excerpt,
  lineOf,
  propertyName,
  requiredModule,
  sourceOf,
  unwrap,
} from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';

// Cloud SDK service clients a repository constructs, read from source without running it: AWS SDK
// for JavaScript v2 clients (`new AWS.S3()`, `new S3()` from `aws-sdk/clients/s3`), whose support
// ended, and v3 clients (`new S3Client()` from `@aws-sdk/client-s3`), which have no deadline but
// show how far a migration has gone. Legacy Azure SDK packages are listed where they are loaded.
// The inventory names exactly which services a move to v3 touches; nothing is edited.

export const AWS_V2_CLIENTS = new URL('../data/aws-sdk-v2-clients.json', import.meta.url);
export const AZURE_RETIREMENTS = new URL('../data/azure-sdk-retirements.json', import.meta.url);
export const AWS_SDK_V2 = 'aws-sdk';
const V2_CLIENT_PATH = /^aws-sdk\/clients\/([a-z0-9]+)(?:\.js)?$/;
const V3_CLIENT_PACKAGE = /^@aws-sdk\/client-[a-z0-9-]+$/;
// v3 client packages also export commands, errors and helpers; only these are not clients.
const V3_NOT_CLIENT = /(?:Command|Exception|Error)$/;
// v2 helpers that v3 moved out of the service client into their own packages.
const V2_HELPER_PACKAGES = new Map([
  ['DynamoDB.DocumentClient', '@aws-sdk/lib-dynamodb'],
  ['S3.ManagedUpload', '@aws-sdk/lib-storage'],
  ['CloudFront.Signer', '@aws-sdk/cloudfront-signer'],
]);

export type CloudSdk = 'aws-sdk-v2' | 'aws-sdk-v3' | 'azure-legacy';

export interface CloudSdkClient {
  sdk: CloudSdk;
  // v2: the client name (`S3`); v3: the client package (`@aws-sdk/client-s3`); Azure: the package.
  service: string;
  // What is constructed or loaded: `S3`, `DynamoDB.DocumentClient`, `S3Client`, `azure-storage`.
  name: string;
  // `constructor` for a client the code creates; `import` for a legacy Azure package it loads.
  form: 'constructor' | 'import';
  file: string;
  line: number;
  // `test` for test, spec, story, fixture and example files.
  use: 'live' | 'test';
  // The v3 package for a v2 client (null when v3 has none); Microsoft's replacements for an Azure
  // package; [] for v3 clients.
  replacement: string[] | null;
  // The registry deadline that covers it; null for v3.
  deadline: { id: string; date: string } | null;
  text: string;
}

export interface CloudSdkService {
  sdk: CloudSdk;
  service: string;
  replacement: string[] | null;
  live: number;
  test: number;
  files: string[];
}

export interface CloudSdkScan {
  clients: CloudSdkClient[];
  // One row per SDK and service, so a half-migrated repository shows both sides.
  services: CloudSdkService[];
  warnings: string[];
}

export interface CloudSdkData {
  // v2 client name -> its `aws-sdk/clients/<id>` id and v3 package.
  v2: Map<string, { id: string; v3Package: string | null }>;
  // `s3` -> `S3`.
  v2Ids: Map<string, string>;
  // Legacy Azure package -> Microsoft's replacements.
  azure: Map<string, string[]>;
  registry: DeadlineRegistry;
}

let cached: Promise<CloudSdkData> | undefined;
export function loadCloudSdkData(): Promise<CloudSdkData> {
  const load = async (): Promise<CloudSdkData> => {
    const clients = JSON.parse(await readFile(AWS_V2_CLIENTS, 'utf8')).clients as Record<
      string,
      { id: string; v3Package: string | null }
    >;
    const azure = JSON.parse(await readFile(AZURE_RETIREMENTS, 'utf8')).packages as {
      name: string;
      replacement: string[];
    }[];
    return {
      v2: new Map(Object.entries(clients)),
      v2Ids: new Map(Object.entries(clients).map(([name, client]) => [client.id, name])),
      azure: new Map(azure.map((item) => [item.name, item.replacement])),
      registry: await loadDeadlineRegistry(),
    };
  };
  cached ??= load();
  return cached;
}

interface Bindings {
  // Local name -> module, for `import X from M`, `import * as X from M`, `X = require(M)`.
  namespaces: Map<string, string>;
  // Local name -> module and exported name, for `import { a as X }` and `const { a: X } = require(M)`.
  named: Map<string, { module: string; name: string }>;
  // Where each matching module is loaded.
  loads: { module: string; node: ts.Node }[];
}

function dynamicImport(node: ts.Node) {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  );
}

// Every binding a file makes to a module the predicate accepts. `require(M).X` binds X by name.
function moduleBindings(source: ts.SourceFile, accepts: (module: string) => boolean): Bindings {
  const namespaces = new Map<string, string>();
  const named = new Map<string, { module: string; name: string }>();
  const loads: Bindings['loads'] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      accepts(node.moduleSpecifier.text)
    ) {
      const module = node.moduleSpecifier.text;
      loads.push({ module, node });
      const clause = node.importClause;
      if (clause?.name) namespaces.set(clause.name.text, module);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.set(clause.namedBindings.name.text, module);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (name === 'default') namespaces.set(element.name.text, module);
          else named.set(element.name.text, { module, name });
        }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      accepts(node.moduleReference.expression.text)
    ) {
      loads.push({ module: node.moduleReference.expression.text, node });
      namespaces.set(node.name.text, node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node)) {
      const module = dynamicImport(node)
        ? (node.arguments[0] as ts.StringLiteral).text
        : requiredModule(node);
      if (module && accepts(module)) loads.push({ module, node });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const awaited = ts.isAwaitExpression(initializer)
        ? unwrap(initializer.expression)
        : undefined;
      const required =
        requiredModule(initializer) ??
        (awaited && dynamicImport(awaited)
          ? ((awaited as ts.CallExpression).arguments[0] as ts.StringLiteral).text
          : undefined);
      // `require(M).X` and `require(M).default`.
      const member =
        ts.isPropertyAccessExpression(initializer) && requiredModule(initializer.expression);
      if (required && accepts(required)) {
        if (ts.isIdentifier(node.name)) namespaces.set(node.name.text, required);
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements) {
            const name = propertyName(element.propertyName) ?? propertyName(element.name);
            if (!name || !ts.isIdentifier(element.name)) continue;
            if (name === 'default') namespaces.set(element.name.text, required);
            else named.set(element.name.text, { module: required, name });
          }
      } else if (
        member &&
        accepts(member) &&
        ts.isIdentifier(node.name) &&
        ts.isPropertyAccessExpression(initializer)
      ) {
        if (initializer.name.text === 'default') namespaces.set(node.name.text, member);
        else named.set(node.name.text, { module: member, name: initializer.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { namespaces, named, loads };
}

// `const { S3 } = AWS`, `const S3 = AWS.S3` and `const DocumentClient = AWS.DynamoDB.DocumentClient`:
// local names bound to a member of something already resolved.
function memberAliases(source: ts.SourceFile) {
  const found: { local: string; property: string | null; initializer: ts.Expression }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name))
        found.push({ local: node.name.text, property: null, initializer });
      if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements) {
          const name = propertyName(element.propertyName) ?? propertyName(element.name);
          if (name && ts.isIdentifier(element.name))
            found.push({ local: element.name.text, property: name, initializer });
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// What an expression names in the v2 SDK: the `AWS` namespace, or a client (`S3`) or a class
// inside one (`DynamoDB.DocumentClient`).
type V2Value = { kind: 'namespace' } | { kind: 'client'; client: string; path: string[] };

function v2Resolver(source: ts.SourceFile, data: CloudSdkData) {
  const accepts = (module: string) => module === AWS_SDK_V2 || V2_CLIENT_PATH.test(module);
  const { namespaces, named, loads } = moduleBindings(source, accepts);
  const locals = new Map<string, V2Value>();
  const fromModule = (module: string): V2Value | undefined => {
    if (module === AWS_SDK_V2) return { kind: 'namespace' };
    const client = data.v2Ids.get(V2_CLIENT_PATH.exec(module)?.[1] ?? '');
    return client ? { kind: 'client', client, path: [] } : undefined;
  };
  const member = (owner: V2Value | undefined, name: string): V2Value | undefined => {
    if (!owner) return undefined;
    if (owner.kind === 'namespace')
      return data.v2.has(name) ? { kind: 'client', client: name, path: [] } : undefined;
    // `DynamoDB.DocumentClient`, `S3.ManagedUpload`: classes that belong to one service.
    return /^[A-Z]/.test(name)
      ? { kind: 'client', client: owner.client, path: [...owner.path, name] }
      : undefined;
  };
  for (const [local, module] of namespaces) {
    const value = fromModule(module);
    if (value) locals.set(local, value);
  }
  for (const [local, binding] of named) {
    // `import { S3 } from 'aws-sdk'`, `import { DocumentClient } from 'aws-sdk/clients/dynamodb'`.
    const value = member(fromModule(binding.module), binding.name);
    if (value) locals.set(local, value);
  }
  const resolveExpression = (expression: ts.Expression): V2Value | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return locals.get(node.text);
    if (ts.isPropertyAccessExpression(node))
      return member(resolveExpression(node.expression), node.name.text);
    const module = requiredModule(node);
    return module && accepts(module) ? fromModule(module) : undefined;
  };
  if (loads.length)
    // Two passes reach `const { DynamoDB } = AWS` and then `const { DocumentClient } = DynamoDB`.
    for (let pass = 0; pass < 2; pass += 1)
      for (const alias of memberAliases(source)) {
        if (locals.has(alias.local)) continue;
        const owner = resolveExpression(alias.initializer);
        const value = alias.property === null ? owner : member(owner, alias.property);
        if (value && (alias.property !== null || ts.isPropertyAccessExpression(alias.initializer)))
          locals.set(alias.local, value);
      }
  return { loads, resolveExpression };
}

// What an expression names in a v3 client package: the module namespace, or an exported class.
function v3Resolver(source: ts.SourceFile) {
  const { namespaces, named, loads } = moduleBindings(source, (module) =>
    V3_CLIENT_PACKAGE.test(module),
  );
  return {
    loads,
    resolveExpression(expression: ts.Expression) {
      const node = unwrap(expression);
      if (ts.isIdentifier(node)) return named.get(node.text);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const module = namespaces.get(node.expression.text);
        if (module) return { module, name: node.name.text };
      }
      return undefined;
    },
  };
}

function deadlineFor(data: CloudSdkData, name: string) {
  const entry = data.registry.deadlines.find(
    (item) => item.kind === 'sdk' && item.versions.includes(name),
  );
  return entry ? { id: entry.id, date: entry.date } : null;
}

// The legacy Azure package a module path loads: `azure-storage` or `azure-storage/lib/…`.
function azurePackage(module: string, data: CloudSdkData) {
  const name = module.startsWith('@')
    ? module.split('/').slice(0, 2).join('/')
    : module.split('/')[0];
  return data.azure.has(name) ? name : undefined;
}

function fileClients(path: string, content: string, data: CloudSdkData): CloudSdkClient[] {
  const source = sourceOf(path, content);
  const use = TEST_PATH.test(path) ? 'test' : 'live';
  const clients: CloudSdkClient[] = [];
  const record = (
    node: ts.Node,
    fields: Pick<CloudSdkClient, 'sdk' | 'service' | 'name' | 'form' | 'replacement' | 'deadline'>,
  ) =>
    clients.push({
      ...fields,
      file: path,
      line: lineOf(source, node),
      use,
      text: excerpt(source, node),
    });
  const v2 = content.includes(AWS_SDK_V2) ? v2Resolver(source, data) : undefined;
  const v3 = content.includes('@aws-sdk/client-') ? v3Resolver(source) : undefined;
  const v2Deadline = deadlineFor(data, AWS_SDK_V2);
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const value = v2?.loads.length ? v2.resolveExpression(node.expression) : undefined;
      if (value?.kind === 'client') {
        const name = [value.client, ...value.path].join('.');
        const v3Package =
          V2_HELPER_PACKAGES.get(name) ?? data.v2.get(value.client)?.v3Package ?? null;
        record(node, {
          sdk: 'aws-sdk-v2',
          service: value.client,
          name,
          form: 'constructor',
          replacement: v3Package ? [v3Package] : null,
          deadline: v2Deadline,
        });
      }
      const exported = v3?.loads.length ? v3.resolveExpression(node.expression) : undefined;
      if (exported && /^[A-Z]/.test(exported.name) && !V3_NOT_CLIENT.test(exported.name))
        record(node, {
          sdk: 'aws-sdk-v3',
          service: exported.module,
          name: exported.name,
          form: 'constructor',
          replacement: [],
          deadline: null,
        });
    }
    ts.forEachChild(node, visit);
  };
  if (v2 || v3) visit(source);
  if ([...data.azure.keys()].some((name) => content.includes(name))) {
    const { loads } = moduleBindings(source, (module) => azurePackage(module, data) !== undefined);
    for (const load of loads) {
      const name = azurePackage(load.module, data)!;
      record(load.node, {
        sdk: 'azure-legacy',
        service: name,
        name,
        form: 'import',
        replacement: data.azure.get(name) ?? null,
        deadline: deadlineFor(data, name),
      });
    }
  }
  return clients;
}

// Lists the cloud SDK clients a repository constructs, and the legacy Azure packages it loads.
export async function scanCloudSdkClients(
  directory: string,
  options: { data?: CloudSdkData } = {},
): Promise<CloudSdkScan> {
  const data = options.data ?? (await loadCloudSdkData());
  const repository = await readRepository(resolve(directory), AWS_SDK_V2);
  const azureNames = [...data.azure.keys()];
  const clients: CloudSdkClient[] = [];
  for (const file of repository.files) {
    if (file.path.endsWith('.json')) continue;
    if (
      !file.content.includes('aws-sdk') &&
      !azureNames.some((name) => file.content.includes(name))
    )
      continue;
    clients.push(...fileClients(file.path, file.content, data));
  }
  clients.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const services = new Map<string, CloudSdkService>();
  for (const client of clients) {
    const key = `${client.sdk}\t${client.service}`;
    const row = services.get(key) ?? {
      sdk: client.sdk,
      service: client.service,
      replacement: null,
      live: 0,
      test: 0,
      files: [],
    };
    services.set(key, row);
    // A service's helpers can move to other v3 packages, so the row lists every one.
    if (client.replacement)
      row.replacement = [...new Set([...(row.replacement ?? []), ...client.replacement])];
    row[client.use] += 1;
    if (!row.files.includes(client.file)) row.files.push(client.file);
  }
  return {
    clients,
    services: [...services.values()].sort(
      (a, b) => a.sdk.localeCompare(b.sdk) || a.service.localeCompare(b.service),
    ),
    warnings: repository.warnings,
  };
}

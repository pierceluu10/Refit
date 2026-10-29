import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  findBreakingChanges,
  GraphQLError,
  NoUnusedFragmentsRule,
  parse,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
} from 'graphql';
import type { AiOptions } from './ai-budget.ts';
import type { ApiVersionDeclaration, ApiVersionEvidence, ApiVersionPolicy } from './api-version.ts';
import { renderFileReplacements, renderPatch } from './patches.ts';
import type { ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import {
  documentLocation,
  scanShopify,
  SHOPIFY_PACKAGES,
  type AdminDocument,
  type DocumentSegment,
  type ShopifyScan,
} from './shopify-analysis.ts';
import {
  loadShopifyDocumentRules,
  rewriteDocument,
  type DocumentEdit,
  type ShopifyDocumentRule,
} from './shopify-document-rules.ts';
import { shopifySchema } from './shopify-schemas.ts';
import { aiRewriteDocument, type ShopifyAiRewrite } from './shopify-ai-rewrite.ts';
import { SHOPIFY_SDK_RULE, shopifySdkSourceChanges } from './shopify-sdk-source.ts';
import { shopifySdkUpgrade } from './shopify-sdk-upgrade.ts';
import {
  enumFromVersion,
  latestApiVersion,
  SHOPIFY_API_ENUM_SINCE,
  sdkHasEnumMember,
} from './shopify-versions.ts';
import { digest, isObject } from './specifications.ts';
import { proposeRestRule } from './shopify-rest-ai.ts';
import {
  loadShopifyRestContract,
  loadShopifyRestRefusals,
  restRewriteNotes,
  shopifyRestRewrites,
} from './shopify-rest-rewrite.ts';
import type { Finding, Repository, SourceEdit } from './types.ts';

export const SHOPIFY: ProviderAdapter = {
  id: 'shopify',
  packageName: '@shopify/shopify-api',
  defaultImport: false,
  namedExport: null,
  operations: [],
};
export const SHOPIFY_VERSION_RULE = 'shopify-api-version';
const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
const CODEGEN_CONFIG = /(?:^|\/)\.graphqlrc\.[cm]?[jt]s$/;
const SHOPIFY_MIGRATION_GUIDE =
  'https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/docs/migrating-to-v12.md';
const UNKNOWN_FRAGMENT = /^Unknown fragment "/;
const MAX_EVIDENCE_TEXT = 300;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.next']);
const MAX_EXTRA_BYTES = 2 * 1024 * 1024;
const WEBHOOK_VERSION = /^\s*api_version\s*=\s*["'](\d{4}-\d{2}|unstable)["']/m;

// The files source scanning skips that carry Shopify facts: .graphql and .gql documents, and the
// app configuration (shopify.app.toml, shopify.app.<name>.toml), whose api_version sets the webhook
// payload version.
async function shopifyExtraFiles(root: string) {
  const graphql: { path: string; content: string }[] = [];
  const configuration: { path: string; content: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
      const target = /\.(?:graphql|gql)$/.test(entry.name)
        ? graphql
        : /^shopify\.app(?:\.[\w-]+)?\.toml$/.test(entry.name)
          ? configuration
          : undefined;
      if (!entry.isFile() || !target || (await stat(path)).size > MAX_EXTRA_BYTES) continue;
      target.push({
        path: relative(root, path).split('\\').join('/'),
        content: await readFile(path, 'utf8'),
      });
    }
  };
  await visit(root);
  const order = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return { graphql: graphql.sort(order), configuration: configuration.sort(order) };
}

// The part of a document between two offsets, with its source mapping.
function sliceDocument(document: AdminDocument, start: number, end: number) {
  const segments: DocumentSegment[] = document.segments
    .filter((entry) => entry.documentEnd > start && entry.documentStart < end)
    .map((entry) => {
      const from = Math.max(entry.documentStart, start);
      return {
        ...entry,
        documentStart: from - start,
        documentEnd: Math.min(entry.documentEnd, end) - start,
        sourceStart: entry.sourceStart + from - entry.documentStart,
      };
    });
  return { text: document.text.slice(start, end), segments };
}

// Fragments defined once across every document Refit read, by name: codegen and .graphql projects
// define a fragment in one file and spread it in another. A name defined twice is left out.
function fragmentPool(documents: AdminDocument[]) {
  const pool = new Map<string, ReturnType<typeof sliceDocument> | null>();
  for (const document of documents) {
    let ast: DocumentNode;
    try {
      ast = parse(document.text);
    } catch {
      continue;
    }
    for (const definition of ast.definitions) {
      if (definition.kind !== 'FragmentDefinition' || !definition.loc) continue;
      const piece = sliceDocument(document, definition.loc.start, definition.loc.end);
      const known = pool.get(definition.name.value);
      pool.set(
        definition.name.value,
        known === undefined || known?.text === piece.text ? piece : null,
      );
    }
  }
  return pool;
}

// The document with every fragment it spreads but does not define appended from the pool.
function withFragments(
  document: AdminDocument,
  pool: ReturnType<typeof fragmentPool>,
): AdminDocument {
  let current = document;
  for (let round = 0; round < 16; round++) {
    let ast: DocumentNode;
    try {
      ast = parse(current.text);
    } catch {
      return current;
    }
    const defined = new Set(
      ast.definitions
        .filter((entry): entry is FragmentDefinitionNode => entry.kind === 'FragmentDefinition')
        .map((entry) => entry.name.value),
    );
    const missing = new Set<string>();
    visit(ast, {
      FragmentSpread(node) {
        if (!defined.has(node.name.value) && pool.get(node.name.value))
          missing.add(node.name.value);
      },
    });
    if (!missing.size) return current;
    let { text } = current;
    const segments = [...current.segments];
    for (const name of missing) {
      const piece = pool.get(name)!;
      text += '\n';
      for (const entry of piece.segments)
        segments.push({
          ...entry,
          documentStart: entry.documentStart + text.length,
          documentEnd: entry.documentEnd + text.length,
        });
      text += piece.text;
    }
    current = { ...current, text, segments };
  }
  return current;
}

// The source edit for a rule's edit to an assembled document, or undefined when the document text
// there is not the source text (an escape sequence in a string literal).
function sourceEdit(document: AdminDocument, edit: DocumentEdit): SourceEdit | undefined {
  const segment = document.segments.find(
    (entry) => edit.start >= entry.documentStart && edit.end <= entry.documentEnd,
  );
  if (!segment) return undefined;
  const length = segment.documentEnd - segment.documentStart;
  if (
    segment.sourceText.slice(segment.sourceStart, segment.sourceStart + length) !==
    document.text.slice(segment.documentStart, segment.documentEnd)
  )
    return undefined;
  const start = segment.sourceStart + edit.start - segment.documentStart;
  return {
    file: segment.file,
    start,
    end: start + edit.end - edit.start,
    replacement: edit.replacement,
    changeId: edit.rule.rule,
    rule: edit.rule.rule,
  };
}

type Snapshot = {
  hash: string;
  document: Record<string, unknown>;
  provenance: { provider: string; revision: string; url: string } | null;
};

export function isShopifySnapshot(snapshot: { document: Record<string, unknown> }) {
  return typeof snapshot.document.graphqlIntrospection === 'string';
}

const SNAPSHOT_HEADER_BYTES = 512;
const SNAPSHOT_KIND = /"kind"\s*:\s*"refit-graphql-snapshot"/;

// Reads only a snapshot's header, so OpenAPI runs do not parse their specifications twice.
export async function isShopifySnapshotFile(path: string) {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(SNAPSHOT_HEADER_BYTES),
      0,
      SNAPSHOT_HEADER_BYTES,
      0,
    );
    return SNAPSHOT_KIND.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

// The @shopify/shopify-api release a lockfile installs, including the copy nested under an app
// framework package. Several different releases answer undefined rather than guessing.
export async function lockedShopifyApi(root: string) {
  const path = join(root, 'package-lock.json');
  if (existsSync(path)) {
    const lock: unknown = JSON.parse(await readFile(path, 'utf8'));
    const packages = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
    const versions = new Set(
      Object.entries(packages)
        .filter(([key]) => key.endsWith('node_modules/@shopify/shopify-api'))
        .map(([, entry]) => (isObject(entry) ? entry.version : undefined)),
    );
    if (versions.size === 1) {
      const [version] = versions;
      if (typeof version === 'string') return version;
    }
    if (versions.size) return undefined;
  }
  const pnpm = join(root, 'pnpm-lock.yaml');
  if (existsSync(pnpm)) {
    const versions = new Set(
      [
        ...(await readFile(pnpm, 'utf8')).matchAll(
          /^\s+'?\/?@shopify\/shopify-api[@/](\d+\.\d+\.\d+)/gm,
        ),
      ].map((match) => match[1]),
    );
    if (versions.size === 1) return [...versions][0];
  }
  const yarn = join(root, 'yarn.lock');
  if (existsSync(yarn)) {
    const versions = new Set(
      [
        ...(await readFile(yarn, 'utf8')).matchAll(
          /^"?@shopify\/shopify-api@[^\n]*\n\s+version:? "?(\d+\.\d+\.\d+)/gm,
        ),
      ].map((match) => match[1]),
    );
    if (versions.size === 1) return [...versions][0];
  }
  return undefined;
}

interface DocumentResult {
  findings: Finding[];
  deprecated: string[];
  otherApi?: true;
}

function errorKey(error: GraphQLError) {
  return `${error.message}@${error.locations?.map((entry) => `${entry.line}:${entry.column}`).join(',')}`;
}

function offset(document: AdminDocument, line: number, column: number) {
  const lines = document.text.split('\n');
  return lines.slice(0, line - 1).reduce((sum, entry) => sum + entry.length + 1, 0) + column - 1;
}

// Validates one document against both contracts. Errors only the after schema reports are
// breaking; errors both report mean the document already fails on the before contract.
function checkDocument(
  document: AdminDocument,
  before: GraphQLSchema,
  after: GraphQLSchema,
  versions: { before: string; after: string },
): DocumentResult {
  const confidence = document.traced ? ('confirmed' as const) : ('review' as const);
  const located = (offsetInDocument: number) => documentLocation(document, offsetInDocument);
  let ast: DocumentNode;
  try {
    ast = parse(document.text);
  } catch (error) {
    if (!(error instanceof GraphQLError)) throw error;
    return {
      findings: [
        {
          ...document,
          changeId: 'shopify-graphql:syntax',
          expression: error.message.slice(0, MAX_EVIDENCE_TEXT),
          confidence: 'review',
          reason:
            'The GraphQL document does not parse, so Refit cannot check it against either contract.',
          contractReview:
            'A Shopify GraphQL document does not parse; Refit cannot prove it works on the target API version.',
        },
      ],
      deprecated: [],
    };
  }
  const beforeErrors = validate(before, ast, RULES);
  const afterErrors = validate(after, ast, RULES);
  if ([...beforeErrors, ...afterErrors].some((error) => UNKNOWN_FRAGMENT.test(error.message)))
    return {
      findings: [
        {
          ...document,
          changeId: 'shopify-graphql:fragment',
          expression: 'Fragment defined outside this document',
          confidence: 'review',
          reason:
            'The document spreads a fragment Refit could not inline, so its selections are incomplete.',
          contractReview:
            'A Shopify GraphQL document uses a fragment Refit could not resolve; its fields were not checked against the target API version.',
        },
      ],
      deprecated: [],
    };
  // A #graphql literal no Admin call reaches that fails on both schemas most likely targets another
  // Shopify API (Storefront, Customer Account, Partner); it is noted, not treated as Admin usage.
  if (!document.traced && beforeErrors.length && afterErrors.length)
    return { findings: [], deprecated: [], otherApi: true };
  const beforeKeys = new Set(beforeErrors.map(errorKey));
  const findings: Finding[] = [];
  const report = (error: GraphQLError, already: boolean) => {
    const position = error.locations?.[0];
    const where = position
      ? located(offset(document, position.line, position.column))
      : { file: document.file, line: document.line, column: document.column };
    findings.push({
      ...where,
      changeId: `shopify-graphql:${digest(error.message).slice(0, 12)}`,
      // graphql-js name suggestions are spelling matches, not documented replacements.
      expression: error.message.replace(/ Did you mean .*$/, '').slice(0, MAX_EVIDENCE_TEXT),
      confidence,
      reason: already
        ? `This document already fails validation against the ${versions.before} contract, the oldest version this run covers.`
        : `Valid on ${versions.before}, invalid on ${versions.after}.`,
      contractReview: already
        ? `A Shopify GraphQL document already fails on Admin API ${versions.before}; fix it before any version upgrade.`
        : `A Shopify GraphQL document breaks on Admin API ${versions.after} and the contract names no proven replacement.`,
    });
  };
  for (const error of afterErrors) report(error, beforeKeys.has(errorKey(error)));
  for (const error of beforeErrors)
    if (!afterErrors.some((entry) => errorKey(entry) === errorKey(error))) report(error, true);
  if (findings.length) return { findings, deprecated: [] };
  return typeChanges(ast, document, before, after, versions);
}

// Selected fields whose declared type differs between the contracts: the document validates on
// both, but values change shape (Date to DateTime, nullable results, new list types). Fields the
// after schema does not have are skipped.
function typeChanges(
  ast: DocumentNode,
  document: AdminDocument,
  before: GraphQLSchema,
  after: GraphQLSchema,
  versions: { before: string; after: string },
): DocumentResult {
  const confidence = document.traced ? ('confirmed' as const) : ('review' as const);
  const located = (offsetInDocument: number) => documentLocation(document, offsetInDocument);
  const findings: Finding[] = [];
  const deprecated: string[] = [];
  {
    const info = new TypeInfo(before);
    visit(
      ast,
      visitWithTypeInfo(info, {
        Field(node) {
          const parent = info.getParentType();
          const field = info.getFieldDef();
          if (!parent || !field || node.name.value.startsWith('__')) return;
          const revised = after.getType(parent.name);
          const target =
            revised && 'getFields' in revised ? revised.getFields()[node.name.value] : undefined;
          if (!target) return;
          if (target.deprecationReason)
            deprecated.push(
              `${parent.name}.${node.name.value}: ${target.deprecationReason.replace(/\s+/g, ' ')}`,
            );
          const [was, now] = [String(field.type), String(target.type)];
          // A nullable output that becomes non-null only removes a case the code already handles.
          if (was === now || `${was}!` === now) return;
          findings.push({
            ...located(node.loc ? node.loc.start : 0),
            changeId: `shopify-graphql-type:${parent.name}.${node.name.value}`,
            expression: `${parent.name}.${node.name.value}: ${was} → ${now}`,
            confidence,
            reason: `The selected field's type changes from ${was} to ${now}, so returned values change shape.`,
            contractReview: `A selected Shopify field changes type on Admin API ${versions.after}; code reading it needs review.`,
          });
        },
      }),
    );
  }
  return { findings, deprecated: [...new Set(deprecated)] };
}

// `GET products/{id}.json (fetch)`: the method and path or resource operation where known, then the
// code that makes the call.
function restLabel(entry: ShopifyScan['rest'][number]) {
  const request = [entry.method, entry.path ?? entry.resource].filter(Boolean).join(' ');
  return request && request !== entry.expression
    ? `${request} (${entry.expression})`
    : entry.expression;
}

// Runtime Admin API pins as API-version declarations; codegen configuration is not runtime.
function versionDeclarations(scan: ShopifyScan): ApiVersionDeclaration[] {
  return [
    ...scan.versions
      .filter((entry) => !CODEGEN_CONFIG.test(entry.file) && !entry.api)
      .map((entry) => ({
        file: entry.file,
        line: entry.line,
        column: entry.column,
        kind: 'constructor' as const,
        value: entry.value,
        status: 'literal' as const,
        reason: `${entry.kind === 'enum' ? 'ApiVersion enum' : entry.kind === 'url' ? 'Admin API URL' : 'apiVersion string'} ${entry.text}`,
      })),
    ...scan.unresolvedVersions.map((entry) => ({
      file: entry.file,
      line: entry.line,
      column: entry.column,
      kind: 'constructor' as const,
      value: null,
      status: 'unknown' as const,
      reason: entry.reason,
    })),
  ];
}

// Pins in a (patched) repository, for checking that a proposal moved every pin to the target.
export function shopifyVersionDeclarations(repository: Repository) {
  return versionDeclarations(scanShopify(repository));
}

// `upgrade` is the opt-in SDK upgrade: the release it moves @shopify/shopify-api to, or why it
// stopped.
function versionFindings(
  scan: ShopifyScan,
  versions: { before: string; after: string },
  sdkRelease: string | undefined,
  upgrade?: { release: string } | { refusal: string },
) {
  const stopped =
    upgrade && 'refusal' in upgrade ? ` The SDK upgrade stopped: ${upgrade.refusal}` : '';
  const upgradedRelease = upgrade && 'release' in upgrade ? upgrade.release : undefined;
  const findings: Finding[] = [];
  const edits: SourceEdit[] = [];
  const runtime = scan.versions.filter((entry) => !CODEGEN_CONFIG.test(entry.file) && !entry.api);
  const member = enumFromVersion(versions.after)!;
  // LATEST_API_VERSION is fixed by the locked SDK release, so it counts as that release's pin.
  const latest = sdkRelease ? latestApiVersion(sdkRelease) : undefined;
  const declared = [
    ...new Set([
      ...runtime.map((entry) => entry.value),
      ...(latest && scan.unresolvedVersions.some((entry) => entry.latest) ? [latest] : []),
    ]),
  ];
  for (const entry of scan.unresolvedVersions)
    findings.push(
      entry.latest && latest && upgradedRelease
        ? {
            ...entry,
            changeId: SHOPIFY_VERSION_RULE,
            expression: `LATEST_API_VERSION (${latest} in @shopify/shopify-api ${sdkRelease}) → ApiVersion.${member}`,
            confidence: 'confirmed',
            reason: `@shopify/shopify-api 12.0.0 removed LATEST_API_VERSION; the SDK upgrade to ${upgradedRelease} pins ApiVersion.${member}.`,
          }
        : entry.latest && latest
          ? {
              ...entry,
              changeId: SHOPIFY_VERSION_RULE,
              expression: `LATEST_API_VERSION (${latest} in @shopify/shopify-api ${sdkRelease})`,
              confidence: 'confirmed',
              reason:
                latest < versions.before
                  ? `@shopify/shopify-api ${sdkRelease} resolves LATEST_API_VERSION to ${latest}, which Shopify no longer serves; requests already get ${versions.before}.`
                  : `@shopify/shopify-api ${sdkRelease} resolves LATEST_API_VERSION to ${latest}.`,
              contractReview: `LATEST_API_VERSION is ${latest} in @shopify/shopify-api ${sdkRelease}, and only an SDK upgrade changes it. ${
                sdkHasEnumMember(sdkRelease!, member)
                  ? `This SDK has ApiVersion.${member}; pin it explicitly to upgrade.`
                  : `ApiVersion.${member} first ships in ${SHOPIFY_API_ENUM_SINCE[member] ?? 'an unknown release'}, a separate, reviewed SDK upgrade.`
              }${stopped}`,
            }
          : {
              ...entry,
              changeId: SHOPIFY_VERSION_RULE,
              expression: 'apiVersion',
              confidence: 'review',
              reason: entry.reason,
              contractReview: `The Shopify Admin API version is not a literal Refit can verify and bump: ${entry.reason}`,
            },
    );
  if (declared.length > 1) {
    for (const entry of runtime)
      findings.push({
        ...entry,
        changeId: SHOPIFY_VERSION_RULE,
        expression: entry.text,
        confidence: 'review',
        reason: `The repository pins several Admin API versions (${declared.join(', ')}).`,
        contractReview: `The repository pins several Shopify Admin API versions (${declared.join(', ')}); choose one before upgrading.`,
      });
    return { findings, edits, declared };
  }
  const enumRelease = upgradedRelease ?? sdkRelease;
  const enumMissing =
    runtime.some((entry) => entry.kind === 'enum') &&
    !(enumRelease && sdkHasEnumMember(enumRelease, member));
  for (const entry of scan.versions) {
    // Storefront clients keep their own version; this run checks only the Admin contract.
    if (entry.value >= versions.after || entry.api) continue;
    const codegen = CODEGEN_CONFIG.test(entry.file);
    const missing = entry.kind === 'enum' && enumMissing;
    if (!codegen || !missing)
      edits.push({
        file: entry.file,
        start: entry.start,
        end: entry.end,
        replacement: entry.kind === 'enum' ? member : versions.after,
        changeId: SHOPIFY_VERSION_RULE,
      });
    if (codegen) continue;
    findings.push({
      ...entry,
      changeId: SHOPIFY_VERSION_RULE,
      expression: `${entry.text} → ${entry.kind === 'enum' ? `ApiVersion.${member}` : versions.after}`,
      confidence: 'confirmed',
      reason:
        entry.value < versions.before
          ? `Pinned to ${entry.value}, which Shopify no longer serves; requests already get ${versions.before}.`
          : `Pinned to ${entry.value}; the target is ${versions.after}.`,
      ...(missing
        ? {
            contractReview: `@shopify/shopify-api ${sdkRelease ?? '(version not found in the lockfile)'} has no ApiVersion.${member}; it first ships in ${SHOPIFY_API_ENUM_SINCE[member] ?? 'an unknown release'}. Upgrading the SDK is a separate, reviewed change.${stopped}`,
          }
        : {}),
    });
  }
  if (!runtime.length && scan.adminCalls && !scan.unresolvedVersions.length)
    findings.push({
      file: scan.shopifyFiles[0] ?? 'package.json',
      line: 1,
      column: 1,
      changeId: SHOPIFY_VERSION_RULE,
      expression: 'apiVersion',
      confidence: 'review',
      reason: 'Admin API calls were found but no pinned API version.',
      contractReview:
        'Refit found Shopify Admin API calls but no pinned API version, so it cannot tell which contract they run against.',
    });
  return { findings, edits, declared };
}

// When every finding on a document is a break the target version introduces, the documented rules'
// rewrite of it: the source edits and confirmed findings that replace those breaks, or why the rules
// could not fix it. Undefined when no rule applies.
function rewriteBreakingDocument(
  document: AdminDocument,
  result: DocumentResult,
  before: GraphQLSchema,
  after: GraphQLSchema,
  versions: { before: string; after: string },
  rules: ShopifyDocumentRule[],
): { result: DocumentResult; edits: SourceEdit[] } | { refusal: string } | undefined {
  if (
    !result.findings.length ||
    result.otherApi ||
    !result.findings.every((finding) => finding.reason.startsWith('Valid on'))
  )
    return undefined;
  const rewrite = rewriteDocument(document.text, before, after, rules);
  if (!rewrite) return undefined;
  if ('refusal' in rewrite) return { refusal: rewrite.refusal };
  const edits = rewrite.edits.map((edit) => sourceEdit(document, edit));
  if (edits.some((edit) => !edit))
    return { refusal: 'An edit falls on an escaped string the source spells differently.' };
  const types = typeChanges(parse(document.text), document, before, after, versions);
  if (types.findings.length)
    return { refusal: 'A selected field that the rules leave changes type on the target.' };
  const confidence = document.traced ? ('confirmed' as const) : ('review' as const);
  return {
    edits: edits as SourceEdit[],
    result: {
      deprecated: types.deprecated,
      findings: rewrite.edits.map((edit) => ({
        ...documentLocation(document, edit.start),
        changeId: edit.rule.rule,
        expression: `${document.text.slice(edit.start, edit.end)} → ${edit.replacement}`,
        confidence,
        reason: `Shopify rule ${edit.rule.rule} (${edit.rule.source}); the rewritten document validates on ${versions.after}.`,
      })),
    },
  };
}

export async function runShopifyPipeline(options: {
  repository: string;
  before: Snapshot;
  after: Snapshot;
  proposePatch?: boolean;
  apiVersion?: string;
  apiVersionPolicy: ApiVersionPolicy;
  // Opt-in: when the locked SDK cannot name the target version, propose its major upgrade.
  sdkUpgrade?: boolean;
  // With AI enabled, breaking documents no rule fixes are rewritten by the model (AI use 4).
  aiPatch?: AiOptions;
}) {
  const manifestPath = join(options.repository, 'package.json');
  const manifest: unknown = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : {};
  const declaredPackages = isObject(manifest)
    ? { ...(manifest.dependencies as object), ...(manifest.devDependencies as object) }
    : {};
  const packageName =
    SHOPIFY_PACKAGES.find((name) => Object.hasOwn(declaredPackages, name)) ?? SHOPIFY.packageName;
  const repository: Repository = await readRepository(options.repository, packageName);
  const extra = await shopifyExtraFiles(repository.root);
  const scan = scanShopify(repository, extra.graphql);
  // .graphql files are edited like source files.
  const patchRepository: Repository = {
    ...repository,
    files: [...repository.files, ...extra.graphql],
  };
  const webhookVersions = extra.configuration.flatMap((entry) => {
    const match = WEBHOOK_VERSION.exec(entry.content);
    return match ? [{ file: entry.path, version: match[1] }] : [];
  });
  const versions = {
    before: String(
      options.before.document.info && (options.before.document.info as { version: string }).version,
    ),
    after: String(
      options.after.document.info && (options.after.document.info as { version: string }).version,
    ),
  };
  const before = shopifySchema(String(options.before.document.graphqlIntrospection));
  const after = shopifySchema(String(options.after.document.graphqlIntrospection));
  const findings: Finding[] = [];
  const deprecated = new Set<string>();
  const otherApi: AdminDocument[] = [];
  const storefront: AdminDocument[] = [];
  const rules = loadShopifyDocumentRules(versions.after);
  const documentEdits = new Map<string, SourceEdit>();
  const aiEdits: SourceEdit[] = [];
  const aiAttempts: (ShopifyAiRewrite & { file: string; line: number })[] = [];
  const pool = fragmentPool(scan.documents);
  for (const original of scan.documents) {
    if (original.api === 'storefront') {
      storefront.push(original);
      continue;
    }
    const document = withFragments(original, pool);
    let result = checkDocument(document, before, after, versions);
    const rewritten = rules.length
      ? rewriteBreakingDocument(document, result, before, after, versions, rules)
      : undefined;
    if (rewritten && 'edits' in rewritten) {
      result = rewritten.result;
      for (const edit of rewritten.edits)
        documentEdits.set(`${edit.file}:${edit.start}:${edit.end}:${edit.replacement}`, edit);
    } else if (rewritten)
      for (const finding of result.findings)
        finding.reason += ` A Shopify rule matched but was not applied: ${rewritten.refusal}`;
    const segment = document === original && document.segments.length === 1 && document.segments[0];
    if (
      options.aiPatch &&
      segment &&
      !(rewritten && 'edits' in rewritten) &&
      result.findings.length &&
      !result.otherApi &&
      result.findings.every((finding) => finding.reason.startsWith('Valid on')) &&
      segment.sourceText.slice(segment.sourceStart, segment.sourceStart + document.text.length) ===
        document.text
    ) {
      const attempt = await aiRewriteDocument({
        text: document.text,
        errors: result.findings.map((finding) => finding.expression),
        before,
        after,
        versions,
        ai: options.aiPatch,
      });
      aiAttempts.push({ ...attempt, file: document.file, line: document.line });
      if (attempt.status === 'kept') {
        aiEdits.push({
          file: segment.file,
          start: segment.sourceStart,
          end: segment.sourceStart + document.text.length,
          replacement: attempt.document!,
          changeId: 'shopify-ai-rewrite',
        });
        result = {
          deprecated: result.deprecated,
          findings: [
            {
              file: document.file,
              line: document.line,
              column: document.column,
              changeId: 'shopify-ai-rewrite',
              expression: result.findings.map((finding) => finding.expression).join('; '),
              confidence: 'review',
              reason: `AI (${attempt.model}) rewrote the document; Refit checked that it validates on ${versions.after}, keeps every operation and variable, and returns every response key with the same type. ${attempt.reason}`,
            },
          ],
        };
      } else
        for (const finding of result.findings)
          finding.reason += ` AI could not rewrite it: ${attempt.reason}`;
    }
    findings.push(...result.findings);
    for (const entry of result.deprecated) deprecated.add(entry);
    if (result.otherApi) otherApi.push(document);
  }
  for (const entry of scan.unreadable)
    findings.push({
      ...entry,
      changeId: 'shopify-graphql:unreadable',
      expression: 'Admin GraphQL call',
      confidence: 'review',
      reason: entry.reason,
      contractReview: `Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API ${versions.after}.`,
    });
  const sdkRelease = await lockedShopifyApi(repository.root);
  const restRun = await shopifyRestRewrites(
    repository,
    scan,
    [
      { version: versions.before, schema: before },
      { version: versions.after, schema: after },
    ],
    sdkRelease,
    options.aiPatch
      ? {
          propose: (stop) =>
            proposeRestRule({
              stop,
              contract: loadShopifyRestContract(),
              refusals: loadShopifyRestRefusals(),
              schemas: [
                { version: versions.before, schema: before },
                { version: versions.after, schema: after },
              ],
              ai: options.aiPatch!,
            }),
        }
      : {},
  );
  const rest = restRun.results;
  const restRewrites = rest.filter((result) => result.status === 'rewritten');
  const restEdits = restRewrites.flatMap((result) => result.edits);
  for (const result of rest) {
    const { entry } = result;
    if (result.status === 'rewritten')
      findings.push({
        file: entry.file,
        line: entry.line,
        column: entry.column,
        changeId: 'shopify-rest-graphql',
        expression: restLabel(entry),
        confidence: 'review',
        reason: `Rewritten as the GraphQL Admin query \`${result.rule.root}\` (${result.rule.origin === 'ai' ? 'a mapping the model proposed and Refit checked' : `documented: ${result.rule.rest?.url}`}). The adapter rebuilds the REST fields this code reads (${result.reads.filter(Boolean).join(', ') || 'none'}); review the behaviour differences listed in the draft.`,
      });
    else
      findings.push({
        file: entry.file,
        line: entry.line,
        column: entry.column,
        changeId: 'shopify-rest',
        expression: restLabel(entry),
        confidence: 'review',
        reason: `REST Admin API usage Refit did not rewrite: ${result.reason}`,
        contractReview:
          'The repository calls the REST Admin API, which has no published versioned contract; Refit cannot prove those calls survive the version change.',
      });
  }
  const member = enumFromVersion(versions.after);
  const upgradeResult =
    options.sdkUpgrade &&
    member &&
    (scan.unresolvedVersions.some((entry) => entry.latest) ||
      scan.versions.some((entry) => entry.kind === 'enum' && !CODEGEN_CONFIG.test(entry.file))) &&
    !(sdkRelease && sdkHasEnumMember(sdkRelease, member))
      ? await shopifySdkUpgrade(repository.root, member)
      : undefined;
  const upgraded = upgradeResult && 'upgrade' in upgradeResult ? upgradeResult.upgrade : undefined;
  const source = upgraded && shopifySdkSourceChanges(repository, upgraded.primary, member!);
  for (const stop of source ? source.stops : [])
    findings.push({
      ...stop,
      changeId: SHOPIFY_SDK_RULE,
      expression: `Shopify SDK upgrade to @shopify/shopify-api ${upgraded!.apiRelease}`,
      confidence: 'review',
      reason: stop.reason,
      contractReview: `The Shopify SDK upgrade stops for review: ${stop.reason}`,
    });
  const pins = versionFindings(
    scan,
    versions,
    sdkRelease,
    upgraded
      ? { release: upgraded.apiRelease }
      : upgradeResult && 'reason' in upgradeResult
        ? { refusal: upgradeResult.reason }
        : undefined,
  );
  findings.push(...pins.findings);
  const application = options.apiVersion ?? (pins.declared.length === 1 ? pins.declared[0] : null);
  // Shopify answers requests for an unsupported version with the oldest supported one.
  const served = application && application < versions.before ? versions.before : application;
  const applicability =
    served === null
      ? ('unknown' as const)
      : served === versions.before
        ? ('matches-before' as const)
        : served === versions.after
          ? ('matches-after' as const)
          : ('matches-neither' as const);
  const apiVersion: ApiVersionEvidence = {
    application,
    before: versions.before,
    after: versions.after,
    applicability,
    reason:
      applicability === 'matches-before'
        ? application !== served
          ? `The code pins ${application}, which Shopify serves as the oldest supported version, ${versions.before}.`
          : `The code pins ${application}, matching the before contract.`
        : applicability === 'unknown'
          ? 'No single pinned Shopify Admin API version was found.'
          : `The code pins ${application}; this run compares ${versions.before} with ${versions.after}. Use the pinned version's contract as the before snapshot.`,
    policy: options.apiVersionPolicy,
    source: {
      status:
        pins.declared.length === 1 ? 'verified' : pins.declared.length ? 'conflict' : 'unknown',
      declarations: versionDeclarations(scan),
      reason:
        pins.declared.length === 1
          ? `Every runtime declaration pins ${pins.declared[0]}.`
          : pins.declared.length
            ? `Runtime declarations disagree: ${pins.declared.join(', ')}.`
            : 'No runtime Admin API version declaration was found.',
    },
  };
  const blocking = findings.find((finding) => finding.contractReview);
  // Rule edits to documents ship only with the version move they are for.
  const versionEdits = [...pins.edits, ...(source ? source.edits : [])];
  const ruleEdits = versionEdits.length ? [...versionEdits, ...documentEdits.values()] : [];
  const edits = [...(versionEdits.length ? [...ruleEdits, ...aiEdits] : []), ...restEdits];
  const environmentPins = scan.versions.filter((entry) => entry.envFallback && !entry.api);
  const sdkUpgradeEvidence = upgraded
    ? {
        primary: upgraded.primary,
        from: upgraded.from,
        to: upgraded.to,
        apiRelease: upgraded.apiRelease,
        packages: upgraded.packages,
        removed: upgraded.removed,
        ...(upgraded.otherLockfiles ? { otherLockfiles: upgraded.otherLockfiles } : {}),
      }
    : upgradeResult && 'reason' in upgradeResult
      ? { skipped: upgradeResult.reason }
      : undefined;
  const confirmed = findings.filter((finding) => finding.confidence === 'confirmed');
  const status = confirmed.length
    ? 'affected'
    : scan.adminCalls || scan.documents.length || scan.versions.length
      ? 'needs-review'
      : 'no-provider-signal';
  const evidence = sdkUpgradeEvidence ? { shopifySdkUpgrade: sdkUpgradeEvidence } : {};
  const patch = !options.proposePatch
    ? {
        status: 'not-generated' as const,
        reason:
          'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
      }
    : blocking
      ? { status: 'not-generated' as const, reason: blocking.contractReview!, ...evidence }
      : applicability !== 'matches-before'
        ? { status: 'not-generated' as const, reason: apiVersion.reason, ...evidence }
        : !edits.length
          ? {
              status: 'not-generated' as const,
              reason: `The code already pins Admin API ${versions.after}.`,
            }
          : {
              generator: aiEdits.length ? ('openai' as const) : ('deterministic' as const),
              summary: `${versionEdits.length ? `Move the pinned Shopify Admin API version to ${versions.after}` : `Rewrite ${restRewrites.length} REST Admin calls as GraphQL Admin queries`}${
                upgraded
                  ? `, upgrading ${upgraded.primary} ${upgraded.from} to ${upgraded.to} (@shopify/shopify-api ${upgraded.apiRelease}) so the code can name ApiVersion.${member}`
                  : ''
              }${
                documentEdits.size
                  ? `, and apply ${documentEdits.size} documented Shopify GraphQL rule edits (renamed fields keep their response key through an alias)`
                  : ''
              }${
                aiEdits.length
                  ? `; AI rewrote ${aiEdits.length} GraphQL documents no rule covers, each checked against the ${versions.after} schema and the original response shape`
                  : ''
              }. Every traced GraphQL document validates against the ${versions.after} schema and no selected field changes type.`,
              status: 'proposed' as const,
              edits: edits.length + (upgraded ? upgraded.files.length : 0),
              // REST rewrites always need a reviewer (docs/SHOPIFY-REST.md).
              unresolvedFindings: restRewrites.length,
              diff:
                renderPatch(patchRepository, edits) +
                (upgraded
                  ? renderFileReplacements(repository, upgraded.files, SHOPIFY_SDK_RULE)
                  : ''),
              validation: 'not-run',
              ruleEdits,
              ...evidence,
              warnings: [
                ...restRewriteNotes(restRewrites),
                ...(upgraded
                  ? [
                      `Upgrades ${upgraded.packages.map((entry) => `${entry.name} ${entry.from ?? '(new)'} to ${entry.to}`).join(', ')} in package.json and package-lock.json from verified npm registry metadata (SHA-512 integrity)${upgraded.removed.length ? `, removing ${upgraded.removed.length} lock entries nothing requires any more` : ''}. Review it against the shopify-app-js changelogs and the v12 migration guide: ${SHOPIFY_MIGRATION_GUIDE}`,
                      '@shopify/shopify-api 12 requires Node.js 20.10 or later (dc41d09); check the deployment runtime.',
                      ...Object.entries(upgraded.otherLockfiles ?? {}).map(
                        ([file, why]) =>
                          `${file} still locks the older Shopify packages: the repository installs from package-lock.json (${why}). Delete the lockfile your package manager does not use.`,
                      ),
                    ]
                  : []),
                ...[...deprecated].map((entry) => `Deprecated on ${versions.after}: ${entry}`),
                ...(scan.documents.some((document) => !document.traced)
                  ? [
                      `${scan.documents.filter((document) => !document.traced).length} #graphql documents were not traced to an Admin call; they were checked against both contracts anyway.`,
                    ]
                  : []),
                ...environmentPins.map(
                  (entry) =>
                    `${entry.file}:${entry.line} moves the default Admin API version; the environment variable ${entry.envFallback} overrides it where it is set.`,
                ),
                ...(storefront.length
                  ? [
                      `${storefront.length} Storefront API documents were not checked: this run compares Admin API contracts, and Storefront clients keep their own version.`,
                    ]
                  : []),
                webhookVersions.length
                  ? `Webhook subscriptions keep their own API version in the app configuration (${webhookVersions.map((entry) => `${entry.file}: ${entry.version}`).join(', ')}); Refit does not move it, because handlers read the payload shape of that version.`
                  : 'Webhook subscriptions keep their own API version in the app configuration (shopify.app.toml); review it separately.',
                'Patch contains source code. Review it for sensitive content before sharing.',
              ],
            };
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      ...(repository.configurations?.length ? { configurations: repository.configurations } : {}),
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: SHOPIFY.id,
    adapter: { ...SHOPIFY, packageName },
    runId: digest(
      `${options.before.hash}:${options.after.hash}:${repositoryHash}:shopify:${options.apiVersion ?? ''}:${options.apiVersionPolicy}`,
    ),
    apiVersion,
    sourceResolution: { status: 'relative-only' as const, warnings: [] as string[] },
    status,
    snapshots: { before: options.before.hash, after: options.after.hash },
    provenance: { before: options.before.provenance, after: options.after.provenance },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    },
    changes: [],
    specificationDiff: {
      engine: 'graphql' as const,
      changes: findBreakingChanges(before, after).map((change) => ({
        type: change.type,
        description: change.description,
      })),
      coverage: `graphql-js breaking changes between the ${versions.before} and ${versions.after} Admin API schemas. Each document is validated against both schemas; only literal and constant documents reached from Admin calls or marked #graphql are checked.`,
    },
    imports: [],
    calls: [],
    sdkCalls: [],
    expandedFields: [] as string[],
    findings,
    providerDetected: scan.shopifyFiles.length > 0,
    stripeDetected: false,
    skippedFiles: [] as string[],
    operationImpacts: [],
    operationChanges: [],
    shopify: {
      sdkRelease: sdkRelease ?? null,
      documents: scan.documents.length,
      tracedDocuments: scan.documents.filter((document) => document.traced).length,
      adminCalls: scan.adminCalls,
      unreadable: scan.unreadable.length,
      rest: scan.rest.length,
      // Each REST Admin call; reads a rule maps are rewritten as GraphQL (docs/SHOPIFY-REST.md).
      restCalls: scan.rest.map((entry) => ({
        file: entry.file,
        line: entry.line,
        column: entry.column,
        method: entry.method ?? null,
        path: entry.path ?? null,
        resource: entry.resource ?? null,
        expression: entry.expression,
      })),
      otherApiDocuments: otherApi.map((document) => `${document.file}:${document.line}`),
      storefrontDocuments: storefront.map((document) => `${document.file}:${document.line}`),
      webhookApiVersions: webhookVersions,
      ruleEdits: documentEdits.size,
      restRewrites: restRewrites.length,
      restAi: restRun.proposals.map((proposal) => ({
        file: proposal.file,
        line: proposal.line,
        status: proposal.status,
        model: proposal.model,
        costUsd: proposal.costUsd,
        reason: proposal.reason,
      })),
      ai: aiAttempts.map((attempt) => ({
        file: attempt.file,
        line: attempt.line,
        status: attempt.status,
        model: attempt.model,
        costUsd: attempt.costUsd,
        reason: attempt.reason,
      })),
      deprecated: [...deprecated],
    },
    warnings: [
      ...repository.warnings,
      ...(blocking ? [blocking.contractReview!] : []),
      ...(apiVersion.applicability === 'matches-before' ? [] : [apiVersion.reason]),
    ],
    assessment: { status: 'not-requested' as const },
    coverage: {
      specification: `Shopify Admin GraphQL schemas ${versions.before} and ${versions.after}, compared by introspection.`,
      code: 'Admin GraphQL documents passed to admin.graphql, createAdminApiClient().request and clients.Graphql().query, resolved from literals, constants, imported and re-exported constants, constant fragments, constant arrays and objects, and helper parameters followed through every call, callback and closure factory, plus #graphql literals. ApiVersion enum members, apiVersion strings and /admin/api/<version>/ URLs are read as pins. REST Admin reads are rewritten as GraphQL where a documented or checked mapping produces every field the code reads. Runtime-built documents, sending functions Refit cannot follow, other REST calls and unresolved pins stop for review.',
      decision:
        'No finding is not proof of no impact: documents Refit cannot read and behavior that validation cannot see (semantics, rate limits, webhook payload versions) remain outside this check.',
    },
    nextAction:
      status === 'affected'
        ? 'Review the version change, then validate the patch in an isolated environment.'
        : 'Review Shopify usage Refit could not trace before deciding impact.',
    patch,
  };
}

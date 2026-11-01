import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  type ShopifyScan,
} from './shopify-analysis.ts';
import {
  loadShopifyDocumentRules,
  rewriteDocument,
  variableRules,
  type DocumentEdit,
  type ShopifyDocumentRule,
} from './shopify-document-rules.ts';
import { documentProof, fragmentPool, shopifySchemaProof, withFragments } from './shopify-proof.ts';
import { shopifySchema } from './shopify-schemas.ts';
import { diffSchemas } from './shopify-schema-diff.ts';
import {
  aiReconstructDocument,
  reconstructionSources,
  type ShopifyReconstruction,
} from './shopify-ai-rewrite.ts';
import { fixWithAgent, shopifyHandOff, type FixWithAgent } from './shopify-agent.ts';
import type { ShopifyLiveCase } from './shopify-live-proof.ts';
import { loadShopifyMigrationRules, migrateDocument } from './shopify-migrations.ts';
import {
  SHOPIFY_SDK_RULE,
  shopifySdkSourceChanges,
  shopifyVersionStringPins,
} from './shopify-sdk-source.ts';
import { shopifySdkUpgrade } from './shopify-sdk-upgrade.ts';
import {
  enumFromVersion,
  latestApiVersion,
  SHOPIFY_API_ENUM_SINCE,
  sdkHasEnumMember,
} from './shopify-versions.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { digest, isObject } from './specifications.ts';
import { proveShopifyRest } from './shopify-rest-contract.ts';
import { loadShopifyRestRefusals, loadShopifyRestRules } from './shopify-rest-rewrite.ts';
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
const VERSIONING = 'https://shopify.dev/docs/api/usage/versioning';
// Version findings that only an SDK the app does not have can clear: the target ApiVersion member
// is missing, or LATEST_API_VERSION stays until an SDK upgrade.
const SDK_BOUND = new WeakSet<Finding>();
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.next']);
const MAX_EXTRA_BYTES = 2 * 1024 * 1024;
const WEBHOOK_VERSION = /^\s*api_version\s*=\s*["'](\d{4}-\d{2}|unstable)["']/m;

// The files source scanning skips that carry Shopify facts: .graphql and .gql documents, and the
// app configuration (shopify.app.toml, shopify.app.<name>.toml), whose api_version sets the webhook
// payload version.
export async function shopifyExtraFiles(root: string) {
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
    // A #graphql literal no Admin call reaches that does not parse is a piece the code assembles at
    // runtime (the call that sends it is reported as unreadable) or fails on every version; the
    // schema proof treats it the same way.
    if (!document.traced) return { findings: [], deprecated: [], otherApi: true };
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
  // The text the schema proof checks: the document as it will be sent.
  sent = document.text,
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
  // What the schema proof sees beyond selected fields (pipeline/shopify-proof.ts): a variable whose
  // input type loses a field or enum value, or gains a required field. The code's runtime values
  // may still send what was removed.
  const reported = new Set(findings.map((finding) => finding.changeId));
  for (const change of documentProof(sent, after, before) ?? []) {
    const field = /^(\w+\.\w+) changes from /.exec(change)?.[1];
    if (field && reported.has(`shopify-graphql-type:${field}`)) continue;
    findings.push({
      file: document.file,
      line: document.line,
      column: document.column,
      changeId: `shopify-graphql-input:${digest(change).slice(0, 12)}`,
      expression: change,
      confidence,
      reason: `Valid on ${versions.before} and ${versions.after}, but ${change}, and the code's variables may still send it.`,
      contractReview: `A Shopify GraphQL document's variables reach an input change on Admin API ${versions.after} (${change}); Refit cannot see the values the code sends.`,
    });
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
    // Notes (an environment variable with no default, `unstable`) are left as they are.
    ...scan.unresolvedVersions
      .filter((entry) => !entry.note && !CODEGEN_CONFIG.test(entry.file))
      .map((entry) => ({
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

// What the draft says about each @shopify/shopify-api major the upgrade crosses, from its
// CHANGELOG.md in Shopify/shopify-app-js (read 2026-10-29). Type changes are left to the type check.
function sdkUpgradeNotes(packages: { name: string; from: string | null; to: string }[]) {
  const api = packages.find((entry) => entry.name === '@shopify/shopify-api');
  const [from, to] = [
    Number((api?.from ?? '0').split('.')[0]),
    Number((api?.to ?? '0').split('.')[0]),
  ];
  const crossed = (major: number) => from < major && to >= major;
  const prisma = packages.find(
    (entry) => entry.name === '@shopify/shopify-app-session-storage-prisma',
  );
  const prismaCrossed =
    prisma &&
    Number((prisma.from ?? '0').split('.')[0]) < 8 &&
    Number(prisma.to.split('.')[0]) >= 8;
  return [
    to >= 14
      ? '@shopify/shopify-api 14 requires Node.js 22 or later (9fec7af); check the deployment runtime.'
      : '@shopify/shopify-api 12 requires Node.js 20.10 or later (dc41d09); check the deployment runtime.',
    ...(crossed(13)
      ? [
          '@shopify/shopify-api 13 removed API versions 2022-10 to 2024-07 (0bb7837) and made WebhookFields a union keyed on webhookType (1eb863d); 13.1.0 signs OAuth and session cookies with a derived key, so merchants may need to sign in again.',
        ]
      : []),
    ...(packages.some((entry) => entry.name === 'prisma')
      ? [
          `Prisma upgraded because session storage requires it: ${packages
            .filter((entry) => entry.name === 'prisma' || entry.name === '@prisma/client')
            .map((entry) => `${entry.name} ${entry.from ?? '(new)'} to ${entry.to}`)
            .join(
              ', ',
            )}. Refit checked the schema against Prisma 6's documented breaking changes and changed no migration or model; run prisma generate and your migrations as usual.`,
        ]
      : []),
    ...(prismaCrossed
      ? [
          '@shopify/shopify-app-session-storage-prisma 8 can store OAuth refresh tokens (700377f). Shopify documents it as backward-compatible: the new Session fields are optional. To keep refresh tokens, add refreshToken String? and refreshTokenExpires DateTime? to the Prisma Session model and run a migration.',
        ]
      : []),
    ...(crossed(14)
      ? [
          '@shopify/shopify-api 14 hardens App Proxy validation and the OAuth callback can throw different errors (b1bcc27); check error handling around them.',
        ]
      : []),
  ];
}

function sdkBound(finding: Finding) {
  SDK_BOUND.add(finding);
  return finding;
}

// `upgrade` is the opt-in SDK upgrade: the release it moves @shopify/shopify-api to, or why it
// stopped.
function versionFindings(
  scan: ShopifyScan,
  versions: { before: string; after: string },
  sdkRelease: string | undefined,
  upgrade?:
    | { release: string; lockless?: boolean }
    | { refusal: string }
    // The locked SDK stays and every pin becomes the dated string (shopifyVersionStringPins).
    | { stringPin: true },
) {
  const stopped =
    upgrade && 'refusal' in upgrade ? ` The SDK upgrade stopped: ${upgrade.refusal}` : '';
  const upgradedRelease = upgrade && 'release' in upgrade ? upgrade.release : undefined;
  const stringPin = Boolean(upgrade && 'stringPin' in upgrade);
  const stringPinReason = `@shopify/shopify-api ${sdkRelease} has no ApiVersion.${enumFromVersion(versions.after)}, but it sends apiVersion only in GraphQL request URLs, and this app uses no REST, billing or Storefront client, so Refit pins the dated string '${versions.after}' without the SDK upgrade (docs/SHOPIFY-SDK-UPGRADE.md#dated-version-string).`;
  const findings: Finding[] = [];
  const edits: SourceEdit[] = [];
  const runtime = scan.versions.filter((entry) => !CODEGEN_CONFIG.test(entry.file) && !entry.api);
  const member = enumFromVersion(versions.after)!;
  // LATEST_API_VERSION is fixed by the locked SDK release, so it counts as that release's pin.
  // Without a lockfile the installed release is unknown, but LATEST_API_VERSION exists only before
  // @shopify/shopify-api 12, where every value is older than the oldest supported version, which
  // Shopify serves instead. The upgrade that replaces it then moves from that version.
  const latest = sdkRelease
    ? latestApiVersion(sdkRelease)
    : upgrade && 'release' in upgrade && upgrade.lockless
      ? versions.before
      : undefined;
  // Pins compared by the version Shopify serves: every pin older than the oldest supported version
  // gets that version, so they do not disagree.
  const pinned = [
    ...new Set([
      ...runtime.map((entry) => entry.value),
      ...(latest && scan.unresolvedVersions.some((entry) => entry.latest) ? [latest] : []),
    ]),
  ];
  const served = [
    ...new Set(pinned.map((value) => (value < versions.before ? versions.before : value))),
  ];
  const declared = pinned.length > 1 ? served : pinned;
  for (const entry of scan.unresolvedVersions.filter((entry) => entry.note))
    findings.push({
      ...entry,
      changeId: SHOPIFY_VERSION_RULE,
      expression: entry.note === 'unstable' ? 'unstable' : 'apiVersion',
      confidence: 'review',
      reason: entry.reason,
    });
  for (const entry of scan.unresolvedVersions.filter((entry) => !entry.note))
    findings.push(
      entry.latest && latest && stringPin
        ? {
            ...entry,
            changeId: SHOPIFY_VERSION_RULE,
            expression: `LATEST_API_VERSION (${latest} in @shopify/shopify-api ${sdkRelease}) → '${versions.after}'`,
            confidence: 'confirmed',
            reason: stringPinReason,
          }
        : entry.latest && latest && upgradedRelease
          ? {
              ...entry,
              changeId: SHOPIFY_VERSION_RULE,
              expression: `LATEST_API_VERSION (${sdkRelease ? `${latest} in @shopify/shopify-api ${sdkRelease}` : `served as ${latest}; no lockfile`}) → ApiVersion.${member}`,
              confidence: 'confirmed',
              reason: `@shopify/shopify-api 12.0.0 removed LATEST_API_VERSION; the SDK upgrade to ${upgradedRelease} pins ApiVersion.${member}.`,
            }
          : entry.latest && latest
            ? sdkBound({
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
                    : `ApiVersion.${member} first ships in ${SHOPIFY_API_ENUM_SINCE[member] ?? 'an unknown release'}, so the SDK must be upgraded with the version.`
                }${stopped}`,
              })
            : {
                ...entry,
                changeId: SHOPIFY_VERSION_RULE,
                expression: 'apiVersion',
                confidence: 'review',
                reason: entry.reason,
                contractReview: `The Shopify Admin API version is not a literal Refit can verify and bump: ${entry.reason}`,
              },
    );
  // Several pins all move to the target; the schema proof judges every document they send.
  const enumRelease = upgradedRelease ?? sdkRelease;
  const enumMissing =
    !stringPin &&
    runtime.some((entry) => entry.kind === 'enum') &&
    !(enumRelease && sdkHasEnumMember(enumRelease, member));
  for (const entry of scan.versions) {
    // Storefront clients keep their own version; this run checks only the Admin contract.
    if (entry.value >= versions.after || entry.api) continue;
    const codegen = CODEGEN_CONFIG.test(entry.file);
    const missing = entry.kind === 'enum' && enumMissing;
    // String pins replace the whole ApiVersion expression themselves.
    if ((!codegen || !missing) && !(stringPin && entry.kind === 'enum'))
      edits.push({
        file: entry.file,
        start: entry.start,
        end: entry.end,
        replacement: entry.kind === 'enum' ? member : versions.after,
        changeId: SHOPIFY_VERSION_RULE,
      });
    if (codegen) continue;
    const finding: Finding = {
      ...entry,
      changeId: SHOPIFY_VERSION_RULE,
      expression: `${entry.text} → ${entry.kind === 'enum' ? (stringPin ? `'${versions.after}'` : `ApiVersion.${member}`) : versions.after}`,
      confidence: 'confirmed',
      reason:
        stringPin && entry.kind === 'enum'
          ? stringPinReason
          : entry.value < versions.before
            ? `Pinned to ${entry.value}, which Shopify no longer serves; requests already get ${versions.before}.`
            : `Pinned to ${entry.value}; the target is ${versions.after}.`,
      ...(missing
        ? {
            contractReview: `@shopify/shopify-api ${sdkRelease ?? '(version not found in the lockfile)'} has no ApiVersion.${member}; it first ships in ${SHOPIFY_API_ENUM_SINCE[member] ?? 'an unknown release'}, so the SDK must be upgraded with the version.${stopped}`,
          }
        : {}),
    };
    findings.push(missing ? sdkBound(finding) : finding);
  }
  if (!runtime.length && scan.adminCalls && !scan.unresolvedVersions.some((entry) => !entry.note))
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
    // Breaks the target brings, and breaks of documents that already fail on the oldest supported
    // version, which Shopify serves today: a rule's rewrite must hold on the target either way.
    !result.findings.every(
      (finding) =>
        finding.reason.startsWith('Valid on') || finding.reason.startsWith('This document already'),
    )
  )
    return undefined;
  const rewrite = rewriteDocument(document.text, before, after, rules);
  if (!rewrite) return undefined;
  if ('refusal' in rewrite) return { refusal: rewrite.refusal };
  const edits = rewrite.edits.map((edit) => sourceEdit(document, edit));
  if (edits.some((edit) => !edit))
    return { refusal: 'An edit falls on an escaped string the source spells differently.' };
  const types = typeChanges(parse(document.text), document, before, after, versions, rewrite.text);
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

const RULE_TABLES = new URL('../data/rules/shopify/', import.meta.url);
const MAX_CHANGES = 120;

// What changed, quoted from Refit's Shopify data, for the agent: the schema diff entries for the
// types the code uses, the quoted rule and migration table entries between the versions, and the
// REST to GraphQL mappings when a REST call is handed off.
function shopifyChange(options: {
  findings: Finding[];
  before: GraphQLSchema;
  after: GraphQLSchema;
  versions: { before: string; after: string };
  documents: string[];
}) {
  const used = options.documents.join('\n') + options.findings.map((f) => f.expression).join('\n');
  const schema = diffSchemas(options.before, options.after)
    .filter((change) => change.breaking && used.includes(change.coordinate.split('.')[0]))
    .slice(0, MAX_CHANGES)
    .map(
      (change) =>
        `- ${change.text}${change.deprecationReason ? ` Shopify's deprecation note: "${change.deprecationReason.replace(/\s+/g, ' ')}"` : ''}`,
    );
  const rules = readdirSync(RULE_TABLES)
    .filter((name) => /^admin-.*\.json$/.test(name))
    .flatMap((name) => {
      const table: unknown = JSON.parse(readFileSync(new URL(name, RULE_TABLES), 'utf8'));
      if (
        !isObject(table) ||
        typeof table.version !== 'string' ||
        table.version <= options.versions.before ||
        table.version > options.versions.after ||
        !Array.isArray(table.rules)
      )
        return [];
      return table.rules
        .filter(isObject)
        .map(
          (rule) =>
            `- ${table.version as string}: ${String(rule.coordinate)}${rule.replacement ? ` → ${String(rule.replacement)}` : ''} (${String(rule.source)})${rule.warning ? ` ${String(rule.warning)}` : ''}${rule.quote ? ` Quote: "${String(rule.quote).replace(/\s+/g, ' ')}"` : ''}`,
        );
    });
  const rest = options.findings.some((finding) => finding.changeId === 'shopify-rest')
    ? [
        ...loadShopifyRestRules().map(
          (rule) =>
            `- REST ${rule.method} ${rule.path} → GraphQL ${rule.root}${rule.rest ? ` (${rule.rest.url})` : ''}${rule.graphql ? ` (${rule.graphql.url})` : ''}${rule.notes?.length ? ` ${rule.notes.join(' ')}` : ''}`,
        ),
        ...loadShopifyRestRefusals().map(
          (refusal) =>
            `- REST ${refusal.method} ${refusal.path} has no equivalent GraphQL query: ${refusal.reason} (${refusal.source})`,
        ),
      ]
    : [];
  const sdk = options.findings.some(
    (finding) => SDK_BOUND.has(finding) || finding.changeId === SHOPIFY_SDK_RULE,
  )
    ? [`- The Shopify SDK migration guides: ${SHOPIFY_MIGRATION_GUIDE}`]
    : [];
  return [
    `Shopify Admin API ${options.versions.before} to ${options.versions.after} (${VERSIONING}).`,
    ...(schema.length ? ['Breaking schema changes for the types the code uses:', ...schema] : []),
    ...(rules.length ? ['Documented Shopify changes Refit keeps as rules:', ...rules] : []),
    ...(rest.length ? ["REST to GraphQL mappings from Shopify's references:", ...rest] : []),
    ...sdk,
  ].join('\n');
}

// Why each finding was handed off, with where it is, for the agent.
function shopifyContext(options: {
  findings: Finding[];
  handoff: string[];
  versions: { before: string; after: string };
  sdkRelease: string | undefined;
  upgrade: { skipped: string } | { from: string; to: string; primary: string } | undefined;
  codemods: number;
  notes: string[];
}) {
  return [
    `Refit's codemods already made ${options.codemods} edit${options.codemods === 1 ? '' : 's'} in this tree. Each item below used to end the repository without a patch; fix all of them so the code works on Shopify Admin API ${options.versions.after}.`,
    `Locked @shopify/shopify-api: ${options.sdkRelease ?? 'not found in a lockfile'}. SDK upgrade: ${!options.upgrade ? 'not attempted' : 'skipped' in options.upgrade ? `not applied: ${options.upgrade.skipped}` : `applied, ${options.upgrade.primary} ${options.upgrade.from} to ${options.upgrade.to}`}.`,
    'Stops:',
    ...options.handoff.map((reason) => {
      const sites = options.findings.filter((finding) => finding.contractReview === reason);
      return `- ${reason}${sites.length ? `\n${sites.map((finding) => `  - ${finding.file}:${finding.line} \`${finding.expression}\`: ${finding.reason}`).join('\n')}` : ''}`;
    }),
    ...(options.notes.length ? ['Notes:', ...options.notes.map((note) => `- ${note}`)] : []),
  ].join('\n');
}

type ShopifyRunOptions = {
  repository: string;
  before: Snapshot;
  after: Snapshot;
  proposePatch?: boolean;
  apiVersion?: string;
  apiVersionPolicy: ApiVersionPolicy;
  // Opt-in: when the locked SDK cannot name the target version, propose its major upgrade.
  sdkUpgrade?: boolean;
  // With AI enabled, every finding Refit used to stop on is handed to the agent fixer, and documents
  // Refit cannot read are read by the model (AI use 5).
  aiPatch?: AiOptions;
  // The agent fixer (pipeline/shopify-agent.ts); tests pass a stub.
  agent?: FixWithAgent;
  // Validation's networked lockfile resolution (pipeline/lockfile-resolution.ts), for SDK upgrades.
  lockfileResolution?: { image: string; before: string };
  // The snapshot of another Admin API version, for the fallback below.
  snapshot?: (version: string) => Promise<Snapshot>;
};

// Supported quarterly versions from `after` back to `before`, newest first, `after` excluded.
function versionsBetween(before: string, after: string) {
  const found: string[] = [];
  let [year, month] = after.split('-').map(Number);
  for (;;) {
    [year, month] = month > 3 ? [year, month - 3] : [year - 1, month + 9];
    const version = `${year}-${String(month).padStart(2, '0')}`;
    if (version < before) return found;
    found.push(version);
  }
}

// When the agent fixer did not pass on the target and only the SDK the app has, or documents that
// break on the target itself, hold the move, the newest supported version the app can move to
// without any hand-off instead (each stays supported for about a year), with the version and SDK
// moved together as for the target.
export async function runShopifyPipeline(options: ShopifyRunOptions) {
  const report = await shopifyRun(options);
  if (
    !options.proposePatch ||
    !options.snapshot ||
    report.shopify.agent.outcome === 'passed' ||
    !report.shopify.handoff.length ||
    !report.findings.every(
      (finding) =>
        !finding.contractReview ||
        SDK_BOUND.has(finding) ||
        finding.changeId === SHOPIFY_SDK_RULE ||
        finding.reason.startsWith('Valid on'),
    )
  )
    return report;
  const target = report.apiVersion.after ?? '';
  const why = report.shopify.handoff[0];
  for (const version of versionsBetween(report.apiVersion.before ?? target, target)) {
    // The fallback is the rules' patch alone: the agent already had its attempt on the target.
    const fallback = await shopifyRun({
      ...options,
      aiPatch: undefined,
      after: await options.snapshot(version),
    });
    if (fallback.patch.status !== 'proposed' || fallback.shopify.handoff.length) continue;
    const deadline = (await loadDeadlineRegistry()).deadlines.find(
      (entry) => entry.id === `shopify-admin-${version}`,
    )?.date;
    const note = `Moves to ${version}, not ${target}: ${why} ${version} is the newest supported version this app can take now${deadline ? `, and Shopify serves it until ${deadline}` : ''} (${VERSIONING}).`;
    return {
      ...fallback,
      fallback: { target, version, reason: why, agent: report.shopify.agent },
      patch: {
        ...fallback.patch,
        summary: `${note} ${'summary' in fallback.patch ? fallback.patch.summary : ''}`,
        warnings: [note, ...('warnings' in fallback.patch ? fallback.patch.warnings : [])],
      },
    };
  }
  return report;
}

async function shopifyRun(options: ShopifyRunOptions) {
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
  const migrationRules = loadShopifyMigrationRules(versions.after);
  // Development store cases for documents whose variables a migration changed, at their lines.
  const liveCases: (Omit<ShopifyLiveCase, 'document'> & { file: string; line: number })[] = [];
  const migrationNotes: string[] = [];
  const documentEdits = new Map<string, SourceEdit>();
  const variableNotes = new Set<string>();
  const pool = fragmentPool(scan.documents);
  for (const original of scan.documents) {
    if (original.api === 'storefront') {
      storefront.push(original);
      continue;
    }
    const document = withFragments(original, pool);
    try {
      for (const rule of variableRules(document.text, rules))
        variableNotes.add(
          `${document.file}:${document.line} sends ${rule.type} through a variable; Shopify rule ${rule.rule} (${rule.type}.${rule.member} → ${rule.replacement}) edits only values written in the document, so check what the code sends.`,
        );
    } catch {
      // A document that does not parse is reported by checkDocument.
    }
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
    // Documents that already fail on the oldest supported version, or break on the target, and
    // that no in-place rule fixed: the documented migrations and the unused-variable fix, which also
    // edit the code around the document (pipeline/shopify-migrations.ts).
    if (
      !(rewritten && 'edits' in rewritten) &&
      result.findings.length &&
      !result.otherApi &&
      result.findings.every(
        (finding) =>
          finding.reason.startsWith('This document already') ||
          (finding.reason.startsWith('Valid on') &&
            !finding.changeId.startsWith('shopify-graphql-input:')),
      )
    ) {
      const migration = migrateDocument({
        document,
        source: patchRepository.files.find((file) => file.path === document.segments[0]?.file)
          ?.content,
        after,
        rules: migrationRules,
      });
      const types =
        migration && 'edits' in migration
          ? typeChanges(
              parse(migration.text),
              { ...document, text: migration.text },
              before,
              after,
              versions,
              migration.text,
            )
          : undefined;
      if (migration && 'edits' in migration && !types!.findings.length) {
        for (const edit of migration.edits)
          documentEdits.set(`${edit.file}:${edit.start}:${edit.end}:${edit.replacement}`, edit);
        liveCases.push(
          ...migration.liveCases.map((entry) => ({
            ...entry,
            file: document.file,
            line: document.line,
          })),
        );
        for (const name of migration.uncovered)
          migrationNotes.push(
            `${document.file}:${document.line} (${name}): the migration changes the variables the code sends, and Refit could not write a development store case for it, so the patch stays [Needs review] until the operation is run.`,
          );
        const confidence = document.traced ? ('confirmed' as const) : ('review' as const);
        result = {
          deprecated: types!.deprecated,
          findings: migration.notes.map((note) => ({
            ...documentLocation(document, note.offset),
            changeId: note.rule,
            expression: note.expression,
            confidence,
            reason: `${note.reason} The rewritten document validates on ${versions.after}.`,
          })),
        };
      } else if (migration)
        for (const finding of result.findings)
          finding.reason += ` A Shopify migration matched but was not applied: ${'refusal' in migration ? migration.refusal : 'a selected field changes type on the target.'}`;
    }
    findings.push(...result.findings);
    for (const entry of result.deprecated) deprecated.add(entry);
    if (result.otherApi) otherApi.push(document);
  }
  // A Storefront call's unreadable document does not reach the Admin version move.
  const storefrontUnreadable = scan.unreadable.filter((entry) => entry.api);
  const reconstructed: (ShopifyReconstruction & { file: string; line: number })[] = [];
  for (const entry of scan.unreadable.filter((item) => !item.api)) {
    // AI use 5: the model reads the document from the code; it counts only when every name it
    // writes is in that code and the document validates on both versions (reconstructionProblem).
    const attempt = options.aiPatch
      ? await aiReconstructDocument({
          file: entry.file,
          line: entry.line,
          why: entry.reason,
          sources: reconstructionSources(patchRepository.files, entry.file),
          before,
          after,
          versions,
          ai: options.aiPatch,
        })
      : undefined;
    if (attempt) reconstructed.push({ ...attempt, file: entry.file, line: entry.line });
    findings.push(
      attempt?.status === 'kept'
        ? {
            ...entry,
            changeId: 'shopify-graphql-reconstructed',
            expression: 'Admin GraphQL call',
            confidence: 'review',
            reason: `AI (${attempt.model}) read the document this call sends from the code; Refit checked that every name in it is written there and that it validates on ${versions.before} and ${versions.after}. ${attempt.reason}`,
          }
        : {
            ...entry,
            changeId: 'shopify-graphql:unreadable',
            expression: 'Admin GraphQL call',
            confidence: 'review',
            reason: attempt
              ? `${entry.reason} AI could not read it: ${attempt.reason}`
              : entry.reason,
            contractReview: `Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API ${versions.after}.`,
          },
    );
  }
  const sdkRelease = await lockedShopifyApi(repository.root);
  // REST calls the versioned REST contract proves stay REST and move with the version; the agent
  // fixer gets the others.
  const restProofs = proveShopifyRest(repository, scan, versions);
  const restProven = restProofs.filter((item) => item.proof.status === 'proven');
  for (const { entry, proof } of restProofs)
    if (proof.status !== 'proven')
      findings.push({
        file: entry.file,
        line: entry.line,
        column: entry.column,
        changeId: 'shopify-rest',
        expression: restLabel(entry),
        confidence: 'review',
        reason: `REST Admin API usage Refit cannot prove: ${proof.reason}`,
        contractReview: `Refit cannot prove this REST Admin call against the ${versions.before} and ${versions.after} REST contracts (docs/SHOPIFY-REST.md): ${proof.reason}`,
      });
  const member = enumFromVersion(versions.after);
  const upgradeResult =
    options.sdkUpgrade &&
    member &&
    (scan.unresolvedVersions.some((entry) => entry.latest) ||
      scan.versions.some((entry) => entry.kind === 'enum' && !CODEGEN_CONFIG.test(entry.file))) &&
    !(sdkRelease && sdkHasEnumMember(sdkRelease, member))
      ? await shopifySdkUpgrade(repository.root, member, options.lockfileResolution)
      : undefined;
  const upgraded = upgradeResult && 'upgrade' in upgradeResult ? upgradeResult.upgrade : undefined;
  // Without the upgrade, a GraphQL-only app may pin the dated string on its locked SDK.
  const stringPins =
    upgradeResult && !upgraded
      ? shopifyVersionStringPins(repository, scan, sdkRelease, versions.after, after)
      : undefined;
  const stringEdits = stringPins && 'edits' in stringPins ? stringPins.edits : [];
  const source =
    upgraded && shopifySdkSourceChanges(repository, upgraded.primary, member!, upgraded.packages);
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
      ? { release: upgraded.apiRelease, lockless: upgraded.lockless }
      : stringEdits.length
        ? { stringPin: true }
        : upgradeResult && 'reason' in upgradeResult
          ? {
              refusal: `${upgradeResult.reason}${stringPins && 'reason' in stringPins ? ` A dated apiVersion string on the locked SDK does not apply either: ${stringPins.reason}` : ''}`,
            }
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
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      ...(repository.configurations?.length ? { configurations: repository.configurations } : {}),
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  // The agent's judge: the schema proof on the patched tree (every Admin document validates on the
  // target, every REST call is proven, no document left unread) and every runtime pin naming the
  // target on an SDK that has it.
  // shortcut: tsc, build and tests run later in validation; add GUT5's before/after check here once
  // gut/sandbox exposes it.
  const judge = async (directory: string) => {
    const patched = await readRepository(directory, packageName);
    const patchedExtra = await shopifyExtraFiles(directory);
    const patchedScan = scanShopify(patched, patchedExtra.graphql);
    const proof = shopifySchemaProof({
      original: patchRepository,
      patched: { ...patched, files: [...patched.files, ...patchedExtra.graphql] },
      before: { version: versions.before, schema: before },
      after: { version: versions.after, schema: after },
      scans: { original: scan, patched: patchedScan },
    });
    const release = await lockedShopifyApi(directory);
    const errors = [
      ...proof.failures.map(
        (failure) =>
          `${failure.file}:${failure.line}: ${failure.text} (Admin API ${failure.version})`,
      ),
      ...(proof.status === 'unproven' ? [proof.reason] : []),
      ...versionFindings(patchedScan, versions, release)
        .findings.filter((finding) => finding.contractReview)
        .map((finding) => `${finding.file}:${finding.line}: ${finding.contractReview}`),
      ...patchedScan.versions
        .filter(
          (entry) => !entry.api && !CODEGEN_CONFIG.test(entry.file) && entry.value < versions.after,
        )
        .map(
          (entry) =>
            `${entry.file}:${entry.line}: ${entry.text} still pins ${entry.value}; the target is ${versions.after}.`,
        ),
    ];
    return { passed: !errors.length, errors: [...new Set(errors)] };
  };
  // The codemods run first: the version move, the SDK upgrade and its source codemods, and the
  // documented rule and migration edits, which now ship without a version move too.
  const versionEdits = [...pins.edits, ...(source ? source.edits : []), ...stringEdits];
  const ruleEdits = [...versionEdits, ...documentEdits.values()];
  const edits = ruleEdits;
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
  const notes = [
    ...(restProven.length
      ? [
          `${restProven.length} REST Admin call${restProven.length === 1 ? '' : 's'} stay REST: every endpoint, parameter, body key and response field ${restProven.length === 1 ? 'it uses' : 'they use'} is in the ${versions.before} REST contract and unchanged in ${versions.after} (Shopify's generated REST resources and REST reference, data/shopify-rest-contract.json): ${restProven.map((item) => `${item.entry.file}:${item.entry.line}`).join(', ')}.`,
        ]
      : []),
    ...(upgraded
      ? [
          upgraded.lockless
            ? `Upgrades ${upgraded.packages.map((entry) => `${entry.name} ${entry.from ?? '(new)'} to ${entry.to}`).join(', ')} in package.json. No lockfile is committed, so the install resolves these ranges; Refit's checks ran against a lockfile it resolved in networked Docker, which is not part of this patch. Review it against the shopify-app-js changelogs: ${SHOPIFY_MIGRATION_GUIDE}`
            : upgraded.resolved
              ? `Upgrades ${upgraded.packages.map((entry) => `${entry.name} ${entry.from ?? '(new)'} to ${entry.to}`).join(', ')}. ${upgraded.resolved.manager} re-resolved ${upgraded.resolved.lockfile} from the committed one in networked Docker with lifecycle scripts off, as of ${upgraded.resolved.before}${upgraded.resolved.legacyPeerDeps ? ' with --legacy-peer-deps' : ''}, because the target SDK needs newer framework packages than the lockfile had${upgraded.resolved.frameworks.length ? ` (${upgraded.resolved.frameworks.join(', ')})` : ''}; nothing outside the Shopify and framework packages and what only they reach changed. Review it against the shopify-app-js changelogs: ${SHOPIFY_MIGRATION_GUIDE}`
              : `Upgrades ${upgraded.packages.map((entry) => `${entry.name} ${entry.from ?? '(new)'} to ${entry.to}`).join(', ')} in package.json and package-lock.json from verified npm registry metadata (SHA-512 integrity)${upgraded.removed.length ? `, removing ${upgraded.removed.length} lock entries nothing requires any more` : ''}. Review it against the shopify-app-js changelogs and the v12 migration guide: ${SHOPIFY_MIGRATION_GUIDE}`,
          ...sdkUpgradeNotes(upgraded.packages),
          ...(source ? source.notes : []),
          ...Object.entries(upgraded.otherLockfiles ?? {}).map(
            ([file, why]) =>
              `${file} still locks the older Shopify packages: the repository installs from ${upgraded.resolved?.lockfile ?? 'package-lock.json'} (${why}). Delete the lockfile your package manager does not use.`,
          ),
        ]
      : []),
    ...(stringEdits.length
      ? [
          `Pins the dated string '${versions.after}' on the locked @shopify/shopify-api ${sdkRelease}, whose ApiVersion enum has no ${versions.after} member: that SDK sends apiVersion only in request URLs, and Refit validated every GraphQL document, including the SDK's webhook registration where the app registers webhooks, on ${versions.after}. The SDK upgrade did not apply: ${upgradeResult && 'reason' in upgradeResult ? upgradeResult.reason : ''}`,
        ]
      : []),
    ...[...deprecated].map((entry) => `Deprecated on ${versions.after}: ${entry}`),
    ...(scan.documents.some((document) => !document.traced)
      ? [
          `${scan.documents.filter((document) => !document.traced).length} #graphql documents were not traced to an Admin call; they were checked against both contracts anyway.`,
        ]
      : []),
    ...variableNotes,
    ...migrationNotes,
    ...reconstructed
      .filter((attempt) => attempt.status === 'kept')
      .map(
        (attempt) =>
          `${attempt.file}:${attempt.line} builds its GraphQL document at runtime; AI read it from the code and Refit validated it on ${versions.before} and ${versions.after}. Check that it is what the call sends:\n${attempt.document}`,
      ),
    ...scan.unresolvedVersions
      .filter((entry) => entry.note)
      .map((entry) => `${entry.file}:${entry.line}: ${entry.reason}`),
    ...environmentPins.map(
      (entry) =>
        `${entry.file}:${entry.line} moves the default Admin API version; ${/^[A-Z0-9_]+$/.test(entry.envFallback!) ? `the environment variable ${entry.envFallback}` : `\`${entry.envFallback}\``} overrides it where it is set.`,
    ),
    ...(storefront.length + storefrontUnreadable.length
      ? [
          `${storefront.length + storefrontUnreadable.length} Storefront API documents were not checked: this run compares Admin API contracts, and Storefront clients keep their own version.${storefrontUnreadable.length ? ` Refit could not read ${storefrontUnreadable.map((entry) => `${entry.file}:${entry.line}`).join(', ')}.` : ''}`,
        ]
      : []),
    webhookVersions.length
      ? `Webhook subscriptions keep their own API version in the app configuration (${webhookVersions.map((entry) => `${entry.file}: ${entry.version}`).join(', ')}); Refit does not move it, because handlers read the payload shape of that version.`
      : 'Webhook subscriptions keep their own API version in the app configuration (shopify.app.toml); review it separately.',
    'Patch contains source code. Review it for sensitive content before sharing.',
  ];
  const codemods =
    renderPatch(patchRepository, edits) +
    (upgraded ? renderFileReplacements(repository, upgraded.files, SHOPIFY_SDK_RULE) : '');
  // Every finding that used to end the repository, and a pin that does not match the before
  // contract, goes to the agent fixer at once: stops are layered, so it sees them all.
  const handedOff = findings.filter((finding) => finding.contractReview);
  const handoff = [
    ...new Set([
      ...handedOff.map((finding) => finding.contractReview!),
      ...(applicability === 'matches-before' ? [] : [apiVersion.reason]),
    ]),
  ];
  const agent =
    options.proposePatch && handoff.length
      ? await shopifyHandOff({
          repository: patchRepository,
          codemods,
          key: digest(
            `${repositoryHash}:${options.before.hash}:${options.after.hash}:${Boolean(options.sdkUpgrade)}`,
          ),
          run: Boolean(options.aiPatch),
          agent: options.agent ?? fixWithAgent,
          input: {
            target: versions.after,
            change: shopifyChange({
              findings: handedOff,
              before,
              after,
              versions,
              documents: scan.documents.map((document) => document.text),
            }),
            context: shopifyContext({
              findings: handedOff,
              handoff,
              versions,
              sdkRelease,
              upgrade: sdkUpgradeEvidence,
              codemods: edits.length + (upgraded ? upgraded.files.length : 0),
              notes: [
                ...variableNotes,
                ...migrationNotes,
                ...otherApi.map(
                  (document) =>
                    `${document.file}:${document.line} looks like another Shopify API's document and was not checked.`,
                ),
                ...(storefront.length + storefrontUnreadable.length
                  ? [
                      `${storefront.length + storefrontUnreadable.length} Storefront API documents keep their own version and were not checked.`,
                    ]
                  : []),
              ],
            }),
            check: (directory) => judge(directory),
          },
        })
      : undefined;
  const agentPatched =
    agent && (agent.outcome === 'passed' || agent.outcome === 'unproven') && agent.diff
      ? agent
      : undefined;
  // The agent passed the judges: what it resolved is no longer a review item; validation and the
  // proof levels decide whether the patch is validated.
  if (agentPatched?.outcome === 'passed')
    for (const finding of handedOff) {
      finding.reason += ` Handed to the agent fixer, whose patch passed Refit's Shopify judges.`;
      delete finding.contractReview;
    }
  const agentEvidence = agent
    ? {
        outcome: agent.outcome,
        errors: agent.errors,
        summary: agent.summary,
        costUsd: agent.costUsd,
        files: agent.files,
        sandbox: agent.sandbox,
      }
    : {
        outcome: 'not-run' as const,
        reason: !handoff.length
          ? 'Nothing was handed off.'
          : !options.proposePatch
            ? 'Scan only.'
            : 'The agent fixer needs AI (--ai-patch), and no earlier run left a result for this tree.',
      };
  const agentNotes = agentPatched
    ? [
        `The agent fixer wrote this patch on top of Refit's codemods. What it says it changed and could not verify: ${agentPatched.summary || '(no summary)'}`,
        ...(agentPatched.sandbox.status === 'unavailable'
          ? [
              `The sandbox check (type check, build and tests before and after) did not run while the agent worked: ${agentPatched.sandbox.reason}`,
            ]
          : agentPatched.sandbox.unproven),
        ...(agentPatched.outcome === 'unproven'
          ? [
              `Refit's Shopify judges still report ${agentPatched.errors.length} error${agentPatched.errors.length === 1 ? '' : 's'} on the patch: ${agentPatched.errors.join(' | ')}`,
            ]
          : []),
      ]
    : handoff.length
      ? [
          `${handoff.length} finding${handoff.length === 1 ? '' : 's'} Refit could not fix with its codemods ${handoff.length === 1 ? 'is' : 'are'} left for review: ${handoff.join(' | ')} The agent fixer ${agent ? `did not produce a patch (${agent.outcome}): ${agent.summary || agent.errors.join(' | ')}` : `did not run: ${(agentEvidence as { reason: string }).reason}`}`,
        ]
      : [];
  const proposed = (diff: string, agentWrote: boolean) => ({
    generator: agentWrote ? ('openai' as const) : ('deterministic' as const),
    summary: `${agentWrote ? `The agent fixer migrated the Shopify Admin API usage to ${versions.after} on top of Refit's codemods` : versionEdits.length ? `Move the pinned Shopify Admin API version to ${versions.after}` : `Apply ${documentEdits.size} documented Shopify GraphQL rule edits`}${
      upgraded
        ? `, upgrading ${upgraded.primary} ${upgraded.from} to ${upgraded.to} (@shopify/shopify-api ${upgraded.apiRelease}) so the code can name ApiVersion.${member}`
        : ''
    }${
      documentEdits.size && (versionEdits.length || agentWrote)
        ? `, and apply ${documentEdits.size} documented Shopify GraphQL rule edits (renamed fields keep their response key through an alias)`
        : ''
    }.${
      agentWrote && agentPatched?.outcome === 'passed'
        ? ` Refit's Shopify judges pass on the patched tree: every GraphQL document validates on ${versions.after}, every REST call is proven against the REST contract, and every pin names ${versions.after}.`
        : !agentWrote && !handoff.length
          ? ` Every traced GraphQL document validates against the ${versions.after} schema and no selected field changes type.`
          : ''
    }`,
    status: 'proposed' as const,
    edits: agentWrote
      ? agentPatched!.files.length
      : edits.length + (upgraded ? upgraded.files.length : 0),
    // Hand-offs the agent did not clear keep the draft [Needs review].
    unresolvedFindings:
      agentWrote && agentPatched?.outcome === 'passed'
        ? 0
        : agentWrote
          ? Math.max(1, agentPatched!.errors.length)
          : handoff.length,
    diff,
    validation: 'not-run' as const,
    ruleEdits,
    ...evidence,
    warnings: [...agentNotes, ...notes],
  });
  const patch = !options.proposePatch
    ? {
        status: 'not-generated' as const,
        reason:
          'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
      }
    : agentPatched
      ? proposed(agentPatched.diff, true)
      : edits.length
        ? proposed(codemods, false)
        : handoff.length
          ? {
              status: 'not-generated' as const,
              reason:
                agent?.outcome === 'no-change'
                  ? `The agent fixer changed nothing: ${agent.summary || handoff[0]}`
                  : handoff[0],
              ...evidence,
            }
          : {
              status: 'not-generated' as const,
              reason: `The code already pins Admin API ${versions.after}.`,
            };
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
      unreadable: scan.unreadable.length - storefrontUnreadable.length,
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
      storefrontDocuments: [...storefront, ...storefrontUnreadable].map(
        (document) => `${document.file}:${document.line}`,
      ),
      webhookApiVersions: webhookVersions,
      ruleEdits: documentEdits.size,
      restContract: restProofs.map((item) => ({
        file: item.entry.file,
        line: item.entry.line,
        ...item.proof,
      })),
      // Documents the model read from code Refit could not (AI use 5); the proof validates the kept ones.
      reconstructed: reconstructed.map((attempt) => ({
        file: attempt.file,
        line: attempt.line,
        status: attempt.status,
        model: attempt.model,
        costUsd: attempt.costUsd,
        reason: attempt.reason,
        ...(attempt.document ? { document: attempt.document } : {}),
      })),
      // The stops handed to the agent fixer, and what it did (docs/GUT-PLAN.md).
      handoff,
      agent: agentEvidence,
      deprecated: [...deprecated],
      // Development store cases the migrations wrote (pipeline/shopify-migrations.ts).
      liveCases,
    },
    warnings: [...repository.warnings, ...(agentPatched?.outcome === 'passed' ? [] : handoff)],
    assessment: { status: 'not-requested' as const },
    coverage: {
      specification: `Shopify Admin GraphQL schemas ${versions.before} and ${versions.after}, compared by introspection.`,
      code: 'Admin GraphQL documents passed to admin.graphql, createAdminApiClient().request and clients.Graphql().query, resolved from literals, constants, imported and re-exported constants, constant fragments, constant arrays and objects, and helper parameters followed through every call, callback and closure factory, plus #graphql literals. ApiVersion enum members, apiVersion strings and /admin/api/<version>/ URLs are read as pins. REST Admin calls stay REST where the versioned REST contract proves them. Rule and migration edits, the version move and the SDK upgrade run first; everything else Refit cannot prove (runtime-built documents, unproven REST calls, unresolved pins, documented SDK breaks) is handed to the agent fixer, whose patch is judged by the same schema, REST and pin checks.',
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

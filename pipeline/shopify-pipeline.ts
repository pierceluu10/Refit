import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { ApiVersionDeclaration, ApiVersionEvidence, ApiVersionPolicy } from './api-version.ts';
import { renderPatch } from './patches.ts';
import type { ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import {
  documentLocation,
  scanShopify,
  SHOPIFY_PACKAGES,
  type AdminDocument,
  type ShopifyScan,
} from './shopify-analysis.ts';
import { shopifySchema } from './shopify-schemas.ts';
import {
  enumFromVersion,
  latestApiVersion,
  SHOPIFY_API_ENUM_SINCE,
  sdkHasEnumMember,
} from './shopify-versions.ts';
import { digest, isObject } from './specifications.ts';
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
const UNKNOWN_FRAGMENT = /^Unknown fragment "/;
const MAX_EVIDENCE_TEXT = 300;

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
  // Selected fields whose declared type differs between the contracts: the document validates on
  // both, but values change shape (Date to DateTime, nullable results, new list types).
  const deprecated: string[] = [];
  if (!findings.length) {
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

// Runtime Admin API pins as API-version declarations; codegen configuration is not runtime.
function versionDeclarations(scan: ShopifyScan): ApiVersionDeclaration[] {
  return [
    ...scan.versions
      .filter((entry) => !CODEGEN_CONFIG.test(entry.file))
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

function versionFindings(
  scan: ShopifyScan,
  versions: { before: string; after: string },
  sdkRelease: string | undefined,
) {
  const findings: Finding[] = [];
  const edits: SourceEdit[] = [];
  const runtime = scan.versions.filter((entry) => !CODEGEN_CONFIG.test(entry.file));
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
      entry.latest && latest
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
            }`,
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
  const enumMissing =
    runtime.some((entry) => entry.kind === 'enum') &&
    !(sdkRelease && sdkHasEnumMember(sdkRelease, member));
  for (const entry of scan.versions) {
    if (entry.value >= versions.after) continue;
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
            contractReview: `@shopify/shopify-api ${sdkRelease ?? '(version not found in the lockfile)'} has no ApiVersion.${member}; it first ships in ${SHOPIFY_API_ENUM_SINCE[member] ?? 'an unknown release'}. Upgrading the SDK is a separate, reviewed change.`,
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

export async function runShopifyPipeline(options: {
  repository: string;
  before: Snapshot;
  after: Snapshot;
  proposePatch?: boolean;
  apiVersion?: string;
  apiVersionPolicy: ApiVersionPolicy;
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
  const scan = scanShopify(repository);
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
  for (const document of scan.documents) {
    const result = checkDocument(document, before, after, versions);
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
  for (const entry of scan.rest)
    findings.push({
      ...entry,
      changeId: 'shopify-rest',
      expression: entry.expression,
      confidence: 'review',
      reason: 'REST Admin API usage. Shopify publishes no versioned REST contract Refit can check.',
      contractReview:
        'The repository calls the REST Admin API, which has no published versioned contract; Refit cannot prove those calls survive the version change.',
    });
  const sdkRelease = await lockedShopifyApi(repository.root);
  const pins = versionFindings(scan, versions, sdkRelease);
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
  const edits = pins.edits;
  const confirmed = findings.filter((finding) => finding.confidence === 'confirmed');
  const status = confirmed.length
    ? 'affected'
    : scan.adminCalls || scan.documents.length || scan.versions.length
      ? 'needs-review'
      : 'no-provider-signal';
  const patch = !options.proposePatch
    ? {
        status: 'not-generated' as const,
        reason:
          'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
      }
    : blocking
      ? { status: 'not-generated' as const, reason: blocking.contractReview! }
      : applicability !== 'matches-before'
        ? { status: 'not-generated' as const, reason: apiVersion.reason }
        : !edits.length
          ? {
              status: 'not-generated' as const,
              reason: `The code already pins Admin API ${versions.after}.`,
            }
          : {
              generator: 'deterministic' as const,
              summary: `Move the pinned Shopify Admin API version to ${versions.after}. Every traced GraphQL document validates against the ${versions.after} schema and no selected field changes type.`,
              status: 'proposed' as const,
              edits: edits.length,
              unresolvedFindings: 0,
              diff: renderPatch(repository, edits),
              validation: 'not-run',
              ruleEdits: edits,
              warnings: [
                ...[...deprecated].map((entry) => `Deprecated on ${versions.after}: ${entry}`),
                ...(scan.documents.some((document) => !document.traced)
                  ? [
                      `${scan.documents.filter((document) => !document.traced).length} #graphql documents were not traced to an Admin call; they were checked against both contracts anyway.`,
                    ]
                  : []),
                'Webhook subscriptions keep their own API version in the app configuration (shopify.app.toml); review it separately.',
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
      otherApiDocuments: otherApi.map((document) => `${document.file}:${document.line}`),
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
      code: 'Admin GraphQL documents passed to admin.graphql, createAdminApiClient().request and clients.Graphql().query, resolved from literals, constants, imported and re-exported constants, constant fragments, constant arrays and objects, and helper parameters followed through every call, callback and closure factory, plus #graphql literals. ApiVersion enum members, apiVersion strings and /admin/api/<version>/ URLs are read as pins. Runtime-built documents, sending functions Refit cannot follow, REST calls and unresolved pins stop for review.',
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

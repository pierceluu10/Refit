import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiOptions } from './ai-budget.ts';
import {
  installedShopifyApi,
  scanShopify,
  SHOPIFY_PACKAGES,
  type AdminDocument,
} from './shopify-analysis.ts';
import {
  aiExtractShopifyRequests,
  reconstructionSources,
  type ShopifyExtraction,
} from './shopify-ai-rewrite.ts';
import {
  liveShopifyProof,
  shopifyAccessToken,
  shopifyTestStore,
  type ShopifyLiveCase,
  type ShopifyLiveProof,
} from './shopify-live-proof.ts';
import { lockedShopifyApi, shopifyExtraFiles } from './shopify-pipeline.ts';
import { checkDocument, fragmentPool, withFragments } from './shopify-proof.ts';
import {
  loadShopifyRestVersionContract,
  proveRestCall,
  proveShopifyRest,
} from './shopify-rest-contract.ts';
import { pinnedShopifySchema, pinnedShopifyVersions } from './shopify-schemas.ts';
import {
  enumFromVersion,
  latestApiVersion,
  sdkHasEnumMember,
  SHOPIFY_API,
} from './shopify-versions.ts';
import { readRepository } from './repository.ts';
import { isObject } from './specifications.ts';

// The Shopify judge (docs/GUT-PLAN.md): deterministic checks that grade a migrated repository at one
// Admin API version. AI only extracts what a call sends where static reading fails; the pinned
// schema, the REST contract and the development store decide.

// REST contract reasons that say the contract cannot decide, not that the call breaks it.
const UNDECIDED_REST =
  /whose fields the contract does not list|contract lists this path under|The REST contract has no Admin API|body that is not an object literal/;

export interface ShopifyJudgeOptions {
  // Reads calls Refit cannot read statically (aiExtractShopifyRequests); never grades.
  ai?: AiOptions;
  // Stands in for aiExtractShopifyRequests in tests.
  extract?: typeof aiExtractShopifyRequests;
  // SHOPIFY_TEST_STORE and its credentials turn on the live judge.
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  cases?: ShopifyLiveCase[];
}

export interface ShopifyExtractedEvidence {
  file: string;
  line: number;
  kind: 'graphql' | 'rest';
  text: string;
  sourceLines: number[];
}

export interface ShopifyJudgement {
  passed: boolean;
  // `file:line: reason`, one per problem, ready to hand back to the fixer.
  errors: string[];
  // The errors that say Refit could not judge something, rather than that it fails.
  unjudged: string[];
  // Requests an AI read from code Refit could not read: AI evidence, never static proof.
  extracted: ShopifyExtractedEvidence[];
  sdk?: { release: string; source: 'installed' | 'lockfile'; latest: string | null | undefined };
  live?: ShopifyLiveProof | { status: 'not-run'; reason: string };
  costUsd: number;
}

// The @shopify/shopify-api release the app runs: the installed copy's own declarations first, else
// the lockfile's release with Refit's release table.
async function shopifySdk(root: string) {
  const installed = await installedShopifyApi(root);
  if (installed) return { ...installed, source: 'installed' as const };
  const release = await lockedShopifyApi(root);
  if (!release) return undefined;
  return {
    release,
    source: 'lockfile' as const,
    // 12.0.0 removed LATEST_API_VERSION; older releases the table does not know stay unknown.
    latest: Number(release.split('.')[0]) >= 12 ? null : latestApiVersion(release),
    versions: undefined,
  };
}

// The live judge: every document sent to Refit's Partner development store at `target`. It passes
// when Shopify accepts each operation; store-side failures (throttling, 5xx) and operations it
// cannot run (mutations without a case, required variables) are not-run, never failed (#435).
export async function shopifyLiveJudge(
  documents: { id: string; text: string }[],
  target: string,
  options: Pick<ShopifyJudgeOptions, 'environment' | 'fetch' | 'cases'> = {},
): Promise<ShopifyLiveProof | { status: 'not-run'; reason: string }> {
  const settings = shopifyTestStore(options.environment ?? {});
  if (!settings) return { status: 'not-run', reason: 'No development store is configured.' };
  if ('refused' in settings) return { status: 'not-run', reason: settings.refused };
  const store = await shopifyAccessToken(settings, options.fetch);
  if ('refused' in store) return { status: 'not-run', reason: store.refused };
  return liveShopifyProof({
    store,
    versions: { before: target, after: target },
    documents: documents.map((document) => ({
      id: document.id,
      original: null,
      patched: document.text,
    })),
    cases: options.cases,
    fetch: options.fetch,
  });
}

// Grades `repoDir` at Admin API `target`. GUT2 passes it as the agent fixer's `check`.
export async function shopifyJudge(
  repoDir: string,
  target: string,
  options: ShopifyJudgeOptions = {},
): Promise<ShopifyJudgement> {
  const manifestPath = join(repoDir, 'package.json');
  const manifest: unknown = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : {};
  const declared = isObject(manifest)
    ? { ...(manifest.dependencies as object), ...(manifest.devDependencies as object) }
    : {};
  const repository = await readRepository(
    repoDir,
    SHOPIFY_PACKAGES.find((name) => Object.hasOwn(declared, name)) ?? SHOPIFY_API,
  );
  const extra = await shopifyExtraFiles(repository.root);
  const scan = scanShopify(repository, extra.graphql);
  const files = [...repository.files, ...extra.graphql];
  const schema = pinnedShopifySchema('admin', target).schema;
  const oldest = pinnedShopifySchema('admin', pinnedShopifyVersions('admin')[0]).schema;
  const errors: string[] = [];
  const unjudged: string[] = [];
  const extracted: ShopifyExtractedEvidence[] = [];
  const member = enumFromVersion(target);
  let costUsd = 0;
  const report = (message: string, undecided = false) => {
    errors.push(message);
    if (undecided) unjudged.push(message);
  };
  const cannot = (message: string) => report(message, true);
  const extract = async (file: string, line: number, kind: 'graphql' | 'rest', why: string) => {
    const run = options.extract ?? (options.ai ? aiExtractShopifyRequests : undefined);
    if (!run) return undefined;
    const result: ShopifyExtraction = await run({
      file,
      line,
      kind,
      why,
      sources: reconstructionSources(files, file),
      ai: options.ai!,
    });
    costUsd += result.costUsd ?? 0;
    return result;
  };

  // Versions. LATEST_API_VERSION is whatever the installed release names.
  const sdk = await shopifySdk(repository.root);
  const sdkLabel = sdk && `@shopify/shopify-api ${sdk.release} (${sdk.source})`;
  for (const entry of scan.versions) {
    if (entry.api) continue;
    const where = `${entry.file}:${entry.line}`;
    if (entry.value < target)
      errors.push(
        `${where}: ${entry.text} pins Admin API ${entry.value}; the target is ${target}.`,
      );
    else if (
      entry.kind === 'enum' &&
      sdk &&
      !(sdk.versions
        ? sdk.versions.includes(entry.value)
        : sdkHasEnumMember(sdk.release, enumFromVersion(entry.value)!))
    )
      errors.push(
        `${where}: ${entry.text} is not in the ApiVersion enum of ${sdkLabel}, so it reads undefined; upgrade the SDK or pin the string '${entry.value}'.`,
      );
  }
  for (const entry of scan.unresolvedVersions) {
    if (entry.note) continue;
    const where = `${entry.file}:${entry.line}`;
    if (!entry.latest) cannot(`${where}: ${entry.reason}`);
    else if (!sdk)
      cannot(
        `${where}: LATEST_API_VERSION depends on the @shopify/shopify-api release, and none is installed or locked.`,
      );
    else if (sdk.latest === null)
      errors.push(
        `${where}: ${sdkLabel} does not export LATEST_API_VERSION (removed in 12.0.0), so it reads undefined; use ApiVersion.${member} or '${target}'.`,
      );
    else if (sdk.latest === undefined)
      cannot(
        `${where}: Refit does not know which version LATEST_API_VERSION names in ${sdkLabel}.`,
      );
    else if (sdk.latest < target)
      errors.push(
        `${where}: LATEST_API_VERSION is ${sdk.latest} in ${sdkLabel}; the target is ${target}.`,
      );
  }
  // GraphQL documents on the target schema.
  const pool = fragmentPool(scan.documents);
  const sent: { id: string; text: string }[] = [];
  for (const document of scan.documents) {
    if (document.api) continue;
    const full = withFragments(document, pool);
    const result = checkDocument(full, schema);
    if (result.unreadable) {
      cannot(`${document.file}:${document.line}: ${result.unreadable}`);
      continue;
    }
    // An untraced literal that fails on every pinned version is for another Shopify API.
    if (!document.traced && result.errors.length && checkDocument(full, oldest).errors.length)
      continue;
    for (const error of result.errors)
      errors.push(`${error.file}:${error.line}: ${error.text} (Admin API ${target} schema)`);
    if (!result.errors.length)
      sent.push({ id: `${document.file}:${document.line}`, text: full.text });
  }
  for (const entry of scan.unreadable) {
    if (entry.api) continue;
    const where = `${entry.file}:${entry.line}`;
    const result = await extract(entry.file, entry.line, 'graphql', entry.reason);
    if (result?.status !== 'extracted') {
      cannot(`${where}: ${entry.reason}${result ? ` AI extraction: ${result.reason}` : ''}`);
      continue;
    }
    for (const request of result.requests) {
      const text = request.document!;
      extracted.push({
        file: entry.file,
        line: entry.line,
        kind: 'graphql',
        text,
        sourceLines: request.sourceLines,
      });
      const document: AdminDocument = {
        ...entry,
        text,
        segments: [
          {
            documentStart: 0,
            documentEnd: text.length,
            file: entry.file,
            sourceStart: entry.line - 1,
            sourceText: '\n'.repeat(entry.line - 1),
          },
        ],
        traced: true,
      };
      const check = checkDocument(withFragments(document, pool), schema);
      for (const error of check.unreadable ? [{ text: check.unreadable }] : check.errors)
        errors.push(
          `${where}: ${error.text} (Admin API ${target} schema, in the document AI read from lines ${request.sourceLines.join(', ')})`,
        );
      if (!check.unreadable && !check.errors.length) sent.push({ id: where, text });
    }
  }

  // REST calls on the target's REST contract.
  const versions = { before: target, after: target };
  for (const { entry, proof, untraced } of scan.rest.length
    ? proveShopifyRest(repository, scan, versions)
    : []) {
    if (proof.status === 'proven') continue;
    const where = `${entry.file}:${entry.line}`;
    if (!untraced) {
      report(
        `${where}: ${proof.reason} (Shopify REST contract ${target})`,
        UNDECIDED_REST.test(proof.reason),
      );
      continue;
    }
    const result = await extract(entry.file, entry.line, 'rest', proof.reason);
    if (result?.status !== 'extracted') {
      cannot(`${where}: ${proof.reason}${result ? ` AI extraction: ${result.reason}` : ''}`);
      continue;
    }
    for (const request of result.requests) {
      const rest = request.rest!;
      extracted.push({
        file: entry.file,
        line: entry.line,
        kind: 'rest',
        text: `${rest.method} ${rest.path}`,
        sourceLines: request.sourceLines,
      });
      // shortcut: every AI-read response use counts as a field read, never the whole record.
      const restProof = proveRestCall(loadShopifyRestVersionContract(), versions, {
        method: rest.method,
        path: rest.path,
        query: rest.query,
        body: rest.body.length ? rest.body : undefined,
        reads: rest.reads.map((path) => ({ path, whole: false })),
      });
      if (restProof.status !== 'proven')
        report(
          `${where}: ${restProof.reason} (Shopify REST contract ${target}, on the request AI read from lines ${request.sourceLines.join(', ')})`,
          UNDECIDED_REST.test(restProof.reason),
        );
    }
  }

  // The live judge, when a development store is configured.
  const live = options.environment
    ? await shopifyLiveJudge(sent, target, options)
    : { status: 'not-run' as const, reason: 'No development store is configured.' };
  if (live.status === 'failed' && 'operations' in live)
    for (const operation of live.operations.filter((item) => item.status === 'failed'))
      errors.push(
        `${operation.document}: the development store rejected ${operation.operationName ?? 'the operation'} at Admin API ${target}: ${operation.reason}`,
      );

  return {
    passed: !errors.length,
    errors,
    unjudged,
    extracted,
    ...(sdk ? { sdk: { release: sdk.release, source: sdk.source, latest: sdk.latest } } : {}),
    live,
    costUsd,
  };
}

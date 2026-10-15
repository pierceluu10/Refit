import { migrationReviewReason } from './migration-review.ts';
import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';
import { applySourceEdits, editCovers, isFieldMove, proposePatch } from './patches.ts';
import { propertyExists } from './stripe-field-moves.ts';
import { readRepository } from './repository.ts';
import {
  MAX_SDK_RESOURCE_LENGTH,
  readProviderAdapter,
  STRIPE,
  validateProviderMappings,
} from './providers.ts';
import { validatePropertyRenames } from './provider-renames.ts';
import {
  requestRenameEvidence,
  validateRequestPropertyRenames,
} from './provider-request-renames.ts';
import {
  countBreakingOperationUsages,
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';
import {
  apiVersionSourceBlocked,
  compareApiVersion,
  validateApiVersion,
  validateApiVersionPolicy,
  type ApiVersionPolicy,
} from './api-version.ts';
import { PipelineInputError } from './types.ts';
import { digest, findRemovedProperties, isObject, readSpecification } from './specifications.ts';
import { stripeAdapterFor } from './stripe-operations.ts';
import {
  SUBSCRIPTION_PERIOD_ITEMS_RULE,
  validateStripeSubscriptionPeriodContract,
} from './stripe-subscription-periods.ts';
import {
  adapterContract,
  compareOpenApi,
  switchedEnumAdditions,
  unmappedBreakingChanges,
} from './openapi-diff.ts';
import {
  operationReplacementEvidence,
  replacementAnalysisAdapter,
  validateOperationReplacements,
} from './provider-operation-replacements.ts';

export async function runPipeline(options: {
  repository: string;
  before: string;
  after: string;
  proposePatch?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  providerConfig?: string;
  apiVersion?: string;
  apiVersionPolicy?: ApiVersionPolicy;
  requireApiVersionMatch?: boolean;
  fullDiff?: boolean;
  documentationSnapshots?: readonly string[];
  onProgress?: (message: string) => void;
}) {
  const applicationApiVersion = validateApiVersion(options.apiVersion);
  const policy = validateApiVersionPolicy(options.apiVersionPolicy);
  const configured = await readProviderAdapter(options.providerConfig);
  const [repository, before, after] = await Promise.all([
    readRepository(options.repository, configured.packageName),
    readSpecification(options.before),
    readSpecification(options.after),
  ]);
  // The built-in Stripe adapter grows to cover every Stripe method the application calls.
  const provider =
    configured === STRIPE
      ? stripeAdapterFor(
          STRIPE,
          before.document,
          new Set(
            analyzeRepository(repository, [], STRIPE).sdkCalls.map(
              (call) => `${call.resource}.${call.method}`,
            ),
          ),
        )
      : configured;
  if (
    [before, after].some(
      (snapshot) => snapshot.provenance && snapshot.provenance.provider !== provider.id,
    )
  )
    throw new PipelineInputError('Snapshot provenance does not match the configured provider.');
  const operationMappings = validateProviderOperationMappings(provider, before.document);
  validateProviderMappings(provider, before.schemas);
  validateStripeSubscriptionPeriodContract(
    provider.stripeSubscriptionPeriods,
    before.document,
    after.document,
  );
  const changes = findRemovedProperties(before.schemas, after.schemas, provider.id);
  const moves = validatePropertyRenames(provider, changes, before.schemas, after.schemas);
  const replacements = validateOperationReplacements(
    provider,
    before.document,
    after.document,
    before.schemas,
    after.schemas,
  );
  const specificationDiff = options.fullDiff
    ? {
        ...(await compareOpenApi(
          adapterContract(before.document, provider),
          adapterContract(after.document, provider),
          { openResponseEnums: provider.packageName === STRIPE.packageName },
        )),
        coverage:
          'oasdiff compared only adapter-selected operations and their reachable components. Unselected endpoints, request schemas and unrelated components were not compared. Code and incoming-event coverage remain bounded; absence of a reported change is not proof of full API compatibility.',
      }
    : undefined;
  const requestRenames = validateRequestPropertyRenames(provider, before.document, after.document);
  const {
    edits: analyzedEdits,
    apiVersionDeclarations,
    apiVersionLiterals,
    sourceWarnings,
    skippedFiles,
    enumChecks,
    ...analysis
  } = analyzeRepository(
    repository,
    changes,
    provider,
    before.schemas,
    replacements,
    requestRenames,
    moves,
  );
  // Field moves apply only when the target contract has the documented new location.
  const movedTo = {
    [SUBSCRIPTION_PERIOD_ITEMS_RULE]:
      propertyExists(after.schemas, ['subscription', 'items']) &&
      propertyExists(after.schemas, ['subscription_item', 'current_period_start']) &&
      propertyExists(after.schemas, ['subscription_item', 'current_period_end']),
  } as Record<string, boolean>;
  const targetVersion = isObject(after.document.info) ? after.document.info.version : undefined;
  const versionEdits =
    provider.packageName === STRIPE.packageName &&
    applicationApiVersion &&
    typeof targetVersion === 'string' &&
    targetVersion !== applicationApiVersion
      ? apiVersionLiterals
          .filter((literal) => literal.value === applicationApiVersion)
          .filter(
            (literal, index, all) =>
              all.findIndex(
                (other) => other.file === literal.file && other.start === literal.start,
              ) === index,
          )
          .map((literal) => ({
            file: literal.file,
            start: literal.start,
            end: literal.end,
            replacement: targetVersion,
            changeId: 'stripe-api-version',
            rule: 'stripe-api-version' as const,
          }))
      : [];
  // Moved reads are correct only once the same patch pins the new outgoing version; a client
  // without a literal version follows the account default, which a patch cannot change.
  // shortcut: requires some bumped literal pin, not the pin of each read's own client; trace the
  // client per read if repositories mix pinned and unpinned clients.
  const edits = analyzedEdits.filter(
    (edit) => !isFieldMove(edit) || (movedTo[edit.rule!] && versionEdits.length > 0),
  );
  const ruleEdits = edits.filter(isFieldMove);
  if (specificationDiff && provider.packageName === STRIPE.packageName)
    specificationDiff.changes.push(
      ...switchedEnumAdditions(enumChecks, before.schemas, after.schemas),
    );
  const apiVersion = compareApiVersion(
    applicationApiVersion,
    before.document,
    after.document,
    { configured: Boolean(provider.apiVersion), declarations: apiVersionDeclarations },
    policy,
  );
  if (
    (options.requireApiVersionMatch && apiVersion.applicability !== 'matches-before') ||
    (apiVersionSourceBlocked(apiVersion) && (options.aiPatch || options.assessment))
  )
    throw new PipelineInputError(`Automated work is blocked. ${apiVersion.reason}`);
  const operationChanges = operationReplacementEvidence(
    replacements,
    analysis.calls,
    analysis.findings,
  );
  const requestChanges = requestRenameEvidence(requestRenames, analysis.calls, analysis.findings);
  const reviewableBreakingChanges = unmappedBreakingChanges(
    specificationDiff,
    changes,
    analysis.findings,
    operationChanges,
    requestChanges,
  );
  const operationImpacts = findBreakingOperationImpacts(
    specificationDiff,
    analysis.calls,
    operationMappings,
    reviewableBreakingChanges,
    operationChanges,
  );
  const operationUsageCount = countBreakingOperationUsages(operationImpacts);
  const representedOperationLocations = new Set(
    analysis.findings
      .filter((finding) =>
        [...replacements, ...requestRenames].some(
          (replacement) => replacement.id === finding.changeId,
        ),
      )
      .map((finding) => JSON.stringify([finding.file, finding.line, finding.column])),
  );
  const additionalOperationUsageCount = countBreakingOperationUsages(
    operationImpacts.map((impact) => ({
      ...impact,
      usages: impact.usages.filter(
        (usage) =>
          !representedOperationLocations.has(
            JSON.stringify([usage.file, usage.line, usage.column]),
          ),
      ),
    })),
  );
  const status =
    analysis.findings.some((finding) => finding.confidence === 'confirmed') ||
    operationImpacts.length
      ? 'affected'
      : analysis.providerDetected
        ? 'needs-review'
        : provider.id === STRIPE.id
          ? 'no-stripe-signal'
          : 'no-provider-signal';
  const configuredMigrationProposal =
    operationChanges.some((change) => change.usages.length > 0) ||
    requestChanges.some((change) => change.usages.length > 0) ||
    analysis.findings.some((finding) => finding.webhook?.migration);
  const rulesCoverAll =
    ruleEdits.length > 0 &&
    analysis.findings
      .filter((finding) => finding.confidence === 'confirmed')
      .every((finding) => editCovers(repository, ruleEdits, finding));
  const deterministicRequested =
    options.proposePatch || (options.aiPatch && (configuredMigrationProposal || rulesCoverAll));
  const unresolvedFindingCount = deterministicRequested
    ? analyzeRepository(
        {
          ...repository,
          files: repository.files.map((file) => ({
            ...file,
            content: applySourceEdits(
              file.content,
              edits.filter((edit) => edit.file === file.path),
            ),
          })),
        },
        changes,
        replacementAnalysisAdapter(provider, replacements),
        before.schemas,
        replacements,
        requestRenames,
        moves,
      ).findings.length
    : 0;
  const reviewReason = migrationReviewReason(
    { findings: analysis.findings, skippedFiles, adapter: provider },
    true,
  );
  const advisoryReviewReason = migrationReviewReason({ findings: analysis.findings, skippedFiles });
  if (
    options.aiPatch &&
    !configuredMigrationProposal &&
    !rulesCoverAll &&
    !operationImpacts.length &&
    !reviewReason
  )
    options.onProgress?.('Requesting an AI migration proposal...');
  else if (deterministicRequested && !reviewReason)
    options.onProgress?.('Generating a deterministic migration proposal...');
  const patch = reviewReason
    ? { status: 'not-generated' as const, reason: reviewReason! }
    : options.aiPatch && !configuredMigrationProposal && !rulesCoverAll
      ? operationImpacts.length
        ? {
            status: 'not-generated' as const,
            reason:
              'AI generation is blocked because the adapter maps code to unresolved breaking API changes without a verified migration rule.',
          }
        : await proposeAiPatch(
            repository,
            changes,
            analysis.findings,
            options.aiPatch,
            provider,
            before.schemas,
            undefined,
            options.documentationSnapshots,
            after.schemas,
            [...ruleEdits, ...versionEdits],
          )
      : deterministicRequested
        ? proposePatch(
            repository,
            ruleEdits.length && !configuredMigrationProposal ? [...edits, ...versionEdits] : edits,
            unresolvedFindingCount,
            provider,
            replacements,
            requestRenames,
          )
        : {
            status: 'not-generated' as const,
            reason:
              'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
          };
  const completePatch =
    'unresolvedFindings' in patch && additionalOperationUsageCount > 0
      ? { ...patch, unresolvedFindings: patch.unresolvedFindings + additionalOperationUsageCount }
      : patch;
  const repositoryHash = digest(
    JSON.stringify({
      files: repository.files,
      ...(repository.excludedPaths?.length ? { excludedPaths: repository.excludedPaths } : {}),
      ...(repository.configurations?.length ? { configurations: repository.configurations } : {}),
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: provider.id,
    adapter: provider,
    runId: digest(
      `${before.hash}:${after.hash}:${repositoryHash}:${digest(JSON.stringify(provider))}:${applicationApiVersion ?? ''}:${policy}`,
    ),
    apiVersion,
    sourceResolution: {
      status: sourceWarnings.length
        ? 'review'
        : repository.configurations?.length
          ? 'configured'
          : 'relative-only',
      warnings: sourceWarnings,
    },
    status,
    snapshots: { before: before.hash, after: after.hash },
    provenance: { before: before.provenance, after: after.provenance },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
      ...(repository.configurations?.length
        ? {
            configurations: repository.configurations.map((file) => ({
              path: file.path,
              sha256: digest(file.content),
              bytes: Buffer.byteLength(file.content),
            })),
          }
        : {}),
    },
    changes,
    specificationDiff: specificationDiff ?? {
      engine: 'direct-properties' as const,
      changes,
      coverage: 'Direct removed properties only; use fullDiff for the oasdiff contract report.',
    },
    ...analysis,
    skippedFiles,
    operationImpacts,
    operationChanges,
    ...(requestChanges.length ? { requestChanges } : {}),
    warnings: [
      ...repository.warnings,
      ...sourceWarnings,
      ...(reviewReason ? [reviewReason!] : []),
      ...skippedFiles.map(
        (file) => `Skipped unparseable file; its API usage was not scanned. ${file}`,
      ),
      ...(apiVersion.applicability === 'matches-before' ? [] : [apiVersion.reason]),
      ...(apiVersion.source.status === 'verified' || apiVersionSourceBlocked(apiVersion)
        ? []
        : [apiVersion.source.reason]),
      ...(operationImpacts.length
        ? [
            `${operationUsageCount} SDK call site${operationUsageCount === 1 ? '' : 's'} map to unresolved breaking OpenAPI changes and require a verified migration rule.`,
          ]
        : []),
      ...(operationChanges.length
        ? [
            'Endpoint replacements are operator-authored mappings. Matching recorded contracts do not prove equivalent semantics or that the replacement method exists in the installed SDK; review the mapping and application checks.',
          ]
        : []),
    ],
    assessment: advisoryReviewReason
      ? {
          status: 'blocked' as const,
          reason: advisoryReviewReason,
        }
      : options.assessment
        ? await assessMigration(
            buildAssessmentEvidence(
              repository,
              changes,
              analysis.findings,
              provider,
              operationImpacts,
              operationChanges,
            ),
            options.assessment,
          )
        : { status: 'not-requested' },
    coverage: {
      specification: specificationDiff
        ? specificationDiff.coverage
        : 'Direct properties removed from existing, non-composed OpenAPI 3 component schemas only. Not a complete breaking-change diff.',
      code: `Immutable ESM/CommonJS SDK clients, including named/default imports and static requires of supported exported bindings through relative paths or recorded tsconfig/jsconfig paths and baseUrl, and awaited resource.method calls mapped by the recorded adapter. Resources can be dot-separated identifier paths up to ${MAX_SDK_RESOURCE_LENGTH} characters. Optional SDK invocations and computed resource access remain review cases; unawaited calls are not treated as response objects. Optional adapter operationId mappings correlate unresolved breaking OpenAPI changes to SDK call sites; explicit operationReplacements can edit direct, non-optional calls on unescaped clients after matching the old/new recorded contracts. Configured requestPropertyRenames edit direct object-literal body keys, including quoted and shorthand properties, after comparing the normalized operation contract; spreads, computed keys, duplicates, aliases and optional calls require review. Property reads can follow direct local component-schema $refs through nested objects, supported array items, literal numeric indexes, const for...of bindings, inline one-parameter array callbacks and immutable aliases. Top-level one-parameter functions returning exactly one mapped SDK call are traced locally or through supported named imports. SDK arguments trace into supported named or identifier-bound helpers; only closed private callers with one stable origin qualify for automation. Exported, escaped or uncertain helper clients carry review evidence and block the run. Configured propertyRenames can also move a removed field to a nested path newly declared in the after contract with the same value shape; reads already using that path are not reported. Removed-field indexes and destructuring can be reported but are not auto-edited. Dynamic indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external schemas, detected writes, alias mutations, and references passed to calls or stored in containers remain review cases. Namespace imports and re-exports invalidate shared-client and wrapper confirmation. Dynamic exports, local ESM/CommonJS interop, shadowed or exposed loaders, unconfigured or unverified aliases, ambiguous resolution, multi-step or transformed wrappers and dynamic code still require review. Supported Stripe snapshot constructors, static payload aliases and exact event-type branches trace incoming payload reads under a curated mapping; webhook version and explicit migration-policy review block automatic patches, AI and publication. Unknown events, thin events, unsigned parsing and cross-function payload flows remain outside confirmation. Confirmed means traced under the supplied mapping, not independently verified SDK semantics or incoming API versions.`,
      decision:
        'No finding is not proof of no impact. Supported root npm, pnpm and yarn lockfiles provide recorded SDK versions, not verified installed versions or API-version applicability.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: completePatch,
  };
}

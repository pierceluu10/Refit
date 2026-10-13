import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';
import { applySourceEdits, proposePatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { readProviderAdapter, STRIPE, validateProviderMappings } from './providers.ts';
import { validatePropertyRenames } from './provider-renames.ts';
import {
  countBreakingOperationUsages,
  findBreakingOperationImpacts,
  validateProviderOperationMappings,
} from './provider-operations.ts';
import { compareApiVersion, validateApiVersion } from './api-version.ts';
import { PipelineInputError } from './types.ts';
import { readDocSnapshot } from './doc-snapshots.ts';
import { digest, findRemovedProperties, readSpecification } from './specifications.ts';
import { compareOpenApi, unmappedBreakingChanges } from './openapi-diff.ts';
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
  requireApiVersionMatch?: boolean;
  fullDiff?: boolean;
  onProgress?: (message: string) => void;
  docSnapshots?: string[];
}) {
  const applicationApiVersion = validateApiVersion(options.apiVersion);
  const provider = await readProviderAdapter(options.providerConfig);
  const [repository, before, after] = await Promise.all([
    readRepository(options.repository, provider.packageName),
    readSpecification(options.before),
    readSpecification(options.after),
  ]);
  if (
    [before, after].some(
      (snapshot) => snapshot.provenance && snapshot.provenance.provider !== provider.id,
    )
  )
    throw new PipelineInputError('Snapshot provenance does not match the configured provider.');
  const apiVersion = compareApiVersion(applicationApiVersion, before.document, after.document);
  if (options.requireApiVersionMatch && apiVersion.applicability !== 'matches-before')
    throw new PipelineInputError(`Automated publication is blocked. ${apiVersion.reason}`);
  const operationMappings = validateProviderOperationMappings(provider, before.document);
  validateProviderMappings(provider, before.schemas);
  const changes = findRemovedProperties(before.schemas, after.schemas, provider.id);
  validatePropertyRenames(provider, changes, before.schemas, after.schemas);
  const replacements = validateOperationReplacements(
    provider,
    before.document,
    after.document,
    before.schemas,
    after.schemas,
  );
  const specificationDiff = options.fullDiff
    ? await compareOpenApi(before.document, after.document)
    : undefined;
  const { edits, ...analysis } = analyzeRepository(
    repository,
    changes,
    provider,
    before.schemas,
    replacements,
  );
  const operationChanges = operationReplacementEvidence(
    replacements,
    analysis.calls,
    analysis.findings,
  );
  const reviewableBreakingChanges = unmappedBreakingChanges(
    specificationDiff,
    changes,
    analysis.findings,
    operationChanges,
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
      .filter((finding) => replacements.some((replacement) => replacement.id === finding.changeId))
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
  const configuredEndpointProposal = operationChanges.some((change) => change.usages.length > 0);
  const deterministicRequested =
    options.proposePatch || (options.aiPatch && configuredEndpointProposal);
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
      ).findings.length
    : 0;
  if (options.aiPatch && !configuredEndpointProposal && !operationImpacts.length)
    options.onProgress?.('Requesting an AI migration proposal...');
  else if (deterministicRequested)
    options.onProgress?.('Generating a deterministic migration proposal...');
  const patch =
    options.aiPatch && !configuredEndpointProposal
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
            {
              document: before.document,
              sourceUrl: before.provenance?.url ?? `spec://${provider.id}`,
              pageSha256: before.hash,
              docSnapshots: options.docSnapshots?.length
                ? await Promise.all(options.docSnapshots.map((path) => readDocSnapshot(path)))
                : undefined,
            },
          )
      : deterministicRequested
        ? proposePatch(repository, edits, unresolvedFindingCount, provider, replacements)
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
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    }),
  );
  return {
    formatVersion: 1,
    provider: provider.id,
    adapter: provider,
    runId: digest(
      `${before.hash}:${after.hash}:${repositoryHash}:${digest(JSON.stringify(provider))}:${applicationApiVersion ?? ''}`,
    ),
    apiVersion,
    status,
    snapshots: { before: before.hash, after: after.hash },
    provenance: { before: before.provenance, after: after.provenance },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
      lockfiles: repository.lockfiles,
    },
    changes,
    specificationDiff: specificationDiff ?? {
      engine: 'direct-properties' as const,
      changes,
      coverage: 'Direct removed properties only; use fullDiff for the oasdiff contract report.',
    },
    ...analysis,
    operationImpacts,
    operationChanges,
    warnings: [
      ...repository.warnings,
      ...(apiVersion.applicability === 'matches-before' ? [] : [apiVersion.reason]),
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
    assessment: options.assessment
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
      code: 'Immutable ESM SDK clients, including direct relative named imports of exported const bindings, and awaited resource.method calls mapped by the recorded adapter. Optional adapter operationId mappings correlate unresolved breaking OpenAPI changes to SDK call sites; explicit operationReplacements can edit direct, non-optional calls on unescaped clients after matching the old/new recorded contracts. Property reads can follow direct local component-schema $refs through nested objects, supported array items, literal numeric indexes, const for...of bindings, inline one-parameter array callbacks and immutable aliases. Top-level one-parameter functions returning exactly one mapped SDK call are traced locally or through direct relative named imports. Removed-field indexes and destructuring can be reported but are not auto-edited. Dynamic indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external schemas, detected writes, alias mutations, and references passed to calls or stored in containers remain review cases. Namespace imports and re-exports invalidate shared-client and wrapper confirmation. CommonJS, default imports, path aliases, ambiguous resolution, multi-step or transformed wrappers, webhooks and dynamic code still require review. Confirmed means traced under the supplied adapter mapping, not independently verified SDK semantics.',
      decision:
        'No finding is not proof of no impact. Supported root npm lockfiles provide recorded SDK versions, not verified installed versions or API-version applicability.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: completePatch,
  };
}

import type { AiOptions } from './ai-budget.ts';
import { analyzeRepository } from './analyzer.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';
import { applySourceEdits, proposePatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { readProviderAdapter, STRIPE, validateProviderMappings } from './providers.ts';
import { validatePropertyRenames } from './provider-renames.ts';
import { PipelineInputError } from './types.ts';
import { digest, findRemovedProperties, readSpecification } from './specifications.ts';
import { compareOpenApi } from './openapi-diff.ts';

export async function runPipeline(options: {
  repository: string;
  before: string;
  after: string;
  proposePatch?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  providerConfig?: string;
  fullDiff?: boolean;
}) {
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
  validateProviderMappings(provider, before.schemas);
  const changes = findRemovedProperties(before.schemas, after.schemas, provider.id);
  validatePropertyRenames(provider, changes, before.schemas, after.schemas);
  const specificationDiff = options.fullDiff
    ? await compareOpenApi(before.document, after.document)
    : undefined;
  const { edits, ...analysis } = analyzeRepository(repository, changes, provider, before.schemas);
  const status = analysis.findings.some((finding) => finding.confidence === 'confirmed')
    ? 'affected'
    : analysis.providerDetected
      ? 'needs-review'
      : provider.id === STRIPE.id
        ? 'no-stripe-signal'
        : 'no-provider-signal';
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
      `${before.hash}:${after.hash}:${repositoryHash}:${digest(JSON.stringify(provider))}`,
    ),
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
    warnings: repository.warnings,
    assessment: options.assessment
      ? await assessMigration(
          buildAssessmentEvidence(repository, changes, analysis.findings, provider),
          options.assessment,
        )
      : { status: 'not-requested' },
    coverage: {
      specification: specificationDiff
        ? specificationDiff.coverage
        : 'Direct properties removed from existing, non-composed OpenAPI 3 component schemas only. Not a complete breaking-change diff.',
      code: 'Immutable ESM SDK clients, including direct relative named imports of exported const bindings, and awaited resource.method calls mapped by the recorded adapter. Property reads can follow direct local component-schema $refs through nested objects, supported array items, literal numeric indexes, const for...of bindings, inline one-parameter array callbacks and immutable aliases. Top-level one-parameter functions returning exactly one mapped SDK call are traced locally or through direct relative named imports. Removed-field indexes and destructuring can be reported but are not auto-edited. Dynamic indexes, mutable loop bindings, named or multi-parameter callbacks, transformed array chains, inline/composed/external schemas, detected writes, alias mutations, and references passed to calls or stored in containers remain review cases. Namespace imports and re-exports invalidate shared-client and wrapper confirmation. CommonJS, default imports, path aliases, ambiguous resolution, multi-step or transformed wrappers, webhooks and dynamic code still require review. Confirmed means traced under the supplied adapter mapping, not independently verified SDK semantics.',
      decision:
        'No finding is not proof of no impact. Supported root npm lockfiles provide recorded SDK versions, not verified installed versions or API-version applicability.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: options.aiPatch
      ? await proposeAiPatch(
          repository,
          changes,
          analysis.findings,
          options.aiPatch,
          provider,
          before.schemas,
        )
      : options.proposePatch
        ? proposePatch(
            repository,
            edits,
            analyzeRepository(
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
              provider,
              before.schemas,
            ).findings.length,
            provider,
          )
        : {
            status: 'not-generated',
            reason:
              'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
          },
  };
}

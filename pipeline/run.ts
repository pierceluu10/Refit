import { analyzeRepository } from './analyzer.ts';
import { proposeAiPatch } from './ai-patches.ts';
import { assessMigration, buildAssessmentEvidence } from './assessment.ts';
import { proposePatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { readProviderAdapter, STRIPE } from './providers.ts';
import { PipelineInputError } from './types.ts';
import { digest, findRemovedProperties, readSpecification } from './specifications.ts';

export async function runPipeline(options: {
  repository: string;
  before: string;
  after: string;
  proposePatch?: boolean;
  assessment?: { apiKey: string; model: string };
  aiPatch?: { apiKey: string; model: string };
  providerConfig?: string;
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
  const changes = findRemovedProperties(before.schemas, after.schemas, provider.id);
  const { edits, ...analysis } = analyzeRepository(repository, changes, provider);
  const status = analysis.findings.some((finding) => finding.confidence === 'confirmed')
    ? 'affected'
    : analysis.providerDetected
      ? 'needs-review'
      : provider.id === STRIPE.id
        ? 'no-stripe-signal'
        : 'no-provider-signal';
  const repositoryHash = digest(
    JSON.stringify({ files: repository.files, dependencies: repository.dependencies }),
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
    },
    changes,
    ...analysis,
    warnings: repository.warnings,
    assessment: options.assessment
      ? await assessMigration(
          buildAssessmentEvidence(repository, changes, analysis.findings, provider),
          options.assessment,
        )
      : { status: 'not-requested' },
    coverage: {
      specification:
        'Direct properties removed from existing, non-composed OpenAPI 3 component schemas only. Not a complete breaking-change diff.',
      code: 'Local immutable ESM SDK clients and awaited resource.method calls mapped by the recorded adapter; direct reads, string indexes, destructuring and immutable aliases. CommonJS, cross-file flows, wrappers, mutations, webhooks and dynamic code require review. Confirmed means traced under the supplied adapter mapping, not independently verified SDK semantics.',
      decision:
        'No finding is not proof of no impact. API version applicability and resolved lockfile versions are not inferred.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: options.aiPatch
      ? await proposeAiPatch(repository, changes, analysis.findings, options.aiPatch, provider)
      : options.proposePatch
        ? proposePatch(repository, edits, analysis.findings.length, provider)
        : {
            status: 'not-generated',
            reason:
              'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
          },
  };
}

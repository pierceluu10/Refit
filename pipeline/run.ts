import { analyzeRepository } from './analyzer.ts';
import { proposePatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { digest, findRemovedProperties, readSpecification } from './specifications.ts';

export async function runPipeline(options: {
  repository: string;
  before: string;
  after: string;
  proposePatch?: boolean;
}) {
  const [repository, before, after] = await Promise.all([
    readRepository(options.repository),
    readSpecification(options.before),
    readSpecification(options.after),
  ]);
  const changes = findRemovedProperties(before.schemas, after.schemas);
  const { edits, ...analysis } = analyzeRepository(repository, changes);
  const status = analysis.findings.some((finding) => finding.confidence === 'confirmed')
    ? 'affected'
    : analysis.stripeDetected
      ? 'needs-review'
      : 'no-stripe-signal';
  const repositoryHash = digest(
    JSON.stringify({ files: repository.files, dependencies: repository.dependencies }),
  );
  return {
    formatVersion: 1,
    provider: 'stripe',
    runId: digest(`${before.hash}:${after.hash}:${repositoryHash}`),
    status,
    snapshots: { before: before.hash, after: after.hash },
    repository: {
      hash: repositoryHash,
      scannedFiles: repository.files.length,
      dependencies: repository.dependencies,
    },
    changes,
    ...analysis,
    warnings: repository.warnings,
    coverage: {
      specification:
        'Direct properties removed from existing, non-composed OpenAPI 3 component schemas only. Not a complete breaking-change diff.',
      code: 'Local immutable ESM Stripe clients and awaited PaymentIntent methods; direct reads, string indexes, destructuring and immutable aliases. CommonJS, cross-file flows, wrappers, mutations, webhooks and dynamic code require review.',
      decision:
        'No finding is not proof of no impact. API version applicability and resolved lockfile versions are not inferred.',
    },
    nextAction:
      status === 'affected'
        ? 'Review migration semantics, generate a patch, then validate in an isolated environment.'
        : 'Review unsupported patterns and API version applicability before deciding impact.',
    patch: options.proposePatch
      ? proposePatch(repository, edits, analysis.findings.length)
      : {
          status: 'not-generated',
          reason:
            'This pipeline produces impact evidence. It does not modify repositories or execute their code.',
        },
  };
}

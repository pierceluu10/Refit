import { readFileSync } from 'node:fs';
import { digest } from './specifications.ts';
import type { runPipeline } from './run.ts';

export const INTEGRATION_MARKER = '<!-- refit-integration:';
export const MIGRATION_MARKER = '<!-- refit-migration:';
// The Refit release that wrote a draft, so a later release can revisit what it left for review.
export const REFIT_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export function migrationIdentity(
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'adapter' | 'findings'>,
  revision: string,
  integration?: string,
) {
  // Applicability metadata must not duplicate an otherwise identical migration PR.
  const adapter = { ...report.adapter };
  delete adapter.apiVersion;
  delete adapter.constructorCalls;
  return digest(
    JSON.stringify({
      revision,
      ...(integration ? { integration } : {}),
      adapter,
      changes: [
        ...new Set(
          report.findings
            .filter((finding) => finding.confidence === 'confirmed')
            .map((finding) => finding.changeId),
        ),
      ].sort(),
    }),
  );
}

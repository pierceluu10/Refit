import { digest } from './specifications.ts';
import type { runPipeline } from './run.ts';

export const INTEGRATION_MARKER = '<!-- refit-integration:';

export function migrationIdentity(
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'adapter' | 'findings'>,
  revision: string,
  integration?: string,
) {
  // Applicability metadata must not duplicate an otherwise identical migration PR.
  const adapter = { ...report.adapter };
  delete adapter.apiVersion;
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

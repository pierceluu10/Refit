import { digest } from './specifications.ts';
import type { runPipeline } from './run.ts';

export function migrationIdentity(
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'adapter' | 'findings'>,
  revision: string,
) {
  // Applicability metadata must not duplicate an otherwise identical migration PR.
  const adapter = { ...report.adapter };
  delete adapter.apiVersion;
  return digest(
    JSON.stringify({
      revision,
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

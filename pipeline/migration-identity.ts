import { digest } from './specifications.ts';
import type { runPipeline } from './run.ts';

export function migrationIdentity(
  report: Pick<Awaited<ReturnType<typeof runPipeline>>, 'adapter' | 'findings'>,
  revision: string,
) {
  return digest(
    JSON.stringify({
      revision,
      adapter: report.adapter,
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

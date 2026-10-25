import { dirname } from 'node:path';
import type { readCommittedRepository } from './committed-repository.ts';
import { PNPM_LOCKFILE } from './pnpm-lock.ts';
import type { PipelineReport } from './run.ts';
import { PipelineInputError } from './types.ts';
import { YARN_LOCKFILE } from './yarn-lock.ts';

type CommittedRepository = Awaited<ReturnType<typeof readCommittedRepository>>;

const LOCKFILES = ['package-lock.json', PNPM_LOCKFILE, YARN_LOCKFILE];

// The nested package that Refit prepares and checks instead of the repository root: every file the
// scan reports (findings and API-version declarations) belongs to it, as the nearest package.json
// above the file that declares the SDK, where Node resolves the SDK from, and it commits its own
// lockfile (`committed` answers for a repository-relative path). Otherwise undefined, and
// preparation and checks use the repository root as before.
export function sdkPackageDirectory(
  report: Pick<PipelineReport, 'findings' | 'apiVersion' | 'repository'>,
  committed: (path: string) => boolean,
) {
  const packages = report.repository.dependencies
    .map((dependency) => dirname(dependency.file))
    .sort((left, right) => right.length - left.length);
  const owners = new Set(
    [...report.findings, ...report.apiVersion.source.declarations].map(({ file }) =>
      packages.find((directory) => directory === '.' || file.startsWith(`${directory}/`)),
    ),
  );
  const [directory] = owners;
  if (owners.size !== 1 || directory === undefined || directory === '.') return undefined;
  return LOCKFILES.some((lockfile) => committed(`${directory}/${lockfile}`))
    ? directory
    : undefined;
}

// One committed directory read as its own repository root, so preparation reads that package's
// manifest, lockfile and workspaces from the same commit.
export async function packageSnapshot(repository: CommittedRepository, directory: string) {
  const missing = new PipelineInputError(`${directory} is not a committed directory.`);
  const tree = (
    await repository
      .git(['rev-parse', '--verify', `${repository.revision}:${directory}`])
      .catch(() => {
        throw missing;
      })
  ).stdout.trim();
  if ((await repository.git(['cat-file', '-t', tree])).stdout.trim() !== 'tree') throw missing;
  const entries = (await repository.git(['ls-tree', '-rz', tree])).stdout
    .split('\0')
    .filter(Boolean);
  return { ...repository, revision: tree, entries };
}

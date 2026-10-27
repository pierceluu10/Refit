// Scratch probe (not committed): prints each repository's preparation refusal, and with several
// lockfiles, each lockfile's own refusal.
import { readCommittedRepository } from '../pipeline/committed-repository.ts';
import { readPreparationInputs } from '../pipeline/dependency-inputs.ts';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
for (const repository of process.argv.slice(2)) {
  console.log(`=== ${repository.split('/').at(-1)}`);
  const snapshot = await readCommittedRepository(repository, { submodules: true });
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const committed = LOCKFILES.filter((file) => paths.includes(file));
  const attempt = async (label: string, entries: string[]) => {
    try {
      const prepared = await readPreparationInputs({ ...snapshot, entries }, snapshot.entries);
      console.log(`  ${label}: OK ${prepared.inputs.manager} ${prepared.inputs.lockfileChoice ? 'choice' : ''}`);
    } catch (error) {
      console.log(`  ${label}: ${(error as Error).message.slice(0, 400)}`);
    }
  };
  await attempt('all', snapshot.entries);
  if (committed.length > 1)
    for (const lockfile of committed)
      await attempt(
        lockfile,
        snapshot.entries.filter((entry) => {
          const path = entry.slice(entry.indexOf('\t') + 1);
          return path === lockfile || !committed.includes(path);
        }),
      );
}

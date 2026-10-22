// Counts catalog SDK declarations in nested package.json files of the frozen-set monorepos that
// have a lockfile below the root, and how many get a locked version from the root lockfile alone
// (before) and with nestedLock's per-package lockfile (after). Checkouts as for
// scripts/workspace-exclusions-scan.mjs. Files are read only.
//
//   node scripts/workspace-nested-locks.mjs --list <monorepos.json> --root <dir> --output <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_CATALOG } from '../pipeline/agent-catalog.ts';
import { readRepository } from '../pipeline/repository.ts';
import { nestedLock } from '../pipeline/workspace-attribution.ts';

const { values } = parseArgs({
  options: { list: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' } },
});
const listing = JSON.parse(await readFile(values.list, 'utf8'));
const candidates = listing.results.filter(
  (entry) => entry.monorepo && entry.lockfiles.some((file) => file.includes('/')),
);
const summary = {
  repositories: candidates.length,
  errors: [],
  declarations: 0,
  nested: 0,
  lockedBefore: 0,
  lockedAfter: 0,
};
const resolved = [];
for (const entry of candidates) {
  const directory = join(
    values.root,
    `${entry.repo.replace('/', '__')}@${entry.commit.slice(0, 12)}`,
  );
  try {
    for (const name of AGENT_CATALOG.flatMap((agent) => agent.packages)) {
      const repository = await readRepository(directory, name);
      for (const dependency of repository.dependencies) {
        summary.declarations += 1;
        if (posix.dirname(dependency.file) === '.') continue;
        summary.nested += 1;
        if (dependency.lock.version) summary.lockedBefore += 1;
        const lock = await nestedLock(repository.root, dependency, name);
        if (lock.version) summary.lockedAfter += 1;
        if (lock.version && !dependency.lock.version)
          resolved.push({
            repository: entry.repo,
            file: dependency.file,
            package: name,
            version: lock.version,
            lockfile: lock.file,
          });
      }
    }
  } catch (error) {
    summary.errors.push({ repository: entry.repo, error: String(error.message).split('\n')[0] });
  }
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, ...summary, resolved }, null, 2)}\n`,
);

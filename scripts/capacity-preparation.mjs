// Summarises the dependency bundles Refit has prepared in a cache directory (default: the one Refit
// uses, ~/.refit/dependencies): each bundle's package manager, package count, archive size and the
// install time its package manager printed. Reads environment.json and the install log's duration
// line only; no bundle or repository content, and nothing identifying a repository, is copied.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { distribution, installSeconds } from './capacity-helpers.mjs';

const { values } = parseArgs({
  options: {
    cache: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.output) {
  console.log(
    'Usage: node scripts/capacity-preparation.mjs [--cache <directory>] --output <results.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const cache = resolve(
  values.cache ??
    (process.env.REFIT_DEPENDENCY_CACHE_DIRECTORY?.trim() ||
      join(homedir(), '.refit', 'dependencies')),
);

const rows = [];
for (const entry of (await readdir(cache)).sort()) {
  const bundle = join(cache, entry, 'bundle');
  const environment = JSON.parse(
    await readFile(join(bundle, 'environment.json'), 'utf8').catch(() => 'null'),
  );
  if (!environment) continue;
  const install = installSeconds(
    await readFile(join(bundle, 'install.log'), 'utf8').catch(() => ''),
  );
  rows.push({
    // Bundles from older recipes record the manager only in their kind.
    manager: environment.manager ?? /^refit-(\w+)-environment$/.exec(environment.kind)?.[1],
    recipeVersion: environment.recipeVersion,
    packages: environment.packages,
    archiveBytes: environment.archiveBytes,
    workspace: environment.installation?.workspace,
    installSeconds: install?.seconds ?? null,
    ...(install?.rounded ? { installRounded: true } : {}),
    preparedAt: (await stat(join(bundle, 'environment.json'))).mtime.toISOString(),
  });
}
rows.sort((a, b) => a.preparedAt.localeCompare(b.preparedAt));

const summarise = (group) => ({
  bundles: group.length,
  installSeconds: distribution(group.map((row) => row.installSeconds ?? Number.NaN)),
  installRounded: group.filter((row) => row.installRounded).length,
  installUnreported: group.filter((row) => row.installSeconds === null).length,
  archiveBytes: distribution(group.map((row) => row.archiveBytes)),
  packages: distribution(group.map((row) => row.packages)),
  totalArchiveBytes: group.reduce((total, row) => total + (row.archiveBytes ?? 0), 0),
});
// Only the current preparation recipe describes what a new job would install.
const recipeVersion = Math.max(...rows.map((row) => row.recipeVersion));
const current = rows.filter((row) => row.recipeVersion === recipeVersion);
const managers = [...new Set(current.map((row) => row.manager))].sort();
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      readAt: new Date().toISOString(),
      note: 'Cold dependency preparation as recorded by each bundle of the current recipe (summary) or any recipe (rows): the package manager install time it printed (npm rounds to whole minutes past 60 s; those are lower bounds), excluding container start and archiving.',
      recipeVersion,
      olderRecipeBundles: rows.length - current.length,
      summary: {
        all: summarise(current),
        ...Object.fromEntries(
          managers.map((manager) => [
            manager,
            summarise(current.filter((row) => row.manager === manager)),
          ]),
        ),
      },
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(`${rows.length} bundles: ${values.output}`);

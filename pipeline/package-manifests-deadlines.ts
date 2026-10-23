import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import {
  matchesPackage,
  readPackageManifests,
  type PackageInventory,
} from './package-manifests.ts';

export interface ManifestSdkDeclaration {
  deadline: DeadlineEntry;
  // The entry's package name that matched.
  name: string;
  file: string;
  line: number;
  text: string;
}

// Direct declarations of SDK packages whose support ended (registry `kind: 'sdk'` entries with an
// `ecosystem`), from non-npm manifests. Like the npm path, every declaration counts whatever its
// version, because the entries end support for the whole package.
export async function manifestSdkDeclarations(
  root: string,
  registry: DeadlineRegistry,
  inventory?: PackageInventory,
): Promise<ManifestSdkDeclaration[]> {
  const entries = registry.deadlines.filter((entry) => entry.kind === 'sdk' && entry.ecosystem);
  if (!entries.length) return [];
  const { dependencies } = inventory ?? (await readPackageManifests(root));
  const declarations: ManifestSdkDeclaration[] = [];
  for (const entry of entries)
    for (const dependency of dependencies)
      if (dependency.direct && dependency.ecosystem === entry.ecosystem) {
        const name = entry.versions.find((candidate) => matchesPackage(dependency, candidate));
        if (name === undefined) continue;
        const version = dependency.locked ?? dependency.declared;
        declarations.push({
          deadline: entry,
          name,
          file: dependency.file,
          line: dependency.line,
          text: `${dependency.ecosystem}:${dependency.name}${version ? ` ${version}` : ''}${dependency.locked ? ' (locked)' : ''} is declared in ${dependency.file}`,
        });
      }
  return declarations;
}

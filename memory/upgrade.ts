import type { ExternalTask, MigrationKind } from '../shared/types.ts';
import type { AnyTask, ChangeKind, MemoryRecipe, UpgradeKey } from './types.ts';

// Recipe.kind in shared/types.ts is MigrationKind; these are its values, so any other kind is kept
// in MemoryRecipe.changeKind and stored in Recipe.kind as 'other'.
const MIGRATION_KINDS: ReadonlySet<string> = new Set<MigrationKind>([
  'api-version',
  'sdk-major',
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'rest-to-graphql',
  'auth-change',
  'webhook-payload',
  'model-retirement',
  'product-shutdown',
  'pagination-or-limits',
  'other',
]);

export function isExternalTask(task: AnyTask): task is ExternalTask {
  return 'dependencies' in task && Array.isArray(task.dependencies);
}

export function recipeKind(kind: ChangeKind): MigrationKind {
  return MIGRATION_KINDS.has(kind) ? (kind as MigrationKind) : 'other';
}

// The kind a recipe was written for: its full change kind when memory kept one.
export function kindOf(recipe: MemoryRecipe): ChangeKind {
  return recipe.changeKind ?? recipe.kind;
}

// A short version label for people and the retrieval judge: "^18.2.0" → "18", "3.9.18" → "3.9",
// ">=16 <17" → "16". Small majors keep their minor, since Python and Django minors are the releases
// that reach end of life. Anything that isn't a version (a model id, an image tag) is kept as written.
export function versionLabel(version: string | undefined): string | undefined {
  const raw = version?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^[\s^~>=<v]*(\d+)(?:\.(\d+))?(?:\.[\dx*]+)?(?:\s|$|-|\|)/);
  if (!match) return raw;
  const [, major, minor] = match;
  return Number(major) <= 3 && minor !== undefined ? `${major}.${minor}` : major;
}

// "node 18 → 22", "next 13 → 15", "gpt-4o → gpt-4.1"; "→ a supported version" when the change names
// no target. Undefined for an API task, whose recipes stay keyed by provider and kind.
export function upgradeKey(task: AnyTask): UpgradeKey | undefined {
  if (!isExternalTask(task)) return undefined;
  const { change } = task;
  const dependency =
    task.dependencies.find((dep) => dep.name === change.dependency) ?? task.dependencies[0];
  const name = change.dependency || dependency?.name || change.provider;
  const from = versionLabel(dependency?.version ?? change.fromVersions?.[0]);
  const to = versionLabel(change.toVersion);
  const target = to ?? (change.kind === 'model-retirement' ? 'replacement' : 'a supported version');
  return {
    dependency: name,
    dependencyKind: change.dependencyKind,
    ...(dependency?.ecosystem && { ecosystem: dependency.ecosystem }),
    ...(from && { from }),
    ...(to && { to }),
    range: from ? `${name} ${from} → ${target}` : `${name} → ${target}`,
  };
}

// How a recipe is named in prompts and on the dashboard.
export function recipeLabel(recipe: MemoryRecipe): string {
  const ranges = recipe.ranges?.length
    ? recipe.ranges
    : recipe.upgrade
      ? [recipe.upgrade.range]
      : [];
  const kind = kindOf(recipe);
  return ranges.length ? `${ranges.join(', ')} (${kind})` : `${recipe.provider} ${kind}`;
}

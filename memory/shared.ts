// What may leave a customer's store: general patterns with no customer code, names or secrets, and
// only from customers who agreed. The default is no. Free text is scrubbed to prose plus the provider
// names the list already holds; a diff sketch, a repo and a run id never leave at all.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from '../harness/secrets.ts';
import { levelsOf, type LadderEntry } from './ladder.ts';
import { SqliteMemoryStore } from './sqlite-store.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryRecipe } from './types.ts';

export const sharedStore = (dir: string) => new SqliteMemoryStore(join(dir, 'shared.sqlite'));

export type Scrub = {
  names: string[]; // the customer's own names: owner, repos
  keep: string[]; // provider names that are safe: what the list holds
};

// What must not leave with a PR's learning: its owner and repo. Provider names stay.
export function scrubFor(pr: string, providers: string[]): Scrub {
  const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)/.exec(pr) ?? [];
  return { names: [owner, repo].filter((name) => name !== undefined), keep: providers };
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

export function scrubText(text: string, { names, keep }: Scrub): string {
  const safe = new Set(keep);
  const held = keep.filter(Boolean).sort((a, b) => b.length - a.length);
  // Provider names go aside first, so no rule below eats them.
  const parked: string[] = [];
  let out = redactSecrets(text).replace(/```[\s\S]*?```/g, ' [code] ');
  for (const name of held) {
    out = out.replace(new RegExp(name.replace(ESCAPE, '\\$&'), 'g'), (found) => {
      parked.push(found);
      return `\u0000${parked.length - 1}\u0000`;
    });
  }
  out = out
    .replace(/`[^`\n]*`/g, (found) => (safe.has(found.slice(1, -1)) ? found : '[code]'))
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
    .replace(/\bhttps?:\/\/\S+/g, '[url]')
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, '[path]')
    .replace(
      /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|toml|env|sql|md|go|java|rb)\b/g,
      '[path]',
    )
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '[text]')
    // Identifiers are code: someBillingFunc, some_billing_func, SomeClass.method.
    .replace(/\b[a-z]+[A-Z]\w*\b/g, '[name]')
    .replace(/\b[A-Z][a-z]+[A-Z]\w*\b/g, '[name]')
    .replace(/\b\w+_\w+\b/g, '[name]')
    .replace(/\b\w+\.\w+\b/g, '[name]')
    .replace(/[{}();=<>]/g, ' ');
  for (const name of names.filter(Boolean)) {
    out = out.replace(new RegExp(name.replace(ESCAPE, '\\$&'), 'gi'), '[name]');
  }
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => parked[Number(index)] ?? '');
  return out.replace(/[ \t]+/g, ' ').trim();
}

// Only a merged recipe is a general pattern worth sharing. Anything low-confidence stays home.
export function sharedRecipe(recipe: MemoryRecipe, scrub: Scrub): MemoryRecipe | undefined {
  if (recipe.confidence !== 'merged' || recipe.benchmarkOnly) return undefined;
  const clean = (text: string) => scrubText(text, scrub);
  return {
    id: `shared-${createHash('sha256').update(recipe.id).digest('hex').slice(0, 16)}`,
    provider: recipe.provider,
    kind: recipe.kind,
    preconditions: clean(recipe.preconditions),
    steps: clean(recipe.steps),
    pitfalls: clean(recipe.pitfalls),
    diffSketch: '',
    sourceRuns: [],
    repos: [],
    verifiedRepos: recipe.verifiedRepos,
    confidence: 'merged',
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    changeIds: recipe.changeIds ?? [],
  };
}

const hashed = (repo: string) => createHash('sha256').update(repo).digest('hex').slice(0, 16);

// The ladder across customers: repos hashed, run ids gone, levels replayed over everyone's evidence.
export function shareLadder(entry: LadderEntry, into: LadderEntry | undefined): LadderEntry {
  const mine = entry.evidence.map(({ kind, repo, at }) => ({
    kind,
    repo: hashed(repo),
    runId: '',
    at,
  }));
  const seen = new Map(
    [...(into?.evidence ?? []), ...mine].map((item) => [
      `${item.kind}\n${item.repo}\n${item.at}`,
      item,
    ]),
  );
  const evidence = [...seen.values()];
  return { entryId: entry.entryId, evidence, updatedAt: entry.updatedAt, ...levelsOf(evidence) };
}

// Sends what a customer agreed to share to the shared store. Without consent, nothing leaves.
export async function shareLearning(input: {
  store: MemoryStore;
  shared: MemoryStore;
  consented: boolean;
  scrub: Scrub;
}): Promise<{ recipes: number; ladder: number }> {
  const { store, shared, consented, scrub } = input;
  if (!consented) return { recipes: 0, ladder: 0 };
  let recipes = 0;
  for (const recipe of await store.listRecipes()) {
    const pattern = sharedRecipe(recipe, scrub);
    if (!pattern) continue;
    await shared.saveRecipe(pattern);
    recipes += 1;
  }
  const already = new Map((await shared.listLadder()).map((entry) => [entry.entryId, entry]));
  const ladder = await store.listLadder();
  for (const entry of ladder) {
    await shared.saveLadder(shareLadder(entry, already.get(entry.entryId)));
  }
  return { recipes, ladder: ladder.length };
}

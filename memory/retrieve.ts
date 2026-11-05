import type { MigrationTask, ProviderChange } from '../shared/types.ts';
import { cosine, type Embedder, type Model } from './ai.ts';
import type { MemoryStore } from './store.ts';
import type { MemoryRecipe } from './types.ts';

// The task's change and any the match agent bundled into it (one task per upgrade).
export function taskChanges(task: MigrationTask): ProviderChange[] {
  const { alsoResolves = [] } = task as MigrationTask & {
    alsoResolves?: { change: ProviderChange }[];
  };
  return [task.change, ...alsoResolves.map((bundled) => bundled.change)];
}

export function describeTask(task: MigrationTask): string {
  const [change, ...bundled] = taskChanges(task);
  const lines = [
    `Provider: ${change.provider}`,
    `Kind: ${change.kind}`,
    `Change: ${change.title}`,
    `Source: ${change.source.quote}`,
    `Affects operations: ${change.affects.operations?.join(', ') ?? ''}`,
    `Affects fields: ${change.affects.fields?.join(', ') ?? ''}`,
    `Affects versions: ${change.affects.versions?.join(', ') ?? ''}`,
    `Affects SDK: ${change.affects.sdk ?? ''}`,
    ...bundled.map((other) => `Also resolves: ${other.kind}: ${other.title}`),
  ];
  for (const usage of task.usages) {
    const sdk = usage.sdk ? ` ${usage.sdk.name}@${usage.sdk.version}` : '';
    lines.push(`Usage: ${usage.provider} via ${usage.via}${sdk}`);
    for (const site of usage.callSites) {
      const fields = site.fields?.length ? ` fields ${site.fields.join(', ')}` : '';
      const notes = site.notes ? ` (${site.notes})` : '';
      lines.push(`  ${site.file}: ${site.operation}${fields}${notes}`);
    }
  }
  return lines.join('\n');
}

export function describeRecipe(recipe: MemoryRecipe): string {
  return [
    `Provider: ${recipe.provider}`,
    `Kind: ${recipe.kind}`,
    `Preconditions: ${recipe.preconditions}`,
    `Steps: ${recipe.steps}`,
    `Pitfalls: ${recipe.pitfalls}`,
    `Diff sketch:\n${recipe.diffSketch}`,
  ].join('\n');
}

const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'why'],
        properties: { id: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
};

const PICK_SYSTEM = `You advise an engineer who is about to migrate code for an API change.
From notes left by past verified migrations, choose the ones worth reading before starting.
A note from another provider can still help when the migration has the same shape.
A note made from this very same change is usually the best head start.
Weigh each note's track record: one whose later runs failed more often than it verified is probably stale or wrong, so prefer another unless it clearly fits.
Order picks from most to least useful and say in one sentence why each helps.
Return an empty list only if none of the notes would help.`;

export function createRetriever(deps: {
  store: MemoryStore;
  embedder: Embedder;
  model?: Model;
  limit?: number;
  candidates?: number;
  judgeAllUpTo?: number;
}): (task: MigrationTask) => Promise<MemoryRecipe[]> {
  const { store, embedder, model, limit = 3, candidates = 10, judgeAllUpTo = 50 } = deps;

  async function rank(task: MigrationTask): Promise<MemoryRecipe[]> {
    const recipes = await store.listRecipes();
    if (recipes.length === 0) return [];

    const stale = recipes.filter((recipe) => recipe.embedding?.model !== embedder.name);
    const [taskVector, ...vectors] = await embedder.embed([
      describeTask(task),
      ...stale.map(describeRecipe),
    ]);
    await Promise.all(
      stale.map(async (recipe, i) => {
        recipe.embedding = { model: embedder.name, vector: vectors[i] };
        // Cache onto a fresh read, since learning may have rewritten the recipe while it was embedded.
        // shortcut: a learning write that lands between this read and write is still lost; retrieval
        // stays off the learning queue because it must never wait behind a model call.
        const fresh = await store.getRecipe(recipe.id);
        if (fresh && describeRecipe(fresh) === describeRecipe(recipe)) {
          await store.saveRecipe({ ...fresh, embedding: recipe.embedding });
        }
      }),
    );

    // Order is evidence for the judge and the fallback when there is none, never a filter: the same
    // change first, a recipe that failed more often than it verified last, then by similarity.
    const tier = (recipe: MemoryRecipe) =>
      (sameChange(recipe, task) ? 0 : 1) + (losing(recipe) ? 2 : 0);
    return (
      recipes
        .map((recipe) => ({ recipe, score: cosine(taskVector, recipe.embedding!.vector) }))
        .sort((a, b) => tier(a.recipe) - tier(b.recipe) || b.score - a.score)
        // A small store goes to the model whole; embeddings only shortlist once it is too big to read.
        .slice(0, recipes.length <= judgeAllUpTo ? recipes.length : candidates)
        .map(({ recipe }) => recipe)
    );
  }

  async function judge(task: MigrationTask, shortlist: MemoryRecipe[], model: Model) {
    const notes = shortlist.map((recipe) =>
      [
        `### ${recipe.id}`,
        `Provider: ${recipe.provider}, kind: ${recipe.kind}`,
        `Active skill: ${recipe.skill?.status === 'active' ? 'yes' : 'no'}; ${track(recipe)}`,
        `Made from this same change: ${sameChange(recipe, task) ? 'yes' : 'no'}`,
        `Preconditions: ${recipe.preconditions}`,
        `Steps: ${recipe.steps}`,
        `Pitfalls: ${recipe.pitfalls}`,
        `Diff sketch:\n${recipe.diffSketch}`,
      ].join('\n'),
    );
    const { picks } = await model.json<{ picks: { id: string; why: string }[] }>({
      system: PICK_SYSTEM,
      prompt: `## The task\n${describeTask(task)}\n\n## Notes from past runs\n${notes.join('\n\n')}`,
      schema: PICK_SCHEMA,
      maxTokens: 8_000,
    });
    const byId = new Map(shortlist.map((recipe) => [recipe.id, recipe]));
    const chosen = new Set<MemoryRecipe>();
    for (const { id } of picks) {
      const recipe = byId.get(id);
      if (recipe) chosen.add(recipe);
    }
    return [...chosen].slice(0, limit);
  }

  return async (task) => {
    try {
      const shortlist = await rank(task);
      if (model && shortlist.length > 0) {
        try {
          return await judge(task, shortlist, model);
        } catch (error) {
          console.warn(`Memory: recipe judgement failed, using embedding order: ${error}`);
        }
      }
      return shortlist.slice(0, limit);
    } catch (error) {
      // Memory is advice; the harness must always proceed without it.
      console.warn(`Memory: retrieval failed, continuing without recipes: ${error}`);
      return [];
    }
  };
}

const sameChange = (recipe: MemoryRecipe, task: MigrationTask) =>
  taskChanges(task).some((change) => recipe.changeIds?.includes(change.id));
const losing = (recipe: MemoryRecipe) => (recipe.failedRunIds?.length ?? 0) > recipe.verifiedRepos;

// How a recipe has fared, for a model to weigh. A count to read, never a filter.
function track(recipe: MemoryRecipe): string {
  const failed = recipe.failedRunIds?.length ?? 0;
  const against = failed
    ? `; ${failed} later run${failed === 1 ? '' : 's'} that used it failed (could not verify on a repo whose checks passed before the edit, or a human closed the PR)`
    : '';
  return `verified on ${recipe.verifiedRepos} repos${against}`;
}

export function renderMemoryForPrompt(recipes: MemoryRecipe[]): string {
  if (recipes.length === 0) return '';
  const isSkill = (recipe: MemoryRecipe) => recipe.skill?.status === 'active';
  const blocks = [
    '## Memory from past runs',
    'Advice from verified past migrations. Use your judgement: follow what fits this repo, ignore what does not.',
    ...recipes
      .filter(isSkill)
      .map((recipe) => `### Proven skill (${track(recipe)})\n${recipe.skill!.prompt}`),
    ...recipes
      .filter((recipe) => !isSkill(recipe))
      .map((recipe) =>
        [
          `### Recipe: ${recipe.provider} ${recipe.kind} (${track(recipe)})`,
          `Preconditions: ${recipe.preconditions}`,
          `Steps:\n${recipe.steps}`,
          `Pitfalls: ${recipe.pitfalls}`,
          '```diff',
          recipe.diffSketch,
          '```',
        ].join('\n'),
      ),
  ];
  return blocks.join('\n\n');
}

// A repo session's recipes: a plain lookup by list entry, so memory costs a fix nothing and can't
// delay it. A merged recipe comes before a low-confidence one, and a losing one stays out.
export async function recipesForEntries(
  entryIds: string[],
  store: Pick<MemoryStore, 'listRecipes'>,
  limit = 3,
): Promise<MemoryRecipe[]> {
  const matches = (await store.listRecipes()).filter(
    (recipe) => recipe.changeIds?.some((id) => entryIds.includes(id)) && !losing(recipe),
  );
  return matches.sort((a, b) => b.verifiedRepos - a.verifiedRepos).slice(0, limit);
}

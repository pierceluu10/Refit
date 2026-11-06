import { cosine, type Embedder, type Model } from './ai.ts';
import type { MemoryStore } from './store.ts';
import type { AnyTask, MemoryRecipe } from './types.ts';
import { isExternalTask, kindOf, recipeLabel, upgradeKey } from './upgrade.ts';

export function describeTask(task: AnyTask): string {
  const { change } = task;
  const lines = [
    `Provider: ${change.provider}`,
    `Kind: ${change.kind}`,
    `Change: ${change.title}`,
    ...upgradeLines(task),
    `Source: ${change.source.quote}`,
    `Affects operations: ${change.affects.operations?.join(', ') ?? ''}`,
    `Affects fields: ${change.affects.fields?.join(', ') ?? ''}`,
    `Affects versions: ${change.affects.versions?.join(', ') ?? ''}`,
    `Affects SDK: ${change.affects.sdk ?? ''}`,
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

// What an external task adds: the dependency, the version range and every place it is declared.
function upgradeLines(task: AnyTask): string[] {
  if (!isExternalTask(task)) return [];
  const { change } = task;
  const key = upgradeKey(task);
  return [
    `Dependency: ${change.dependency} (${change.dependencyKind})`,
    `Upgrade: ${key?.range ?? ''}`,
    `Severity: ${change.severity ?? ''}`,
    ...task.dependencies.flatMap((dep) => [
      `Uses: ${dep.name}${dep.version ? `@${dep.version}` : ''}${dep.ecosystem ? ` (${dep.ecosystem})` : ''}`,
      ...dep.declaredIn.map(
        (place) => `  declared in ${place.file}${place.text ? `: ${place.text}` : ''}`,
      ),
    ]),
  ];
}

export function describeRecipe(recipe: MemoryRecipe): string {
  return [
    `Provider: ${recipe.provider}`,
    `Kind: ${kindOf(recipe)}`,
    ...(recipe.ranges?.length ? [`Upgrades: ${recipe.ranges.join(', ')}`] : []),
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

const PICK_SYSTEM = `You advise an engineer who is about to change code because something outside it changed: an API, or a runtime, framework, library, AI model, base image or CI version that is retiring or has a new major.
From notes left by past verified runs, choose the ones worth reading before starting.
A note from another provider, dependency or version range can still help when the change has the same shape (for example a node 16 → 20 note for a node 18 → 22 upgrade, or a Django note for a Flask upgrade that hits the same Python change).
Order picks from most to least useful and say in one sentence why each helps.
Return an empty list only if none of the notes would help.`;

export function createRetriever(deps: {
  store: MemoryStore;
  embedder: Embedder;
  model?: Model;
  limit?: number;
  candidates?: number;
  judgeAllUpTo?: number;
}): (task: AnyTask) => Promise<MemoryRecipe[]> {
  const { store, embedder, model, limit = 3, candidates = 10, judgeAllUpTo = 50 } = deps;

  async function rank(task: AnyTask): Promise<MemoryRecipe[]> {
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

    return (
      recipes
        .map((recipe) => ({ recipe, score: cosine(taskVector, recipe.embedding!.vector) }))
        .sort((a, b) => b.score - a.score)
        // A small store goes to the model whole; embeddings only shortlist once it is too big to read.
        .slice(0, recipes.length <= judgeAllUpTo ? recipes.length : candidates)
        .map(({ recipe }) => recipe)
    );
  }

  async function judge(task: AnyTask, shortlist: MemoryRecipe[], model: Model) {
    const notes = shortlist.map((recipe) =>
      [
        `### ${recipe.id}`,
        `Provider: ${recipe.provider}, kind: ${kindOf(recipe)}`,
        ...(recipe.ranges?.length ? [`Upgrades: ${recipe.ranges.join(', ')}`] : []),
        `Active skill: ${recipe.skill?.status === 'active' ? 'yes' : 'no'}; ${track(recipe)}`,
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

// How a recipe has fared, for a model to weigh. A count to read, never a filter.
function track(recipe: MemoryRecipe): string {
  const failed = recipe.failedRunIds?.length ?? 0;
  const against = failed
    ? `; ${failed} later PR${failed === 1 ? '' : 's'} that used it closed by a human without merging`
    : '';
  return `verified on ${recipe.verifiedRepos} repos${against}`;
}

export function renderMemoryForPrompt(recipes: MemoryRecipe[]): string {
  if (recipes.length === 0) return '';
  const isSkill = (recipe: MemoryRecipe) => recipe.skill?.status === 'active';
  const blocks = [
    '## Memory from past runs',
    'Advice from verified past runs. Use your judgement: follow what fits this repo, ignore what does not.',
    ...recipes
      .filter(isSkill)
      .map((recipe) => `### Proven skill (${track(recipe)})\n${recipe.skill!.prompt}`),
    ...recipes
      .filter((recipe) => !isSkill(recipe))
      .map((recipe) =>
        [
          `### Recipe: ${recipeLabel(recipe)} (${track(recipe)})`,
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

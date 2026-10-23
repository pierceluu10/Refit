// Pure functions for the AI application model-site benchmark (docs/AI-APP-PRECISION.md): the
// labeller's candidate search, the negative-file draw and the score of `refit deadlines --json`
// live exposures against the site labels. They live apart from scripts/ai-app-precision.mjs so
// pipeline/ai-app-precision-summary.test.ts can feed them fixtures. Nothing here imports pipeline
// code: the candidate search must stay independent of Refit's scanner.

export const SETS = ['openai', 'anthropic'];
export const VIA = ['sdk', 'wrapper', 'raw-http', 'indirect'];
export const PROVIDERS = ['openai', 'anthropic', 'gemini', 'compatible'];
// Registry providers whose deadlines retire models. Meta Graph and Shopify deadlines are API
// versions, outside this benchmark.
const MODEL_PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);

const NON_PRODUCTION =
  /[^/]*_test\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|__tests__|__mocks__|mocks?|spec|specs|e2e|cypress|playwright|fixtures?|examples?|demos?|docs?|stories|\.storybook|scripts?|seeds?|benchmarks?|evals?|testdata)\/|\.(?:test|spec|stories|e2e)\.[^/]+$|(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.py|conftest\.py|[^/]*\.config\.[cm]?[jt]s)$/i;
const SKIPPED =
  /(?:^|\/)(?:node_modules|\.git|dist|build|coverage|\.next|out|vendor|\.venv|venv)\//;
export const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;

export function isProduction(path) {
  return SOURCE.test(path) && !SKIPPED.test(path) && !NON_PRODUCTION.test(path);
}

// A quoted literal shaped like a model ID of a major provider, whether or not any registry lists
// it: a family name with a version (`gpt-4o`, `claude-3-5-haiku-latest`, `gemini-2.5-flash`), or
// a bare reasoning model (`o1`, `o3-mini`). Bare family names (`claude`, `gemini`) name a product
// or a CLI, not a model.
const MODEL_LITERAL =
  /(['"`])((?:openai\/|anthropic\/|google\/)?(?:(?:gpt|chatgpt|claude|gemini|gemma|text-embedding|text-moderation|omni-moderation|dall-e|whisper|tts|davinci|babbage|codex|computer-use)[-.]\w[\w.:-]*|o[134](?:-[\w.:-]+)?))\1/gi;
// Where a model value is set without a literal on the same line, or under another name.
const MODEL_FIELD =
  /\b(?:model|modelName|modelId|model_name|model_id|MODEL[A-Z_]*|[A-Z_]*_MODEL)\b\s*(?:[:=]|\?\?|\|\|)/;

// Candidate lines in one file: model-shaped literals and model fields, with 1-based lines.
export function modelCandidates(text) {
  const found = [];
  for (const [index, line] of text.split('\n').entries()) {
    const literals = [...line.matchAll(MODEL_LITERAL)].map((match) => match[2]);
    if (literals.length || MODEL_FIELD.test(line)) found.push({ line: index + 1, literals });
  }
  return found;
}

// Files that talk to the set's provider: an SDK import or the API host.
const PROVIDER_FILE = {
  openai:
    /(?:from\s*|require\(\s*|import\s+)['"]?(?:openai|@ai-sdk\/openai|@langchain\/openai|langchain_openai)\b|api\.openai\.com/,
  anthropic:
    /(?:from\s*|require\(\s*|import\s+)['"]?(?:@anthropic-ai\/sdk|anthropic|@ai-sdk\/anthropic|@langchain\/anthropic|langchain_anthropic)\b|api\.anthropic\.com/,
};

export function talksToProvider(set, text) {
  return PROVIDER_FILE[set].test(text);
}

// Deterministic draw of `count` items: sort, then a mulberry32-driven Fisher-Yates shuffle. Same
// generator as seededSample in scripts/ai-app-helpers.mjs, but returning the whole order so a
// rejected draw can be replaced by the next one.
export function seededOrder(items, seed) {
  const pool = [...items].sort();
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// Every problem with a labels file, as text.
export function validateSiteLabels(labels) {
  const problems = [];
  const inSample = (set, repo) => (labels.sample?.[set] ?? []).includes(repo);
  const keys = new Set();
  for (const site of labels.sites ?? []) {
    const where = `${site.repo} ${site.file}:${site.line}`;
    if (!SETS.some((set) => inSample(set, site.repo)))
      problems.push(`${where}: repository not in a sample`);
    if (!PROVIDERS.includes(site.provider)) problems.push(`${where}: provider ${site.provider}`);
    if (!VIA.includes(site.via)) problems.push(`${where}: via ${site.via}`);
    if (typeof site.model !== 'string' || !site.model) problems.push(`${where}: model`);
    if (!Number.isInteger(site.line) || site.line < 1) problems.push(`${where}: line`);
    if (typeof site.file !== 'string' || site.file.startsWith('/') || site.file.includes('..'))
      problems.push(`${where}: file`);
    const key = `${site.repo}\u0000${site.file}\u0000${site.line}\u0000${site.model}`;
    if (keys.has(key)) problems.push(`${where}: duplicate site`);
    keys.add(key);
  }
  for (const set of SETS) {
    const negatives = (labels.negatives ?? []).filter((n) => n.set === set);
    // Negatives later removed with their repositories (`removed`) were still drawn and labelled.
    const removed = labels.removed?.negatives?.[set] ?? 0;
    if (negatives.length + removed < 30)
      problems.push(`${set}: ${negatives.length} negative files, at least 30 needed`);
    for (const n of negatives) {
      if (!inSample(set, n.repo))
        problems.push(`${n.repo} ${n.file}: negative outside the ${set} sample`);
      if ((labels.sites ?? []).some((s) => s.repo === n.repo && s.file === n.file))
        problems.push(`${n.repo} ${n.file}: negative file has a labelled site`);
    }
  }
  return problems;
}

// 95% Wilson score interval for k successes in n trials, as percentages.
export function wilson(k, n, z = 1.96) {
  if (!n) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  const round = (value) => Math.round(value * 1000) / 10;
  return {
    k,
    n,
    rate: round(p),
    low: round(Math.max(0, centre - half)),
    high: round(Math.min(1, centre + half)),
  };
}

// Live model sites Refit reported in one repository's `refit deadlines --json` result, one per
// file:line:model, and the deadlines whose evidence list was cut at the limit.
export function reportedSites(result) {
  const sites = [];
  const capped = new Set();
  for (const exposure of result?.exposures ?? []) {
    if (!MODEL_PROVIDERS.has(exposure.deadline.provider)) continue;
    if (exposure.more > 0) capped.add(exposure.deadline.id);
    for (const evidence of exposure.evidence)
      if (evidence.kind === 'source')
        sites.push({
          file: evidence.file,
          line: evidence.line,
          model: evidence.version,
          provider: exposure.deadline.provider,
          deadline: exposure.deadline.id,
        });
  }
  return { sites, capped };
}

// Scores one set. `results` maps each sampled repository to its `refit deadlines --json` result
// (or `{ error }`); `deadlineOf` maps a provider:model pair to its registry deadline id. A
// labelled registry site Refit did not list counts as a miss, unless its deadline's evidence was
// cut at the limit, in which case it is "beyond the evidence limit" and counted apart. A reported
// site matches a label at the same file, line and model. A report at a labelled compatible site
// is kept out of precision, as the guide keeps compatible sites out of the scores.
export function scoreSet(set, labels, results, deadlineOf) {
  const sampled = labels.sample[set];
  const siteKey = (repo, s) => `${repo}\u0000${s.file}\u0000${s.line}\u0000${s.model}`;
  const labelled = labels.sites.filter(
    (s) => sampled.includes(s.repo) && s.provider !== 'compatible',
  );
  const byKey = new Map(labelled.map((s) => [siteKey(s.repo, s), s]));
  const compatible = new Set(
    labels.sites
      .filter((s) => sampled.includes(s.repo) && s.provider === 'compatible')
      .map((s) => siteKey(s.repo, s)),
  );
  const negatives = new Set(
    labels.negatives.filter((n) => n.set === set).map((n) => `${n.repo}\u0000${n.file}`),
  );
  const truePositives = [];
  const falsePositives = [];
  const compatibleHits = [];
  const falseNegatives = [];
  const beyondLimit = [];
  const errored = [];
  const matched = new Set();
  for (const repo of sampled) {
    const result = results[repo];
    if (!result || result.error) {
      errored.push({ repo, error: result?.error ?? 'not run' });
      continue;
    }
    const { sites, capped } = reportedSites(result);
    for (const site of sites) {
      const key = siteKey(repo, site);
      const label = byKey.get(key);
      const item = { repo, ...site, negativeFile: negatives.has(`${repo}\u0000${site.file}`) };
      if (label) {
        truePositives.push(item);
        matched.add(key);
      } else if (compatible.has(key)) compatibleHits.push(item);
      else falsePositives.push(item);
    }
    for (const label of labelled.filter((s) => s.repo === repo && s.registry)) {
      if (matched.has(siteKey(repo, label))) continue;
      const deadline = deadlineOf.get(`${label.provider}:${label.model}`);
      (capped.has(deadline) ? beyondLimit : falseNegatives).push({ ...label });
    }
  }
  const scored = labelled.filter((s) => !errored.some((e) => e.repo === s.repo));
  return {
    set,
    repositories: sampled.length - errored.length,
    errored,
    labelledSites: scored.length,
    registrySites: scored.filter((s) => s.registry).length,
    nonRegistrySites: scored.filter((s) => !s.registry).length,
    compatibleSites: labels.sites.filter(
      (s) => sampled.includes(s.repo) && s.provider === 'compatible',
    ).length,
    precision: wilson(truePositives.length, truePositives.length + falsePositives.length),
    recall: wilson(truePositives.length, truePositives.length + falseNegatives.length),
    // Over every labelled site, registry or not: how much of the model choice Refit sees at all.
    recallAllSites: wilson(truePositives.length, scored.length),
    negativeFileFalsePositives: falsePositives.filter((f) => f.negativeFile).length,
    truePositives,
    falsePositives,
    compatibleHits,
    falseNegatives,
    beyondLimit,
  };
}

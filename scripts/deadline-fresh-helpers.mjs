// Pure functions for the fresh deadline sample (docs/DEADLINE-BENCHMARK-2026-10-22.md): the
// application check used when drawing it, and the score of `refit deadlines --json` against its
// blind labels. They live apart from the scripts so pipeline/deadline-fresh.test.ts can test them.

// An application ships something to run: it is private, has no package entry points, or depends
// on an app framework or runtime. A published library has entry points and none of these.
const APP_DEPENDENCIES =
  /^(next|react-dom|react-native|expo|nuxt|@remix-run\/[\w-]+|@react-router\/[\w-]+|@sveltejs\/kit|astro|vite|electron|express|fastify|koa|hono|@nestjs\/core|discord\.js|telegraf|grammy|@shopify\/shopify-app-[\w-]+|@slack\/bolt|@raycast\/api|wxt|plasmo)$/;

export function applicationReason(manifest) {
  if (manifest.private === true) return null;
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (Object.keys(dependencies).some((name) => APP_DEPENDENCIES.test(name))) return null;
  if (!manifest.main && !manifest.exports && !manifest.module) return null;
  return 'library package.json';
}

export const LABELS = ['live', 'catalog', 'test', 'comment', 'other'];
// Refit's evidence uses, mapped onto the label set: a tokenizer argument or a prefix check is a
// match that selects nothing, like the labels' `other`.
const USE = { live: 'live', catalog: 'catalog', test: 'test', comment: 'comment' };
const useOf = (use) => USE[use] ?? 'other';

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

const lineKey = (file, line, version) => `${file}\u0000${line}\u0000${version}`;

// Every line one `refit deadlines --json` result lists, with its use and deadline, and the
// deadlines whose live or non-live list was cut at the evidence limit.
export function reportedLines(result) {
  const lines = new Map();
  const cappedLive = new Set();
  const cappedNonLive = new Set();
  for (const group of [...(result?.exposures ?? []), ...(result?.mentions ?? [])]) {
    if (group.more > 0) cappedLive.add(group.deadline.id);
    if (group.nonLiveMore > 0) cappedNonLive.add(group.deadline.id);
    for (const item of [...(group.evidence ?? []), ...(group.nonLive ?? [])])
      lines.set(lineKey(item.file, item.line, item.version), {
        file: item.file,
        line: item.line,
        version: item.version,
        use: useOf(item.use),
        deadline: group.deadline.id,
      });
  }
  return { lines, cappedLive, cappedNonLive };
}

// Scores one group of repositories. `labels` are line labels from the loose search; `results`
// maps a repository to its `refit deadlines --json` result (or `{ error }`); `deadlineOf` maps
// `provider:version` to a registry entry. Live exposure is scored per repository, per (repository,
// deadline) pair and per line; the use of every labelled line Refit lists is compared with its
// label, so test and comment classification get their own precision and recall.
export function scoreFresh(repos, labels, results, deadlineOf) {
  const inScope = new Set(repos);
  const scoped = labels.filter(
    (l) => inScope.has(l.repo) && deadlineOf.has(`${l.provider}:${l.version}`),
  );
  const liveByRepo = new Map();
  for (const l of scoped.filter((l) => l.label === 'live')) {
    const deadline = deadlineOf.get(`${l.provider}:${l.version}`);
    liveByRepo.set(l.repo, [...(liveByRepo.get(l.repo) ?? []), { ...l, deadline: deadline.id }]);
  }
  const errored = repos.filter((repo) => !results[repo] || results[repo].error);
  const scanned = repos.filter((repo) => !errored.includes(repo));
  const flagged = scanned.filter((repo) => results[repo].exposures?.length);
  const exposed = repos.filter((repo) => liveByRepo.has(repo));
  const pairs = new Set();
  for (const [repo, lines] of liveByRepo)
    for (const l of lines) pairs.add(`${repo}\u0000${l.deadline}`);
  const reportedPairs = new Set();
  for (const repo of scanned)
    for (const e of results[repo].exposures ?? [])
      reportedPairs.add(`${repo}\u0000${e.deadline.id}`);
  const uses = Object.fromEntries(LABELS.map((u) => [u, { both: 0, refit: 0, label: 0 }]));
  const lineFalsePositives = [];
  const lineFalseNegatives = [];
  const unlabelledReported = [];
  const misclassified = [];
  let beyondLimit = 0;
  for (const repo of scanned) {
    const { lines, cappedLive, cappedNonLive } = reportedLines(results[repo]);
    const labelled = new Map(
      scoped.filter((l) => l.repo === repo).map((l) => [lineKey(l.file, l.line, l.version), l]),
    );
    for (const [key, item] of lines) {
      const label = labelled.get(key);
      if (!label) {
        unlabelledReported.push({ repo, ...item });
        continue;
      }
      uses[item.use].refit += 1;
      if (item.use === label.label) uses[item.use].both += 1;
      else misclassified.push({ repo, ...item, label: label.label, note: label.note });
      if (item.use === 'live' && label.label !== 'live')
        lineFalsePositives.push({ repo, ...item, label: label.label, note: label.note });
    }
    for (const [key, label] of labelled) {
      const item = lines.get(key);
      const deadline = deadlineOf.get(`${label.provider}:${label.version}`).id;
      if (!item) {
        const capped = label.label === 'live' ? cappedLive : cappedNonLive;
        if (capped.has(deadline)) {
          beyondLimit += 1;
          continue;
        }
        if (label.label === 'live')
          lineFalseNegatives.push({ ...label, deadline, reported: 'not listed' });
      } else if (label.label === 'live' && item.use !== 'live')
        lineFalseNegatives.push({ ...label, deadline, reported: item.use });
      uses[label.label].label += 1;
    }
  }
  const per = (u) => ({
    precision: wilson(uses[u].both, uses[u].refit),
    recall: wilson(uses[u].both, uses[u].label),
  });
  return {
    repositories: repos.length,
    errored,
    exposed: exposed.length,
    exposedShare: wilson(exposed.length, repos.length),
    repoPrecision: wilson(flagged.filter((r) => liveByRepo.has(r)).length, flagged.length),
    repoRecall: wilson(exposed.filter((r) => flagged.includes(r)).length, exposed.length),
    pairPrecision: wilson(
      [...reportedPairs].filter((p) => pairs.has(p)).length,
      reportedPairs.size,
    ),
    pairRecall: wilson([...pairs].filter((p) => reportedPairs.has(p)).length, pairs.size),
    live: per('live'),
    catalog: per('catalog'),
    test: per('test'),
    comment: per('comment'),
    beyondLimit,
    falsePositivePairs: [...reportedPairs]
      .filter((p) => !pairs.has(p))
      .map((p) => p.split('\u0000')),
    falseNegativePairs: [...pairs]
      .filter((p) => !reportedPairs.has(p))
      .map((p) => p.split('\u0000')),
    lineFalsePositives,
    lineFalseNegatives,
    misclassified,
    unlabelledReported,
  };
}

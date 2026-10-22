// Pure functions for the inventory benchmark (docs/INVENTORY-BENCHMARK.md): which sampled
// repositories count as applications, and how Refit's provider detections score against the hand
// labels. They live apart from the scripts so pipeline/inventory-benchmark.test.ts can test them.
// Nothing here imports Refit's pipeline code.

export const LANGUAGE_GROUPS = ['js-ts', 'python', 'go'];

// Matched against the repository name and its topics, never the owner.
export const EXCLUDED_NAME =
  /tutorial|course|example|sample|demo|template|boilerplate|starter|awesome|learn|homework|exercise|interview|cheatsheet|roadmap|dotfiles|config|docs|documentation|sdk|library|framework|plugin|extension|wrapper|client/i;

// Vendored, generated and dependency directories are never counted or scanned.
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'out',
  'vendor',
  'third_party',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
]);

const SOURCE = {
  'js-ts': /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/,
  python: /\.py$/,
  go: /\.go$/,
};
const DECLARATION = /\.d\.[cm]?ts$/;
const MINIFIED = /\.min\.[cm]?js$/;

export function excludedName(fullName, topics = []) {
  return [fullName.split('/')[1] ?? '', ...topics].some((text) => EXCLUDED_NAME.test(text));
}

export function skippedPath(path) {
  return path
    .split('/')
    .slice(0, -1)
    .some((part) => SKIPPED_DIRECTORIES.has(part));
}

export function isSource(group, path) {
  if (skippedPath(path) || !SOURCE[group].test(path)) return false;
  if (group === 'js-ts') return !DECLARATION.test(path) && !MINIFIED.test(path);
  if (group === 'go') return !path.endsWith('_test.go');
  return true;
}

export function sourceFileCount(group, paths) {
  return paths.filter((path) => isSource(group, path)).length;
}

// The package.json files that may make a JS/TS repository an application: the root, top-level
// directories and direct children of apps/, packages/ and services/. Paths come from GitHub and are
// only matched, never opened here.
export function candidateManifests(paths) {
  return paths
    .filter(
      (path) =>
        !skippedPath(path) &&
        (path === 'package.json' ||
          /^[^/]+\/package\.json$/.test(path) ||
          /^(?:apps|packages|services)\/[^/]+\/package\.json$/.test(path)),
    )
    .sort((a, b) => (a === 'package.json' ? -1 : b === 'package.json' ? 1 : a < b ? -1 : 1));
}

const WORKSPACE_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json'];
const APP_CONFIG =
  /^(?:(?:next|vite|nuxt|svelte|astro|remix|vue|angular|electron\.vite|webpack|expo|app)\.config\.[^/]+|angular\.json|wrangler\.(?:toml|jsonc?)|tauri\.conf\.json|app\.json)$/;
const APP_DEPENDENCIES = [
  'express',
  'fastify',
  'hono',
  'koa',
  '@nestjs/core',
  'electron',
  'react-native',
  'expo',
  '@tauri-apps/api',
  'discord.js',
  'telegraf',
  'grammy',
];

export function isWorkspaceRoot(manifest, paths) {
  return Boolean(manifest?.workspaces) || WORKSPACE_FILES.some((name) => paths.includes(name));
}

// An app marker in one package directory: a framework or deployment config, a routes directory, or
// a server, desktop, mobile or bot runtime dependency.
export function appMarker(manifest, paths, directory) {
  const prefix = directory ? `${directory}/` : '';
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (APP_CONFIG.test(rest)) return `marker:${rest}`;
    const route = /^((?:src\/)?(?:app|pages|routes))\//.exec(rest);
    if (route) return `marker:${route[1]}/`;
  }
  const dependencies = manifest?.dependencies ?? {};
  const runtime = APP_DEPENDENCIES.find((name) => Object.hasOwn(dependencies, name));
  return runtime ? `dependency:${runtime}` : null;
}

const PYTHON_MANIFEST = /^(?:requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/;
const PYTHON_ENTRY =
  /^(?:manage\.py|app\.py|main\.py|server\.py|bot\.py|run\.py|wsgi\.py|asgi\.py|Dockerfile|docker-compose\.ya?ml|Procfile)$/;

// Why a repository counts as an application, or null. `manifests` maps each candidate package.json
// path to its parsed content (JS/TS only).
export function applicationReason(group, paths, manifests = {}) {
  const shallow = (path) => path.split('/').length <= 2 && !skippedPath(path);
  const name = (path) => path.split('/').at(-1);
  if (group === 'js-ts') {
    // A workspace root is private by convention, so it counts only through an app workspace.
    const root = manifests['package.json'];
    if (root && !isWorkspaceRoot(root, paths)) {
      // A published package is a library; an unpublished one still needs an app marker, because a
      // package.json alone often only configures tooling (solution and notes repositories).
      const published = ['main', 'exports', 'bin', 'files'].some((field) => field in root);
      if (published && root.private !== true) return null;
      const marker = appMarker(root, paths, '');
      return marker ? `${root.private === true ? 'private' : 'unpublished'}, ${marker}` : null;
    }
    for (const path of candidateManifests(paths)) {
      if (path === 'package.json' || !manifests[path]) continue;
      const directory = path.slice(0, -'/package.json'.length);
      const reason = appMarker(manifests[path], paths, directory);
      if (reason) return `${directory}: ${reason}`;
    }
    return root ? appMarker(root, paths, '') : null;
  }
  if (group === 'python') {
    const manifest = paths.find((path) => !path.includes('/') && PYTHON_MANIFEST.test(path));
    const entry = paths.find((path) => shallow(path) && PYTHON_ENTRY.test(name(path)));
    return manifest && entry ? `${manifest} + ${entry}` : null;
  }
  if (!paths.includes('go.mod')) return null;
  const main = paths.find((path) => path === 'main.go' || /^cmd\/[^/]+\/main\.go$/.test(path));
  return main ? `go.mod + ${main}` : null;
}

// Code that does not run when the application is used: tests, fixtures, examples, docs, stories,
// benchmarks, seeds and maintenance scripts (docs/INVENTORY-BENCHMARK.md, "What does not count").
const NON_PRODUCTION_DIRECTORY =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|mocks?|spec|specs|e2e|cypress|playwright|fixtures?|examples?|demos?|docs?|stories|\.storybook|storybook|scripts?|seeds?|benchmarks?|bench|testdata|testing|\.github)\//i;
const NON_PRODUCTION_FILE =
  /\.(?:test|spec|stories|story|e2e|bench)\.[^/]+$|(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go)|conftest\.py|[^/]*\.config\.[cm]?[jt]s)$/i;

export function isProduction(path) {
  return !NON_PRODUCTION_DIRECTORY.test(path) && !NON_PRODUCTION_FILE.test(path);
}

const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const JS_IMPORTS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

// The package a bare JS specifier names, or null for relative paths and common path aliases.
export function jsPackage(specifier) {
  if (/^(?:\.|\/|~|#|@\/|\$|virtual:|src\/|app\/|components\/)/.test(specifier)) return null;
  const parts = specifier.replace(/^node:/, '').split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Every bare import in one file, with its 1-based line and language.
export function importSpecifiers(path, text) {
  const found = [];
  const lines = text.split('\n');
  if (JS_FILE.test(path)) {
    for (const [index, line] of lines.entries())
      for (const pattern of JS_IMPORTS)
        for (const match of line.matchAll(pattern)) {
          const name = jsPackage(match[1]);
          if (name) found.push({ specifier: name, line: index + 1, language: 'js' });
        }
  } else if (path.endsWith('.py')) {
    for (const [index, line] of lines.entries()) {
      const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
      const plain = /^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/.exec(line);
      const names = from ? [from[1]] : plain ? plain[1].split(',') : [];
      for (const name of names)
        found.push({ specifier: name.trim().split('.')[0], line: index + 1, language: 'python' });
    }
  } else if (path.endsWith('.go')) {
    let block = false;
    for (const [index, line] of lines.entries()) {
      if (/^\s*import\s*\(/.test(line)) block = true;
      else if (block && /^\s*\)/.test(line)) block = false;
      const match = block
        ? /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(line)
        : /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
      if (match) found.push({ specifier: match[1], line: index + 1, language: 'go' });
    }
  }
  return found;
}

const IGNORED_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|(?:www\.)?w3\.org|(?:www\.)?schema\.org|json-schema\.org|(?:www\.)?example\.(?:com|org|net))$/;

// URL hosts written in a file, lower-cased, with their 1-based line.
export function urlHosts(text) {
  const found = [];
  for (const [index, line] of text.split('\n').entries())
    for (const match of line.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const host = match[1].toLowerCase();
      if (!IGNORED_HOST.test(host)) found.push({ host, line: index + 1 });
    }
  return found;
}

const PEP508_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;

// Declared third-party dependencies in one manifest: package.json, requirements*.txt,
// pyproject.toml, Pipfile and go.mod. Other files return nothing.
export function dependencyDeclarations(path, text) {
  const name = path.split('/').at(-1);
  const out = [];
  const add = (dependency, dev) => out.push({ name: dependency, dev, file: path });
  if (name === 'package.json') {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      return out;
    }
    for (const section of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'devDependencies',
    ])
      for (const dependency of Object.keys(manifest?.[section] ?? {}))
        add(dependency, section === 'devDependencies');
  } else if (/^requirements[^/]*\.txt$/.test(name)) {
    for (const line of text.split('\n')) {
      const clean = line.replace(/#.*/, '').trim();
      if (!clean || clean.startsWith('-')) continue;
      const match = PEP508_NAME.exec(clean);
      if (match) add(match[1].toLowerCase(), /dev|test/i.test(name));
    }
  } else if (name === 'pyproject.toml' || name === 'Pipfile') {
    let table = '';
    let depth = 0;
    for (const line of text.split('\n')) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        table = header[1].trim();
        depth = 0;
        continue;
      }
      const dev = /dev|test/i.test(table);
      if (
        /^(?:tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies|packages|dev-packages)$/.test(
          table,
        )
      ) {
        const key = /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line);
        if (key && key[1].toLowerCase() !== 'python') add(key[1].toLowerCase(), dev);
        continue;
      }
      if (
        table === 'project' ||
        table === 'project.optional-dependencies' ||
        table === 'dependency-groups'
      ) {
        // Only the dependency arrays: `dependencies = [...]` in [project], every key elsewhere.
        const opens = table === 'project' ? /^\s*dependencies\s*=\s*\[/ : /^\s*[\w-]+\s*=\s*\[/;
        if (!depth && !opens.test(line)) continue;
        for (const match of (depth ? line : line.replace(/^[^=]*=/, '')).matchAll(
          /"([^"]+)"|'([^']+)'/g,
        )) {
          const dependency = PEP508_NAME.exec(match[1] ?? match[2]);
          if (dependency) add(dependency[1].toLowerCase(), table !== 'project');
        }
        const unquoted = line.replace(/"[^"]*"|'[^']*'/g, '');
        depth += (unquoted.match(/\[/g) ?? []).length - (unquoted.match(/\]/g) ?? []).length;
      }
    }
  } else if (name === 'go.mod') {
    let block = false;
    for (const line of text.split('\n')) {
      if (/^\s*require\s*\(/.test(line)) block = true;
      else if (block && /^\s*\)/.test(line)) block = false;
      const match = block
        ? /^\s*([^\s/]+\.[^\s]+)\s+v/.exec(line)
        : /^\s*require\s+([^\s]+)\s+v/.exec(line);
      if (match) add(match[1], /\/\/\s*indirect/.test(line));
    }
  }
  return out;
}

// Scoring (docs/INVENTORY-BENCHMARK.md, "Scoring"). A detection or label is the pair
// (repository, provider); labels for the same provider through several packages count once.
export const VIA = ['sdk', 'http'];
export const LANGUAGES = ['javascript', 'typescript', 'python', 'go'];
export const MISS_CATEGORIES = [
  'language not supported',
  'provider not in catalog',
  'raw HTTP',
  'monorepo',
  'other',
];
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Every problem with a labels file against its frozen list, as { repo, problem } entries.
export function validateLabels(list, labels) {
  const problems = [];
  const byRepo = new Map(labels.repos.map((entry) => [entry.repo, entry]));
  if (byRepo.size !== labels.repos.length)
    problems.push({ repo: null, problem: 'duplicate repository' });
  for (const { repo, commit } of list.repos) {
    const entry = byRepo.get(repo);
    const fail = (problem) => problems.push({ repo, problem });
    if (!entry) {
      fail('not labelled');
      continue;
    }
    if (entry.commit !== commit) fail('commit differs from the frozen list');
    if (!Array.isArray(entry.labels)) {
      fail('labels is not a list');
      continue;
    }
    if (entry.none !== (entry.labels.length === 0))
      fail('none must be true exactly when labels is empty');
    const keys = new Set();
    for (const label of entry.labels) {
      if (!PROVIDER_ID.test(label.provider ?? '')) fail(`provider id ${label.provider}`);
      if (!VIA.includes(label.via)) fail(`via ${label.via}`);
      if (!LANGUAGES.includes(label.language)) fail(`language ${label.language}`);
      if (label.via === 'sdk' && !label.package)
        fail(`${label.provider}: sdk label without package`);
      if (label.via === 'http' && !label.host) fail(`${label.provider}: http label without host`);
      if (
        typeof label.file !== 'string' ||
        !label.file ||
        label.file.startsWith('/') ||
        label.file.includes('..')
      )
        fail(`${label.provider}: file`);
      if (!Number.isInteger(label.line) || label.line < 1) fail(`${label.provider}: line`);
      if (typeof label.monorepo !== 'boolean') fail(`${label.provider}: monorepo`);
      const key = [label.provider, label.via, label.package ?? label.host].join('|');
      if (keys.has(key)) fail(`duplicate label ${key}`);
      keys.add(key);
    }
  }
  for (const repo of byRepo.keys())
    if (!list.repos.some((entry) => entry.repo === repo))
      problems.push({ repo, problem: 'not in the frozen list' });
  return problems;
}

// One category per missed pair, first matching rule wins.
export function missCategory(labels, catalog) {
  const agent = catalog.find((entry) => entry.id === labels[0].provider);
  if (labels.every((label) => label.language === 'python' || label.language === 'go'))
    return {
      category: 'language not supported',
      detail: [...new Set(labels.map((l) => l.language))].join(', '),
    };
  if (!agent) return { category: 'provider not in catalog', detail: labels[0].provider };
  const hostKnown = (host) => agent.hostnames.some((name) => host?.includes(name.split('/')[0]));
  if (labels.every((label) => label.via === 'http' && !hostKnown(label.host)))
    return { category: 'raw HTTP', detail: labels.map((label) => label.host).join(', ') };
  if (labels.some((label) => label.monorepo))
    return { category: 'monorepo', detail: labels.find((label) => label.monorepo).file };
  const unlisted = labels.filter(
    (label) => label.via === 'sdk' && !agent.packages.includes(label.package),
  );
  return {
    category: 'other',
    detail: unlisted.length
      ? `package not in catalog: ${unlisted.map((label) => label.package).join(', ')}`
      : 'catalog package or host present but not detected',
  };
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

const tally = (tp, fp, fn) => ({
  truePositives: tp,
  falsePositives: fp,
  falseNegatives: fn,
  precision: wilson(tp, tp + fp),
  recall: wilson(tp, tp + fn),
});

// Scores one results file against the labels. Repositories whose detection errored are left out
// of every count and listed, since a failed scan says nothing about what Refit would report.
export function scoreInventory(labels, results) {
  const catalog = results.catalog;
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  const labelled = new Map(labels.repos.map((entry) => [entry.repo, entry]));
  const groupOf = new Map((results.repos ?? []).map((entry) => [entry.repo, entry.group]));
  const truePositives = [];
  const falsePositives = [];
  const falseNegatives = [];
  const errored = [];
  for (const result of results.repos) {
    const entry = labelled.get(result.repo);
    if (!entry) continue;
    if (result.error) {
      errored.push({ repo: result.repo, error: result.error });
      continue;
    }
    const byProvider = new Map();
    for (const label of entry.labels)
      byProvider.set(label.provider, [...(byProvider.get(label.provider) ?? []), label]);
    const detected = new Map();
    for (const detection of result.detections)
      detected.set(detection.provider, [...(detected.get(detection.provider) ?? []), detection]);
    for (const [provider, detections] of [...detected].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const item = {
        repo: result.repo,
        group: result.group,
        provider,
        detectors: [...new Set(detections.map((d) => d.detector))].sort(),
        files: [...new Set(detections.flatMap((d) => d.files))].sort(),
      };
      (byProvider.has(provider) ? truePositives : falsePositives).push(item);
    }
    for (const [provider, providerLabels] of [...byProvider].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!detected.has(provider))
        falseNegatives.push({
          repo: result.repo,
          group: result.group,
          provider,
          inCatalog: catalogIds.has(provider),
          files: providerLabels.map((label) => `${label.file}:${label.line}`),
          ...missCategory(providerLabels, catalog),
        });
  }
  const providers = [
    ...new Set(
      [...truePositives, ...falsePositives, ...falseNegatives].map((item) => item.provider),
    ),
  ].sort();
  const count = (items, provider) => items.filter((item) => item.provider === provider).length;
  const perProvider = Object.fromEntries(
    providers.map((provider) => [
      provider,
      {
        inCatalog: catalogIds.has(provider),
        ...tally(
          count(truePositives, provider),
          count(falsePositives, provider),
          count(falseNegatives, provider),
        ),
      },
    ]),
  );
  const subtotal = (filter) =>
    tally(
      truePositives.filter(filter).length,
      falsePositives.filter(filter).length,
      falseNegatives.filter(filter).length,
    );
  const inCatalog = (item) => catalogIds.has(item.provider);
  const groups = [...new Set([...groupOf.values()].filter(Boolean))].sort();
  return {
    repositories: results.repos.length - errored.length,
    errored,
    catalogProviders: subtotal(inCatalog),
    allProviders: subtotal(() => true),
    byGroup: Object.fromEntries(
      groups.map((group) => [
        group,
        {
          catalogProviders: subtotal((item) => item.group === group && inCatalog(item)),
          allProviders: subtotal((item) => item.group === group),
        },
      ]),
    ),
    missesByCategory: Object.fromEntries(
      MISS_CATEGORIES.map((category) => [
        category,
        falseNegatives.filter((item) => item.category === category).length,
      ]),
    ),
    perProvider,
    falsePositives,
    falseNegatives,
  };
}

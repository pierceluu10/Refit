// The labeller's independent search for the inventory benchmark (docs/INVENTORY-BENCHMARK.md). For
// each frozen repository at its pinned commit it lists declared dependencies, every bare import with
// its first production and non-production file and line, URL hosts in source, and credential-like
// environment variable names. It imports no pipeline code and reads no Refit output, so labels made
// from it stay blind. Checkouts are shallow, without submodules, and nothing in them is installed or
// run. Writes one text summary per repository to --output, outside the repository.
import { execFile } from 'node:child_process';
import { builtinModules } from 'node:module';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { checkoutDirectory, shallowCheckout } from './ai-app-helpers.mjs';
import {
  dependencyDeclarations,
  importSpecifiers,
  isProduction,
  skippedPath,
  urlHosts,
} from './inventory-benchmark-helpers.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-inventory-repos.json' },
    root: { type: 'string' },
    output: { type: 'string' },
    only: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root || !values.output) {
  console.log(
    'Usage: node scripts/inventory-benchmark-candidates.mjs --root <checkouts> --output <dir> [--list <frozen.json>] [--only owner/name,...]',
  );
  process.exit(values.help ? 0 : 1);
}
const MAX_FILE_BYTES = 1024 * 1024;
const TEXT =
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|go|json|toml|ya?ml|txt|cfg|ini|env[^/]*)$|(?:^|\/)(?:Pipfile|\.env[^/]*)$/;
// Local environment files may hold real credentials, even in a public repository: only committed
// templates are read.
const SECRET_FILE = /^\.env(?!\.(?:example|sample|template|dist)$)(?:\..*)?$/;
const ENV_NAME =
  /\b[A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:API_KEY|SECRET_KEY|SECRET|TOKEN|API_TOKEN|ACCESS_KEY|DSN|API_URL|BASE_URL|ENDPOINT|KEY)\b/g;

// Python's standard library names, from the local interpreter run in isolated mode on no input.
const pythonStdlib = new Set(
  await execute('python3', ['-I', '-c', 'import sys;print("\\n".join(sys.stdlib_module_names))'])
    .then(({ stdout }) => stdout.split('\n').filter(Boolean))
    .catch(() => []),
);
const nodeBuiltins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]),
);

async function walk(root, directory = '', files = []) {
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : 1),
  )) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!skippedPath(`${path}/x`)) await walk(root, path, files);
    } else if (entry.isFile() && TEXT.test(path) && !SECRET_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

const list = JSON.parse(await readFile(values.list, 'utf8'));
const only = values.only ? new Set(values.only.split(',')) : null;
await mkdir(resolve(values.output), { recursive: true });
for (const entry of list.repos) {
  if (only && !only.has(entry.repo)) continue;
  let directory;
  try {
    directory = await shallowCheckout(values.root, entry.repo, entry.commit);
  } catch (error) {
    console.error(`${entry.repo}: checkout failed (${String(error.message).split('\n')[0]})`);
    continue;
  }
  const files = await walk(directory);
  const declarations = [];
  const imports = new Map();
  const hosts = new Map();
  const envNames = new Map();
  const note = (map, key, path, line) => {
    const item = map.get(key) ?? { prod: 0, other: 0, firstProd: null, firstOther: null };
    const production = isProduction(path);
    item[production ? 'prod' : 'other'] += 1;
    const field = production ? 'firstProd' : 'firstOther';
    item[field] ??= `${path}:${line}`;
    map.set(key, item);
  };
  for (const path of files) {
    const stats = await lstat(join(directory, path));
    if (stats.size > MAX_FILE_BYTES) continue;
    const text = await readFile(join(directory, path), 'utf8');
    declarations.push(...dependencyDeclarations(path, text));
    const seenImports = new Set();
    for (const { specifier, line, language } of importSpecifiers(path, text)) {
      if (language === 'js' && nodeBuiltins.has(specifier.replace(/^node:/, ''))) continue;
      if (language === 'python' && pythonStdlib.has(specifier)) continue;
      if (language === 'go' && !specifier.split('/')[0].includes('.')) continue;
      if (seenImports.has(specifier)) continue;
      seenImports.add(specifier);
      note(imports, specifier, path, line);
    }
    if (
      !/\.(?:json|lock)$/.test(path) ||
      /(?:^|\/)(?:app|config|settings)[^/]*\.json$/.test(path)
    ) {
      const seenHosts = new Set();
      for (const { host, line } of urlHosts(text)) {
        if (seenHosts.has(host)) continue;
        seenHosts.add(host);
        note(hosts, host, path, line);
      }
    }
    for (const [index, line] of text.split('\n').entries())
      for (const match of line.matchAll(ENV_NAME))
        if (!envNames.has(match[0])) envNames.set(match[0], `${path}:${index + 1}`);
  }
  const format = (map) =>
    [...map]
      .sort(([a, x], [b, y]) => y.prod - x.prod || y.other - x.other || (a < b ? -1 : 1))
      .map(
        ([key, item]) =>
          `  ${key}  prod=${item.prod} other=${item.other}  ${item.firstProd ?? '-'}  ${item.firstOther ?? '-'}`,
      );
  const lines = [
    `# ${entry.repo} @ ${entry.commit} (${entry.group}, ${entry.application}, ${entry.sourceFiles} source files)`,
    `checkout: ${checkoutDirectory(values.root, entry.repo)}`,
    '',
    'Declared dependencies:',
    ...[
      ...new Set(declarations.map((d) => `  ${d.name}${d.dev ? ' (dev)' : ''}  ${d.file}`)),
    ].sort(),
    '',
    'Imports (prod count, other count, first production, first other):',
    ...format(imports),
    '',
    'URL hosts in source and config:',
    ...format(hosts),
    '',
    'Credential-like environment names:',
    ...[...envNames].sort().map(([name, where]) => `  ${name}  ${where}`),
    '',
  ];
  await writeFile(
    join(resolve(values.output), `${entry.repo.replace('/', '__')}.txt`),
    lines.join('\n'),
  );
  console.error(`${entry.repo}: ${imports.size} imports, ${hosts.size} hosts`);
}

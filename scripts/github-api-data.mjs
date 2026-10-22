// Builds data/github-api.json: the REST endpoint behind every `octokit.rest.<scope>.<method>` of
// each @octokit/plugin-rest-endpoint-methods release, GitHub's REST API versions with their end of
// support dates and breaking changes, the operations GitHub's published OpenAPI description marks
// deprecated with their removal dates, and GitHub's upcoming GraphQL breaking changes with a
// field-to-type map of the GraphQL schema. Package sources are parsed from unpacked npm tarballs
// and never executed or installed.
//
//   npm pack @octokit/plugin-rest-endpoint-methods@<each release> --ignore-scripts && tar xzf …
//   curl -o octokit-registry.json https://registry.npmjs.org/@octokit%2fplugin-rest-endpoint-methods
//   git clone --depth 1 --sparse https://github.com/github/rest-api-description
//     (and `git sparse-checkout set /descriptions/api.github.com/`)
//   git clone --depth 1 --sparse https://github.com/github/docs
//     (and `git sparse-checkout set /data/tables/ /data/reusables/rest-api/ /src/rest/lib/ /src/graphql/data/fpt/`)
//   node scripts/github-api-data.mjs --octokit 4.15.1/package --octokit … --registry octokit-registry.json \
//     --rest-description rest-api-description --docs docs --checked-at 2026-10-22 \
//     --output data/github-api.json
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { buildSchema, getNamedType, isInterfaceType, isObjectType } from 'graphql';
import ts from 'typescript-compiler';
import YAML from 'yaml';

const execute = promisify(execFile);
const PACKAGE = '@octokit/plugin-rest-endpoint-methods';
const ENDPOINTS = 'dist-src/generated/endpoints.js';
const DESCRIPTION = 'descriptions/api.github.com/api.github.com.json';
const VERSIONS_TABLE = 'data/tables/rest-api-versions.yml';
const REST_CONFIG = 'src/rest/lib/config.json';
const BREAKING = 'data/reusables/rest-api/breaking-changes-changelog.md';
const GRAPHQL_CHANGES = 'src/graphql/data/fpt/graphql_upcoming_changes.public.yml';
const GRAPHQL_SCHEMA = 'src/graphql/data/fpt/schema.docs.graphql';
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete']);
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const { values } = parseArgs({
  options: {
    octokit: { type: 'string', multiple: true },
    registry: { type: 'string' },
    'rest-description': { type: 'string' },
    docs: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.octokit?.length ||
  !values.registry ||
  !values['rest-description'] ||
  !values.docs ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/github-api-data.mjs --octokit <unpacked dir>… --registry <registry.json> --rest-description <checkout> --docs <github/docs checkout> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function gitCommit(root) {
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  return {
    commit: await git('rev-parse', 'HEAD'),
    committedAt: await git('show', '-s', '--format=%cI', 'HEAD'),
  };
}

// `scope: { method: ["GET /route", defaults?, { deprecated?, renamed? }] }` in endpoints.js.
async function octokitRelease(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE) throw new Error(`${root} is not ${PACKAGE}.`);
  const path = join(root, ENDPOINTS);
  const source = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let table;
  const visit = (node) => {
    if (
      !table &&
      ts.isVariableDeclaration(node) &&
      node.name.getText() === 'Endpoints' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      table = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!table) throw new Error(`${manifest.version} has no Endpoints table.`);
  const name = (property) => property.name.getText().replace(/^['"]|['"]$/g, '');
  const methods = {};
  for (const scope of table.properties) {
    if (!ts.isPropertyAssignment(scope) || !ts.isObjectLiteralExpression(scope.initializer))
      continue;
    for (const method of scope.initializer.properties) {
      if (!ts.isPropertyAssignment(method) || !ts.isArrayLiteralExpression(method.initializer))
        continue;
      const [route, , decorations] = method.initializer.elements;
      if (!route || !ts.isStringLiteral(route)) continue;
      const entry = { route: route.text };
      const decoration =
        decorations && ts.isObjectLiteralExpression(decorations) ? decorations : undefined;
      for (const property of decoration?.properties ?? []) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (name(property) === 'deprecated' && ts.isStringLiteral(property.initializer))
          entry.deprecated = property.initializer.text;
        if (name(property) === 'renamed' && ts.isArrayLiteralExpression(property.initializer))
          entry.renamed = property.initializer.elements.map((item) => item.text).join('.');
      }
      methods[`${name(scope)}.${name(method)}`] = entry;
    }
  }
  return { version: manifest.version, methods };
}

function isoDate(text) {
  const match = /([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(text ?? '');
  const month = match ? MONTHS.indexOf(match[1]) + 1 : 0;
  return month
    ? `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`
    : null;
}

// REST API versions, their end of support, the version unversioned requests get, and the
// breaking changes each version brings with the endpoints they affect.
async function restVersions(root) {
  const table = YAML.parse(await readFile(join(root, VERSIONS_TABLE), 'utf8'));
  const config = JSON.parse(await readFile(join(root, REST_CONFIG), 'utf8'));
  const supported = [...config['api-versions'].fpt].sort();
  const versions = Object.entries(table.versions).map(([version, value]) => ({
    version,
    endOfSupport: isoDate(value?.end_of_support) ?? null,
    endOfSupportText: value?.end_of_support ?? null,
  }));
  const changelog = await readFile(join(root, BREAKING), 'utf8');
  const breaking = {};
  let version;
  let change;
  for (const raw of changelog.split('\n')) {
    const line = raw.replace(/\{%.*?%\}/g, '');
    const heading = /^## Version (\d{4}-\d{2}-\d{2})/.exec(line);
    if (heading) {
      version = heading[1];
      breaking[version] = [];
      change = undefined;
      continue;
    }
    if (!version) continue;
    const title = /^- \*\*(.+?)\*\*/.exec(line);
    if (title) {
      change = { title: title[1].replace(/`/g, ''), endpoints: [] };
      breaking[version].push(change);
      continue;
    }
    const endpoint = /^\s+- `(GET|POST|PUT|PATCH|DELETE) (\/[^`]+)`/.exec(line);
    if (endpoint && change) change.endpoints.push(`${endpoint[1]} ${endpoint[2]}`);
  }
  return {
    page: 'https://docs.github.com/en/rest/about-the-rest-api/api-versions',
    breakingChangesPage: 'https://docs.github.com/en/rest/about-the-rest-api/breaking-changes',
    repository: 'https://github.com/github/docs',
    files: [VERSIONS_TABLE, REST_CONFIG, BREAKING],
    ...(await gitCommit(root)),
    supported,
    // The docs site's `defaultRestApiVersion`: the oldest supported version.
    defaultVersion: supported[0],
    versions,
    breakingChanges: breaking,
  };
}

// Operations of GitHub's published OpenAPI description marked deprecated, with x-github dates.
async function openapi(root) {
  const text = await readFile(join(root, DESCRIPTION));
  const document = JSON.parse(text.toString('utf8'));
  const deprecated = [];
  let operations = 0;
  for (const [path, item] of Object.entries(document.paths ?? {}))
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP.has(method)) continue;
      operations += 1;
      if (!operation.deprecated) continue;
      const github = operation['x-github'] ?? {};
      deprecated.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId ?? null,
        deprecationDate: github.deprecationDate ?? null,
        removalDate: github.removalDate ?? null,
      });
    }
  return {
    repository: 'https://github.com/github/rest-api-description',
    file: DESCRIPTION,
    ...(await gitCommit(root)),
    sha256: createHash('sha256').update(text).digest('hex'),
    version: document.info?.version ?? null,
    operations,
    deprecated,
  };
}

// Upcoming GraphQL breaking changes, and each object and interface type's fields with the named
// type they return, so a query can be walked without the full schema.
async function graphql(root) {
  const changes = YAML.parse(await readFile(join(root, GRAPHQL_CHANGES), 'utf8')).upcoming_changes;
  const schema = buildSchema(await readFile(join(root, GRAPHQL_SCHEMA), 'utf8'), {
    assumeValidSDL: true,
  });
  const types = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith('__') || !(isObjectType(type) || isInterfaceType(type))) continue;
    types[name] = Object.fromEntries(
      Object.values(type.getFields()).map((field) => [field.name, getNamedType(field.type).name]),
    );
  }
  return {
    page: 'https://docs.github.com/en/graphql/overview/breaking-changes',
    repository: 'https://github.com/github/docs',
    files: [GRAPHQL_CHANGES, GRAPHQL_SCHEMA],
    ...(await gitCommit(root)),
    query: schema.getQueryType()?.name ?? null,
    mutation: schema.getMutationType()?.name ?? null,
    changes: changes.map((change) => ({
      location: change.location,
      description: String(change.description).replace(/\s+/g, ' ').trim(),
      date: String(change.date).slice(0, 10),
    })),
    types,
  };
}

const releases = await Promise.all(values.octokit.map((root) => octokitRelease(resolve(root))));
releases.sort((a, b) => compareVersions(a.version, b.version));
const registry = JSON.parse(await readFile(resolve(values.registry), 'utf8'));
if (registry.name !== PACKAGE) throw new Error(`--registry is not ${PACKAGE}.`);
const order = releases.map((item) => item.version);
// Method -> one entry per distinct route, with the releases that define it.
const methods = {};
for (const { version, methods: listed } of releases)
  for (const [method, entry] of Object.entries(listed)) {
    const entries = (methods[method] ??= []);
    let found = entries.find((item) => item.route === entry.route);
    if (!found) entries.push((found = { route: entry.route, releases: [] }));
    found.releases.push(version);
    // The newest release's decorations win.
    delete found.deprecated;
    delete found.renamed;
    if (entry.deprecated) found.deprecated = entry.deprecated;
    if (entry.renamed) found.renamed = entry.renamed;
  }
const span = (listed) => {
  const first = order.indexOf(listed[0]);
  const consecutive = listed.every((version, index) => order[first + index] === version);
  return consecutive && listed.length > 1 ? `${listed[0]}..${listed.at(-1)}` : listed.join(' ');
};
const lines = Object.entries(methods)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([method, entries]) =>
      `${JSON.stringify(method)}:${JSON.stringify(entries.map((entry) => ({ ...entry, releases: span(entry.releases) })))}`,
  );
const graph = await graphql(resolve(values.docs));
const typeLines = Object.entries(graph.types)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, fields]) => `${JSON.stringify(name)}:${JSON.stringify(fields)}`);
delete graph.types;
const sections = {
  formatVersion: 1,
  generatedBy: 'scripts/github-api-data.mjs',
  checkedAt: values['checked-at'],
  rest: await restVersions(resolve(values.docs)),
  openapi: await openapi(resolve(values['rest-description'])),
  graphql: graph,
};
// One line per Octokit method and per GraphQL type keeps the file small and its diffs readable.
const head = JSON.stringify(sections, null, 1).replace(/\n\}$/, '');
await writeFile(
  values.output,
  `${head},
 "graphqlTypes": {
${typeLines.map((line) => `  ${line}`).join(',\n')}
 },
 "octokit": {
  "package": ${JSON.stringify(PACKAGE)},
  "source": "https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}",
  "latest": ${JSON.stringify(registry['dist-tags']?.latest ?? null)},
  "releases": ${JSON.stringify(order)},
  "methods": {
${lines.map((line) => `   ${line}`).join(',\n')}
  }
 }
}
`,
);

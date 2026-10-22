// Builds data/cloudflare-endpoints.json: the HTTP method and path behind every
// `client.<resource>.<method>` of each `cloudflare` npm release from 3.x on, the operations
// Cloudflare's published OpenAPI document marks deprecated, and the entries of Cloudflare's API
// deprecations page with their dates and endpoints. Package sources are parsed from unpacked npm
// tarballs and never executed or installed.
//
//   npm pack cloudflare@<each release> --ignore-scripts && tar xzf <tgz> -C sdk/<v>
//   curl -o cloudflare-registry.json https://registry.npmjs.org/cloudflare
//   git clone --depth 1 https://github.com/cloudflare/api-schemas
//   git clone --depth 1 --sparse https://github.com/cloudflare/cloudflare-docs
//     (and `git sparse-checkout add /src/content/release-notes/`)
//   node scripts/cloudflare-endpoints.mjs --sdk sdk/3.5.0/package --sdk … \
//     --registry cloudflare-registry.json --schemas api-schemas --docs cloudflare-docs \
//     --checked-at 2026-10-22 --output data/cloudflare-endpoints.json
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import ts from 'typescript-compiler';
import YAML from 'yaml';

const execute = promisify(execFile);
const PACKAGE = 'cloudflare';
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete']);
const DEPRECATIONS = 'src/content/release-notes/api-deprecations.yaml';
const DEPRECATIONS_PAGE =
  'https://developers.cloudflare.com/fundamentals/api/reference/deprecations/';
const FLAGS = 'src/content/compatibility-flags';
const FLAGS_PAGE = 'https://developers.cloudflare.com/workers/configuration/compatibility-flags/';
const FLAGS_PAGE_SOURCE = 'src/content/docs/workers/configuration/compatibility-flags.mdx';
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
    sdk: { type: 'string', multiple: true },
    registry: { type: 'string' },
    schemas: { type: 'string' },
    docs: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.sdk?.length ||
  !values.registry ||
  !values.schemas ||
  !values.docs ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/cloudflare-endpoints.mjs --sdk <unpacked dir>… --registry <registry.json> --schemas <api-schemas checkout> --docs <cloudflare-docs checkout> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

// `/zones/{zone_id}/settings/{setting_id}`; the SDK's own parameter names are kept for reading,
// and compared with `{}` for every segment.
function templatePath(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTaggedTemplateExpression(node)) return templatePath(node.template);
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => `{${span.expression.getText().replace(/^.*\./, '')}}${span.literal.text}`)
        .join('')
    );
  return undefined;
}

const pathKey = (path) => path.replace(/\{[^}]*\}/g, '{}');

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Reads every resource class of one release and walks them from the root client.
async function release(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE) throw new Error(`${root} is not ${PACKAGE}.`);
  const sources = new Map();
  const sourceAt = async (path) => {
    if (!sources.has(path)) {
      const text = await readFile(path, 'utf8');
      sources.set(path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
    }
    return sources.get(path);
  };
  const moduleFile = (from, specifier) => {
    const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
    return [`${base}.ts`, join(base, 'index.ts')].find((file) => existsSync(file));
  };
  // The class `name` exported from `file`, following `export … from` re-exports.
  const findClass = async (file, name, depth = 0) => {
    if (!file || depth > 6) return undefined;
    const source = await sourceAt(file);
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === name)
        return { file, node: statement };
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const specifier = statement.moduleSpecifier.text;
        const clause = statement.exportClause;
        const element =
          clause && ts.isNamedExports(clause)
            ? clause.elements.find((item) => item.name.text === name)
            : undefined;
        if (element || !clause) {
          const found = await findClass(
            moduleFile(file, specifier),
            (element?.propertyName ?? element?.name)?.text ?? name,
            depth + 1,
          );
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  // `SettingsAPI.Settings` or `Settings` in a file, to its class.
  const classOf = async (file, expression) => {
    const source = await sourceAt(file);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const alias = expression.expression.text;
      for (const statement of source.statements)
        if (
          ts.isImportDeclaration(statement) &&
          statement.importClause?.namedBindings &&
          ts.isNamespaceImport(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.name.text === alias
        )
          return findClass(moduleFile(file, statement.moduleSpecifier.text), expression.name.text);
    }
    if (ts.isIdentifier(expression)) return findClass(file, expression.text);
    return undefined;
  };
  const properties = {};
  const visited = new Set();
  const walk = async (found, prefix) => {
    const key = `${found.file}#${found.node.name.text}:${prefix}`;
    if (visited.has(key) || prefix.split('.').length > 8) return;
    visited.add(key);
    // Members of the class and of the base class it extends in the same file (7.x `BaseX`).
    const classes = [found];
    const heritage = found.node.heritageClauses?.[0]?.types[0]?.expression;
    if (heritage && ts.isIdentifier(heritage) && heritage.text !== 'APIResource') {
      const base = await findClass(found.file, heritage.text);
      if (base) classes.push(base);
    }
    for (const { file, node } of classes)
      for (const member of node.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
        if (!name) continue;
        if (ts.isPropertyDeclaration(member) && member.initializer) {
          const initializer = member.initializer;
          if (ts.isNewExpression(initializer)) {
            const target = await classOf(file, initializer.expression);
            if (target) await walk(target, prefix ? `${prefix}.${name}` : name);
          }
          continue;
        }
        if (!ts.isMethodDeclaration(member) || !member.body || !prefix) continue;
        let request;
        const visit = (child) => {
          if (request) return;
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.expression.getText() === 'this._client'
          ) {
            const verb = child.expression.name.text;
            const path = child.arguments[0] && templatePath(child.arguments[0]);
            if (verb === 'getAPIList' && path) request = { method: 'GET', path };
            else if (VERBS.has(verb) && path) request = { method: verb.toUpperCase(), path };
          }
          ts.forEachChild(child, visit);
        };
        visit(member.body);
        if (request) properties[`${prefix}.${name}`] = request;
      }
  };
  const rootFile = ['src/client.ts', 'src/index.ts']
    .map((file) => join(root, file))
    .find((file) => existsSync(file));
  const client = await findClass(rootFile, 'Cloudflare');
  if (!client) throw new Error(`${manifest.version} has no Cloudflare client class.`);
  // The root class holds resources as `zones: API.Zones = new API.Zones(this)`.
  await walk(client, '');
  if (!Object.keys(properties).length) throw new Error(`${manifest.version} maps no methods.`);
  return { version: manifest.version, properties };
}

async function gitCommit(root) {
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  return {
    commit: await git('rev-parse', 'HEAD'),
    committedAt: await git('show', '-s', '--format=%cI', 'HEAD'),
  };
}

// Deprecated operations of Cloudflare's published OpenAPI document, with `x-cfDeprecation`.
async function openapi(root) {
  const text = await readFile(join(root, 'openapi.json'));
  const document = JSON.parse(text.toString('utf8'));
  const deprecated = [];
  let operations = 0;
  for (const [path, item] of Object.entries(document.paths ?? {}))
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP.has(method)) continue;
      operations += 1;
      if (!operation.deprecated) continue;
      const notice = operation['x-cfDeprecation'];
      deprecated.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId ?? null,
        ...(notice
          ? {
              notice: {
                id: notice.id ?? null,
                eol: typeof notice.eol === 'string' ? notice.eol.slice(0, 10) : null,
                description: notice.description ?? null,
              },
            }
          : {}),
      });
    }
  return {
    repository: 'https://github.com/cloudflare/api-schemas',
    file: 'openapi.json',
    ...(await gitCommit(root)),
    sha256: createHash('sha256').update(text).digest('hex'),
    version: document.info?.version ?? null,
    servers: (document.servers ?? []).map((server) => server.url),
    operations,
    deprecated,
  };
}

function isoDate(text) {
  const match = /([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(text ?? '');
  const month = match ? MONTHS.indexOf(match[1]) + 1 : 0;
  return month
    ? `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`
    : null;
}

// `GET /zones/{zone_id}`, `GET zones/:zone_identifier/analytics/colos` or `GET/zones/{zone_id}/…`.
const ENDPOINT = /`(GET|POST|PUT|PATCH|DELETE) ?(\/?[A-Za-z0-9_{}:.\/-]+)`/g;
const BARE_METHOD = /`(GET|POST|PUT|PATCH|DELETE)`/g;

// Each entry of the deprecations page's YAML: its dates and the endpoints listed under a
// "Deprecated API", "Affected API" or "Deprecated endpoints" heading, until "Replacement".
async function announcements(root) {
  const document = YAML.parse(await readFile(join(root, DEPRECATIONS), 'utf8'));
  const entries = document.entries.map((entry) => {
    const text = String(entry.description);
    const endpoints = [];
    // `deprecated`: the endpoint goes away; `affected`: it stays and changes behaviour.
    let listing;
    for (const line of text.split('\n')) {
      const heading = /^\s*(?:\*\*)?(Deprecated|Affected) (?:APIs?|endpoints?)\b/i.exec(line);
      if (heading) listing = heading[1].toLowerCase();
      else if (/^\s*(?:\*\*)?Replacements?\b/i.test(line)) listing = undefined;
      if (!listing) continue;
      for (const match of line.matchAll(ENDPOINT)) {
        const [, method, path] = match;
        // "`GET`, `PUT`, and `DELETE /accounts/…`" lists several methods for one path.
        const before = line.slice(0, match.index);
        const methods = [...new Set([...before.matchAll(BARE_METHOD)].map((item) => item[1]))];
        // "`POST /…/gateway/rules` — creating rules with `action: "audit_ssh"` is no longer
        // accepted" retires one request shape, not the endpoint.
        const qualified = /\bwith `/.test(line.slice(match.index + match[0].length));
        for (const each of [...methods, method])
          endpoints.push({
            method: each,
            path: `/${path.replace(/^\//, '').replace(/\/$/, '')}`.replace(/:(\w+)/g, '{$1}'),
            change: qualified ? 'affected' : listing,
          });
      }
    }
    const deprecation = /Deprecation date:\s*([^\n]+)/.exec(text)?.[1].trim() ?? null;
    const endOfLife = /End of life date:\s*([^\n]+)/.exec(text)?.[1].trim() ?? null;
    return {
      title: String(entry.title),
      publishDate: String(entry.publish_date),
      // ISO dates when the page gives a day; the page's own words otherwise ("January 2026").
      deprecationDate: isoDate(deprecation) ?? deprecation,
      endOfLife: isoDate(endOfLife) ?? endOfLife,
      endpoints,
    };
  });
  return {
    page: DEPRECATIONS_PAGE,
    repository: 'https://github.com/cloudflare/cloudflare-docs',
    file: DEPRECATIONS,
    ...(await gitCommit(root)),
    entries,
  };
}

// Workers compatibility flags: the front matter of each file behind the compatibility flags page.
async function compatibilityFlags(root) {
  const flags = [];
  for (const file of (await readdir(join(root, FLAGS))).sort()) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join(root, FLAGS, file), 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (!front) throw new Error(`${FLAGS}/${file} has no front matter.`);
    const value = YAML.parse(front);
    flags.push({
      enableFlag: value.enable_flag ?? null,
      disableFlag: value.disable_flag ?? null,
      // The date from which a compatibility date turns the flag on by default.
      enableDate: value.enable_date ? String(value.enable_date) : null,
      experimental: value.experimental === true,
    });
  }
  // The page names the Node.js flags in prose, outside the collection above.
  const page = await readFile(join(root, FLAGS_PAGE_SOURCE), 'utf8');
  const section = page.split(/^## Node\.js compatibility flag/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error(`${FLAGS_PAGE_SOURCE} has no Node.js compatibility flag section.`);
  const named = new Set(flags.flatMap((flag) => [flag.enableFlag, flag.disableFlag]));
  const documented = [
    ...new Set(
      [...section.matchAll(/[`"](n[a-z_]*nodejs[a-z0-9_]*|nodejs[a-z0-9_]*)[`"]/g)].map(
        (match) => match[1],
      ),
    ),
  ]
    .filter((flag) => !named.has(flag))
    .sort();
  return {
    page: FLAGS_PAGE,
    repository: 'https://github.com/cloudflare/cloudflare-docs',
    directory: FLAGS,
    pageSource: FLAGS_PAGE_SOURCE,
    // Flags the page's Node.js section names that the collection does not list.
    documented,
    ...(await gitCommit(root)),
    flags,
  };
}

const releases = await Promise.all(values.sdk.map((root) => release(resolve(root))));
releases.sort((a, b) => compareVersions(a.version, b.version));
const registry = JSON.parse(await readFile(resolve(values.registry), 'utf8'));
if (registry.name !== PACKAGE) throw new Error(`--registry is not ${PACKAGE}.`);
// Property -> its request and the releases that define it. A property whose request changes
// between releases keeps one entry per request.
const properties = {};
for (const { version, properties: listed } of releases)
  for (const [property, request] of Object.entries(listed)) {
    const entries = (properties[property] ??= []);
    let entry = entries.find(
      (item) => item.method === request.method && pathKey(item.path) === pathKey(request.path),
    );
    if (!entry) entries.push((entry = { ...request, releases: [] }));
    // The newest release's parameter names (`settingId` became `settingID` in 7.x).
    entry.path = request.path;
    entry.releases.push(version);
  }
// Releases as `3.5.0..7.3.0` when they are consecutive recorded releases.
const order = releases.map((item) => item.version);
const span = (listed) => {
  const first = order.indexOf(listed[0]);
  const consecutive = listed.every((version, index) => order[first + index] === version);
  return consecutive && listed.length > 1 ? `${listed[0]}..${listed.at(-1)}` : listed.join(' ');
};
const lines = Object.entries(properties)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([property, entries]) =>
      `${JSON.stringify(property)}:${JSON.stringify(entries.map((entry) => ({ ...entry, releases: span(entry.releases) })))}`,
  );
const sections = {
  formatVersion: 1,
  generatedBy: 'scripts/cloudflare-endpoints.mjs',
  checkedAt: values['checked-at'],
  openapi: await openapi(resolve(values.schemas)),
  announcements: await announcements(resolve(values.docs)),
  compatibilityFlags: await compatibilityFlags(resolve(values.docs)),
};
// One line per SDK property keeps the file small and its diffs readable.
const head = JSON.stringify(sections, null, 1).replace(/\n\}$/, '');
await writeFile(
  values.output,
  `${head},
 "sdk": {
  "package": ${JSON.stringify(PACKAGE)},
  "source": "https://registry.npmjs.org/${PACKAGE}",
  "latest": ${JSON.stringify(registry['dist-tags']?.latest ?? null)},
  "releases": ${JSON.stringify(order)},
  "properties": {
${lines.map((line) => `   ${line}`).join(',\n')}
  }
 }
}
`,
);

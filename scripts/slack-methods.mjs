// Builds data/slack-methods.json: the Slack Web API method behind every `client.<group>.<method>`
// property of each @slack/web-api release, the methods each release marks @deprecated, and the
// deprecations and removals Slack's own SDKs publish. Package sources are read as text from
// unpacked npm tarballs and parsed, never executed or installed.
//
//   npm pack @slack/web-api@<each release> --ignore-scripts && tar xzf <tgz> -C web-api/<v>
//   curl -o web-api-registry.json https://registry.npmjs.org/@slack%2fweb-api
//   git clone --depth 1 https://github.com/slackapi/python-slack-sdk python-slack-sdk
//   git clone --depth 1 https://github.com/slackapi/node-slack-sdk node-slack-sdk
//   node scripts/slack-methods.mjs --web-api web-api/5.15.0/package --web-api … \
//     --registry web-api-registry.json --python-sdk python-slack-sdk --node-sdk node-slack-sdk \
//     --checked-at 2026-10-22 --output data/slack-methods.json
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import ts from 'typescript-compiler';

const execute = promisify(execFile);
const PACKAGE = '@slack/web-api';
const BINDERS = new Set(['bindApiCall', 'bindApiCallWithOptionalArgument', 'bindFilesUploadV2']);
const PYTHON_DEPRECATIONS = 'slack_sdk/web/deprecation.py';
const NODE_REMOVALS = 'docs/english/migration/web-api/migrating-web-api-package-to-v8.md';
const { values } = parseArgs({
  options: {
    'web-api': { type: 'string', multiple: true },
    registry: { type: 'string' },
    'python-sdk': { type: 'string' },
    'node-sdk': { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values['web-api']?.length ||
  !values.registry ||
  !values['python-sdk'] ||
  !values['node-sdk'] ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/slack-methods.mjs --web-api <unpacked dir>… --registry <registry.json> --python-sdk <git checkout> --node-sdk <git checkout> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

// The property path of an object member: `admin.apps.approve` for `admin = { apps: { approve: … } }`
// in a class field (7.x and later) or `this.admin = { … }` in the constructor (5.x and 6.x).
function pathOf(node) {
  const names = [];
  for (let current = node; current; current = current.parent) {
    if (ts.isPropertyAssignment(current)) names.unshift(propertyName(current.name));
    if (ts.isPropertyDeclaration(current)) {
      names.unshift(propertyName(current.name));
      break;
    }
    if (
      ts.isBinaryExpression(current) &&
      ts.isPropertyAccessExpression(current.left) &&
      current.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      names.unshift(current.left.name.text);
      break;
    }
  }
  return names.includes(undefined) ? undefined : names.join('.');
}

function deprecation(node) {
  const tag = ts.getJSDocTags(node).find((item) => item.tagName.text === 'deprecated');
  if (!tag) return undefined;
  const comment = ts.getTextOfJSDocComment(tag.comment)?.replace(/\s+/g, ' ').trim();
  return comment || 'deprecated';
}

// Each `name: bindApiCall(this, 'group.method')` in dist/methods.js. `bindFilesUploadV2(this)`
// binds the client's own `filesUploadV2`, which calls two methods (see WebClient.js).
async function release(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE) throw new Error(`${root} is not ${PACKAGE}.`);
  const path = join(root, 'dist', 'methods.js');
  const source = ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const client = await readFile(join(root, 'dist', 'WebClient.js'), 'utf8');
  const properties = {};
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      BINDERS.has(node.initializer.expression.text)
    ) {
      const property = pathOf(node);
      if (!property) throw new Error(`${manifest.version}: a bound method has no property path.`);
      const [, argument] = node.initializer.arguments;
      const methods =
        node.initializer.expression.text === 'bindFilesUploadV2'
          ? ['files.getUploadURLExternal', 'files.completeUploadExternal']
          : argument && ts.isStringLiteral(argument)
            ? [argument.text]
            : undefined;
      if (!methods) throw new Error(`${manifest.version}: ${property} binds no method name.`);
      if (methods.length > 1)
        for (const method of methods)
          if (!client.includes(`this.${method}(`) && !client.includes(`'${method}'`))
            throw new Error(`${manifest.version}: filesUploadV2 no longer calls ${method}.`);
      properties[property] = { methods, deprecated: deprecation(node) ?? null };
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!Object.keys(properties).length) throw new Error(`${manifest.version} binds no methods.`);
  return { version: manifest.version, properties };
}

async function gitCommit(root) {
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  return {
    commit: await git('rev-parse', 'HEAD'),
    committedAt: await git('show', '-s', '--format=%cI', 'HEAD'),
  };
}

// slack_sdk/web/deprecation.py: lists of method prefixes, each warned about with one changelog URL.
async function pythonDeprecations(root) {
  const text = await readFile(join(root, PYTHON_DEPRECATIONS), 'utf8');
  const lists = new Map();
  for (const [, name, body] of text.matchAll(/^(deprecated_method_prefixes_\w+) = \[([^\]]*)\]/gm))
    lists.set(
      name,
      [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    );
  const deprecations = [];
  for (const block of text.split(/\n(?= {4}# )/).slice(1)) {
    const name = /prefix in (deprecated_method_prefixes_\w+)/.exec(block)?.[1];
    const url = /"(https:\/\/docs\.slack\.dev\/changelog\/[^"]+)"/.exec(block)?.[1];
    if (!name) continue;
    if (!lists.has(name) || !url)
      throw new Error(`${PYTHON_DEPRECATIONS}: ${name} has no list or URL.`);
    deprecations.push({ prefixes: lists.get(name), announcement: url });
  }
  if (deprecations.length !== lists.size)
    throw new Error(
      `${PYTHON_DEPRECATIONS}: ${lists.size} lists but ${deprecations.length} warnings.`,
    );
  return {
    repository: 'https://github.com/slackapi/python-slack-sdk',
    file: PYTHON_DEPRECATIONS,
    ...(await gitCommit(root)),
    deprecations,
  };
}

// The "Removed method | Replacement | Notes" table of the @slack/web-api v8 migration guide.
async function nodeRemovals(root) {
  const text = await readFile(join(root, NODE_REMOVALS), 'utf8');
  const table = text.split('| Removed method |')[1];
  if (!table) throw new Error(`${NODE_REMOVALS} has no removed-method table.`);
  const removed = [];
  for (const line of table.split('\n').slice(2)) {
    const cells = /^\| `([\w.]+)` \| (.+?) \| (.+?) \|$/.exec(line.trim());
    if (!cells) break;
    const replacement = /^`([\w.]+)`$/.exec(cells[2])?.[1] ?? null;
    removed.push({ method: cells[1], replacement, notes: cells[3] });
  }
  if (!removed.length) throw new Error(`${NODE_REMOVALS}: the removed-method table is empty.`);
  return {
    repository: 'https://github.com/slackapi/node-slack-sdk',
    file: NODE_REMOVALS,
    ...(await gitCommit(root)),
    removed,
  };
}

const releases = await Promise.all(values['web-api'].map((root) => release(resolve(root))));
releases.sort((a, b) => compareVersions(a.version, b.version));
const registry = JSON.parse(await readFile(resolve(values.registry), 'utf8'));
if (registry.name !== PACKAGE) throw new Error(`--registry is not ${PACKAGE}.`);
// Property -> the methods it calls and the releases that define it. A property whose methods
// change between releases fails the build. `deprecated` is the newest release's JSDoc notice.
const properties = {};
for (const { version, properties: listed } of releases)
  for (const [property, entry] of Object.entries(listed)) {
    const known = (properties[property] ??= {
      methods: entry.methods,
      releases: [],
      deprecated: null,
    });
    if (known.methods.join() !== entry.methods.join())
      throw new Error(`${property} changed its methods in ${version}.`);
    known.releases.push(version);
    known.deprecated = entry.deprecated;
  }
const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/slack-methods.mjs',
      checkedAt: values['checked-at'],
      webApi: {
        package: PACKAGE,
        source: `https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}`,
        latest: registry['dist-tags']?.latest ?? null,
        releases: releases.map((item) => item.version),
        properties: sorted(properties),
      },
      pythonSdk: await pythonDeprecations(resolve(values['python-sdk'])),
      nodeSdk: await nodeRemovals(resolve(values['node-sdk'])),
    },
    null,
    2,
  )}\n`,
);

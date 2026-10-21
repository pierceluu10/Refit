// Builds data/paypal-requests.json: the HTTP method and path behind every request class of
// @paypal/checkout-server-sdk, behind every controller method of each @paypal/paypal-server-sdk
// release, and the operations in PayPal's published OpenAPI documents. Package sources are read as
// text from unpacked npm tarballs and never executed or installed.
//
//   npm pack @paypal/checkout-server-sdk@1.0.3 --ignore-scripts && tar xzf <tgz> -C checkout
//   npm pack @paypal/paypal-server-sdk@<each release> --ignore-scripts && tar xzf <tgz> -C server/<v>
//   curl -o checkout-registry.json https://registry.npmjs.org/@paypal%2fcheckout-server-sdk
//   git clone https://github.com/paypal/paypal-rest-api-specifications specifications
//   node scripts/paypal-requests.mjs --checkout checkout/package --checkout-registry checkout-registry.json \
//     --server server/0.5.1/package --server … --specifications specifications --checked-at 2026-10-21 \
//     --output data/paypal-requests.json
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const CHECKOUT = '@paypal/checkout-server-sdk';
const SERVER = '@paypal/paypal-server-sdk';
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete']);
const { values } = parseArgs({
  options: {
    checkout: { type: 'string' },
    'checkout-registry': { type: 'string' },
    server: { type: 'string', multiple: true },
    specifications: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.checkout ||
  !values['checkout-registry'] ||
  !values.server?.length ||
  !values.specifications ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/paypal-requests.mjs --checkout <unpacked dir> --checkout-registry <registry.json> --server <unpacked dir>… --specifications <git checkout> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

async function manifest(root, name) {
  const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (value.name !== name) throw new Error(`${root} is not ${name}.`);
  return value;
}

// Each old-SDK request class sets `this.path` and `this.verb` in its constructor; `?` ends every
// generated path and is dropped.
async function checkoutRequests(root) {
  const { version } = await manifest(root, CHECKOUT);
  const requests = {};
  for (const area of ['core', 'orders', 'payments']) {
    const directory = join(root, 'lib', area);
    const exported = await readFile(join(directory, 'lib.js'), 'utf8');
    for (const [, name, file] of exported.matchAll(/(\w+): require\('\.\/(\w+)'\)\.\1/g)) {
      const content = await readFile(join(directory, `${file}.js`), 'utf8');
      const path = /this\.path = '([^']+)'/.exec(content)?.[1];
      const method = /this\.verb = '([A-Z]+)'/.exec(content)?.[1];
      if (!path && !method) continue;
      if (!path || !method) throw new Error(`${area}.${name} has a path or verb but not both.`);
      requests[area] ??= {};
      requests[area][name] = { method, path: path.replace(/\?$/, '') };
    }
  }
  return { version, requests };
}

// Each controller method creates one request: `createRequest('POST', '/v2/checkout/orders')`, or
// `createRequest('GET')` followed by `appendTemplatePath` with `${mapped.id}` substitutions.
async function serverControllers(root) {
  const { version } = await manifest(root, SERVER);
  const directory = join(root, 'src', 'controllers');
  const controllers = {};
  for (const file of (await readdir(directory)).sort()) {
    if (!file.endsWith('Controller.ts') || file === 'baseController.ts') continue;
    const content = await readFile(join(directory, file), 'utf8');
    const name = /export class (\w+) extends BaseController/.exec(content)?.[1];
    if (!name) throw new Error(`${file} exports no controller.`);
    const methods = {};
    const blocks = content.split(/\n {2}async (?=\w+\()/).slice(1);
    for (const block of blocks) {
      const method = /^(\w+)\(/.exec(block)[1];
      const request = /this\.createRequest\(\s*'([A-Z]+)'(?:,\s*'([^']+)')?/.exec(block);
      const template = /appendTemplatePath`([^`]+)`/.exec(block)?.[1];
      const path = request?.[2] ?? template?.replace(/\$\{mapped\.(\w+)\}/g, '{$1}');
      if (!request || !path) throw new Error(`${name}.${method} has no request method and path.`);
      methods[method] = { method: request[1], path };
    }
    controllers[name] = methods;
  }
  return { version, controllers };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function specifications(root) {
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim();
  const commit = await git('rev-parse', 'HEAD');
  const committedAt = await git('show', '-s', '--format=%cI', 'HEAD');
  const documents = {};
  for (const file of (await readdir(join(root, 'openapi'))).sort()) {
    if (!file.endsWith('.json')) continue;
    const document = JSON.parse(await readFile(join(root, 'openapi', file), 'utf8'));
    const operations = [];
    for (const [path, item] of Object.entries(document.paths ?? {}))
      for (const [method, operation] of Object.entries(item))
        if (HTTP.has(method))
          operations.push({
            method: method.toUpperCase(),
            path,
            operationId: operation.operationId ?? null,
            ...(operation.deprecated ? { deprecated: true } : {}),
          });
    documents[file] = {
      title: document.info?.title ?? null,
      version: document.info?.version ?? null,
      servers: (document.servers ?? []).map((server) => server.url),
      operations,
    };
  }
  return {
    repository: 'https://github.com/paypal/paypal-rest-api-specifications',
    commit,
    committedAt,
    documents,
  };
}

const checkout = await checkoutRequests(resolve(values.checkout));
// npm's deprecation notice for the release the request classes come from.
const registry = JSON.parse(await readFile(resolve(values['checkout-registry']), 'utf8'));
if (registry.name !== CHECKOUT) throw new Error(`--checkout-registry is not ${CHECKOUT}.`);
const deprecated = registry.versions?.[checkout.version]?.deprecated ?? null;
const releases = await Promise.all(values.server.map((root) => serverControllers(resolve(root))));
releases.sort((a, b) => compareVersions(a.version, b.version));
// Controller -> method -> request, with the releases that define the method. A method whose method
// or path changed between releases fails the build, so each entry holds one request.
const controllers = {};
for (const release of releases)
  for (const [controller, methods] of Object.entries(release.controllers))
    for (const [method, request] of Object.entries(methods)) {
      controllers[controller] ??= {};
      const entry = (controllers[controller][method] ??= { ...request, releases: [] });
      if (entry.method !== request.method || entry.path !== request.path)
        throw new Error(`${controller}.${method} changed its request in ${release.version}.`);
      entry.releases.push(release.version);
    }
const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/paypal-requests.mjs',
      checkedAt: values['checked-at'],
      checkout: {
        package: CHECKOUT,
        version: checkout.version,
        deprecated,
        source: `https://registry.npmjs.org/${CHECKOUT.replace('/', '%2F')}`,
        requests: sorted(
          Object.fromEntries(
            Object.entries(checkout.requests).map(([area, requests]) => [area, sorted(requests)]),
          ),
        ),
      },
      server: {
        package: SERVER,
        source: `https://registry.npmjs.org/${SERVER.replace('/', '%2F')}`,
        releases: releases.map((release) => release.version),
        controllers: sorted(
          Object.fromEntries(
            Object.entries(controllers).map(([name, methods]) => [name, sorted(methods)]),
          ),
        ),
      },
      specification: await specifications(resolve(values.specifications)),
    },
    null,
    2,
  )}\n`,
);

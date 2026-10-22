// Builds data/shopify-rest-deprecations.json: REST Admin API endpoints and resource fields that one
// API version has and the next one does not. The facts come from the REST resources Shopify
// generates for every Admin API version and ships in @shopify/shopify-api (`rest/admin/<version>/`):
// each resource class lists its endpoints (`paths`: method, operation, path) and its fields. A
// release ships only the versions it supports, so several releases are read and each version is
// taken from the newest release that has it. Files are read as text from unpacked npm tarballs; no
// SDK code is executed or installed.
//
// `removedIn` is the first version whose resources no longer list the endpoint or field, and
// `lastVersion` the last one that does. This is what Shopify's generated resources say; it is not
// a changelog entry, and Shopify's per-version release notes are cited only where someone read them.
//
// --verification applies what shopify.dev says (scripts/shopify-rest-verify.mjs, run on the list
// generated without it): an endpoint shopify.dev still documents is dropped, an earlier removal
// version shopify.dev states replaces the SDK's, and every endpoint records its shopify.dev status.
//
//   npm pack @shopify/shopify-api@6.2.0 @shopify/shopify-api@12.3.0 @shopify/shopify-api@15.0.1
//   node scripts/shopify-rest-deprecations.mjs --sdk shopify-api-6.2.0/package \
//     --sdk shopify-api-12.3.0/package --sdk shopify-api-15.0.1/package \
//     --verification docs/benchmarks/2026-10-22-shopify-rest-verification.json \
//     --checked-at 2026-10-22 --output data/shopify-rest-deprecations.json
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org';
const VERSION = /^\d{4}-\d{2}$/;
const PATH_ENTRY =
  /\{\s*"http_method":\s*"(\w+)",\s*"operation":\s*"(\w+)",\s*"ids":\s*\[([^\]]*)\],\s*"path":\s*"([^"]+)"\s*\}/g;
const { values } = parseArgs({
  options: {
    sdk: { type: 'string', multiple: true },
    'checked-at': { type: 'string' },
    verification: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.sdk?.length ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/shopify-rest-deprecations.mjs --sdk <unpacked @shopify/shopify-api dir>… --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

// The directory of per-version resources in a release: source (`rest/admin`) in older releases,
// compiled output (`dist/esm/rest/admin` with `dist/ts` declarations) in newer ones.
function resourceDirectories(root) {
  for (const [code, types] of [
    ['dist/esm/rest/admin', 'dist/ts/rest/admin'],
    ['rest/admin', 'rest/admin'],
  ])
    if (existsSync(join(root, code)) && existsSync(join(root, types)))
      return { code: join(root, code), types: join(root, types) };
  throw new Error(`${root} has no REST resources.`);
}

// Fields a declaration file's resource class declares: `title: string | null;` members.
function fields(declaration) {
  const body = /class \w+ extends Base \{([\s\S]*)\n\}/.exec(declaration)?.[1] ?? '';
  return [...body.matchAll(/^ {2,4}(?:public )?([a-z_][a-z0-9_]*): [^();]+;$/gm)].map(
    (match) => match[1],
  );
}

async function readVersion(directories, version) {
  const resources = {};
  const codeFiles = (await readdir(join(directories.code, version))).filter(
    (file) => /\.(?:m?js|ts)$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.map'),
  );
  for (const file of codeFiles) {
    const code = await readFile(join(directories.code, version, file), 'utf8');
    const name = /class (\w+) extends (?:\w+\.)?Base\b/.exec(code)?.[1];
    if (!name) continue;
    const base = file.replace(/\.(?:m?js|ts)$/, '');
    const declarationPath = join(directories.types, version, `${base}.d.ts`);
    const declaration = existsSync(declarationPath)
      ? await readFile(declarationPath, 'utf8')
      : code;
    resources[name] = {
      file: base,
      paths: [...code.matchAll(PATH_ENTRY)].map((match) => ({
        method: match[1].toUpperCase(),
        operation: match[2],
        ids: match[3]
          .split(',')
          .map((id) => id.trim().replace(/"/g, ''))
          .filter(Boolean),
        path: match[4],
      })),
      fields: fields(declaration),
    };
  }
  return resources;
}

const releases = [];
for (const root of values.sdk) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@shopify/shopify-api')
    throw new Error(`${root} is not @shopify/shopify-api.`);
  const directories = resourceDirectories(root);
  const versions = (await readdir(directories.code)).filter((name) => VERSION.test(name)).sort();
  releases.push({ version: manifest.version, root, directories, versions });
}
releases.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
const byVersion = new Map();
for (const release of releases)
  for (const version of release.versions) byVersion.set(version, release);
const versions = [...byVersion.keys()].sort();
const tarball = (release) => `${REGISTRY}/@shopify/shopify-api/-/shopify-api-${release}.tgz`;
const snapshots = new Map();
for (const version of versions) {
  const release = byVersion.get(version);
  snapshots.set(version, {
    release: release.version,
    resources: await readVersion(release.directories, version),
  });
}

// Every endpoint and field, with the versions whose resources list it. One is removed only when
// no later version lists it again: the generated resources occasionally skip a resource for a
// version and restore it in the next, which is not a removal.
const seen = new Map();
const note = (key, version, value) => {
  const entry = seen.get(key) ?? { value, versions: [] };
  entry.versions.push(version);
  seen.set(key, entry);
};
for (const version of versions)
  for (const [resource, entry] of Object.entries(snapshots.get(version).resources)) {
    for (const path of entry.paths)
      note(`endpoint ${resource} ${path.method} ${path.path}`, version, {
        resource,
        method: path.method,
        operation: path.operation,
        path: path.path,
        file: entry.file,
      });
    for (const field of entry.fields)
      note(`field ${resource} ${field}`, version, { resource, field, file: entry.file });
  }
const endpoints = [];
const removedFields = [];
for (const [key, { value, versions: listed }] of seen) {
  const last = listed.at(-1);
  const index = versions.indexOf(last);
  if (index === versions.length - 1) continue;
  const next = versions[index + 1];
  const before = snapshots.get(last);
  const after = snapshots.get(next);
  const following = after.resources[value.resource];
  const compared = `${tarball(after.release)} rest/admin/${next}/${following?.file ?? ''} (compared with ${tarball(before.release)} rest/admin/${last}/${value.file})`;
  if (key.startsWith('endpoint '))
    endpoints.push({
      resource: value.resource,
      method: value.method,
      operation: value.operation,
      path: value.path,
      lastVersion: last,
      removedIn: next,
      resourceRemoved: !versions
        .slice(index + 1)
        .some((version) => snapshots.get(version).resources[value.resource]),
      source: compared,
    });
  // A field of a resource that is itself gone is covered by its endpoints.
  else if (following)
    removedFields.push({
      resource: value.resource,
      field: value.field,
      lastVersion: last,
      removedIn: next,
      source: compared,
    });
}
if (values.verification) {
  const verified = new Map(
    JSON.parse(await readFile(values.verification, 'utf8')).endpoints.map((item) => [
      `${item.resource} ${item.method} ${item.path}`,
      item,
    ]),
  );
  for (const endpoint of endpoints.splice(0)) {
    const item = verified.get(`${endpoint.resource} ${endpoint.method} ${endpoint.path}`);
    if (!item) throw new Error(`${endpoint.method} ${endpoint.path} is not in the verification.`);
    if (item.status === 'contradicted') continue;
    if (item.status === 'confirmed-earlier') {
      endpoint.sdkRemovedIn = endpoint.removedIn;
      endpoint.removedIn = item.removedIn;
      endpoint.lastVersion = versions[versions.indexOf(item.removedIn) - 1];
    }
    endpoint.shopifyDev = { status: item.status, source: item.source, checkedAt: item.checkedAt };
    endpoints.push(endpoint);
  }
}
const order = (a, b) =>
  a.removedIn.localeCompare(b.removedIn) ||
  a.resource.localeCompare(b.resource) ||
  (a.path ?? a.field).localeCompare(b.path ?? b.field) ||
  (a.method ?? '').localeCompare(b.method ?? '');
endpoints.sort(order);
removedFields.sort(order);

// Each resource class's operations across all versions, so a call can be matched to its endpoint
// by class and operation (`Product.all` is `GET products.json`).
const resources = {};
for (const version of versions)
  for (const [name, entry] of Object.entries(snapshots.get(version).resources)) {
    const operations = new Set(resources[name] ?? []);
    for (const path of entry.paths) operations.add(`${path.operation} ${path.method} ${path.path}`);
    resources[name] = [...operations].sort();
  }
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/shopify-rest-deprecations.mjs',
      checkedAt: values['checked-at'],
      versions: Object.fromEntries(
        versions.map((version) => [version, snapshots.get(version).release]),
      ),
      endpoints,
      fields: removedFields,
      resources: Object.fromEntries(
        Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    null,
    2,
  )}\n`,
);
console.error(
  `${versions.length} versions (${versions[0]}..${versions.at(-1)}); ${endpoints.length} endpoint removals; ${removedFields.length} field removals`,
);

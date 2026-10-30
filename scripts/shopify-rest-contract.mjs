// Builds data/shopify-rest-contract.json: the REST Admin API contract of every version Shopify's
// generated REST resources cover, for pipeline/shopify-rest-contract.ts to prove REST calls across
// a version move. For each resource and version: its endpoints (method, operation, path), the
// query or body parameters each endpoint's SDK method sends, and every field with its declared type.
//
// Sources, both read as text and never executed or installed:
// - @shopify/shopify-api tarballs from the npm registry, checked against the registry's SHA-512
//   integrity. Each release ships the resources Shopify generates for the versions it supports
//   (`dist/esm/rest/admin/<version>/*.mjs` with `dist/ts` declarations); each version is taken from
//   the newest release that has it.
// - No release ships a version after the newest one below. A later version is added from
//   shopify.dev's REST reference (`/docs/api/admin-rest/<version>/resources/<page>.md`): a resource
//   is carried forward only when its page's Endpoints, Properties and Parameters sections are
//   identical to the previous version's, once the version in links is masked. A resource whose page
//   differs or is missing is left out of that version, so calls to it stay unproven.
//
//   node scripts/shopify-rest-contract.mjs [--output data/shopify-rest-contract.json]
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import ts from 'typescript-compiler';
import { contractDigest, referenceSections } from '../pipeline/shopify-rest-contract.ts';

const execute = promisify(execFile);
const PACKAGE = '@shopify/shopify-api';
// 12.3.0 is the newest release with 2022-10 to 2024-07; 15.0.1 (the newest on 2026-10-29) has
// 2024-10 to 2026-07.
const RELEASES = ['12.3.0', '15.0.1'];
// Versions shopify.dev documents after the newest SDK version, read on GENERATED_AT.
const DOCS_VERSIONS = ['2026-10'];
const GENERATED_AT = '2026-10-29';
const DOCS = 'https://shopify.dev/docs/api/admin-rest/{version}/resources/{page}.md';
// shopify.dev page names that are not the resource file name without underscores.
const PAGES = {
  abandoned_checkout: 'abandoned-checkouts',
  deprecated_api_call: 'deprecated-api-calls',
  dispute_evidence: 'dispute-evidence',
  dispute_file_upload: 'dispute-file-upload',
  gift_card: 'gift-card',
  gift_card_adjustment: 'gift-card-adjustment',
  image: 'product-image',
  payment_transaction: 'transactions',
  payout: 'payouts',
  product_resource_feedback: 'product-resourcefeedback',
  variant: 'product-variant',
};

const { values } = parseArgs({
  options: {
    output: { type: 'string', default: 'data/shopify-rest-contract.json' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log('Usage: node scripts/shopify-rest-contract.mjs [--output <file.json>]');
  process.exit(0);
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response;
}

async function unpack(version, directory) {
  const registry = await (
    await fetchOk(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`)
  ).json();
  const dist = registry.versions?.[version]?.dist;
  if (!dist?.tarball || !dist.integrity?.startsWith('sha512-'))
    throw new Error(`${PACKAGE}@${version} has no tarball with a SHA-512 integrity.`);
  const tarball = Buffer.from(await (await fetchOk(dist.tarball)).arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (integrity !== dist.integrity)
    throw new Error(
      `${dist.tarball} has integrity ${integrity}, the registry says ${dist.integrity}.`,
    );
  const target = join(directory, version);
  await execute('mkdir', ['-p', target]);
  await writeFile(join(target, 'package.tgz'), tarball);
  await execute('tar', ['xzf', 'package.tgz', '--no-same-owner'], { cwd: target });
  const root = join(target, 'package');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE || manifest.version !== version)
    throw new Error(
      `The tarball is ${manifest.name}@${manifest.version}, not ${PACKAGE}@${version}.`,
    );
  return { release: version, tarball: dist.tarball, integrity, root };
}

const text = (node) => node.getText().replace(/\s+/g, '').replace(/;\}/g, '}');
const isStatic = (member) =>
  member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
const keys = (object) =>
  object && ts.isObjectLiteralExpression(object)
    ? object.properties
        .filter((entry) => !ts.isSpreadAssignment(entry))
        .map((entry) => (ts.isStringLiteral(entry.name) ? entry.name.text : entry.name.getText()))
    : [];
const property = (object, name) =>
  object.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      (ts.isStringLiteral(entry.name) ? entry.name.text : entry.name.getText()) === name,
  )?.initializer;

// One resource class from its compiled module and its declaration file.
function readResource(code, declaration, file) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = source.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name,
  );
  if (!node) return undefined;
  const staticValue = (name) => {
    const member = node.members.find(
      (item) => isStatic(item) && ts.isPropertyDeclaration(item) && item.name.getText() === name,
    );
    return member?.initializer && JSON.parse(member.initializer.getText());
  };
  const paths = staticValue('paths') ?? [];
  const names = staticValue('resourceNames')?.[0] ?? {};
  // Each static method's request: method, operation, the URL ids it can fill and its parameters.
  const requests = [];
  for (const member of node.members) {
    if (!isStatic(member) || !ts.isMethodDeclaration(member) || !member.body) continue;
    const visit = (child) => {
      if (
        ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        child.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ['baseFind', 'request'].includes(child.expression.name.text) &&
        child.arguments[0] &&
        ts.isObjectLiteralExpression(child.arguments[0])
      ) {
        const options = child.arguments[0];
        const literal = (name, fallback) => {
          const value = property(options, name);
          return value && ts.isStringLiteral(value) ? value.text : fallback;
        };
        requests.push({
          method: literal('http_method', 'get'),
          operation: literal('operation', 'get'),
          ids: keys(property(options, 'urlIds')),
          params: [...keys(property(options, 'params')), ...keys(property(options, 'body'))],
        });
      }
      ts.forEachChild(child, visit);
    };
    visit(member.body);
  }
  const types = ts.createSourceFile(`${file}.d.ts`, declaration, ts.ScriptTarget.Latest, true);
  const declared = types.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === node.name.text,
  );
  const fields = {};
  for (const member of declared?.members ?? [])
    if (
      ts.isPropertyDeclaration(member) &&
      !isStatic(member) &&
      member.type &&
      /^[a-z_][a-z0-9_]*$/.test(member.name.getText())
    )
      fields[member.name.getText()] = text(member.type);
  return {
    name: node.name.text,
    contract: {
      ...(names.singular ? { singular: names.singular, plural: names.plural } : {}),
      endpoints: paths
        .map((path) => ({
          method: path.http_method.toUpperCase(),
          operation: path.operation,
          path: path.path,
          params: [
            ...new Set(
              requests
                .filter(
                  (request) =>
                    request.method === path.http_method &&
                    request.operation === path.operation &&
                    path.ids.every((id) => request.ids.includes(id)),
                )
                .flatMap((request) => request.params),
            ),
          ].sort(),
        }))
        .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
      fields,
    },
  };
}

async function readVersion(root, version) {
  const code = join(root, 'dist', 'esm', 'rest', 'admin', version);
  const declarations = join(root, 'dist', 'ts', 'rest', 'admin', version);
  const resources = {};
  for (const file of (await readdir(code)).filter((name) => name.endsWith('.mjs')).sort()) {
    const base = file.replace(/\.mjs$/, '');
    const declaration = join(declarations, `${base}.d.ts`);
    if (!existsSync(declaration)) continue;
    const resource = readResource(
      await readFile(join(code, file), 'utf8'),
      await readFile(declaration, 'utf8'),
      file,
    );
    if (resource) resources[resource.name] = { file: base, ...resource.contract };
  }
  return resources;
}

const directory = await mkdtemp(join(tmpdir(), 'refit-shopify-rest-'));
try {
  const snapshots = new Map();
  const sdk = [];
  for (const release of RELEASES) {
    const unpacked = await unpack(release, directory);
    const versions = (await readdir(join(unpacked.root, 'dist', 'esm', 'rest', 'admin')))
      .filter((name) => /^\d{4}-\d{2}$/.test(name))
      .sort();
    for (const version of versions)
      snapshots.set(version, {
        source: `${PACKAGE}@${release}`,
        resources: await readVersion(unpacked.root, version),
      });
    sdk.push({
      package: PACKAGE,
      release,
      tarball: unpacked.tarball,
      integrity: unpacked.integrity,
    });
  }
  for (const source of sdk)
    source.versions = [...snapshots.keys()]
      .filter((version) => snapshots.get(version).source === `${PACKAGE}@${source.release}`)
      .sort();
  // shopify.dev carries a resource into a later version only when its reference is unchanged.
  const docs = [];
  for (const version of DOCS_VERSIONS) {
    const from = [...snapshots.keys()].sort().at(-1);
    const previous = snapshots.get(from);
    const resources = {};
    const pages = {};
    for (const [name, resource] of Object.entries(previous.resources)) {
      const page = PAGES[resource.file] ?? resource.file.replace(/_/g, '');
      const read = async (at) => {
        const response = await fetch(DOCS.replace('{version}', at).replace('{page}', page));
        const body = response.ok ? await response.text() : '';
        return referenceSections(body, at);
      };
      const [before, after] = [await read(from), await read(version)];
      const entry = {
        page,
        [from]: before === null ? null : contractDigest(before),
        [version]: after === null ? null : contractDigest(after),
      };
      pages[name] = entry;
      if (before !== null && before === after) resources[name] = resource;
    }
    snapshots.set(version, {
      source: `shopify.dev ${version} reference, unchanged from ${from}`,
      resources,
    });
    docs.push({ version, from, url: DOCS, fetchedAt: GENERATED_AT, pages });
  }

  // Each resource's distinct contracts, with the versions that have each.
  const resources = {};
  for (const [version, snapshot] of [...snapshots].sort(([a], [b]) => a.localeCompare(b)))
    for (const [name, { file, ...contract }] of Object.entries(snapshot.resources)) {
      const list = (resources[name] ??= []);
      const same = list.find(
        (entry) => JSON.stringify(entry.contract) === JSON.stringify(contract),
      );
      if (same) same.versions.push(version);
      else list.push({ versions: [version], contract });
    }
  const body = {
    versions: Object.fromEntries(
      [...snapshots]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([version, { source }]) => [version, source]),
    ),
    resources: Object.fromEntries(
      Object.entries(resources)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, list]) => [
          name,
          list.map(({ versions, contract }) => ({ versions, ...contract })),
        ]),
    ),
  };
  const output = {
    formatVersion: 1,
    generatedBy: 'scripts/shopify-rest-contract.mjs',
    generatedAt: GENERATED_AT,
    sources: { sdk, docs },
    sha256: contractDigest(JSON.stringify(body)),
    ...body,
  };
  await writeFile(values.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `${values.output}: ${Object.keys(body.versions).length} versions, ${Object.keys(body.resources).length} resources`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

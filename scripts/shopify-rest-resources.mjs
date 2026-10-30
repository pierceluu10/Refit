// Builds data/shopify-rest-resources.json: the REST Admin resource classes of one pinned
// @shopify/shopify-api release, with each class's JSON envelope keys, its static paths and every
// declared instance field with its TypeScript type. The tarball is downloaded from the npm registry,
// checked against the registry's SHA-512 integrity, unpacked into a fresh temporary directory and
// read as text with the TypeScript compiler API; nothing in it is installed or executed.
//
//   node scripts/shopify-rest-resources.mjs [--output data/shopify-rest-resources.json]
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import ts from 'typescript-compiler';

const execute = promisify(execFile);
const PACKAGE = '@shopify/shopify-api';
// The newest release on 2026-10-29; 15.0.1 still ships the REST resource classes.
const VERSION = '15.0.1';
const GENERATED_AT = '2026-10-29';

const { values } = parseArgs({
  options: {
    output: { type: 'string', default: 'data/shopify-rest-resources.json' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log('Usage: node scripts/shopify-rest-resources.mjs [--output <file.json>]');
  process.exit(0);
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response;
}

const registry = await (
  await fetchOk(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`)
).json();
const dist = registry.versions?.[VERSION]?.dist;
if (!dist?.tarball || !dist.integrity?.startsWith('sha512-'))
  throw new Error(`${PACKAGE}@${VERSION} has no tarball with a SHA-512 integrity in the registry.`);
const tarball = Buffer.from(await (await fetchOk(dist.tarball)).arrayBuffer());
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
if (integrity !== dist.integrity)
  throw new Error(
    `${dist.tarball} has integrity ${integrity}, the registry says ${dist.integrity}.`,
  );

const directory = await mkdtemp(join(tmpdir(), 'refit-shopify-api-'));
try {
  await writeFile(join(directory, 'package.tgz'), tarball);
  await execute('tar', ['xzf', 'package.tgz', '--no-same-owner'], { cwd: directory });
  const root = join(directory, 'package');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE || manifest.version !== VERSION)
    throw new Error(
      `The tarball is ${manifest.name}@${manifest.version}, not ${PACKAGE}@${VERSION}.`,
    );

  const versions = (await readdir(join(root, 'rest', 'admin')))
    .filter((name) => /^\d{4}-\d{2}$/.test(name))
    .sort();
  const restVersion = versions.at(-1);
  if (!restVersion) throw new Error(`${PACKAGE}@${VERSION} ships no rest/admin/<version> sources.`);

  const resources = {};
  const folder = join(root, 'rest', 'admin', restVersion);
  for (const file of (await readdir(folder)).filter((name) => name.endsWith('.ts')).sort()) {
    const text = await readFile(join(folder, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const isStatic = (member) =>
        member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      const staticValue = (name) => {
        const member = node.members.find(
          (item) =>
            ts.isPropertyDeclaration(item) && isStatic(item) && item.name.getText(source) === name,
        );
        // The generated initializers are JSON literals, so they are parsed, never evaluated.
        return member?.initializer ? JSON.parse(member.initializer.getText(source)) : undefined;
      };
      const names = staticValue('resourceNames');
      const paths = staticValue('paths');
      if (!names?.length || !Array.isArray(paths))
        throw new Error(`${file}: ${node.name.text} has no resourceNames or paths.`);
      const fields = {};
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || isStatic(member)) continue;
        if (!member.type)
          throw new Error(`${file}: ${node.name.text}.${member.name.getText(source)} has no type.`);
        fields[member.name.getText(source)] = member.type.getText(source).replace(/\s+/g, ' ');
      }
      resources[node.name.text] = {
        plural: names[0].plural,
        singular: names[0].singular,
        // A few classes answer under more than one envelope (FulfillmentRequest); all are listed.
        ...(names.length > 1 ? { names } : {}),
        paths: paths.map((path) => ({
          operation: path.operation,
          method: path.http_method,
          path: path.path,
          ids: path.ids,
        })),
        fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
      };
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)),
  );
  const output = {
    formatVersion: 1,
    package: PACKAGE,
    version: VERSION,
    integrity: dist.integrity,
    tarball: dist.tarball,
    restVersion,
    generatedAt: GENERATED_AT,
    generatedBy: 'scripts/shopify-rest-resources.mjs',
    resources: sorted,
  };
  await writeFile(resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `${Object.keys(sorted).length} resources, REST Admin ${restVersion}, ${PACKAGE}@${VERSION}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

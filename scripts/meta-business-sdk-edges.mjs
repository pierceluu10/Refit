// Builds data/meta-business-sdk-edges.json from an unpacked facebook-nodejs-business-sdk package:
// which resource classes the SDK exports and which Graph API edge each generated method calls.
// The SDK's source files are read as text and never executed or installed.
//
//   npm pack facebook-nodejs-business-sdk@24.0.1 --ignore-scripts && tar xzf facebook-nodejs-business-sdk-24.0.1.tgz
//   node scripts/meta-business-sdk-edges.mjs --package <dir>/package --output data/meta-business-sdk-edges.json
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HTTP = { getEdge: 'GET', createEdge: 'POST', deleteEdge: 'DELETE' };
const { values } = parseArgs({
  options: { package: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help || !values.package || !values.output) {
  console.log(
    'Usage: node scripts/meta-business-sdk-edges.mjs --package <unpacked package dir> --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.package);
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (metadata.name !== 'facebook-nodejs-business-sdk')
  throw new Error(`${root} is not facebook-nodejs-business-sdk.`);
const bundle = await readFile(join(root, 'src', 'bundle.es6'), 'utf8');
// Resource classes are the bundle's exports from src/objects/<name> (not serverside helpers).
const exported = new Map(
  [
    ...bundle.matchAll(/export \{ default as (\w+) \} from '\.\/\.\.\/src\/objects\/([\w-]+)'/g),
  ].map((match) => [match[2], match[1]]),
);
const api = await readFile(join(root, 'src', 'api.js'), 'utf8');
const graphVersion = /static get VERSION\(\)[^{]*\{\s*return '(v\d+\.\d+)'/.exec(api)?.[1];
if (!graphVersion) throw new Error('FacebookAdsApi.VERSION was not found.');

const classes = [];
// method name -> class -> { http, edge }
const methods = new Map();
for (const name of (await readdir(join(root, 'src', 'objects'))).sort()) {
  const stem = name.replace(/\.js$/, '');
  if (!name.endsWith('.js') || !exported.has(stem)) continue;
  const content = await readFile(join(root, 'src', 'objects', name), 'utf8');
  const className = /export default class (\w+) extends AbstractCrudObject/.exec(content)?.[1];
  if (!className) continue;
  classes.push(className);
  for (const match of content.matchAll(
    /\n {2}(\w+) \([^)]*\)[^{]*\{\s*return this\.(getEdge|createEdge|deleteEdge)\(([^;]*?)\);/gs,
  )) {
    const [, method, kind, args] = match;
    const path = /'\/([\w/]+)'/.exec(args)?.[1];
    if (!path) throw new Error(`${className}.${method} has no literal edge path.`);
    const byClass = methods.get(method) ?? new Map();
    methods.set(method, byClass);
    byClass.set(className, { http: HTTP[kind], edge: path });
  }
}

// One entry per method name. A name every class maps to the same edge has `edge`; a name whose
// edge differs by class lists each class under `byClass`.
const entries = {};
for (const method of [...methods.keys()].sort()) {
  const byClass = methods.get(method);
  const distinct = new Set([...byClass.values()].map((item) => `${item.http} ${item.edge}`));
  const [first] = byClass.values();
  entries[method] =
    distinct.size === 1
      ? { http: first.http, edge: first.edge }
      : {
          http:
            distinct.size && new Set([...byClass.values()].map((item) => item.http)).size === 1
              ? first.http
              : null,
          edge: null,
          byClass: Object.fromEntries(
            [...byClass.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([className, item]) => [className, item.edge]),
          ),
        };
}
// One method per line keeps the file reviewable in a diff when the SDK is regenerated.
const header = {
  formatVersion: 1,
  package: metadata.name,
  version: metadata.version,
  graphVersion,
  generatedBy: 'scripts/meta-business-sdk-edges.mjs',
};
const lines = Object.entries(entries).map(
  ([method, entry]) => `  ${JSON.stringify(method)}: ${JSON.stringify(entry)}`,
);
await writeFile(
  resolve(values.output),
  `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "classes": ${JSON.stringify(classes)},\n  "methods": {\n${lines.join(',\n')}\n  }\n}\n`,
);
console.log(
  `${classes.length} classes, ${Object.keys(entries).length} methods (${Object.values(entries).filter((entry) => entry.byClass).length} differ by class), Graph ${graphVersion}`,
);

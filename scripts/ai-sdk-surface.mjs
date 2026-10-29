#!/usr/bin/env node
// Lists the client methods of an installed AI SDK release, for data/sdk-surfaces/: a client is built
// with a placeholder key (no request is sent) and its resource objects are walked, so an upgrade
// can check that every call it keeps or writes exists in the release it moves to.
//
// Usage: node scripts/ai-sdk-surface.mjs --directory <dir with node_modules> --package <name> --output <file>
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    directory: { type: 'string' },
    package: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.directory || !values.package || !values.output)
  throw new Error('Usage: --directory <dir> --package <name> --output <file>');
const CLIENTS = {
  openai: 'OpenAI',
  '@anthropic-ai/sdk': 'Anthropic',
  '@google/genai': 'GoogleGenAI',
};
const require = createRequire(join(values.directory, 'package.json'));
const entry = require.resolve(values.package);
// package.json is outside the packages' exports; read it from the install directory.
const manifest = JSON.parse(
  await readFile(join(values.directory, 'node_modules', values.package, 'package.json'), 'utf8'),
);
const module = await import(pathToFileURL(entry).href);
const Client = module[CLIENTS[values.package]] ?? module.default;
const client = new Client({ apiKey: 'placeholder-key-no-request-is-sent' });
const methods = new Set();
const seen = new Set();
function walk(object, path, depth) {
  if (!object || typeof object !== 'object' || seen.has(object) || depth > 5) return;
  seen.add(object);
  const names = new Set();
  for (
    let proto = object;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  for (const name of names) {
    if (name === 'constructor' || name.startsWith('_') || name.startsWith('#')) continue;
    let value;
    try {
      value = object[name];
    } catch {
      continue;
    }
    if (typeof value === 'function' && path) methods.add(`${path}.${name}`);
    else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      /^[a-z][A-Za-z]*$/.test(name)
    )
      walk(value, path ? `${path}.${name}` : name, depth + 1);
  }
}
walk(client, '', 0);
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      package: values.package,
      version: manifest.version,
      generatedBy: 'scripts/ai-sdk-surface.mjs',
      methods: [...methods].sort(),
    },
    null,
    2,
  )}\n`,
);
console.log(`${values.package} ${manifest.version}: ${methods.size} methods`);

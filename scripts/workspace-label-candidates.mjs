// Prints what a person reads to label a monorepo blind for docs/WORKSPACE-ATTRIBUTION.md: the
// root's workspace configuration, every package manifest with its name, and every file that
// declares a catalog provider SDK or names a provider host, a model ID or an API version. It
// imports no pipeline code and reads no Refit output.
//
//   node scripts/workspace-label-candidates.mjs --root <checkout>
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = values.root;
const SKIP = new Set(['.git', 'node_modules']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SDK =
  /"(stripe|openai|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai|@shopify\/[\w-]+|shopify-api-node|facebook-nodejs-business-sdk|twilio|@sendgrid\/[\w-]+|resend|@paypal\/[\w-]+)"\s*:/;
const EVIDENCE =
  /api\.stripe\.com|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|myshopify\.com\/admin\/api|graph\.facebook\.com|api\.twilio\.com|api\.sendgrid\.com|api\.resend\.com|api-m\.(?:sandbox\.)?paypal\.com|['"`](?:gpt-[\w.-]+|o[134](?:-[\w.-]+)?|claude-[\w.-]+|gemini-[\w.-]+|text-embedding-[\w.-]+)['"`]|apiVersion\s*[:=]/;

const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) await visit(path);
    } else if (entry.isFile()) files.push(relative(root, path));
  }
}
await visit(root);
files.sort();
const read = (file) => readFile(join(root, file), 'utf8').catch(() => '');
const rootManifest = await read('package.json');
console.log(
  `workspaces: ${(/"workspaces"\s*:\s*(\[[^\]]*\]|\{[^}]*\})/.exec(rootManifest) ?? [])[1] ?? '-'}`,
);
for (const config of ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'])
  if (files.includes(config))
    console.log(`${config}: ${(await read(config)).slice(0, 200).replace(/\n/g, ' ')}`);
console.log('manifests:');
for (const file of files.filter((item) => /(^|\/)(package|project)\.json$/.test(item)))
  console.log(
    `  ${file}  ${(/"name"\s*:\s*"([^"]+)"/.exec(await read(file)) ?? [])[1] ?? '(no name)'}`,
  );
console.log('candidates:');
for (const file of files) {
  const isManifest = file.endsWith('package.json');
  if (!isManifest && !SOURCE.test(file)) continue;
  const lines = (await read(file)).split('\n');
  const hits = lines
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => (isManifest ? SDK : EVIDENCE).test(line));
  if (hits.length) console.log(`  ${file}  (${hits.length}) ${hits[0][1].trim().slice(0, 90)}`);
}

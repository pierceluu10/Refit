// Reads openai's published JS for each method of the v5 guide's named-path list: the path
// parameters it now takes by name, in the URL's order, and whether its params object also carries
// a body or query. Writes the `methods` of the openai-node-v5-named-path-rewrite rule.
// Usage: node scripts/openai-named-path-params.mjs <node_modules/openai> docs/ai-docs/pages/openai-node-v5-migration.md
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [root, guide] = process.argv.slice(2);
const listed = [...readFileSync(guide, 'utf8').matchAll(/^- `client\.([\w.]+)\(\)`$/gm)].map(
  (m) => m[1],
);
const named = listed.slice(0, listed.indexOf('skills.versions.content.retrieve') + 1);
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const out = {};
const missing = [];
for (const path of named) {
  const parts = path.split('.');
  const method = parts.pop();
  const segs = parts.map(kebab);
  const candidates = [
    join(root, 'resources', ...segs) + '.js',
    join(root, 'resources', ...segs, segs.at(-1)) + '.js',
  ];
  const pattern = new RegExp(
    `^    ${method}\\((\\w+), params(?: = \\{\\})?, options\\) \\{\\n([\\s\\S]*?)\\n    \\}`,
    'm',
  );
  const def = candidates
    .filter(existsSync)
    .map((file) => pattern.exec(readFileSync(file, 'utf8')))
    .find(Boolean);
  if (!def) {
    missing.push(`${path}: no method in ${candidates.filter(existsSync).join(' ')}`);
    continue;
  }
  const [, id, body] = def;
  const names = /const \{ ([\w, .]+) \} = params/.exec(body)?.[1].split(', ') ?? [];
  const destructured = names.filter((n) => !n.startsWith('...'));
  // `...body` or `...query`: the method still takes a body or query, which v4 took after the ids.
  const rest = names.some((n) => n.startsWith('...'));
  const url = /path_1\.path\) `([^`]+)`/.exec(body)?.[1] ?? '';
  const order = [...url.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  const parents = order.filter((name) => destructured.includes(name));
  if (order.at(-1) !== id || parents.length !== order.length - 1) {
    missing.push(`${path}: url ${url}`);
    continue;
  }
  out[path] = { parents, body: rest };
}
console.log(JSON.stringify({ methods: out, missing }, null, 1));

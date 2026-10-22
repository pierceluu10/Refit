// Independent candidate search for the Shopify REST deprecation label pass. It imports no pipeline
// code and uses no Refit output, so labels made from its candidates are blind to what
// `refit shopify-rest` reports. In live source files (tests, examples, fixtures and build output
// left out) it lists every line that looks like REST Admin usage:
// - `rest`: a `/admin/api/` URL, a REST client (`admin.rest`, `clients.Rest`,
//   `createAdminRestApiClient`) or a REST resource class (`rest.Product`, `resources.Product`);
// - `removed`: in a file with REST usage, a line naming a resource or path segment that
//   data/shopify-rest-deprecations.json lists as removed (`CustomerAddress`, `addresses`, …), which
//   catches a path written on another line than its call.
// A labeller decides, for each, whether the line sends a REST Admin request to an endpoint in that
// list. The list says which endpoints were removed; the labeller reads which endpoint the code calls.
//
//   node scripts/shopify-rest-label-candidates.mjs --list <frozen.json> --root <dir> --repos a/b,c/d \
//     --output <candidates.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';

const execute = promisify(execFile);
const CONTEXT = 4;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.refit)\/|\.d\.[cm]?ts$|\.min\.js$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
const REST =
  /\/admin\/api\/|\badmin\.rest\b|\bclients\.Rest\b|createAdminRestApiClient|\b(?:rest|resources)\.[A-Z]\w+/;

const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    repos: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.list || !values.root || !values.output) {
  console.log(
    'Usage: node scripts/shopify-rest-label-candidates.mjs --list <frozen.json> --root <dir> [--repos a/b,c/d] --output <candidates.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const data = JSON.parse(
  await readFile(new URL('../data/shopify-rest-deprecations.json', import.meta.url), 'utf8'),
);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Resource class names and the path segments that tell removed endpoints apart.
const words = new Set([
  ...data.endpoints.map((item) => item.resource),
  ...data.endpoints.flatMap((item) =>
    item.path
      .replace(/\.json$/, '')
      .split('/')
      .filter(
        (segment) =>
          !segment.startsWith('<') &&
          !['orders', 'customers', 'checkouts', 'count'].includes(segment),
      ),
  ),
]);
const REMOVED = new RegExp(`\\b(?:${[...words].map(escape).join('|')})\\b`);
const list = JSON.parse(await readFile(values.list, 'utf8'));
const wanted = values.repos ? new Set(values.repos.split(',')) : undefined;
const candidates = [];
const repos = [];
for (const entry of list.repos) {
  if (wanted && !wanted.has(entry.repo)) continue;
  const directory = await shallowCheckout(values.root, entry.repo, entry.commit);
  const { stdout } = await execute('git', ['-C', directory, 'ls-files'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const counts = { rest: 0, removed: 0 };
  for (const file of stdout.split('\n')) {
    if (!SOURCE.test(file) || SKIPPED.test(file) || TEST_PATH.test(file)) continue;
    let content;
    try {
      content = await readFile(join(directory, file), 'utf8');
    } catch {
      continue;
    }
    // Only files with REST usage: a removed resource's name in a GraphQL-only file is not a call.
    if (!REST.test(content)) continue;
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      const why = [
        ...(REST.test(line) ? ['rest'] : []),
        ...(REMOVED.test(line) ? ['removed'] : []),
      ];
      if (!why.length) continue;
      for (const kind of why) counts[kind] += 1;
      candidates.push({
        repo: entry.repo,
        file,
        line: index + 1,
        why,
        context: lines
          .slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1)
          .map(
            (text, offset) => `${Math.max(0, index - CONTEXT) + offset + 1}: ${text.slice(0, 200)}`,
          )
          .join('\n'),
      });
    }
  }
  repos.push({ repo: entry.repo, commit: entry.commit, candidates: counts });
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, list: values.list, repos, candidates }, null, 2)}\n`,
);
console.error(`${candidates.length} candidates in ${repos.length} repositories`);

// Independent candidate search for the cloud SDK label pass. It imports no pipeline code and uses no
// Refit output, so labels made from its candidates are blind to what `refit cloud-sdk` reports.
// In live source files (tests, examples, fixtures, generated and vendored paths left out) it lists:
// - every `new X(…)` in a file that names `aws-sdk` (v2 or `@aws-sdk/…` v3), except JavaScript
//   built-ins (`new Date()`, `new Error()`, …) and v3 `…Command` objects, which are never clients;
// - every `new AWS.…` anywhere, in case a file reaches the namespace without naming the package;
// - every line that quotes a legacy Azure package from data/azure-sdk-retirements.json.
// A labeller then decides, from the code around each candidate, whether it constructs an AWS SDK
// client (and which SDK version and service) or loads a legacy Azure package. Clients built in a
// file that names neither the package nor `AWS.` are outside this net, and so outside the labels.
//
//   node scripts/cloud-sdk-label-candidates.mjs --list <frozen.json> --root <dir> --repos a/b,c/d \
//     --output <candidates.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';

const execute = promisify(execFile);
const CONTEXT = 4;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// The directories `refit` itself never reads, plus declaration and minified files.
const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.refit)\/|\.d\.[cm]?ts$|\.min\.js$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;
const BUILT_INS = new Set([
  'Date',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Array',
  'Object',
  'RegExp',
  'URL',
  'URLSearchParams',
  'Buffer',
  'Proxy',
  'Function',
  'Uint8Array',
  'ArrayBuffer',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'Headers',
  'Request',
  'Response',
  'FormData',
  'Blob',
  'Event',
  'EventEmitter',
  'Intl.DateTimeFormat',
  'Intl.NumberFormat',
]);
const NEW = /\bnew\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

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
    'Usage: node scripts/cloud-sdk-label-candidates.mjs --list <frozen.json> --root <dir> [--repos a/b,c/d] --output <candidates.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const azure = JSON.parse(
  await readFile(new URL('../data/azure-sdk-retirements.json', import.meta.url), 'utf8'),
).packages.map((item) => item.name);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const AZURE_LOAD = new RegExp(`(['"\`])(?:${azure.map(escape).join('|')})(?:/[^'"\`]*)?\\1`);
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
  let count = 0;
  for (const file of stdout.split('\n')) {
    if (!SOURCE.test(file) || SKIPPED.test(file) || TEST_PATH.test(file)) continue;
    let content;
    try {
      content = await readFile(join(directory, file), 'utf8');
    } catch {
      continue;
    }
    const aws = content.includes('aws-sdk');
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      const constructed = [...line.matchAll(NEW)]
        .map((match) => match[1])
        .filter(
          (name) =>
            !BUILT_INS.has(name) && !name.endsWith('Command') && (aws || name.startsWith('AWS.')),
        );
      const loads = AZURE_LOAD.test(line);
      if (!constructed.length && !loads) continue;
      count += 1;
      candidates.push({
        repo: entry.repo,
        file,
        line: index + 1,
        why: [...(constructed.length ? ['new'] : []), ...(loads ? ['azure-load'] : [])],
        constructed,
        context: lines
          .slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1)
          .map(
            (text, offset) => `${Math.max(0, index - CONTEXT) + offset + 1}: ${text.slice(0, 200)}`,
          )
          .join('\n'),
      });
    }
  }
  repos.push({ repo: entry.repo, commit: entry.commit, group: entry.group, candidates: count });
  console.error(`${entry.repo}: ${count} candidates`);
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, list: values.list, repos, candidates }, null, 2)}\n`,
);
console.error(`${candidates.length} candidates in ${repos.length} repositories`);

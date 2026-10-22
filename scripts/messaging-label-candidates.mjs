// Independent candidate search for the messaging label pass. It imports no pipeline code and uses no
// Refit output, so labels made from its candidates are blind to what `refit messaging` reports. For
// each repository it writes three kinds of candidate:
// - `provider`: every live source line that loads a messaging SDK package or names a provider's API
//   host, grouped by provider, so a labeller can decide whether the repository uses that provider;
// - `call`: every live source line whose text has a member chain the SDK declarations mark
//   deprecated (`.verify.services`, `.domains.getTracking`; from data/messaging-deprecations.json,
//   matched as text with any spacing) or a removed endpoint from data/messaging-endpoints.json;
// - `version`: each package.json that declares `twilio`, with the declared range and any version
//   package-lock.json records, so a labeller can decide whether it is below 6.0.0.
// Tests, examples, fixtures, node_modules, dist, build, coverage, .next, .d.ts and .min.js are out
// of scope. Nothing in a checkout is installed or run.
//
//   node scripts/messaging-label-candidates.mjs --list <frozen.json> --root <dir> --repos a/b,c/d \
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
const PROVIDERS = {
  twilio: { packages: ['twilio'], host: /[\w-]+\.twilio\.com/ },
  sendgrid: {
    packages: ['@sendgrid/mail', '@sendgrid/client', 'sendgrid'],
    host: /api(?:\.eu)?\.sendgrid\.com/,
  },
  resend: { packages: ['resend'], host: /api\.resend\.com/ },
  postmark: { packages: ['postmark'], host: /api\.postmarkapp\.com/ },
  mailgun: { packages: ['mailgun.js', 'mailgun-js'], host: /api(?:\.eu)?\.mailgun\.net/ },
};

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
    'Usage: node scripts/messaging-label-candidates.mjs --list <frozen.json> --root <dir> [--repos a/b,c/d] --output <candidates.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const deprecations = JSON.parse(
  await readFile(new URL('../data/messaging-deprecations.json', import.meta.url), 'utf8'),
);
const members = Object.values(deprecations.sdks).flatMap((sdk) => sdk.members.map((m) => m.path));
const MEMBER = new RegExp(
  `\\.\\s*(?:${members.map((path) => path.split('.').map(escape).join('\\s*\\.\\s*')).join('|')})\\b`,
);
const endpoints = JSON.parse(
  await readFile(new URL('../data/messaging-endpoints.json', import.meta.url), 'utf8'),
).endpoints.map((item) => `${item.host}${item.path}`);
const loads = (line, name) =>
  new RegExp(
    `(?:from\\s*|require\\s*\\(\\s*|import\\s*\\(\\s*)['"\`]${escape(name)}(?:/[^'"\`]*)?['"\`]`,
  ).test(line);

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
  const files = stdout.split('\n').filter(Boolean);
  const counts = { provider: 0, call: 0, version: 0 };
  const push = (item) => {
    counts[item.kind] += 1;
    candidates.push({ repo: entry.repo, ...item });
  };
  for (const file of files) {
    if (SKIPPED.test(file) || TEST_PATH.test(file)) continue;
    if (file === 'package.json' || file.endsWith('/package.json')) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(directory, file), 'utf8'));
      } catch {
        continue;
      }
      const declared = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]
        .map((section) => manifest[section]?.twilio)
        .find(Boolean);
      if (!declared) continue;
      let locked = null;
      try {
        const lock = JSON.parse(
          await readFile(
            join(directory, file.replace(/package\.json$/, 'package-lock.json')),
            'utf8',
          ),
        );
        locked =
          lock.packages?.['node_modules/twilio']?.version ??
          lock.dependencies?.twilio?.version ??
          null;
      } catch {
        locked = null;
      }
      push({ kind: 'version', file, line: null, provider: 'twilio', declared, locked });
      continue;
    }
    if (!SOURCE.test(file)) continue;
    let content;
    try {
      content = await readFile(join(directory, file), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      const context = () =>
        lines
          .slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1)
          .map(
            (text, offset) => `${Math.max(0, index - CONTEXT) + offset + 1}: ${text.slice(0, 200)}`,
          )
          .join('\n');
      for (const [provider, rule] of Object.entries(PROVIDERS))
        if (rule.packages.some((name) => loads(line, name)) || rule.host.test(line))
          push({ kind: 'provider', provider, file, line: index + 1, context: context() });
      if (MEMBER.test(line) || endpoints.some((url) => line.includes(url)))
        push({ kind: 'call', file, line: index + 1, context: context() });
    }
  }
  repos.push({ repo: entry.repo, commit: entry.commit, group: entry.group, candidates: counts });
  console.error(`${entry.repo}: ${JSON.stringify(counts)}`);
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, list: values.list, repos, candidates }, null, 2)}\n`,
);
console.error(`${candidates.length} candidates in ${repos.length} repositories`);

// Runs `refit messaging` over a frozen messaging benchmark: shallow fetches at the pinned commits
// and one scan per repository, then a summary per provider: repositories where Refit detects it,
// live deprecated-member and removed-endpoint calls, twilio declarations below 6.0.0 and retired
// packages. With --labels it scores the labelled repositories (scripts/messaging-score.mjs).
// Repository code is never installed or run, and no provider is contacted.
//
//   node scripts/messaging-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] \
//     [--labels <labels.json>] [--output <file>]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { scoreMessaging } from './messaging-score.mjs';

const execute = promisify(execFile);
const SCAN_TIMEOUT_MS = 180_000;
const PROVIDERS = ['twilio', 'sendgrid', 'resend', 'postmark', 'mailgun'];
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-messaging-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    labels: { type: 'string' },
    output: { type: 'string', default: 'messaging-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/messaging-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--labels <labels.json>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const results = [];
for (const [index, entry] of pinned.repos.entries()) {
  console.error(`[${index + 1}/${pinned.repos.length}] ${entry.repo}`);
  const result = {
    repo: entry.repo,
    commit: entry.commit,
    group: entry.group,
    declared: entry.declared,
  };
  const empty = { providers: [], calls: [], packages: [] };
  let directory;
  try {
    directory = await shallowCheckout(values.root, entry.repo, entry.commit);
  } catch (error) {
    results.push({ ...result, status: 'not-fetched', error: message(error), ...empty });
    continue;
  }
  try {
    const { stdout } = await execute(
      process.execPath,
      [refit, 'messaging', '--repository', directory, '--json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
    );
    const report = JSON.parse(stdout);
    results.push({
      ...result,
      status: 'scanned',
      providers: report.providers.map((item) => ({
        agent: { id: item.agent.id },
        packages: item.packages,
        hostnames: item.hostnames,
      })),
      packages: report.packages,
      calls: report.calls,
      warnings: report.warnings,
    });
  } catch (error) {
    results.push({ ...result, status: 'not-scanned', error: message(error), ...empty });
  }
}

function message(error) {
  const text = error instanceof Error ? error.stderr || error.message : String(error);
  return String(text).trim().split('\n').at(-1).slice(0, 300);
}

const scanned = results.filter((result) => result.status === 'scanned');
const liveCalls = (result, provider) =>
  result.calls.filter((call) => call.use === 'live' && call.provider === provider);
const summary = {
  repositories: results.length,
  scanned: scanned.length,
  notScanned: results
    .filter((result) => result.status !== 'scanned')
    .map((result) => `${result.repo}: ${result.error}`),
  byProvider: Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      {
        detected: scanned.filter((result) =>
          result.providers.some((item) => item.agent.id === provider),
        ).length,
        withLiveDeprecatedCalls: scanned.filter((result) => liveCalls(result, provider).length)
          .length,
        liveDeprecatedCalls: scanned.reduce(
          (total, result) => total + liveCalls(result, provider).length,
          0,
        ),
      },
    ]),
  ),
  twilioBelow6: scanned.filter((result) =>
    result.packages.some((item) => item.name === 'twilio' && item.deadline),
  ).length,
  retiredPackages: Object.fromEntries(
    ['sendgrid', 'mailgun-js'].map((name) => [
      name,
      scanned.filter((result) => result.packages.some((item) => item.name === name)).length,
    ]),
  ),
};
// The Refit commit and whether its worktree was dirty, recorded by the run instead of by hand.
const { stdout: refitCommit } = await execute('git', ['rev-parse', '--short', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain']);
const output = {
  formatVersion: 1,
  list: values.list,
  checkedAt: new Date().toISOString(),
  refit: { commit: refitCommit.trim(), dirty: Boolean(dirty.trim()) },
  summary,
  results,
};
if (values.labels)
  output.score = scoreMessaging(JSON.parse(await readFile(values.labels, 'utf8')), { results });
await writeFile(join(resolve(values.root), values.output), `${JSON.stringify(output, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      summary,
      score: output.score && {
        providers: output.score.providers,
        calls: output.score.calls,
        versions: output.score.versions,
      },
    },
    null,
    2,
  ),
);

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanGitHubCalls, type GitHubCall } from './github-api-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit github-api [--repository <root>] [--all] [--json]
Lists the GitHub API use a repository makes: Octokit REST methods (octokit.rest.<scope>.<method>), octokit.request and paginate routes, raw https://api.github.com requests, pinned X-GitHub-Api-Version headers, and GraphQL queries sent through Octokit. Each request is matched to the operations GitHub's OpenAPI description deprecates, Octokit's own deprecations, and GitHub's upcoming GraphQL breaking changes. --all also lists the breaking changes a newer REST API version makes to each endpoint, which apply only when a request moves to that version. Values built at runtime are marked unknown, with the reason.
By default only requests with a notice are printed; --all prints every request.
Review only: nothing is changed, installed, run or sent to GitHub.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const root = resolve(values.repository ?? '.');
    const scan = await scanGitHubCalls(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, scannedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan, values.all ?? false);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function describe(call: GitHubCall) {
  if (call.kind === 'graphql') return 'GraphQL query';
  return [call.method, call.route ?? 'route unknown'].filter(Boolean).join('  ');
}

function print(root: string, scan: Awaited<ReturnType<typeof scanGitHubCalls>>, all: boolean) {
  console.log(`Refit GitHub API use  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to GitHub.');
  console.log(
    `Sources      ${terminalText(`${scan.sources.openapi}; ${scan.sources.docs}; checked ${scan.sources.checkedAt}`)}`,
  );
  for (const item of scan.packages)
    console.log(
      `Package      ${terminalText(`${item.name} ${item.locked ?? item.declared} in ${item.file}`)}`,
    );
  for (const pin of scan.pins)
    console.log(
      `\n${terminalText(`${pin.file}:${pin.line}`)}  X-GitHub-Api-Version ${terminalText(pin.version)}${pin.use === 'test' ? ' (test)' : ''}\n  Support    ${pin.endOfSupport ? `ends ${pin.endOfSupport}` : 'no end date published'}${pin.notes.map((note) => `\n  Note       ${terminalText(note)}`).join('')}`,
    );
  const live = scan.calls.filter((call) => call.use === 'live');
  const flagged = live.filter((call) => call.notices.length || call.notes.length);
  if (!scan.calls.length) {
    console.log('\nNo GitHub API request was found.');
    return;
  }
  console.log(
    `\n${live.length} ${live.length === 1 ? 'request' : 'requests'} in live code, ${flagged.length} with a notice; ${scan.calls.length - live.length} in tests and examples.`,
  );
  for (const call of all ? scan.calls : flagged) {
    console.log(
      `\n${terminalText(`${call.file}:${call.line}`)}  ${terminalText(describe(call))}${call.use === 'test' ? ' (test)' : ''}`,
    );
    console.log(`  Via        ${terminalText(call.client ?? 'no request call traced')}`);
    for (const notice of call.notices) console.log(`  Notice     ${terminalText(notice.text)}`);
    for (const change of call.versionChanges)
      console.log(`  ${change.version} ${terminalText(change.title)}`);
    for (const note of call.notes) console.log(`  Note       ${terminalText(note)}`);
    for (const reason of call.unknown) console.log(`  Unknown    ${terminalText(reason)}`);
  }
}

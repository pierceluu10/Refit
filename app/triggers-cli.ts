// Usage: node app/triggers-cli.ts summary [--json]     what ran, why, and how long since each repo's last check
//        node app/triggers-cli.ts rescan <owner/name>  scan now and try a fix again, even with nothing changed
// Only rescan needs the App's credentials, and only rescan can spend.
import { parseArgs } from 'node:util';
import { readTriggerDir } from './config.ts';
import {
  createTriggerStore,
  STALE_AFTER_HOURS,
  summarizeTriggers,
  type RepoSummary,
} from './triggers.ts';

const USAGE = 'Usage: triggers-cli.ts summary [--json] | rescan <owner/name>';
const BAD_USAGE = 2;

const age = (row: RepoSummary) =>
  row.hoursSinceCheck === undefined ? 'never checked' : `${row.hoursSinceCheck.toFixed(1)} h ago`;

function line(row: RepoSummary): string {
  const flag = row.stale ? 'STALE ' : '';
  const findings = row.findings > 0 ? `, ${row.findings} finding(s)` : '';
  const fix = row.fix ? `, fix ${row.fix}` : '';
  const unlisted = row.unlistedProviders.length
    ? `, unlisted: ${row.unlistedProviders.join(' ')}`
    : '';
  const { trigger, decision, why, error } = row.last;
  const failed = error ? `: ${error}` : '';
  return (
    `${flag}${row.repo}  ${row.status}${findings}${fix}${unlisted}\n` +
    `  checked ${age(row)}; last: ${trigger} -> ${decision} (${why})${failed}\n` +
    `  ${row.scans} scan(s), ${row.skips} skip(s), ${row.failures} failure(s), $${row.costUsd.toFixed(4)}`
  );
}

async function summary(json: boolean): Promise<void> {
  const rows = summarizeTriggers(await createTriggerStore(readTriggerDir()).records(), new Date());
  if (json) return console.log(JSON.stringify(rows, null, 2));
  for (const row of rows) console.log(line(row));
  const watched = rows.filter((row) => row.status !== 'removed');
  const stale = watched.filter((row) => row.stale).length;
  console.log(
    `${watched.length} repo(s) watched, ${watched.length - stale} checked within ${STALE_AFTER_HOURS} h, ${stale} stale`,
  );
}

async function rescan(repo: string): Promise<void> {
  const triggers = createTriggerStore(readTriggerDir());
  const state = await triggers.state(repo);
  if (!state) {
    console.error(`No scan of ${repo} on record, so its installation isn't known here.`);
    process.exit(BAD_USAGE);
  }
  // Loaded here so that a summary doesn't pull in the orchestrator or ask for credentials.
  const [{ readConfig }, { createInstallationTokens }, { createAppRunner }] = await Promise.all([
    import('./config.ts'),
    import('./github.ts'),
    import('./runner.ts'),
  ]);
  const config = readConfig();
  const tokens = createInstallationTokens(config.appId, config.privateKey);
  await createAppRunner(
    tokens,
    triggers,
  )({
    kind: 'understand',
    installationId: state.installationId,
    repo,
    reason: 'manual',
  });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean', default: false } },
});
const [command, repo] = positionals;
if (command === 'summary') await summary(values.json);
else if (command === 'rescan' && repo) await rescan(repo);
else {
  console.error(USAGE);
  process.exit(BAD_USAGE);
}

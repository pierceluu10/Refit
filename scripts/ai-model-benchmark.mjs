// Runs the deadline scan and the model replacement rule on a frozen AI SDK benchmark list
// (scripts/ai-sdk-select.mjs). Each repository is fetched at its recorded commit into --root; Refit
// reads files only, with no install, no repository code run and no provider contacted.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.list || !values.root || !values.output) {
  console.log(
    'Usage: node scripts/ai-model-benchmark.mjs --list <frozen.json> --root <dir> --output <results.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const root = resolve(values.root);
await mkdir(root, { recursive: true });
const refit = resolve('bin/refit.mjs');

async function checkout(entry) {
  const directory = join(root, entry.repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) return directory;
  await execute('git', ['init', '-q', directory]);
  await execute(
    'git',
    [
      '-C',
      directory,
      'fetch',
      '-q',
      '--depth',
      '1',
      `https://github.com/${entry.repo}`,
      entry.commit,
    ],
    { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
  await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
  return directory;
}

async function refitJson(args) {
  try {
    const { stdout } = await execute(process.execPath, [refit, ...args, '--json'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return { result: JSON.parse(stdout) };
  } catch (error) {
    return {
      error: String(error.stderr || error.message)
        .trim()
        .split('\n')
        .at(-1),
    };
  }
}

const results = [];
for (const [index, entry] of frozen.repos.entries()) {
  console.error(`[${index + 1}/${frozen.repos.length}] ${entry.repo}`);
  let directory;
  try {
    directory = await checkout(entry);
  } catch (error) {
    results.push({ repo: entry.repo, commit: entry.commit, error: `checkout: ${error.message}` });
    continue;
  }
  const deadlines = await refitJson(['deadlines', '--repository', directory]);
  const proposal = await refitJson([
    'deadlines',
    '--propose-model-fixes',
    '--repository',
    directory,
  ]);
  const live = (deadlines.result?.exposures ?? []).filter(
    (exposure) => exposure.deadline.provider === frozen.provider,
  );
  results.push({
    repo: entry.repo,
    commit: entry.commit,
    ...(deadlines.error || proposal.error ? { error: deadlines.error ?? proposal.error } : {}),
    exposures: live.map((exposure) => ({
      deadline: exposure.deadline.id,
      date: exposure.deadline.date,
      evidence: exposure.evidence.map((item) => `${item.file}:${item.line}`),
    })),
    replacements: (proposal.result?.replacements ?? [])
      .filter((item) => item.provider === frozen.provider)
      .map(({ file, line, call, edited, from, to, deadline }) => ({
        file,
        line,
        call,
        edited,
        from,
        to,
        deadline,
      })),
    stops: (proposal.result?.stops ?? [])
      .filter((item) => item.provider === frozen.provider)
      .map(({ file, line, call, at, model, reason }) => ({ file, line, call, at, model, reason })),
  });
}

const exposed = results.filter((item) => item.exposures?.length);
const summary = {
  repositories: results.length,
  errors: results.filter((item) => item.error).length,
  exposed: exposed.length,
  exposedWithReplacement: exposed.filter((item) => item.replacements.length).length,
  exposedStoppedOnly: exposed.filter((item) => !item.replacements.length && item.stops.length)
    .length,
  exposedSilent: exposed.filter((item) => !item.replacements.length && !item.stops.length).length,
  replacements: results.reduce((total, item) => total + (item.replacements?.length ?? 0), 0),
  stops: results.reduce((total, item) => total + (item.stops?.length ?? 0), 0),
};
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      list: values.list,
      provider: frozen.provider,
      ranAt: new Date().toISOString(),
      note: 'refit deadlines and refit deadlines --propose-model-fixes at each frozen commit; files read only. Exposure counts live evidence for this provider only.',
      summary,
      results,
    },
    null,
    2,
  )}\n`,
);
console.error(JSON.stringify(summary));

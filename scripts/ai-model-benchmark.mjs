// Runs the deadline scan and the model replacement rule on a frozen AI SDK benchmark list
// (scripts/ai-sdk-select.mjs). Each repository is fetched at its recorded commit into --root; Refit
// reads files only, with no install, no repository code run and no provider contacted.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { benchmarkSummary, repositoryNonLive, stopReasons } from './ai-model-benchmark-summary.mjs';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
// Each Refit command gets this long per repository; a repository past it is reported as timed out.
const SCAN_TIMEOUT_MS = 120_000;
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
      timeout: SCAN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { result: JSON.parse(stdout) };
  } catch (error) {
    if (error.killed) return { error: `timed out after ${SCAN_TIMEOUT_MS / 1000} s` };
    return {
      error: String(error.stderr || error.message)
        .trim()
        .split('\n')
        .at(-1),
    };
  }
}

// A list with no single provider (the AI wrapper sample) counts every model provider.
const providers = frozen.provider ? [frozen.provider] : ['openai', 'anthropic', 'gemini'];
const counted = (provider) => providers.includes(provider);
function nonLive(result) {
  const merged = { nonLive: {}, nonLiveTotal: 0 };
  for (const provider of providers) {
    const counts = repositoryNonLive(result, provider);
    for (const [use, count] of Object.entries(counts.nonLive))
      merged.nonLive[use] = (merged.nonLive[use] ?? 0) + count;
    merged.nonLiveTotal += counts.nonLiveTotal;
  }
  return merged;
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
  const live = (deadlines.result?.exposures ?? []).filter((exposure) =>
    counted(exposure.deadline.provider),
  );
  // Only a repository with a live exposure can get a replacement, so the slower proposal runs
  // only there.
  const proposal = live.length
    ? await refitJson(['deadlines', '--propose-model-fixes', '--repository', directory])
    : { result: { replacements: [], stops: [], unresolved: [] } };
  results.push({
    repo: entry.repo,
    commit: entry.commit,
    ...(deadlines.error || proposal.error ? { error: deadlines.error ?? proposal.error } : {}),
    exposures: live.map((exposure) => ({
      deadline: exposure.deadline.id,
      date: exposure.deadline.date,
      evidence: exposure.evidence.map((item) => `${item.file}:${item.line}`),
      // Evidence sent through an AI wrapper SDK, with the call (pipeline/model-wrappers.ts).
      ...(exposure.evidence.some((item) => item.via)
        ? {
            wrapped: exposure.evidence
              .filter((item) => item.via)
              .map((item) => `${item.file}:${item.line} ${item.via}`),
          }
        : {}),
    })),
    replacements: (proposal.result?.replacements ?? [])
      .filter((item) => counted(item.provider))
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
      .filter((item) => counted(item.provider))
      .map(({ file, line, call, at, model, reason }) => ({ file, line, call, at, model, reason })),
    unresolved: (proposal.result?.unresolved ?? [])
      .filter((item) => counted(item.provider))
      .map(({ file, line, model, to, reason }) => ({ file, line, model, to, reason })),
    ...nonLive(deadlines.result),
  });
}

const summary = benchmarkSummary(results);
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      list: values.list,
      provider: frozen.provider ?? providers.join(', '),
      ranAt: new Date().toISOString(),
      note: 'refit deadlines and refit deadlines --propose-model-fixes at each frozen commit; files read only. Exposure counts live evidence for this provider only.',
      summary,
      stopReasons: stopReasons(results),
      results,
    },
    null,
    2,
  )}\n`,
);
console.error(JSON.stringify(summary));

// Times Refit's static inventory, `refit deadlines` and `refit agents` (both read files only: no
// install, no repository code run, no provider contacted), on the first --take repositories of each
// frozen list, at their pinned commits. Each command runs under /usr/bin/time for CPU seconds and
// peak resident memory; wall time includes Node startup, so it is an upper bound for in-process use.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { distribution, parseTime } from './capacity-helpers.mjs';

const execute = promisify(execFile);
// Each command gets this long per repository; a repository past it is recorded as timed out.
const COMMAND_TIMEOUT_MS = 300_000;
const COMMANDS = {
  deadlines: ['deadlines', '--json'],
  agents: ['agents', '--json'],
};
const { values } = parseArgs({
  options: {
    list: { type: 'string', multiple: true },
    take: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const take = Number(values.take);
if (values.help || !values.list?.length || !values.root || !values.output || !(take > 0)) {
  console.log(
    'Usage: node scripts/capacity-inventory.mjs --list <frozen.json> [--list ...] --take <n> --root <checkouts> --output <results.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const refit = resolve('bin/refit.mjs');
const timeFlag = platform() === 'darwin' ? '-l' : '-v';
const scratch = await mkdtemp(join(tmpdir(), 'refit-capacity-'));

async function trackedSize(directory) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '-z'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const files = stdout.split('\0').filter(Boolean);
  let bytes = 0;
  for (const file of files)
    bytes += (await stat(join(directory, file)).catch(() => null))?.size ?? 0;
  return { files: files.length, bytes };
}

async function measure(name, directory) {
  const report = join(scratch, `${name}.time`);
  const started = performance.now();
  let exit = 0;
  let error;
  try {
    await execute(
      '/usr/bin/time',
      [
        timeFlag,
        '-o',
        report,
        process.execPath,
        refit,
        ...COMMANDS[name],
        '--repository',
        directory,
      ],
      { timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (failure) {
    exit = failure.killed ? 'timeout' : failure.code;
    error = String(failure.stderr || failure.message)
      .trim()
      .split('\n')
      .at(-1);
  }
  const wallSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  const usage = parseTime(await readFile(report, 'utf8').catch(() => ''));
  await rm(report, { force: true });
  return { wallSeconds, ...usage, exit, ...(error ? { error } : {}) };
}

const machine = () => ({ loadAverage: loadavg().map((value) => Number(value.toFixed(2))) });
const started = machine();
const rows = [];
try {
  for (const list of values.list) {
    const frozen = JSON.parse(await readFile(list, 'utf8'));
    for (const entry of frozen.repos.slice(0, take)) {
      console.error(`[${rows.length + 1}] ${entry.repo}`);
      const row = { list, repo: entry.repo, commit: entry.commit };
      rows.push(row);
      let directory;
      try {
        directory = await shallowCheckout(values.root, entry.repo, entry.commit);
      } catch (error) {
        row.checkout = String(error.message).split('\n')[0];
        continue;
      }
      Object.assign(row, await trackedSize(directory));
      for (const name of Object.keys(COMMANDS)) row[name] = await measure(name, directory);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const ok = (usage) => usage?.exit === 0 && usage.maxRssBytes !== undefined;
const measured = rows.filter((row) => ok(row.deadlines) && ok(row.agents));
const cpu = (usage) => usage.userSeconds + usage.systemSeconds;
// One inventory is both commands, run one after the other.
function usage(row, name) {
  if (name !== 'inventory')
    return {
      wallSeconds: row[name].wallSeconds,
      cpuSeconds: cpu(row[name]),
      maxRssBytes: row[name].maxRssBytes,
    };
  return {
    wallSeconds: row.deadlines.wallSeconds + row.agents.wallSeconds,
    cpuSeconds: cpu(row.deadlines) + cpu(row.agents),
    maxRssBytes: Math.max(row.deadlines.maxRssBytes, row.agents.maxRssBytes),
  };
}
const summary = Object.fromEntries(
  [...Object.keys(COMMANDS), 'inventory'].map((name) => {
    const usages = measured.map((row) => usage(row, name));
    return [
      name,
      Object.fromEntries(
        ['wallSeconds', 'cpuSeconds', 'maxRssBytes'].map((field) => [
          field,
          distribution(usages.map((entry) => entry[field])),
        ]),
      ),
    ];
  }),
);
const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const clean = !(await execute('git', ['status', '--porcelain'])).stdout.trim();
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      measuredAt: new Date().toISOString(),
      refit: { commit, clean },
      machine: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        cpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        loadAverageAtStart: started.loadAverage,
        loadAverageAtEnd: machine().loadAverage,
      },
      commands: Object.fromEntries(
        Object.entries(COMMANDS).map(([name, args]) => [
          name,
          `refit ${args.join(' ')} --repository <checkout>`,
        ]),
      ),
      measured: measured.length,
      failed: rows.length - measured.length,
      summary,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(`${measured.length} of ${rows.length} repositories measured: ${values.output}`);

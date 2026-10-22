import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { assertResults } from '../scripts/benchmark-results.mjs';

// The AI-app and deadline benchmark scripts end to end on local checkouts. Fetching is limited to
// file:// so the missing repository fails at once, offline, as a clone failure.
const execute = promisify(execFile);
const roots: string[] = [];
const OFFLINE = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
const MISSING = 'acme/missing';
const MISSING_COMMIT = 'd'.repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-benchmark-scripts-test-'));
  roots.push(root);
  return root;
}

// A checkout of an application that sends a model OpenAI retires on 2026-10-23.
async function application(path: string) {
  const git = (...args: string[]) => execute('git', ['-C', path, ...args]);
  await mkdir(path, { recursive: true });
  await git('init', '-q');
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { openai: '^4.0.0' } }),
  );
  await writeFile(
    join(path, 'chat.ts'),
    "import OpenAI from 'openai';\n\nconst client = new OpenAI();\n\nexport const reply = () =>\n  client.chat.completions.create({ model: 'gpt-3.5-turbo', messages: [] });\n",
  );
  await git('add', '-A');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'pinned');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
}

const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const node = (args: string[]) =>
  execute(process.execPath, args, { env: OFFLINE, maxBuffer: 16 * 1024 * 1024 }).catch(
    (error: { code: number; stdout: string; stderr: string }) => error,
  );

it('runs the AI-app benchmark in list order, classifies a failed clone and resumes the same run', async () => {
  const root = await directory();
  const commit = await application(join(root, 'acme__chat'));
  const list = join(root, 'list.json');
  await writeFile(
    list,
    JSON.stringify({
      provider: 'openai',
      repos: [
        { repo: 'acme/chat', commit },
        { repo: MISSING, commit: MISSING_COMMIT },
      ],
    }),
  );
  const output = join(root, 'results.json');
  const run = (...extra: string[]) =>
    node([
      'scripts/ai-model-benchmark.mjs',
      '--list',
      list,
      '--root',
      root,
      '--output',
      output,
      '--allow-dirty',
      ...extra,
    ]);
  await run();
  const first = await read(output);
  expect(() => assertResults('ai-model-results', first)).not.toThrow();
  expect(first).toMatchObject({
    formatVersion: 2,
    provider: 'openai',
    harness: { format: 'ai-model-results', list: { path: list }, options: {}, docker: null },
    summary: { repositories: 2, errors: 1, exposed: 1, infrastructureErrors: 1 },
  });
  expect(first.results.map((row: { repo: string }) => row.repo)).toEqual(['acme/chat', MISSING]);
  expect(first.results[0]).toMatchObject({
    commit,
    exposures: [{ evidence: ['chat.ts:6'] }],
    outcomeClass: 'repository',
  });
  expect(first.results[1]).toMatchObject({
    commit: MISSING_COMMIT,
    error: expect.stringMatching(/^checkout: /),
    outcomeClass: 'infrastructure',
    infrastructure: { kind: 'clone' },
  });

  // Interrupted after the first repository: resuming keeps it and reruns only the rest.
  await writeFile(output, JSON.stringify({ ...first, results: [first.results[0]] }));
  const resumed = await run('--resume');
  expect(resumed.stderr).toContain('[1/2] acme/chat: finished before resuming');
  const second = await read(output);
  expect(second.results).toEqual(first.results);
  expect(second.harness.resumes).toHaveLength(1);

  await writeFile(
    list,
    JSON.stringify({ provider: 'openai', repos: [{ repo: 'acme/chat', commit }] }),
  );
  expect(await run('--resume')).toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      `Refusing to resume ${output}: list differ from the run it started.`,
    ),
  });
});

it('runs the deadline benchmark with every repository in the output, and scores only scanned ones', async () => {
  const root = await directory();
  const commit = await application(join(root, 'repos', 'acme__chat'));
  const list = join(root, 'repos.json');
  await writeFile(
    list,
    JSON.stringify({
      repos: [
        { provider: 'openai', repo: 'acme/chat', commit },
        { provider: 'openai', repo: MISSING, commit: MISSING_COMMIT },
      ],
    }),
  );
  const setup = (...extra: string[]) =>
    node([
      'scripts/deadline-benchmark-setup.mjs',
      '--root',
      root,
      '--list',
      list,
      '--refit',
      resolve('.'),
      '--output',
      'after.json',
      '--allow-dirty',
      ...extra,
    ]);
  // A failed repository still exits 1, as before; it is now in the output too.
  const result = await setup();
  expect(result).toMatchObject({ code: 1 });
  const run = await read(join(root, 'after.json'));
  expect(() => assertResults('deadline-results', run)).not.toThrow();
  expect(run).toMatchObject({ formatVersion: 2, list, harness: { format: 'deadline-results' } });
  expect(run.results.map((row: { repo: string }) => row.repo)).toEqual(['acme/chat', MISSING]);
  expect(run.results[0]).toMatchObject({ outcomeClass: 'repository', mentions: [] });
  expect(run.results[0].exposures.length).toBeGreaterThan(0);
  expect(run.results[1]).toMatchObject({
    outcomeClass: 'infrastructure',
    infrastructure: { kind: 'clone' },
  });

  // The score reads the new file and a bare array from before the harness the same way.
  await writeFile(join(root, 'grep.json'), '[]');
  await writeFile(
    join(root, 'before.json'),
    JSON.stringify([{ ...run.results[0], outcomeClass: undefined }]),
  );
  const score = async () => {
    const { stdout } = await execute(process.execPath, [
      'scripts/deadline-benchmark-score.mjs',
      '--root',
      root,
      '--runs',
      'before,after',
    ]);
    return JSON.parse(stdout);
  };
  const scored = await score();
  expect(scored.runs.before).toMatchObject({
    scanned: 1,
    failed: { infrastructure: 0, repository: 0 },
  });
  expect(scored.runs.after).toMatchObject({
    scanned: 1,
    failed: { infrastructure: 1, repository: 0 },
  });
  expect(scored.runs.after.all).toEqual(scored.runs.before.all);

  // Results that break the schema are refused before anything is counted.
  await writeFile(join(root, 'before.json'), JSON.stringify([{ repo: 'acme/chat' }]));
  await expect(score()).rejects.toMatchObject({
    stderr: expect.stringContaining('Results do not match the deadline-results schema'),
  });
});

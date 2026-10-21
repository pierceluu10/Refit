import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const run = promisify(execFile);
const node = (script: string, args: string[]) =>
  run(process.execPath, [script, ...args]).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }),
  );
const candidatesScript = 'scripts/ai-app-label-candidates.mjs';
const labelsScript = 'scripts/ai-app-labels.mjs';

let dir = '';
let commit = '';
const args = () => [
  '--list',
  join(dir, 'list.json'),
  '--root',
  join(dir, 'checkouts'),
  '--registry',
  join(dir, 'registry.json'),
  '--output',
  join(dir, 'labels', 'candidates.json'),
  '--batches',
  join(dir, 'labels'),
];
const mergeArgs = (out: string) => [
  '--candidates',
  join(dir, 'labels', 'candidates.json'),
  '--batches',
  join(dir, 'labels'),
  '--output',
  out,
  '--labelled-at',
  '2026-10-21',
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-app-labels-'));
  const repo = join(dir, 'checkouts', 'o__r');
  await mkdir(join(repo, 'dist'), { recursive: true });
  await mkdir(join(repo, 'node_modules'), { recursive: true });
  await writeFile(join(repo, 'a.ts'), 'const a = 1;\nconst m = "gpt-4-turbo";\n');
  await writeFile(join(repo, 'c.json'), '{"model": "gpt-4-turbo-2024-04-09"}\n');
  await writeFile(join(repo, '.env'), "MODEL='gpt-4-turbo'\n");
  await writeFile(join(repo, 'dist', 'app.js'), 'x("gpt-4-turbo")\n');
  await writeFile(join(repo, 'package-lock.json'), '"gpt-4-turbo"\n');
  await writeFile(join(repo, 'node_modules', 'n.js'), '"gpt-4-turbo"\n');
  await writeFile(join(repo, 'b.bin'), Buffer.from([0, 0x22, 0x67, 0x22]));
  const git = (...a: string[]) => run('git', ['-C', repo, ...a]);
  await git('init', '-q');
  await git('add', '-f', '.');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(
    join(dir, 'list.json'),
    JSON.stringify({
      provider: 'openai',
      repos: [
        { repo: 'o/r', commit },
        { repo: 'o/empty', commit },
      ],
    }),
  );
  await mkdir(join(dir, 'checkouts', 'o__empty'), { recursive: true });
  const empty = join(dir, 'checkouts', 'o__empty');
  await run('git', ['-C', empty, 'init', '-q']);
  await writeFile(join(empty, 'a.txt'), 'nothing\n');
  await run('git', ['-C', empty, 'add', '.']);
  await run('git', [
    '-C',
    empty,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'x',
  ]);
  const emptyCommit = (await run('git', ['-C', empty, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(
    join(dir, 'list.json'),
    JSON.stringify({
      provider: 'openai',
      repos: [
        { repo: 'o/r', commit },
        { repo: 'o/empty', commit: emptyCommit },
      ],
    }),
  );
  await writeFile(
    join(dir, 'registry.json'),
    JSON.stringify({
      formatVersion: 1,
      deadlines: [
        {
          id: 'a',
          provider: 'openai',
          kind: 'model',
          versions: ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09'],
          replacement: 'gpt-5',
          checkedAt: '2026-10-20',
        },
      ],
    }),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

it('runs candidates -> batches -> labels -> labels file, and rejects bad or missing batches', async () => {
  const found = await node(candidatesScript, args());
  expect(found.code, found.stderr).toBe(0);
  const candidates = JSON.parse(await readFile(join(dir, 'labels', 'candidates.json'), 'utf8'));
  expect(candidates.repos.map((r: { repo: string }) => r.repo)).toEqual(['o/empty', 'o/r']);
  const mine = candidates.repos[1].candidates;
  expect(mine.map((c: { file: string }) => c.file)).toEqual([
    '.env',
    'a.ts',
    'c.json',
    'dist/app.js',
  ]);
  expect(mine[3].generated).toBe(true);
  expect(mine[1]).toMatchObject({
    line: 2,
    column: 12,
    language: 'typescript',
    replacement: 'gpt-5',
  });
  expect(JSON.stringify(candidates)).not.toContain('const m');
  const batch = JSON.parse(await readFile(join(dir, 'labels', 'batch-01.json'), 'utf8'));
  expect(batch.candidates).toHaveLength(4);
  expect(batch.candidates[1].context.line).toBe('const m = "gpt-4-turbo";');

  const out = join(dir, 'merged.json');
  const missing = await node(labelsScript, mergeArgs(out));
  expect(missing.code).toBe(3);
  expect(missing.stderr).toContain('missing batches: 01');
  await expect(readFile(out)).rejects.toThrow();

  const label = (c: { file: string; line: number; column: number; model: string }) => ({
    repo: 'o/r',
    provider: 'openai',
    file: c.file,
    line: c.line,
    column: c.column,
    model: c.model,
    live: true,
    via: 'sdk-text',
    replacement: 'gpt-5',
    notes: 'passed to the chat call',
  });
  const labels = batch.candidates.map(label);
  await writeFile(
    join(dir, 'labels', 'labels-01.json'),
    JSON.stringify({
      batch: '01',
      labels: [{ ...labels[0], replacement: 'wrong' }, ...labels.slice(1)],
    }),
  );
  const wrong = await node(labelsScript, mergeArgs(out));
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain('invalid batch 01');
  await expect(readFile(out)).rejects.toThrow();

  await writeFile(join(dir, 'labels', 'labels-01.json'), JSON.stringify({ batch: '01', labels }));
  const merged = await node(labelsScript, mergeArgs(out));
  expect(merged.code, merged.stderr).toBe(0);
  const file = JSON.parse(await readFile(out, 'utf8'));
  expect(file.counts).toMatchObject({
    repositories: 2,
    candidates: 4,
    live: 4,
    liveJsTs: 2,
    generated: 1,
  });
  expect(file.repos[0]).toMatchObject({ repo: 'o/empty', labels: [] });
  expect(Object.keys(file.repos[1].labels[0]).sort()).toEqual([
    'column',
    'deadline',
    'file',
    'generated',
    'language',
    'line',
    'live',
    'model',
    'notes',
    'replacement',
    'via',
  ]);
  expect(file.method).toContain('Not hand labelling');
});

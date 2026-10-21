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

it('re-reads a seeded sample: agreement, adjudication, regenerated labels, and the exit codes', async () => {
  const out = join(dir, 'merged.json');
  const sample = join(dir, 'sample.json');
  const drawn = await node(labelsScript, [
    '--reread-sample',
    '--candidates',
    join(dir, 'labels', 'candidates.json'),
    '--batches',
    join(dir, 'labels'),
    '--seed',
    '5',
    '--fraction',
    '0.5',
    '--output',
    sample,
  ]);
  expect(drawn.code, drawn.stderr).toBe(0);
  const drawnFile = JSON.parse(await readFile(sample, 'utf8'));
  expect(drawnFile).toMatchObject({ formatVersion: 1, seed: 5, fraction: 0.5, sampleSize: 2 });
  for (const c of drawnFile.candidates) {
    expect(c.context).toBeDefined();
    expect(c).not.toHaveProperty('live');
    expect(c).not.toHaveProperty('notes');
  }

  const second = drawnFile.candidates.map((c: Record<string, unknown>, i: number) => ({
    repo: c.repo,
    provider: c.provider,
    file: c.file,
    line: c.line,
    column: c.column,
    model: c.model,
    live: i !== 0,
    ...(i === 0 ? { reason: 'test' } : { via: 'sdk-text' }),
    ...(i === 0 ? { via: null } : {}),
    replacement: 'gpt-5',
    notes: 'second reading',
  }));
  const reread = join(dir, 'reread.json');
  const mergeReread = (extra: string[]) =>
    node(labelsScript, [
      '--reread-merge',
      '--candidates',
      join(dir, 'labels', 'candidates.json'),
      '--batches',
      join(dir, 'labels'),
      '--labels',
      out,
      '--sample',
      sample,
      '--reread',
      reread,
      '--output',
      join(dir, 'final.json'),
      ...extra,
    ]);
  expect((await mergeReread([])).code).toBe(3);

  await writeFile(reread, JSON.stringify({ labels: second }));
  const open = await mergeReread([]);
  expect(open.code).toBe(2);
  expect(open.stderr).toContain('unadjudicated');
  await expect(readFile(join(dir, 'final.json'))).rejects.toThrow();

  const first = second[0];
  const key = [first.repo, first.provider, first.file, first.line, first.column, first.model].join(
    '|',
  );
  const adjudications = join(dir, 'adjudications.json');
  await writeFile(
    adjudications,
    JSON.stringify([
      { key, final: { live: false, via: null, reason: 'test' }, note: 'second reading was right' },
    ]),
  );
  const done = await mergeReread(['--adjudications', adjudications]);
  expect(done.code, done.stderr).toBe(0);
  const file = JSON.parse(await readFile(join(dir, 'final.json'), 'utf8'));
  expect(file.reread).toMatchObject({
    seed: 5,
    sampleSize: 2,
    agreement: { live: { agree: 1, total: 2 }, via: { agree: 1, total: 2 } },
  });
  expect(file.reread.rereadSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(file.reread.disagreements).toHaveLength(1);
  expect(file.reread.disagreements[0]).toMatchObject({
    key,
    first: { live: true, via: 'sdk-text' },
    second: { live: false, reason: 'test' },
    final: { live: false, reason: 'test' },
  });
  expect(file.counts).toMatchObject({ candidates: 4, live: 3, notLive: 1 });
  const changed = file.repos[1].labels.find(
    (l: { file: string; line: number }) => l.file === first.file && l.line === first.line,
  );
  expect(changed).toMatchObject({ live: false, reason: 'test', notes: 'second reading was right' });
  expect(file.method).toContain('separate fresh-context agent');
  expect(file.method).toContain('Not hand labelling');
});

it('refuses to merge when a candidate lacks exactly one label', async () => {
  const out = join(dir, 'unlabelled.json');
  const candidatesPath = join(dir, 'labels', 'candidates.json');
  const candidates = JSON.parse(await readFile(candidatesPath, 'utf8'));
  const extra = { ...candidates.repos[1].candidates[0], line: 99 };
  candidates.repos[1].candidates.push(extra);
  const skewed = join(dir, 'skewed-candidates.json');
  await writeFile(skewed, JSON.stringify(candidates));
  const args = mergeArgs(out);
  args[1] = skewed;
  const result = await node(labelsScript, args);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('label/candidate mismatch');
  await expect(readFile(out)).rejects.toThrow();
});

it('takes identity fields from the candidate, never from the label', async () => {
  const out = join(dir, 'identity.json');
  const batch = JSON.parse(await readFile(join(dir, 'labels', 'batch-01.json'), 'utf8'));
  const labels = JSON.parse(await readFile(join(dir, 'labels', 'labels-01.json'), 'utf8'));
  labels.labels[0].line = String(labels.labels[0].line);
  const bad = join(dir, 'identity-batches');
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, 'batch-01.json'), JSON.stringify(batch));
  await writeFile(join(bad, 'labels-01.json'), JSON.stringify(labels));
  const args = mergeArgs(out);
  args[3] = bad;
  const result = await node(labelsScript, args);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('identity-type');
  await expect(readFile(out)).rejects.toThrow();
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readCsv, RESULT_COLUMNS, RUN_COLUMNS, type ResultRow, type RunRow } from './results.ts';
import { assertPublicGitHubUrl, runEvaluation } from './runner.ts';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureRepository(name: string, source: string) {
  const directory = await mkdtemp(join(tmpdir(), `refit-eval-fixture-${name}-`));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies: { openai: '1.0.0' } }),
  );
  await writeFile(join(directory, 'index.js'), source);
  await execute('git', ['init', '--quiet'], { cwd: directory });
  await execute('git', ['config', 'user.name', 'Eval Test'], { cwd: directory });
  await execute('git', ['config', 'user.email', 'eval@example.invalid'], { cwd: directory });
  await execute('git', ['add', '.'], { cwd: directory });
  await execute('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: directory });
  return {
    url: pathToFileURL(directory).href,
    commit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim(),
  };
}

it('shallow-clones local git fixtures, records findings and failures, and removes checkouts', async () => {
  const affected = await fixtureRepository(
    'affected',
    `import OpenAI from 'openai';
const client = new OpenAI();
client.completions.create({ model: 'fixture-openai-retired-model', prompt: 'hello' });
`,
  );
  const clean = await fixtureRepository(
    'clean',
    `import OpenAI from 'openai';
const client = new OpenAI();
client.completions.create({ model: 'current-model', prompt: 'hello' });
`,
  );
  const invalid = await fixtureRepository('invalid', `const broken = ;\n`);
  const outputDirectory = await mkdtemp(join(tmpdir(), 'refit-eval-output-'));
  temporaryDirectories.push(outputDirectory);
  const output = join(outputDirectory, 'results.csv');
  const missing = pathToFileURL(join(outputDirectory, 'missing.git')).href;
  const logs: string[] = [];
  const tempBefore = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('refit-openai-eval-')),
  );

  const outcome = await runEvaluation({
    repositories: [affected.url, clean.url, invalid.url, missing],
    output,
    log: (message) => logs.push(message),
  });

  expect(outcome.results).toEqual([
    expect.objectContaining({
      repo: affected.url,
      commit: affected.commit,
      file: 'index.js',
      line: '3',
      modelId: 'fixture-openai-retired-model',
      confidence: 'confirmed',
      label: '',
      notes: '',
    }),
  ]);
  expect(outcome.runs).toEqual([
    expect.objectContaining({ repo: affected.url, status: 'scanned', findingCount: '1' }),
    expect.objectContaining({
      repo: clean.url,
      commit: clean.commit,
      status: 'scanned',
      findingCount: '0',
    }),
    expect.objectContaining({ repo: invalid.url, status: 'scan-failed' }),
    expect.objectContaining({ repo: missing, status: 'clone-failed' }),
  ]);
  expect(logs).toHaveLength(2);
  expect(logs[0]).toContain('scan failed; skipped');
  expect(logs[1]).toContain('clone failed; skipped');
  expect(await readCsv<ResultRow>(output, RESULT_COLUMNS)).toEqual(outcome.results);
  expect(await readCsv<RunRow>(outcome.runsOutput, RUN_COLUMNS)).toEqual(outcome.runs);
  const reports = await readdir(outcome.reportsDirectory);
  expect(reports).toHaveLength(2);
  const affectedReport = reports.find((report) => report.startsWith('001-'));
  expect(affectedReport).toBeDefined();
  expect(
    JSON.parse(await readFile(join(outcome.reportsDirectory, affectedReport!), 'utf8')),
  ).toMatchObject({ provider: 'openai', status: 'affected' });
  const tempAfter = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('refit-openai-eval-')),
  );
  expect(tempAfter).toEqual(tempBefore);
});

it('accepts only repository-shaped HTTPS GitHub URLs for CLI input', () => {
  expect(() => assertPublicGitHubUrl('https://github.com/openai/openai-node')).not.toThrow();
  expect(() => assertPublicGitHubUrl('https://github.com/openai/openai-node.git')).not.toThrow();
  expect(() => assertPublicGitHubUrl('git@github.com:openai/openai-node.git')).toThrow(
    /public HTTPS GitHub URL/,
  );
  expect(() => assertPublicGitHubUrl('https://example.com/openai/openai-node')).toThrow(
    /public HTTPS GitHub URL/,
  );
  expect(() => assertPublicGitHubUrl('https://token@github.com/openai/openai-node')).toThrow(
    /public HTTPS GitHub URL/,
  );
});

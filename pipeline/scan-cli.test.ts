import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');

it('prints readable scan results without claiming validation or changing the scanned files', async () => {
  const source = resolve('pipeline/fixtures/repository/billing.ts');
  const before = await readFile(source, 'utf8');
  const result = await execute(process.execPath, [bin, 'replay', '--propose-patch', '--human']);
  expect(result.stdout).toContain('Refit scan');
  expect(result.stdout).toContain('Stripe removes payment_intent.charges');
  expect(result.stdout).toContain('1 confirmed usage');
  expect(result.stdout).toContain('Deterministic migration');
  expect(result.stdout).toContain('checks have not run');
  expect(result.stdout).not.toContain('sha256');
  expect(await readFile(source, 'utf8')).toBe(before);
});

it('preserves full redirected JSON and saves it separately from a readable summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-readable-scan-'));
  try {
    const output = join(root, 'scan.json');
    // Independent runs start together; each CLI start costs about 0.3 s.
    const [json, explicit, human] = await Promise.all([
      execute(process.execPath, [bin, 'replay', '--propose-patch']),
      execute(process.execPath, [bin, 'replay', '--propose-patch', '--json']),
      execute(process.execPath, [bin, 'replay', '--propose-patch', '--human', '--output', output]),
    ]);
    expect(JSON.parse(explicit.stdout)).toEqual(JSON.parse(json.stdout));
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.patch.status).toBe('proposed');
    expect(report.findings[0].file).toBe('billing.ts');
    expect(human.stdout).toContain('Refit scan');
    await expect(
      execute(process.execPath, [bin, 'replay', '--output', output]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('EEXIST'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Starts the CLI several times; shared CI runners can exceed the default 5s timeout.
}, 30_000);

it('refuses conflicting output formats before scanning', async () => {
  await expect(execute(process.execPath, [bin, 'scan', '--json', '--human'])).rejects.toMatchObject(
    {
      code: 1,
      stderr: expect.stringContaining('Choose either --json or --human.'),
    },
  );
});

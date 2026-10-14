import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('scans the rest of a repository when one file cannot be parsed, and reports it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  await writeFile(join(root, 'broken.ts'), 'export const value = {,};\n');
  const report = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  });
  expect(report.findings.some((finding) => finding.confidence === 'confirmed')).toBe(true);
  expect(report.warnings).toContainEqual(
    expect.stringMatching(
      /^Skipped unparseable file; its API usage was not scanned\. broken\.ts: /,
    ),
  );
});

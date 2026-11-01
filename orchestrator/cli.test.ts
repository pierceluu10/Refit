import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.ts';

describe('aptitude CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aptitude-cli-'));
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the whole loop offline on a repo in dry-run mode', async () => {
    const out = join(dir, 'runs.jsonl');
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['run', '--repo', dir, '--dry-run', '--out', out])).toBe(0);

    const summary = print.mock.calls.flat().join('\n');
    expect(summary).toContain('(dry run: no PRs opened)');
    expect(summary).toContain('PRs: none');
    const lines = (await readFile(out, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.repo).toBe(dir.split('/').pop());
      expect(line.pr).toBeUndefined();
    }
  });

  it('runs several repos in one org run', async () => {
    const second = await mkdtemp(join(tmpdir(), 'aptitude-cli-'));
    const out = join(dir, 'runs.jsonl');
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['run', '--repo', dir, '--repo', second, '--dry-run', '--out', out])).toBe(0);

    expect(print.mock.calls.flat().join('\n')).toContain('Aptitude run on 2 repos');
    const repos = (await readFile(out, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).repo);
    expect(new Set(repos)).toEqual(new Set([dir, second].map((d) => d.split('/').pop())));
    await rm(second, { recursive: true, force: true });
  });

  it('exits non-zero on a usage error', async () => {
    expect(await main(['run'])).toBe(2);
    expect(await main(['run', '--repo', join(dir, 'missing')])).toBe(2);
    expect(await main(['deploy', '--repo', dir])).toBe(2);
  });
});

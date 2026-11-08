import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSummary, main } from './cli.ts';
import type { LoopRecord } from './loop.ts';

describe('refit CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'refit-cli-'));
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
    const second = await mkdtemp(join(tmpdir(), 'refit-cli-'));
    const out = join(dir, 'runs.jsonl');
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['run', '--repo', dir, '--repo', second, '--dry-run', '--out', out])).toBe(0);

    expect(print.mock.calls.flat().join('\n')).toContain('Refit run on 2 repos');
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

describe('formatSummary', () => {
  const run = (taskId: string, outcome: LoopRecord['outcome'], note?: string): LoopRecord => ({
    taskId,
    outcome,
    diff: '',
    checks: [],
    costUsd: 0,
    transcriptPath: '',
    note,
  });

  it('lists attempted work first and each not-affected verdict with its reasoning last', () => {
    const records = [
      run('acme/shop:meta:v19', 'not-affected', 'The repo never calls the Graph API.'),
      run('acme/shop:stripe:source', 'verified'),
      run('acme/shop:openai:gpt-4o', 'failed', 'not attempted: match failed after retries'),
      run('acme/shop:stripe:charges', 'waiting-budget', 'not attempted: $0.50 of the run cap left'),
    ];
    const text = formatSummary(
      'acme/shop',
      {
        counts: {
          verified: 1,
          'needs-review': 0,
          'not-affected': 1,
          failed: 1,
          'waiting-budget': 1,
        },
        prs: [],
        costUsd: 0,
        records,
        errors: [],
      },
      { dryRun: true, out: '/tmp/runs.jsonl' },
    );
    const lines = text.split('\n');
    const at = (id: string) => lines.findIndex((l) => l.includes(id));
    expect(at('stripe:source')).toBeLessThan(at('openai:gpt-4o'));
    expect(at('openai:gpt-4o')).toBeLessThan(at('stripe:charges'));
    expect(at('stripe:charges')).toBeLessThan(at('meta:v19'));
    expect(lines[1]).toContain('1 waiting on budget');
    expect(lines[at('meta:v19') + 1].trim()).toBe('The repo never calls the Graph API.');
  });
});

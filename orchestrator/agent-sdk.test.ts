import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyForReading, readOnlyInRepo } from './agent-sdk.ts';

const base = mkdtempSync(join(tmpdir(), 'aptitude-agent-sdk-'));
const repo = join(base, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'pay.ts'), '');
writeFileSync(join(base, 'secret.txt'), '');
symlinkSync(join(base, 'secret.txt'), join(repo, 'escape.txt'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const decide = async (tool: string, input: Record<string, unknown>) =>
  (await readOnlyInRepo(repo)(tool, input, { signal: new AbortController().signal } as never))
    ?.behavior;

describe('readOnlyInRepo', () => {
  it('allows read-only tools inside the repo', async () => {
    expect(await decide('Read', { file_path: join(repo, 'src', 'pay.ts') })).toBe('allow');
    expect(await decide('Grep', { pattern: 'charges', path: 'src' })).toBe('allow');
    expect(await decide('Glob', { pattern: '**/*.ts' })).toBe('allow');
  });

  it('denies paths outside the repo, including through a symlink', async () => {
    expect(await decide('Read', { file_path: join(base, 'secret.txt') })).toBe('deny');
    expect(await decide('Read', { file_path: '../secret.txt' })).toBe('deny');
    expect(await decide('Read', { file_path: join(repo, 'escape.txt') })).toBe('deny');
  });

  it('denies any other tool', async () => {
    expect(await decide('Bash', { command: 'npm test' })).toBe('deny');
    expect(await decide('Write', { file_path: join(repo, 'x') })).toBe('deny');
  });
});

describe('copyForReading', () => {
  it('copies code and env templates but never real env files, .git, node_modules or symlinks', () => {
    const src = join(base, 'checkout');
    const dest = join(base, 'copy');
    mkdirSync(join(src, 'src'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    mkdirSync(join(src, 'node_modules', 'stripe'), { recursive: true });
    mkdirSync(join(src, 'config'), { recursive: true });
    for (const file of [
      'src/pay.ts',
      '.env',
      '.env.local',
      '.env.production',
      '.envrc',
      '.env.example',
      '.env.sample',
      '.env.template',
      '.env.dist',
      'config/.env',
      '.git/config',
      'node_modules/stripe/index.js',
    ])
      writeFileSync(join(src, file), 'x');
    symlinkSync(join(base, 'secret.txt'), join(src, 'link.txt'));

    copyForReading(src, dest);
    const kept = (file: string) => existsSync(join(dest, file));

    for (const file of ['src/pay.ts', '.env.example', '.env.sample', '.env.template', '.env.dist'])
      expect(kept(file), file).toBe(true);
    for (const file of [
      '.env',
      '.env.local',
      '.env.production',
      '.envrc',
      'config/.env',
      '.git',
      'node_modules',
      'link.txt',
    ])
      expect(kept(file), file).toBe(false);
  });
});

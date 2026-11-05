import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from './ledger.ts';
import { gatherEvidence, preparationNotes, prepareRepo, withEnv } from './prepare.ts';
import type { Sandbox } from './types.ts';

const fakeSandbox = (dir: string, ran: string[]): Sandbox => ({
  dir,
  mode: 'local',
  exec: async (command) => {
    ran.push(command);
    return { code: 0, stdout: 'generated', stderr: '', timedOut: false };
  },
  diff: async () => '',
  dispose: async () => {},
});

describe('prepare', () => {
  it('exports placeholder env before a compound command, quoting values', () => {
    expect(withEnv('a && b', { DATABASE_URL: "postgres://x'y", 'BAD NAME': 'x' })).toBe(
      `export DATABASE_URL='postgres://x'\\''y'; a && b`,
    );
    expect(withEnv('npm test', {})).toBe('npm test');
  });

  it('shows the planner the scripts and codegen config, and runs the steps it names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-test-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { postinstall: 'prisma generate' } }),
    );
    writeFileSync(join(dir, 'schema.prisma'), 'generator client {}');
    const ran: string[] = [];
    let seen = '';
    const prep = await prepareRepo(
      fakeSandbox(dir, ran),
      [{ name: 'build', command: 'npm run build' }],
      new BudgetLedger(1),
      async (evidence) => {
        seen = evidence;
        return {
          steps: [{ command: 'npx prisma generate', why: 'postinstall' }],
          env: { DATABASE_URL: 'postgresql://localhost/db' },
          reasoning: 'Prisma client',
        };
      },
    );
    expect(seen).toContain('prisma generate');
    expect(seen).toContain('schema.prisma');
    expect(seen).toContain('build: `npm run build`');
    expect(ran).toEqual(["export DATABASE_URL='postgresql://localhost/db'; npx prisma generate"]);
    expect(preparationNotes(prep)).toEqual([
      'Before the baseline the harness ran `npx prisma generate` (postinstall); it exited 0.',
      'Checks ran with placeholder env: DATABASE_URL.',
    ]);
  });

  it('never throws when the planner fails; the repo stays as installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-test-'));
    const prep = await prepareRepo(fakeSandbox(dir, []), [], new BudgetLedger(1), async () => {
      throw new Error('model down');
    });
    expect(prep).toMatchObject({ steps: [], env: {}, error: 'no codegen plan: model down' });
    expect(await gatherEvidence(dir, [])).toContain('none detected');
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareChecks,
  detectChecks,
  detectPackageManager,
  failureSignatures,
  installCommand,
  packageManagerVersion,
  type PackageManager,
} from './checks.ts';
import type { CheckRun } from './types.ts';

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aptitude-checks-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('failureSignatures', () => {
  it('returns nothing for a passing run', () => {
    expect(failureSignatures('error TS2339: whatever', true)).toEqual([]);
  });

  it('normalises TypeScript errors in both formats', () => {
    const output = [
      "src/client.ts(12,5): error TS2339: Property 'charges' does not exist on type 'Stripe'.",
      '\x1b[96msrc/pay.ts\x1b[0m:\x1b[93m40\x1b[0m:\x1b[93m3\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2554: \x1b[0mExpected 1 arguments, but got 2.',
      "src/client.ts(30,1): error TS2339: Property 'charges' does not exist on type 'Stripe'.",
      'Found 3 errors in 2 files.',
    ].join('\n');
    expect(failureSignatures(output, false)).toEqual([
      "src/client.ts: error TS2339: Property 'charges' does not exist on type 'Stripe'.",
      'src/pay.ts: error TS2554: Expected 1 arguments, but got 2.',
    ]);
  });

  it('picks failing tests out of vitest output', () => {
    const output = `
 ❯ src/pay.test.ts (3 tests | 1 failed) 12ms
   ✓ charges a card 3ms
   × refunds a charge 5ms
     → expected 'ok' to be 'refunded'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/pay.test.ts > payments > refunds a charge
AssertionError: expected 'ok' to be 'refunded'
 ❯ /tmp/aptitude-abc123/src/pay.test.ts:22:18

 Test Files  1 failed (1)
`;
    expect(failureSignatures(output, false)).toEqual([
      'failed: refunds a charge',
      'FAIL src/pay.test.ts > payments > refunds a charge',
      "AssertionError: expected 'ok' to be 'refunded'",
    ]);
  });

  it('picks failing tests out of jest output', () => {
    const output = `FAIL src/api.test.js
  api
    ✓ lists customers (4 ms)
    ✕ creates a customer (12 ms)

  ● api › creates a customer

    TypeError: stripe.customers.create is not a function

      at Object.<anonymous> (/private/var/folders/xy/abc/T/aptitude-1/src/api.test.js:10:5)
`;
    expect(failureSignatures(output, false)).toEqual([
      'FAIL src/api.test.js',
      'failed: creates a customer',
      'TypeError: stripe.customers.create is not a function',
    ]);
  });

  it('picks failing tests out of pytest output', () => {
    const output = `
tests/test_pay.py ..F                                                    [100%]
=================================== FAILURES ===================================
E       AttributeError: module 'openai' has no attribute 'Completion'
=========================== short test summary info ============================
FAILED tests/test_pay.py::test_refund - AttributeError: module 'openai' has no attribute 'Completion'
ERROR tests/test_client.py - ImportError: cannot import name 'OpenAI'
========================= 1 failed, 2 passed in 0.12s ==========================
`;
    expect(failureSignatures(output, false)).toEqual([
      'FAILED tests/test_pay.py::test_refund',
      'ERROR tests/test_client.py',
    ]);
  });

  it('falls back to the last line when nothing matches', () => {
    expect(failureSignatures('building...\nnpm ERR! code 1 at line 42:7\n\n', false)).toEqual([
      'exit-nonzero: npm ERR! code 1 at line 42',
    ]);
  });
});

describe('compareChecks', () => {
  const run = (name: string, failures: string[]): CheckRun => ({
    name,
    command: `npm run ${name}`,
    ok: failures.length === 0,
    output: '',
    failures,
  });

  it('counts only failures that are new after the change', () => {
    const before = [run('test', ['FAIL a.test.ts', 'FAIL b.test.ts']), run('build', [])];
    const after = [run('test', ['FAIL b.test.ts', 'FAIL c.test.ts']), run('build', [])];
    expect(compareChecks(before, after)).toEqual([
      { name: 'test', before: 'fail (2)', after: 'fail (2)', newFailures: ['FAIL c.test.ts'] },
      { name: 'build', before: 'pass', after: 'pass', newFailures: [] },
    ]);
  });

  it('treats every failure of a check missing before as new', () => {
    expect(compareChecks([], [run('typecheck', ['x: error TS1: y'])])).toEqual([
      { name: 'typecheck', before: 'not run', after: 'fail (1)', newFailures: ['x: error TS1: y'] },
    ]);
    expect(compareChecks([run('test', [])], [])[0]).toMatchObject({ after: 'not run' });
  });
});

describe('detectPackageManager and detectChecks', () => {
  it('detects package managers from lockfiles', async () => {
    expect(await detectPackageManager(await fixture({ 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(await detectPackageManager(await fixture({ 'yarn.lock': '' }))).toBe('yarn');
    expect(await detectPackageManager(await fixture({ 'bun.lock': '' }))).toBe('bun');
    expect(await detectPackageManager(await fixture({ 'package.json': '{}' }))).toBe('npm');
    expect(await detectPackageManager(await fixture({ 'poetry.lock': '' }))).toBe('poetry');
    expect(await detectPackageManager(await fixture({ 'requirements.txt': '' }))).toBe('pip');
    expect(await detectPackageManager(await fixture({}))).toBe('none');
  });

  it('reads checks from package.json scripts', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({
        scripts: { 'type-check': 'tsc', build: 'vite build', test: 'vitest run' },
      }),
    });
    expect(await detectChecks(dir, 'pnpm')).toEqual([
      { name: 'typecheck', command: 'corepack pnpm run type-check' },
      { name: 'build', command: 'corepack pnpm run build' },
      { name: 'test', command: 'corepack pnpm run test' },
    ]);
    expect(await detectChecks(dir, 'yarn', '3')).toContainEqual({
      name: 'build',
      command: 'corepack yarn@3 run build',
    });
    // Scripts never write the lockfile, so npm runs them with the sandbox's own release.
    expect(await detectChecks(dir, 'npm', '6')).toContainEqual({
      name: 'build',
      command: 'npm run build',
    });
  });

  it("falls back to tsc for a tsconfig and skips npm's placeholder test script", async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
      'tsconfig.json': '{}',
    });
    expect(await detectChecks(dir, 'npm')).toEqual([
      { name: 'typecheck', command: 'npx --no-install tsc --noEmit' },
    ]);
  });

  it('finds pytest for Python repos and nothing for empty ones', async () => {
    const dir = await fixture({ 'requirements.txt': 'openai\n', 'tests/test_a.py': '' });
    expect(await detectChecks(dir, 'pip')).toEqual([
      {
        name: 'pytest',
        command:
          '(python3 -m pytest --version >/dev/null 2>&1 || python3 -m pip install -q --only-binary=:all: pytest) && python3 -m pytest -q',
      },
    ]);
    expect(await detectChecks(await fixture({}), 'none')).toEqual([]);
  });
});

describe('packageManagerVersion', () => {
  const version = async (pm: PackageManager, files: Record<string, string>) =>
    packageManagerVersion(await fixture(files), pm);
  const npmLock = (lockfileVersion: number, packages: Record<string, object> = { '': {} }) =>
    JSON.stringify({ lockfileVersion, packages });

  it('takes the packageManager field first', async () => {
    const files = {
      'package.json': '{ "packageManager": "pnpm@8.15.9+sha512.abc" }',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    };
    expect(await version('pnpm', files)).toBe('8.15.9');
    expect(await version('npm', { 'package.json': '{ "packageManager": "yarn@4.1.0" }' })).toBe(
      undefined,
    );
  });

  it('pins npm only where a newer npm would rewrite the lockfile', async () => {
    expect(await version('npm', { 'package-lock.json': npmLock(1) })).toBe('6');
    expect(await version('npm', { 'package-lock.json': npmLock(2) })).toBe('8');
    // License lines on entries mean npm 10.8+ wrote it, so the sandbox's npm matches.
    const licensed = { '': {}, 'node_modules/ms': { license: 'MIT' } };
    expect(await version('npm', { 'package-lock.json': npmLock(2, licensed) })).toBe(undefined);
    expect(await version('npm', { 'package-lock.json': npmLock(3) })).toBe(undefined);
    expect(await version('npm', { 'package.json': '{}' })).toBe(undefined);
  });

  it('treats a malformed lockfile as an unknown release instead of throwing', async () => {
    for (const lock of [
      'null',
      '{ "lockfileVersion": 2, "packages": { "a": null } }',
      '{ "packages": "x" }',
    ]) {
      expect(await version('npm', { 'package-lock.json': lock }), lock).toBe(undefined);
    }
  });

  it("reads pnpm's and yarn's release from the lockfile format", async () => {
    expect(await version('pnpm', { 'pnpm-lock.yaml': 'lockfileVersion: 5.4\n' })).toBe('7');
    expect(await version('pnpm', { 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n" })).toBe('8');
    expect(await version('pnpm', { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })).toBe('9');
    const classic =
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n';
    expect(await version('yarn', { 'yarn.lock': classic })).toBe('1');
    const berry = (format: number) => `__metadata:\n  version: ${format}\n  cacheKey: 8\n`;
    expect(await version('yarn', { 'yarn.lock': berry(6) })).toBe('3');
    expect(await version('yarn', { 'yarn.lock': berry(8) })).toBe('4');
  });
});

describe('installCommand', () => {
  const managers: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'poetry'];

  it('always disables install scripts, in Docker too, at any release', () => {
    for (const pm of managers) {
      for (const release of [undefined, '1', '8', '3.6.1']) {
        const command = installCommand(pm, release);
        const safe = /ignore-scripts|only-binary|ONLY_BINARY/;
        for (const part of command.split(/\|\||;|\bthen\b|\belse\b/)) {
          if (/\b(?:npm|pnpm|yarn|bun|pip|poetry)(?:@\S+)? (?:ci|install)\b/.test(part)) {
            expect(part, `${pm}@${release}: ${part}`).toMatch(
              pm === 'yarn' ? /ignore-scripts|YARN_ENABLE_SCRIPTS=false/ : safe,
            );
          }
        }
      }
    }
  });

  it('prefers a frozen install and falls back to a plain one', () => {
    expect(installCommand('npm')).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund || npm install --ignore-scripts --no-audit --no-fund',
    );
    expect(installCommand('pnpm')).toBe(
      'corepack pnpm install --frozen-lockfile --ignore-scripts || corepack pnpm install --no-frozen-lockfile --ignore-scripts',
    );
  });

  it("runs the repo's own release, so the lockfile keeps its format", () => {
    expect(installCommand('npm', '8')).toBe(
      'npx -y npm@8 ci --ignore-scripts --no-audit --no-fund || npx -y npm@8 install --ignore-scripts --no-audit --no-fund',
    );
    expect(installCommand('pnpm', '8.15.9')).toMatch(
      /^corepack pnpm@8\.15\.9 install --frozen-lockfile/,
    );
    expect(installCommand('yarn', '1')).toBe(
      'corepack yarn@1 install --frozen-lockfile --ignore-scripts || corepack yarn@1 install --ignore-scripts',
    );
    expect(installCommand('yarn', '3.6.1')).toBe(
      'YARN_ENABLE_SCRIPTS=false corepack yarn@3.6.1 install --immutable || YARN_ENABLE_SCRIPTS=false YARN_ENABLE_IMMUTABLE_INSTALLS=false corepack yarn@3.6.1 install',
    );
  });
});

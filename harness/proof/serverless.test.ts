import { describe, expect, it } from 'vitest';
import { findRuntimes, serverlessCheck } from './serverless.ts';
import { fakeSandbox, fixture } from './test-helpers.ts';

const now = new Date('2026-11-06T00:00:00Z');

describe('serverless proof', () => {
  it('reads runtimes from serverless.yml, SAM and Terraform', () => {
    expect(
      findRuntimes('serverless.yml', 'provider:\n  runtime: nodejs18.x\n').map((r) => r.runtime),
    ).toEqual(['nodejs18.x']);
    expect(
      findRuntimes('template.yaml', '      Runtime: python3.12\n').map((r) => r.runtime),
    ).toEqual(['python3.12']);
    expect(findRuntimes('main.tf', '  runtime = "java21"\n').map((r) => r.runtime)).toEqual([
      'java21',
    ]);
  });

  it('flags deprecated runtimes and does not run tests without a command', async () => {
    const sandbox = fakeSandbox(fixture('serverless-old'));
    const result = await serverlessCheck.run({}, { repoDir: sandbox.dir, sandbox, now });
    expect(result.passed).toBe(false);
    const failed = result.failedItems.join('\n');
    expect(failed).toContain(
      'serverless.yml:4 (serverless) runtime nodejs18.x was deprecated on AWS Lambda on 2025-09-01',
    );
    expect(failed).toContain('runtime python3.9');
    expect(failed).toContain('template.yaml:7 (sam/cloudformation) runtime go1.x');
    expect(result.notes.join('\n')).toContain('no testCommand given');
    expect(sandbox.commands).toEqual([]);
  });

  it('takes deprecations the agent found at the source', async () => {
    const sandbox = fakeSandbox(fixture('serverless-new'));
    const result = await serverlessCheck.run(
      { deprecated: { 'nodejs22.x': '2026-01-01' } },
      { repoDir: sandbox.dir, sandbox, now },
    );
    expect(result.failedItems.join('\n')).toContain(
      'nodejs22.x was deprecated on AWS Lambda on 2026-01-01',
    );
  });

  it('runs the tests in the sandbox and records the runtime they ran on', async () => {
    const sandbox = fakeSandbox(fixture('serverless-new'), (command) => {
      if (command === 'node --version') return { code: 0, stdout: 'v20.11.0\n' };
      if (command === 'npm test') return { code: 0, stdout: 'ok 1 report\n' };
      return undefined;
    });
    const result = await serverlessCheck.run(
      { testCommand: 'npm test' },
      { repoDir: sandbox.dir, sandbox, now },
    );
    expect(sandbox.commands).toEqual(['node --version', 'npm test']);
    expect(result.passed).toBe(true);
    expect(result.passedItems).toContain('tests passed: npm test');
    expect(result.notes.join('\n')).toContain('tests ran on v20.11.0, not nodejs22.x');
    expect(result.logTail).toContain('ok 1 report');
  });

  it('reports failing tests with their log', async () => {
    const sandbox = fakeSandbox(fixture('serverless-new'), (command) =>
      command === 'npm test'
        ? { code: 1, stderr: 'FAIL report.test.js' }
        : { code: 0, stdout: 'v22.1.0' },
    );
    const result = await serverlessCheck.run(
      { testCommand: 'npm test' },
      { repoDir: sandbox.dir, sandbox, now },
    );
    expect(result.passed).toBe(false);
    expect(result.passedItems).toContain('sandbox runtime v22.1.0 matches nodejs22.x');
    expect(result.failedItems).toContain('tests failed (exit 1): npm test');
    expect(result.evidence.at(-1)).toContain('FAIL report.test.js');
  });
});

import { describe, expect, it } from 'vitest';
import {
  PROOF_CHECK_NAMES,
  buildProofTools,
  formatProofResult,
  proofTools,
  runProof,
} from './index.ts';
import { fakeSandbox, fixture } from './test-helpers.ts';

describe('runProof', () => {
  it('exposes every check from the plan', () => {
    expect(PROOF_CHECK_NAMES).toEqual([
      'kubernetes',
      'serverless',
      'android-sdk',
      'ios-privacy-manifest',
      'browser-extension',
      'tls',
      'login',
      'accessibility',
      'payment-scripts',
      'container-image',
    ]);
  });

  it('returns a plain ProofResult', async () => {
    const result = await runProof('browser-extension', {}, { repoDir: fixture('extension-mv3') });
    expect(result).toEqual({
      check: 'browser-extension',
      passed: true,
      evidence: ['passed: manifest.json is valid Manifest V3'],
    });
  });

  it('never throws: an unknown check or bad input comes back unknown', async () => {
    const unknown = await runProof('fax-machine', null, { repoDir: fixture('web') });
    expect(unknown.passed).toBe('unknown');
    expect(unknown.evidence[0]).toContain('available: kubernetes, serverless');
    const odd = await runProof('kubernetes', 'not an object', {
      repoDir: '/nonexistent/refit',
      sandbox: fakeSandbox('/nonexistent/refit'),
    } as never);
    expect(odd.passed).toBe('unknown');
  });

  it('redacts secrets from evidence', async () => {
    const sandbox = fakeSandbox(fixture('serverless-new'), (command) =>
      command === 'npm test'
        ? { code: 1, stderr: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' }
        : { code: 0, stdout: 'v22.0.0' },
    );
    const result = await runProof('serverless', { testCommand: 'npm test' }, {
      repoDir: sandbox.dir,
      sandbox,
    } as never);
    expect(result.evidence.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.evidence.join('\n')).toContain('[redacted]');
  });
});

describe('proof tools', () => {
  it('are AgentTools named proof_<check> with JSON Schemas', () => {
    expect(proofTools.map((t) => t.name)).toContain('proof_ios_privacy_manifest');
    for (const tool of proofTools) expect(tool.inputSchema.type).toBe('object');
  });

  it('run against the repoDir they are called with and return the evidence as text', async () => {
    const tool = proofTools.find((t) => t.name === 'proof_tls')!;
    const out = await tool.run({}, { repoDir: fixture('tls-bad') });
    expect(out.split('\n')[0]).toBe('tls: failed');
    expect(out).toContain('- failed: nginx.conf:3');
  });

  it('reuse the harness sandbox when given one', async () => {
    const sandbox = fakeSandbox(fixture('k8s-new'));
    const tool = buildProofTools({ sandbox }).find((t) => t.name === 'proof_kubernetes')!;
    const out = await tool.run({ targetVersion: '1.32' }, { repoDir: '/somewhere/else' });
    expect(out.split('\n')[0]).toBe('kubernetes: passed');
    expect(sandbox.commands[0]).toBe("command -v 'pluto'");
  });

  it('formats unknown results', () => {
    expect(
      formatProofResult({ check: 'x', passed: 'unknown', evidence: ['skipped: no browser'] }),
    ).toBe(
      'x: unknown (not proof: counts as failed until a rerun or a person confirms it)\n- skipped: no browser',
    );
  });
});

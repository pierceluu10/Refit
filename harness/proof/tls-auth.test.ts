import { describe, expect, it } from 'vitest';
import { loginCheck, tlsCheck } from './tls-auth.ts';
import { fixture } from './test-helpers.ts';

describe('tls proof', () => {
  it('finds forced retired versions in server config and client code', async () => {
    const result = await tlsCheck.run({}, { repoDir: fixture('tls-bad') });
    expect(result.passed).toBe(false);
    const failed = result.failedItems.join('\n');
    expect(failed).toContain('nginx.conf:3 nginx ssl_protocols enables a retired version');
    expect(failed).toContain("client.js:2 Node TLS minVersion is retired: minVersion: 'TLSv1'");
    expect(failed).toContain(
      'legacy.py:2 Python ssl forces a retired protocol: ssl.PROTOCOL_TLSv1_1',
    );
    expect(result.notes.join('\n')).toContain('client.js:2 turns certificate checks off');
  });

  it('passes TLS 1.2+ settings', async () => {
    const result = await tlsCheck.run({}, { repoDir: fixture('tls-good') });
    expect(result.failedItems).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('login proof', () => {
  it('fails a flow without PKCE to a provider that requires it, and a password login to Exchange Online', async () => {
    const result = await loginCheck.run({}, { repoDir: fixture('login-bad') });
    expect(result.passed).toBe(false);
    const failed = result.failedItems.join('\n');
    expect(failed).toContain(
      'x-auth.js:4 authorization-code flow to X (Twitter) OAuth 2.0 has no PKCE',
    );
    expect(failed).toContain(
      'mailer.js:4 logs in to Exchange Online (smtp.office365.com) with a password',
    );
  });

  it('passes PKCE and OAuth SMTP', async () => {
    const result = await loginCheck.run({}, { repoDir: fixture('login-good') });
    expect(result.failedItems).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.passedItems.join('\n')).toContain(
      'x-auth.js:4 authorization-code flow sends PKCE',
    );
  });

  it('only notes missing PKCE elsewhere unless asked to require it', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'refit-proof-login-'));
    await writeFile(
      path.join(dir, 'auth.ts'),
      'const url = `https://id.example.test/authorize?response_type=code&client_id=${id}`;\n',
    );
    const relaxed = await loginCheck.run({}, { repoDir: dir });
    expect(relaxed.failedItems).toEqual([]);
    expect(relaxed.notes.join('\n')).toContain(
      'auth.ts:1 authorization-code flow has no PKCE in this file',
    );
    const strict = await loginCheck.run({ requirePkce: true }, { repoDir: dir });
    expect(strict.failedItems).toEqual(['auth.ts:1 authorization-code flow has no PKCE']);
  });
});

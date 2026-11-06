import { describe, expect, it } from 'vitest';
import { redactOutbound, redactSecrets, scanSecrets, secretsAddedByDiff } from './secrets.ts';

describe('redactSecrets', () => {
  const env = {};

  it('redacts named secrets in env, YAML and JSON forms', () => {
    const text = [
      'MY_SERVICE_TOKEN=abc123def456ghi',
      'db_password: hunter22hunter',
      '"clientSecret": "Zx9_8yw7vu6ts5"',
      "API_KEY='q1w2e3r4t5y6'",
    ].join('\n');
    const out = redactSecrets(text, env);
    expect(out).toBe(
      [
        'MY_SERVICE_TOKEN=[redacted]',
        'db_password: [redacted]',
        '"clientSecret": "[redacted]"',
        "API_KEY='[redacted]'",
      ].join('\n'),
    );
  });

  it('leaves code that reads keys alone', () => {
    const code = [
      'apiKey: await getApiKey(),',
      'const key = process.env.OPENAI_API_KEY;',
      'primaryKey: 1,',
      'OPENAI_API_KEY=your-key-here',
    ].join('\n');
    expect(redactSecrets(code, env)).toBe(code);
  });

  it('still redacts known prefixes and env values', () => {
    const out = redactSecrets('token sk_live_1234567890abcdefgh and value-from-env-99', {
      HOST_TOKEN: 'value-from-env-99',
    });
    expect(out).toBe('token [redacted] and [redacted]');
  });
});

describe('scanSecrets and redactOutbound', () => {
  // Illustrative fake credentials, not real ones.
  const fakeGithub = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const fakeGoogle = `AIza${'Sy0123456789abcdefghijABCDEFGHIJ_-x'.slice(0, 35)}`;

  it('reports kind and line, never the value', () => {
    const text = ['ok line', `token: ${fakeGithub}`, `key=${fakeGoogle}`].join('\n');
    const findings = scanSecrets(text, {});
    expect(findings).toContainEqual({ kind: 'github-token', line: 2 });
    expect(findings).toContainEqual({ kind: 'google-api-key', line: 3 });
    expect(JSON.stringify(findings)).not.toContain(fakeGithub);
  });

  it('redacts a password in a connection string but not a placeholder', () => {
    expect(redactSecrets('postgres://app:s3cretpw@db:5432/app', {})).toBe(
      'postgres://app:[redacted]@db:5432/app',
    );
    const placeholder = 'postgres://app:${DB_PASSWORD}@db/app';
    expect(redactSecrets(placeholder, {})).toBe(placeholder);
  });

  it('redacts a PR body and says what was found', () => {
    const body = `## Checks\n\nlog: ${fakeGithub}\n`;
    const out = redactOutbound('pr-body', body, {});
    expect(out.text).not.toContain(fakeGithub);
    expect(out.text).toContain('[redacted]');
    expect(out.note).toMatch(/github-token \(line 3\)/);
    expect(out.note).not.toContain(fakeGithub);
    expect(redactOutbound('log', 'all clean', {})).toEqual({ text: 'all clean', findings: [] });
  });

  it('flags a diff that adds a secret, but not one that removes it', () => {
    const diff = [
      '--- a/config.js',
      '+++ b/config.js',
      `-const token = '${fakeGithub}';`,
      '+const token = process.env.GITHUB_TOKEN;',
      `+const backup = '${fakeGithub}';`,
    ].join('\n');
    expect(secretsAddedByDiff(diff, {})).toEqual([{ kind: 'github-token', line: 5 }]);
    expect(redactOutbound('diff', diff, {}).note).toMatch(/must not be committed/);
  });

  it('finds a host env secret value wherever it appears', () => {
    const out = redactOutbound('log', 'echo leaked-value-1234', {
      DEPLOY_TOKEN: 'leaked-value-1234',
    });
    expect(out.findings).toEqual([{ kind: 'host-env-secret', line: 1 }]);
    expect(out.text).toBe('echo [redacted]');
  });
});

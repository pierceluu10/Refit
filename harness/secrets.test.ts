import { describe, expect, it } from 'vitest';
import { redactSecrets } from './secrets.ts';

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
      'accessKeyId: process.env.R2_ACCESS_KEY_ID,',
      'const token = import.meta.env.VITE_S3_TOKEN;',
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

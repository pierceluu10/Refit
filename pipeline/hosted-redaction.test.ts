import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { hostedRedactor } from './hosted-ops.ts';

const WEBHOOK_SECRET = 'webhook-secret-for-redaction-tests-0123456789';
const INSTALLATION_TOKEN = `ghs_${'A1b2C3d4E5'.repeat(4)}`;
const OPENAI_KEY = `sk-proj-${'q'.repeat(40)}`;

it('removes known secret values and their base64 forms, longest first', () => {
  const redact = hostedRedactor({
    REFIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    REFIT_SERVICE_TOKEN: `${WEBHOOK_SECRET}-longer`,
    OPENAI_API_KEY: 'short',
  });
  const encoded = Buffer.from(WEBHOOK_SECRET).toString('base64');
  expect(redact(`a ${WEBHOOK_SECRET}-longer b ${WEBHOOK_SECRET} c ${encoded} d`)).toBe(
    'a [redacted] b [redacted] c [redacted] d',
  );
  // Values under eight characters would redact ordinary words, so they are not treated as secrets.
  expect(redact('a short message')).toBe('a short message');
});

it('removes credential shapes it was never told about', () => {
  const redact = hostedRedactor({});
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const samples = [
    `git failed: remote: token ${INSTALLATION_TOKEN} rejected`,
    `OpenAI said: Incorrect API key provided: ${OPENAI_KEY}.`,
    `key file: ${pem} end`,
    `truncated: ${pem.slice(0, 200)}`,
    `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64')}`,
    'curl -H "Authorization: token 0123456789abcdef0123"',
    'sent Bearer abcdefghijklmnop0123456789 to the API',
    'connect postgresql://refit_hosted:p%40ss-w0rd!@db.example.test:5432/postgres failed',
    `github_pat_${'x'.repeat(30)} expired`,
  ];
  const redacted = samples.map(redact);
  for (const [index, text] of redacted.entries())
    expect(text, samples[index]).toContain('[redacted]');
  const joined = redacted.join('\n');
  for (const secret of [
    INSTALLATION_TOKEN,
    OPENAI_KEY,
    'PRIVATE KEY-----\nMII',
    'p%40ss-w0rd!',
    'abcdefghijklmnop0123456789',
    '0123456789abcdef0123',
    Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64'),
  ])
    expect(joined).not.toContain(secret);
  expect(redacted[7]).toBe(
    'connect postgresql://refit_hosted:[redacted]@db.example.test:5432/postgres failed',
  );
});

it('leaves ordinary diagnostics readable', () => {
  const redact = hostedRedactor({ REFIT_WEBHOOK_SECRET: WEBHOOK_SECRET });
  for (const text of [
    'GitHub GET /repos/example/application failed with HTTP 404.',
    'OpenAI token counting failed with HTTP 401; generation was not attempted.',
    'Basic authentication is not supported; use a Bearer token.',
    'Managed Git fetch failed: fatal: unable to access the repository',
    'skipped sk-1 and ghs_short',
  ])
    expect(redact(text)).toBe(text);
});

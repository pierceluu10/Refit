// Credential shapes that may reach an error message from code that never saw the secret itself:
// GitHub tokens (installation tokens are ghs_), OpenAI keys, PEM private keys, HTTP authorization
// values and the password in a database URL.
const CREDENTIALS: [RegExp, string][] = [
  [/\bgh[opsur]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted]',
  ],
  [/(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s"',;]+/gi, '$1[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]'],
  [/\b(postgres(?:ql)?:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1[redacted]@'],
];
const MIN_SECRET_LENGTH = 8;

// The database password as configured, raw and URL-decoded, from pg pool options.
export function databaseSecrets(options: { password?: unknown; connectionString?: string }) {
  const secrets = typeof options.password === 'string' ? [options.password] : [];
  if (!options.connectionString) return secrets;
  try {
    const { password } = new URL(options.connectionString);
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch {
    // An unparseable URL fails when pg connects; the credential patterns still cover its usual form.
  }
  return secrets;
}

// Returns a function that removes the given secret values, their base64 forms and known credential
// shapes from text bound for logs, stored receipts or HTTP responses.
export function secretRedactor(secrets: (string | undefined)[]) {
  const values = [
    ...new Set(
      secrets
        .filter((secret): secret is string => (secret?.length ?? 0) >= MIN_SECRET_LENGTH)
        .flatMap((secret) => [secret, Buffer.from(secret).toString('base64')]),
    ),
  ].sort((left, right) => right.length - left.length);
  return (text: string) => {
    let redacted = text;
    for (const value of values) redacted = redacted.replaceAll(value, '[redacted]');
    for (const [pattern, replacement] of CREDENTIALS)
      redacted = redacted.replace(pattern, replacement);
    return redacted;
  };
}

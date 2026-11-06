// Hard limit 4: never print or commit secrets. Everything the agent sees or the PR shows passes here,
// and every diff, log and PR body is scanned before it leaves the sandbox.

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|SESSION/i;

// Known credential shapes, by kind. The kind is what a finding reports; the value never is.
const SECRET_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'anthropic-or-openai-key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'stripe-webhook-secret', pattern: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { kind: 'slack-token', pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'slack-webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
  },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'shopify-token', pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'pypi-token', pattern: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

// user:password@host in a connection string. The password is redacted, the rest stays readable.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi;

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string);
}

// NAME=value, NAME: value and "NAME": "value" where NAME mentions a key, token, secret or password.
// shortcut: only values with a digit and 8+ token characters count, so code like `apiKey: getApiKey()`
// or `process.env.API_KEY` stays readable; a digit-free secret slips through.
const NAMED_SECRET =
  /(\b[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*["']?\s*[:=]\s*["']?)(?=[\w+/=.~-]*\d)([\w+/=.~-]{8,})/gi;

const isPlaceholder = (value: string) => /^\[redacted\]$|^\$\{|^<|x{6,}|\*{4,}/i.test(value);

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const value of secretValues(env)) out = out.split(value).join('[redacted]');
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  out = out.replace(URL_PASSWORD, (all, head: string, password: string, at: string) =>
    isPlaceholder(password) || password.startsWith('$') ? all : `${head}[redacted]${at}`,
  );
  return out.replace(NAMED_SECRET, '$1[redacted]');
}

export type SecretFinding = { kind: string; line: number };

// Where secrets are, by kind and 1-based line, never by value. Used to say in a PR or a run note that
// something was redacted, and to stop a diff that adds a secret from being committed unseen.
export function scanSecrets(text: string, env: NodeJS.ProcessEnv = process.env): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  const values = secretValues(env);
  lines.forEach((line, index) => {
    const add = (kind: string) => {
      if (!findings.some((f) => f.line === index + 1 && f.kind === kind)) {
        findings.push({ kind, line: index + 1 });
      }
    };
    if (values.some((value) => line.includes(value))) add('host-env-secret');
    for (const { kind, pattern } of SECRET_PATTERNS) {
      if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(line)) add(kind);
    }
    for (const match of line.matchAll(URL_PASSWORD)) {
      if (!isPlaceholder(match[2]) && !match[2].startsWith('$')) add('url-password');
    }
    if (new RegExp(NAMED_SECRET.source, 'i').test(line)) add('named-secret');
  });
  // A private key spans lines; report it once, on its first line.
  const keyStart = lines.findIndex((line) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line));
  if (keyStart >= 0 && !findings.some((f) => f.kind === 'private-key')) {
    findings.push({ kind: 'private-key', line: keyStart + 1 });
  }
  return findings.sort((a, b) => a.line - b.line);
}

export type OutboundKind = 'diff' | 'log' | 'pr-body' | 'transcript';

export type Outbound = {
  text: string; // redacted, safe to print, store or send
  findings: SecretFinding[];
  // One line for a run note or PR body, or undefined when nothing was found. Names kinds and lines only.
  note?: string;
};

// The gate every artifact passes through before it leaves the sandbox: scan, then redact. For a diff,
// a finding means the change itself would commit a secret; the note says so, so a human sees it.
export function redactOutbound(
  kind: OutboundKind,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Outbound {
  const findings = scanSecrets(text, env);
  const out = redactSecrets(text, env);
  if (findings.length === 0) return { text: out, findings };
  const where = findings.map((f) => `${f.kind} (line ${f.line})`).join(', ');
  const note =
    kind === 'diff'
      ? `Redacted ${findings.length} possible secret(s) in the diff: ${where}. A diff that adds a secret must not be committed as is.`
      : `Redacted ${findings.length} possible secret(s) in the ${kind}: ${where}.`;
  return { text: out, findings, note };
}

// Only diff lines the change adds (`+`, not the `+++` header) can commit a new secret.
export function secretsAddedByDiff(
  diff: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretFinding[] {
  const lines = diff.split('\n');
  return scanSecrets(diff, env).filter((finding) => {
    const line = lines[finding.line - 1] ?? '';
    return line.startsWith('+') && !line.startsWith('+++');
  });
}

// Environment for untrusted code: the host's env minus anything that looks like a credential.
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

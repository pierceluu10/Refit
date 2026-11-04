// Hard limit 4: never print or commit secrets. Everything the agent sees or the PR shows passes here.

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|SESSION/i;

const SECRET_PATTERNS = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, // Shopify
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string);
}

// NAME=value, NAME: value and "NAME": "value" where NAME mentions a key, token, secret or password.
// shortcut: only values with a digit and 8+ token characters count, so code like `apiKey: getApiKey()`
// or `process.env.API_KEY` stays readable; a digit-free secret slips through.
// A reference to an env var is no secret, digits in its name or not (`process.env.R2_ACCESS_KEY_ID`
// was redacted in round 3, and the PR diff no longer matched the file).
const NAMED_SECRET =
  /(\b[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*["']?\s*[:=]\s*["']?)(?!process\.env\.|import\.meta\.env\.|os\.environ|Deno\.env\.)(?=[\w+/=.~-]*\d)([\w+/=.~-]{8,})/gi;

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const value of secretValues(env)) out = out.split(value).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.replace(NAMED_SECRET, '$1[redacted]');
}

// Environment for untrusted code: the host's env minus anything that looks like a credential.
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

// TLS and login: configs and client code don't force TLS 1.0, 1.1 or SSL (retired by RFC 8996); OAuth
// authorization-code flows send PKCE where the provider requires it; no password logins to providers
// that switched them off. Text scans that point the agent at lines; reads files only.
import type { ProofCheck } from './types.ts';
import { lineOf, optBoolean, proofDetail, readRoot, readText, walkFiles } from './util.ts';

const TEXT_FILE =
  /\.(conf|cnf|cfg|ini|toml|ya?ml|json|properties|env\.example|xml|tf|js|cjs|mjs|ts|tsx|jsx|py|go|java|kt|kts|scala|cs|rb|php|rs|swift|sh|bash|dockerfile)$|(^|\/)(nginx\.conf|httpd\.conf|haproxy\.cfg|Dockerfile|openssl\.cnf)$/i;
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.js|.*\.map)$/;

// Each pattern matches only a forced retired version; TLSv1.2 and TLSv1.3 never match.
export const RETIRED_TLS: { re: RegExp; what: string }[] = [
  {
    re: /\bssl_protocols\b[^;\n]*\b(SSLv[23]|TLSv1(?:\.1)?)(?![.\d])/g,
    what: 'nginx ssl_protocols enables a retired version',
  },
  {
    re: /\bSSLProtocol\b[^\n]*\+(SSLv3|TLSv1(?:\.1)?)(?![.\d])/g,
    what: 'Apache SSLProtocol enables a retired version',
  },
  {
    re: /\bssl-min-ver\s+(SSLv3|TLSv1\.[01])\b|\bforce-(sslv3|tlsv10|tlsv11)\b/gi,
    what: 'HAProxy allows a retired version',
  },
  {
    re: /\bminVersion\s*[:=]\s*["'`](TLSv1(?:\.1)?)["'`]/g,
    what: 'Node TLS minVersion is retired',
  },
  {
    re: /\bsecureProtocol\s*[:=]\s*["'`](SSLv3_method|TLSv1_method|TLSv1_1_method)["'`]/g,
    what: 'Node secureProtocol forces a retired version',
  },
  {
    re: /\bmaxVersion\s*[:=]\s*["'`](TLSv1(?:\.1)?)["'`]/g,
    what: 'Node TLS maxVersion caps at a retired version',
  },
  {
    re: /\bssl\.PROTOCOL_(SSLv3|TLSv1(?:_1)?)\b(?!_2)/g,
    what: 'Python ssl forces a retired protocol',
  },
  {
    re: /\bTLSVersion\.(SSLv3|TLSv1(?:_1)?)\b(?!_)/g,
    what: 'Python TLSVersion sets a retired version',
  },
  { re: /\btls\.Version(SSL30|TLS10|TLS11)\b/g, what: 'Go tls config uses a retired version' },
  {
    re: /SSLContext\.getInstance\(\s*"(SSLv3|TLSv1(?:\.1)?)"\s*\)/g,
    what: 'Java SSLContext forces a retired version',
  },
  {
    re: /\b(?:https\.protocols|jdk\.tls\.client\.protocols)\s*=\s*["']?(?:[^\s"']*,)?(TLSv1(?:\.1)?|SSLv3)(?![.\d])/g,
    what: 'Java TLS protocols property enables a retired version',
  },
  {
    re: /\bSecurityProtocolType\.(Ssl3|Tls|Tls11)\b(?!\d)/g,
    what: '.NET SecurityProtocol forces a retired version',
  },
  {
    re: /\bMinProtocol\s*=\s*(SSLv3|TLSv1(?:\.1)?)(?![.\d])/g,
    what: 'OpenSSL MinProtocol is retired',
  },
  {
    re: /\bCURL_SSLVERSION_(SSLv3|TLSv1_0|TLSv1_1)\b|\s--(sslv3|tlsv1\.0|tlsv1\.1)\b/g,
    what: 'curl forces a retired version',
  },
];

const CERT_CHECKS_OFF =
  /\brejectUnauthorized\s*:\s*false\b|\bverify\s*=\s*False\b|\bInsecureSkipVerify\s*:\s*true\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/g;

async function textFiles(root: string): Promise<string[]> {
  return (await walkFiles(root)).filter((f) => TEXT_FILE.test(f) && !SKIP_FILE.test(f));
}

export const tlsCheck: ProofCheck = {
  name: 'tls',
  description:
    'Scan server configs (nginx, Apache, HAProxy, OpenSSL) and client code (Node, Python, Go, Java, .NET, curl) for settings that force TLS 1.0, TLS 1.1 or SSL. Also notes code that switches certificate checks off. Returns evidence, never blocks.',
  inputSchema: { type: 'object', properties: {} },
  run: async (_input, ctx) => {
    const root = readRoot(ctx);
    const files = await textFiles(root);
    const failedItems: string[] = [];
    const notes: string[] = [];
    for (const file of files) {
      const text = await readText(root, file);
      if (!text) continue;
      for (const { re, what } of RETIRED_TLS)
        for (const match of text.matchAll(re))
          failedItems.push(`${file}:${lineOf(text, match.index ?? 0)} ${what}: ${match[0].trim()}`);
      for (const match of text.matchAll(CERT_CHECKS_OFF))
        notes.push(
          `${file}:${lineOf(text, match.index ?? 0)} turns certificate checks off: ${match[0].trim()}`,
        );
    }
    return proofDetail('tls', {
      passedItems:
        failedItems.length === 0 && files.length > 0
          ? [`no forced TLS 1.0, TLS 1.1 or SSL in ${files.length} config and code files`]
          : [],
      failedItems,
      notes: [
        ...notes,
        'TLS libraries and defaults set outside the repo (load balancers, CDN) were not checked',
      ],
    });
  },
};

// Authorization endpoints whose providers require PKCE for the authorization-code flow.
// Sources: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code,
// https://airtable.com/developers/web/api/oauth-reference, https://www.canva.dev/docs/connect/authentication/
export const PKCE_REQUIRED_HOSTS: { host: RegExp; provider: string }[] = [
  { host: /(twitter|x)\.com\/i\/oauth2\/authorize/, provider: 'X (Twitter) OAuth 2.0' },
  { host: /airtable\.com\/oauth2\/v1\/authorize/, provider: 'Airtable' },
  { host: /canva\.com\/api\/oauth\/authorize/, provider: 'Canva Connect' },
];

// Providers that switched password logins off. Sources:
// https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online
// https://support.google.com/accounts/answer/6010255
export const PASSWORD_LOGIN_OFF: {
  host: RegExp;
  provider: string;
  certain: boolean;
  note: string;
}[] = [
  {
    host: /\b(outlook\.office365\.com|outlook\.office\.com|smtp\.office365\.com|imap-mail\.outlook\.com|pop-mail\.outlook\.com|smtp-mail\.outlook\.com)\b/,
    provider: 'Exchange Online',
    certain: true,
    note: 'Basic auth (username and password) is off for EWS, IMAP and POP, and being retired for SMTP AUTH; use OAuth 2.0',
  },
  {
    host: /\b(smtp|imap|pop)\.gmail\.com\b/,
    provider: 'Google',
    certain: false,
    note: 'password sign-in for "less secure apps" is off; an app password or OAuth still works, so a person must say which this is',
  },
];

const AUTH_CODE_FLOW =
  /response_type\s*[=:]\s*["'`]?code\b|["'`]response_type["'`]\s*[:,]\s*["'`]code["'`]|responseType\s*:\s*["'`]code["'`]/g;
const PKCE = /code_challenge|codeChallenge|code_verifier|codeVerifier|\bpkce\w*\s*[:=(]|usePKCE/i;
const PASSWORD_NEAR = /\b(pass(word)?|pwd|auth\s*:\s*\{|AUTH_PASS|SMTP_PASS|IMAP_PASS)\b/i;
const ROPC =
  /grant_type\s*[=:]\s*["'`]?password\b|["'`]grant_type["'`]\s*[:,]\s*["'`]password["'`]/g;

export const loginCheck: ProofCheck = {
  name: 'login',
  description:
    'Check OAuth authorization-code flows for PKCE (required by some providers, recommended by RFC 9700 for all) and look for password logins to providers that switched them off (Exchange Online Basic auth, Google less-secure-app access) and for the password grant. Returns evidence, never blocks.',
  inputSchema: {
    type: 'object',
    properties: {
      requirePkce: {
        type: 'boolean',
        description:
          'Count every authorization-code flow without PKCE as a failure, not only those to providers that require it',
      },
    },
  },
  run: async (input, ctx) => {
    const root = readRoot(ctx);
    const requireAll = optBoolean(input, 'requirePkce') ?? false;
    const files = (await textFiles(root)).filter((f) => !/\.(conf|cnf|ini|xml|tf)$/.test(f));
    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    let flows = 0;
    for (const file of files) {
      const text = await readText(root, file);
      if (!text) continue;
      for (const match of text.matchAll(AUTH_CODE_FLOW)) {
        flows += 1;
        const where = `${file}:${lineOf(text, match.index ?? 0)}`;
        const required = PKCE_REQUIRED_HOSTS.find((p) => p.host.test(text));
        if (PKCE.test(text)) passedItems.push(`${where} authorization-code flow sends PKCE`);
        else if (required)
          failedItems.push(
            `${where} authorization-code flow to ${required.provider} has no PKCE, which it requires`,
          );
        else if (requireAll) failedItems.push(`${where} authorization-code flow has no PKCE`);
        else
          notes.push(
            `${where} authorization-code flow has no PKCE in this file; RFC 9700 recommends it, and an OAuth library may add it`,
          );
      }
      for (const match of text.matchAll(ROPC))
        notes.push(
          `${file}:${lineOf(text, match.index ?? 0)} uses the password grant, which OAuth 2.1 drops and which fails for accounts with MFA`,
        );
      for (const provider of PASSWORD_LOGIN_OFF) {
        const host = provider.host.exec(text);
        if (
          !host ||
          !PASSWORD_NEAR.test(text) ||
          /oauth|xoauth2|accessToken|access_token/i.test(text)
        )
          continue;
        const line = `${file}:${lineOf(text, host.index)} logs in to ${provider.provider} (${host[0]}) with a password: ${provider.note}`;
        if (provider.certain) failedItems.push(line);
        else notes.push(line);
      }
    }
    if (flows === 0) notes.push('no OAuth authorization-code flow found in the repo code');
    if (failedItems.length === 0 && files.length > 0)
      passedItems.push(
        `no password logins to providers that switched them off in ${files.length} files`,
      );
    return proofDetail('login', { passedItems, failedItems, notes });
  },
};

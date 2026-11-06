// Refit never claims that code satisfies a law and never gives legal advice. These helpers let the
// agents check their own wording and let the PR writer clean up anything that slips through.

const CLAIMS: RegExp[] = [
  /\b(?:non-?|fully |now |is |are |be |made )?compliant\b/gi,
  /\bin (?:full )?compliance with\b/gi,
  /\b(?:meets|satisfies|fulfils|fulfills|conforms to) (?:all )?(?:the )?(?:requirements of )?(?:the )?(?:[A-Z][\w.-]*|PCI|WCAG|GDPR|CCPA|PSD2|EAA)\b[^.,;\n]*/g,
  /\blegally (?:safe|sufficient|required to)\b/gi,
];

// Phrases that read as a compliance claim or legal conclusion.
export function findClaims(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of CLAIMS) {
    for (const match of text.matchAll(pattern)) found.add(match[0].trim());
  }
  return [...found];
}

// Last resort when the model's own rewrite still carries a claim: replace the phrase with a
// neutral note, so the text never ships a claim.
export function scrubClaims(text: string): string {
  let out = text;
  for (const pattern of CLAIMS) out = out.replace(pattern, '[claim removed: needs human review]');
  return out;
}

const SECRETS: RegExp[] = [
  /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// Redacts common secret shapes before text is stored or shown. A safety net, not a scanner.
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]',
    );
  }
  return out;
}

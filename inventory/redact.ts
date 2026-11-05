import { redactSecrets } from '../harness/secrets.ts';

const BEARER = /\b(Bearer\s+)[\w+/=.~-]{8,}/gi;
// The harness's own pattern, which folds a key into one line and would shift every line below it.
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Hard limit 4 for the scan and its check: redactSecrets, plus the bearer values it has no pattern for. */
export const redact = (text: string) => redactSecrets(text).replace(BEARER, '$1[redacted]');

/**
 * Redacts a whole file and keeps its line numbers, since a key across lines only matches whole. Lines
 * past `maxLineChars` are cut first, because a long run of one token makes the named-secret pattern
 * quadratic: 1 MB of it hangs for minutes.
 * shortcut: a multi-line env value found in the file still folds, so lines below it shift; handle it
 * if a repo ever commits one.
 */
export const redactFile = (text: string, maxLineChars: number) =>
  redact(
    text
      .replace(PEM, (block) => block.replace(/[^\n]+/g, '[redacted]'))
      .replace(new RegExp(`[^\\n]{${maxLineChars + 1},}`, 'g'), (line) =>
        line.slice(0, maxLineChars),
      ),
  );

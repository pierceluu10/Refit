// shortcut: stand-in for Pierce's scanner and list (P2, P4), so the session can be measured before
// they land. Delete it once rebuild/pierce is in rebuild/integration. Evals only, never the product.
// It reads docs/rebuild/DEAD-APIS.md for model strings and matches them as quoted strings, plus the
// Universal Analytics markers and the Stripe field reads, gated on the version the repo runs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DeadApiEntry, Finding, ScanResult } from '../../harness/findings.ts';

const LIST = path.join(import.meta.dirname, '../../docs/rebuild/DEAD-APIS.md');
const SKIP = /^(node_modules|dist|build|\.next|out|vendor|coverage|\.git|__pycache__|venv|\.venv)$/;
const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|toml|env\.example|env\.sample|ipynb|vue|svelte)$|^\.env\.(example|sample|template)$/;
const LOCK = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|\.min\.js)$/;

type Rule = DeadApiEntry & { patterns: RegExp[]; stripeSince?: string };

const escape = (text: string) =>
  text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.-]*');
const quoted = (name: string) => new RegExp(`["'\`=:]\\s*${escape(name)}["'\`\\s,]`);

function modelRules(): Rule[] {
  const text = readFileSync(LIST, 'utf8');
  const rules: Rule[] = [];
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const provider = section.split('\n')[0].trim().toLowerCase();
    if (!['anthropic', 'openai', 'gemini', 'groq'].includes(provider)) continue;
    const source = /https:\/\/\S+?(?=[) ,]|$)/m.exec(section)?.[0] ?? '';
    const body = section.split('**Not dead yet')[0];
    // A "requires" bullet, with any sub-bullets under it.
    const requires = [...body.matchAll(/^- \*\*Requires:\*\* (.*(?:\n  - .*)*)$/gm)].map((m) =>
      m[1].replace(/\n  - /g, ' '),
    );
    let row = 0;
    for (const line of body.split('\n')) {
      if (!line.startsWith('| `')) continue;
      const cells = line.split('|').map((cell) => cell.trim());
      const names = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      row += 1;
      rules.push({
        id: `${provider}-${row}`,
        provider,
        what: names.join(', '),
        diedOn: cells[2],
        source: { url: source, checkedOn: '2026-11-04' },
        lookFor: names,
        replacement: cells[3],
        requires,
        matchers: [],
        patterns: names.map(quoted),
      });
    }
  }
  return rules;
}

const FIXED: Rule[] = [
  {
    id: 'GA-1',
    provider: 'google-analytics',
    what: 'Universal Analytics',
    diedOn: '2024-07-01',
    source: {
      url: 'https://developers.google.com/analytics/legacy/universal-analytics',
      checkedOn: '2026-11-04',
    },
    lookFor: [
      'google-analytics.com/collect',
      'analytics.js',
      "ga('send'",
      'UA- property IDs',
      'react-ga',
    ],
    replacement:
      'GA4. Server or extension hits use Measurement Protocol: POST https://www.google-analytics.com/mp/collect?measurement_id=G-XXXX&api_secret=SECRET with JSON holding client_id and events [{name, params}]. Web pages use the Google tag (gtag.js) with a G- ID.',
    matchers: [],
    requires: [
      'A GA4 measurement ID and API secret nobody has yet: read them from config and say what a person must set.',
      'The API secret is private; never put it in client code.',
      'Move custom dimensions such as cd1 into event params; event names must follow GA4 rules.',
    ],
    patterns: [
      /google-analytics\.com\/(collect|batch)\b(?!\/)/,
      /google-analytics\.com\/analytics\.js/,
      /\bga\(\s*['"](create|send)['"]/,
      /["']UA-\d{4,}-\d+["']/,
      /["']react-ga["']/,
      /["']universal-analytics["']/,
    ],
  },
  {
    id: 'OA-2',
    provider: 'openai',
    what: 'Assistants API',
    diedOn: '2026-08-26',
    source: { url: 'https://platform.openai.com/docs/deprecations', checkedOn: '2026-11-04' },
    lookFor: ['/v1/assistants', '/v1/threads', 'client.beta.assistants', 'client.beta.threads'],
    replacement: 'Responses API and Conversations API.',
    requires: [
      'Real rework: threads and runs do not map one to one. See the Assistants migration guide.',
    ],
    matchers: [],
    patterns: [
      /\bbeta\.(assistants|threads)\b/,
      /\/v1\/(assistants|threads)\b/,
      /assistants=v[12]\b/,
    ],
  },
  ...(
    [
      [
        'ST-1',
        'subscription.current_period_start and current_period_end',
        /\b(subscription|sub)\w*\.current_period_(start|end)\b/i,
        'subscription.items.data[].current_period_start and current_period_end',
        '2025-03-31',
        'Items can have different periods: choose one deliberately, with a comment, and handle an empty list.',
        'adds',
      ],
      [
        'ST-2',
        'invoice.subscription and friends',
        /\binvoice\w*\.(subscription|subscription_details|subscription_proration_date|quote)\b/i,
        'invoice.parent.subscription_details.subscription (check invoice.parent.type is subscription_details)',
        '2025-03-31',
        'The field can be a string or an expanded object, as before.',
        'adds',
      ],
      [
        'ST-3',
        'invoice.payment_intent and invoice.charge',
        /\b(invoice\w*|latest_invoice)\.(payment_intent|charge)\b/i,
        'expand payments and read invoice.payments; for Payment Element, invoice.confirmation_secret.client_secret',
        '2025-03-31',
        'One invoice can have several payments.',
        'adds',
      ],
      [
        'ST-5',
        'invoices.retrieveUpcoming',
        /\binvoices\.(retrieveUpcoming|listUpcomingLines|upcoming)\b/,
        'invoices.createPreview',
        '2025-03-31',
        '',
        'adds',
      ],
    ] as const
  ).map(([id, what, pattern, replacement, since, require]) => ({
    id,
    provider: 'stripe',
    what,
    diedOn: since,
    source: { url: 'https://docs.stripe.com/changelog/basil', checkedOn: '2026-11-04' },
    lookFor: [what],
    versions: `at or after ${since}.basil`,
    replacement,
    requires: require ? [require] : [],
    matchers: [],
    patterns: [pattern],
    stripeSince: since,
  })),
];

export const standinList = (): Rule[] => [...modelRules(), ...FIXED];

const classOf = (file: string, line: string): Finding['matchClass'] => {
  if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return 'comment';
  if (/(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?)(\/|$)|\.(test|spec)\.\w+$/.test(file))
    return 'test';
  if (/(^|\/)(docs?|examples?|samples?)\//.test(file)) return 'comment';
  return 'live';
};

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.test(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full, { throwIfNoEntry: false });
    if (info?.isDirectory()) walk(root, full, out);
    else if (info?.isFile() && info.size < 500_000 && CODE.test(name) && !LOCK.test(name))
      out.push(full);
  }
  return out;
}

// The Stripe API version the repo runs: its pin, else the release its SDK major sends.
function stripeVersion(texts: string[], manifest: string): string | undefined {
  const pin = texts
    .flatMap((text) =>
      [...text.matchAll(/apiVersion:\s*["'](\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]),
    )
    .sort()[0];
  if (pin) return pin;
  const major = /"stripe":\s*"[\^~]?(\d+)/.exec(manifest)?.[1];
  return major && Number(major) >= 18 ? '2025-03-31' : undefined;
}

export function standinScan(root: string, list: Rule[] = standinList()): ScanResult {
  const files = walk(root).map((file) => ({
    file: path.relative(root, file),
    text: readFileSync(file, 'utf8'),
  }));
  const manifest = files.find((f) => f.file === 'package.json')?.text ?? '';
  const stripe = stripeVersion(
    files.map((f) => f.text),
    manifest,
  );
  const findings: Finding[] = [];
  for (const { file, text } of files) {
    const lines = text.split('\n');
    for (const rule of list) {
      if (rule.stripeSince && !(stripe && stripe >= rule.stripeSince)) continue;
      lines.forEach((line, index) => {
        if (line.length > 1000 || !rule.patterns.some((p) => p.test(`${line} `))) return;
        findings.push({
          entryId: rule.id,
          file,
          line: index + 1,
          matchClass: classOf(file, line),
          ...(rule.stripeSince && stripe ? { version: stripe } : {}),
        });
      });
    }
  }
  const live = findings.filter((finding) => finding.matchClass === 'live');
  // Comments never start a fix; a test that hard-codes the name goes with the live finding it pins.
  return {
    findings: findings.filter((finding) => finding.matchClass !== 'comment'),
    unlistedProviders: [],
    clean: live.length === 0,
  };
}

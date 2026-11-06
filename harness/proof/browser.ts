// The headless-browser runner behind the accessibility and payment-page checks. Pages are repo code,
// so the browser runs inside the sandbox, next to the repo's own server: a scan script is written to
// the sandbox's /tmp and run with Node there. Playwright and a Chromium must be installed in the
// sandbox; axe-core is installed into /tmp with scripts off when it is missing. Without a browser the
// scan reports `skipped` and the checks say so.
import { randomBytes } from 'node:crypto';
import type { Sandbox } from '../types.ts';
import { tail } from './util.ts';

export const AXE_CORE_VERSION = '4.10.3';
const RESULT_MARK = 'REFIT_PROOF_RESULT ';
const DEPS_DIR = '/tmp/refit-proof-deps';

export type AxeViolation = { id: string; impact?: string; help: string; targets: string[] };
export type PageScan = {
  url: string;
  violations?: AxeViolation[];
  scripts?: string[];
  error?: string;
};
export type BrowserScan = { skipped?: string; pages: PageScan[]; command: string; log: string };

export type ScanOptions = {
  mode: 'axe' | 'scripts';
  urls: string[]; // http(s) URLs, or paths of HTML files relative to the repo root
  startCommand?: string; // starts the repo's server in the background for the scan
  waitMs?: number; // how long to wait for each http URL to answer
};

// Runs in the sandbox. Plain ESM so it needs nothing but Node, Playwright and (for axe) axe-core.
const SCAN_SCRIPT = String.raw`
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const MARK = ${JSON.stringify(RESULT_MARK)};
const out = (value) => { process.stdout.write('\n' + MARK + JSON.stringify(value) + '\n'); process.exit(0); };
const require = createRequire(path.join(process.cwd(), 'refit-proof.cjs'));
const bases = [process.cwd(), ${JSON.stringify(DEPS_DIR)}, process.env.REFIT_NPM_GLOBAL || ''].filter(Boolean);
const load = (name) => { for (const base of bases) { try { return require(require.resolve(name, { paths: [base] })); } catch {} } return null; };
const pw = load('playwright') || load('playwright-core');
if (!pw) out({ skipped: 'Playwright is not installed in the sandbox', pages: [] });
const axe = cfg.mode === 'axe' ? load('axe-core') : null;
if (cfg.mode === 'axe' && !axe) out({ skipped: 'axe-core could not be installed in the sandbox', pages: [] });
let browser;
try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); }
catch (error) { out({ skipped: 'no headless browser in the sandbox: ' + String(error && error.message || error).split('\n')[0], pages: [] }); }
const pages = [];
for (const raw of cfg.urls) {
  const url = /^[a-z]+:/i.test(raw) ? raw : pathToFileURL(path.resolve(raw)).href;
  const page = await browser.newPage();
  const scripts = new Set();
  page.on('request', (request) => { if (request.resourceType() === 'script') scripts.add(request.url()); });
  try {
    const deadline = Date.now() + (cfg.waitMs || 60000);
    for (;;) {
      try { await page.goto(url, { waitUntil: 'load', timeout: 30000 }); break; }
      catch (error) { if (!/^https?:/.test(url) || Date.now() > deadline) throw error; await new Promise((r) => setTimeout(r, 1000)); }
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (cfg.mode === 'axe') {
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(async () => await window.axe.run(document));
      pages.push({ url: raw, violations: result.violations.map((v) => ({ id: v.id, impact: v.impact || undefined, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) })) });
    } else {
      const inline = await page.$$eval('script:not([src])', (nodes) => nodes.map((n) => n.textContent || ''));
      for (const text of inline) if (text.trim()) scripts.add('inline:sha256-' + createHash('sha256').update(text).digest('hex').slice(0, 16));
      pages.push({ url: raw, scripts: [...scripts].sort() });
    }
  } catch (error) {
    pages.push({ url: raw, error: String(error && error.message || error).split('\n')[0] });
  }
  await page.close();
}
await browser.close();
out({ pages });
`;

export function scanCommand(options: ScanOptions): string {
  const id = randomBytes(4).toString('hex');
  const script = `/tmp/refit-proof-scan-${id}.mjs`;
  const cfg = Buffer.from(
    JSON.stringify({ mode: options.mode, urls: options.urls, waitMs: options.waitMs }),
  ).toString('base64');
  const encoded = Buffer.from(SCAN_SCRIPT).toString('base64');
  const install =
    options.mode === 'axe'
      ? `(node -e "require.resolve('axe-core')" >/dev/null 2>&1 || test -d ${DEPS_DIR}/node_modules/axe-core || npm install --prefix ${DEPS_DIR} --no-save --no-audit --no-fund --ignore-scripts --silent axe-core@${AXE_CORE_VERSION} >/dev/null 2>&1); `
      : '';
  const scan = `REFIT_NPM_GLOBAL="$(npm root -g 2>/dev/null)" node ${script} ${cfg}`;
  const body = options.startCommand
    ? `set -m; (${options.startCommand}) > /tmp/refit-proof-server-${id}.log 2>&1 & SERVER=$!; ${scan}; CODE=$?; kill -TERM -$SERVER 2>/dev/null; kill -TERM $SERVER 2>/dev/null; tail -c 1500 /tmp/refit-proof-server-${id}.log >&2; exit $CODE`
    : scan;
  return `printf %s ${encoded} | base64 -d > ${script} && ${install}${body}`;
}

// What the audit trail shows instead of the base64 blob.
export function describeScan(options: ScanOptions): string {
  return [
    options.startCommand ? `start in background: ${options.startCommand}` : undefined,
    `headless Chromium ${options.mode === 'axe' ? `axe-core@${AXE_CORE_VERSION} scan` : 'script inventory'} of ${options.urls.join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function parseScanOutput(
  stdout: string,
): { skipped?: string; pages: PageScan[] } | undefined {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_MARK));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_MARK.length)) as { skipped?: string; pages: PageScan[] };
  } catch {
    return undefined;
  }
}

export async function runBrowserScan(sandbox: Sandbox, options: ScanOptions): Promise<BrowserScan> {
  const command = describeScan(options);
  const result = await sandbox.exec(scanCommand(options), { timeoutMs: 10 * 60 * 1000 });
  const log = tail(result.stderr || result.stdout.split(RESULT_MARK)[0]);
  const parsed = parseScanOutput(result.stdout);
  if (!parsed) {
    const reason =
      result.code === 127 || /node: (not found|command not found)/.test(result.stderr)
        ? 'Node is not available in the sandbox'
        : `the scan gave no result (exit ${result.code}${result.timedOut ? ', timed out' : ''})`;
    return { skipped: reason, pages: [], command, log };
  }
  return { ...parsed, command, log };
}

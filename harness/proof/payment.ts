// Payment pages: list every script a checkout page loads, before and after the change, so new ones can
// be authorized (PCI DSS v4.0 requirement 6.4.3 asks for an inventory and authorization of every
// payment-page script). In a browser when the sandbox has one; otherwise from the page sources.
import { beforeAndAfter } from './baseline.ts';
import { browserInputSchema, scanOptions } from './accessibility.ts';
import { runBrowserScan } from './browser.ts';
import type { Sandbox } from '../types.ts';
import type { ProofCheck } from './types.ts';
import { lineOf, optStrings, proofDetail, readText, walkFiles } from './util.ts';

const PAGE_FILE = /\.(html?|jsx|tsx|vue|svelte|astro|erb|ejs|hbs|php|liquid|njk)$/;
const CHECKOUT = /checkout|payment|billing|(^|[/_.-])pay([/_.-]|$)|cart/i;
const SCRIPT_SOURCES = [
  /<script\b[^>]*\bsrc\s*=\s*["'{`]+([^"'`}]+)["'`}]/gi, // <script src="..."> and JSX <Script src={"..."}>
  /\.src\s*=\s*["'`]([^"'`]+\.js[^"'`]*)["'`]/g, // script.src = '...'
  /\bloadScript\(\s*["'`]([^"'`]+)["'`]/g,
];

export type StaticScript = { page: string; line: number; src: string };

export function scriptsInSource(page: string, text: string): StaticScript[] {
  const out: StaticScript[] = [];
  for (const re of SCRIPT_SOURCES)
    for (const match of text.matchAll(re))
      out.push({ page, line: lineOf(text, match.index ?? 0), src: match[1].trim() });
  const inline = (text.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>(?!\s*<\/script>)/gi) ?? []).length;
  if (inline) out.push({ page, line: 0, src: `inline scripts: ${inline}` });
  return out;
}

async function staticInventory(sandbox: Sandbox, pages: string[]): Promise<Map<string, string[]>> {
  const files = pages.length
    ? pages
    : (await walkFiles(sandbox.dir)).filter((f) => PAGE_FILE.test(f) && CHECKOUT.test(f));
  const out = new Map<string, string[]>();
  for (const file of files) {
    const text = await readText(sandbox.dir, file);
    if (text === undefined) continue;
    out.set(file, [...new Set(scriptsInSource(file, text).map((s) => s.src))].sort());
  }
  return out;
}

export function compareInventories(before: Map<string, string[]>, after: Map<string, string[]>) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const [page, scripts] of after) {
    const old = new Set(before.get(page) ?? []);
    for (const s of scripts) if (!old.has(s)) added.push(`${page}: ${s}`);
  }
  for (const [page, scripts] of before) {
    const now = new Set(after.get(page) ?? []);
    for (const s of scripts) if (!now.has(s)) removed.push(`${page}: ${s}`);
  }
  return { added, removed };
}

type Inventory = {
  mode: 'browser' | 'source';
  pages: Map<string, string[]>;
  command: string;
  log?: string;
  skippedBrowser?: string;
  errors: string[];
};

export const paymentScriptsCheck: ProofCheck = {
  name: 'payment-scripts',
  description:
    'List every script loaded on checkout and payment pages, before and after the change, and flag scripts the change added (PCI DSS v4.0 6.4.3). Loads the pages in a headless browser in the sandbox when urls are given and a browser is there; otherwise reads the page sources. Returns evidence, never blocks.',
  inputSchema: {
    type: 'object',
    properties: {
      ...browserInputSchema,
      pages: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Checkout page source files to read when no browser runs. Default: page files whose path mentions checkout, payment, billing, pay or cart',
      },
    },
  },
  run: async (input, ctx) => {
    const urls = optStrings(input, 'urls');
    const pages = optStrings(input, 'pages');
    const options = await scanOptions({ ...input, urls }, ctx, 'scripts');
    const phase = input.phase === 'before' || input.phase === 'after' ? input.phase : undefined;
    const measure = async (sandbox: Sandbox): Promise<Inventory> => {
      if (urls.length) {
        const scan = await runBrowserScan(sandbox, { ...options, urls });
        if (!scan.skipped)
          return {
            mode: 'browser',
            pages: new Map(
              scan.pages.filter((p) => p.scripts).map((p) => [p.url, p.scripts ?? []]),
            ),
            command: scan.command,
            log: scan.log,
            errors: scan.pages
              .filter((p) => p.error)
              .map((p) => `${p.url} did not load: ${p.error}`),
          };
        const fromSource = await staticInventory(sandbox, pages);
        return {
          mode: 'source',
          pages: fromSource,
          command: 'read checkout page sources',
          log: scan.log,
          skippedBrowser: scan.skipped,
          errors: [],
        };
      }
      return {
        mode: 'source',
        pages: await staticInventory(sandbox, pages),
        command: 'read checkout page sources',
        errors: [],
      };
    };
    let run: Awaited<ReturnType<typeof beforeAndAfter<Inventory>>>;
    try {
      run = await beforeAndAfter(
        ctx,
        `scripts ${urls.join(' ')} ${pages.join(' ')}`,
        phase,
        measure,
      );
    } catch (error) {
      return proofDetail('payment-scripts', {
        skipped: `no sandbox: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const { before, after } = run;
    const passedItems: string[] = [];
    const failedItems: string[] = [...after.errors];
    const notes: string[] = [];
    if (after.skippedBrowser)
      notes.push(
        `browser scan skipped (${after.skippedBrowser}); listed scripts from the page sources instead, which misses scripts added at runtime`,
      );
    for (const [page, scripts] of after.pages)
      notes.push(`${page} loads ${scripts.length ? scripts.join(', ') : 'no scripts'}`);
    if (after.pages.size === 0)
      notes.push('no checkout or payment pages found; pass urls or pages');
    if (before && before.value.mode !== after.mode)
      notes.push(
        `baseline was a ${before.value.mode} inventory and this one is a ${after.mode} inventory, so they are not comparable`,
      );
    else if (before) {
      const { added, removed } = compareInventories(before.value.pages, after.pages);
      for (const a of added)
        failedItems.push(
          `new script on a payment page: ${a}; authorize it and record why it is needed`,
        );
      for (const r of removed) notes.push(`script no longer loaded: ${r}`);
      if (added.length === 0 && after.pages.size > 0)
        passedItems.push(`no new scripts on payment pages compared with ${before.source}`);
    } else
      notes.push(
        run.recordedNow
          ? 'recorded as the baseline; call again after editing to compare'
          : 'no baseline, so this is an inventory only',
      );
    return proofDetail('payment-scripts', {
      commands: [after.command],
      passedItems,
      failedItems,
      notes: [
        ...notes,
        'whether each script is authorized and its integrity assured is for a person to confirm',
      ],
      logTail: after.log || undefined,
      ...(after.pages.size === 0 || (!before && failedItems.length === 0)
        ? { passed: 'unknown' as const }
        : {}),
    });
  },
};

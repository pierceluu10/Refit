// Accessibility: an axe-core scan of the app's pages in a headless browser in the sandbox, before and
// after the change, counting only violations the change added. Rule context: WCAG 2.1 AA, which the
// European Accessibility Act points to through EN 301 549.
import { beforeAndAfter } from './baseline.ts';
import {
  runBrowserScan,
  type AxeViolation,
  type BrowserScan,
  type ScanOptions,
} from './browser.ts';
import type { ProofCheck, ProofContext } from './types.ts';
import { optNumber, optString, optStrings, proofDetail, readRoot, walkFiles } from './util.ts';

export function violationKeys(violations: AxeViolation[]): Map<string, AxeViolation> {
  const out = new Map<string, AxeViolation>();
  for (const v of violations)
    for (const target of v.targets.length ? v.targets : ['(page)'])
      out.set(`${v.id} @ ${target}`, v);
  return out;
}

// Violations in `after` whose rule and element were not in `before`, per page.
export function newViolations(
  before: BrowserScan,
  after: BrowserScan,
): { url: string; key: string; v: AxeViolation }[] {
  const out: { url: string; key: string; v: AxeViolation }[] = [];
  for (const page of after.pages) {
    const old = violationKeys(before.pages.find((p) => p.url === page.url)?.violations ?? []);
    for (const [key, v] of violationKeys(page.violations ?? []))
      if (!old.has(key)) out.push({ url: page.url, key, v });
  }
  return out;
}

export async function defaultPages(root: string): Promise<string[]> {
  const files = await walkFiles(root);
  const built = files.filter((f) => /^(dist|build|out|public|_site|site)\/.*\.html$/.test(f));
  const top = files.filter((f) => /^[^/]+\.html$/.test(f));
  return [...new Set([...top, ...built])].slice(0, 10);
}

export async function scanOptions(
  input: Record<string, unknown>,
  ctx: ProofContext,
  mode: ScanOptions['mode'],
): Promise<ScanOptions> {
  const urls = optStrings(input, 'urls');
  return {
    mode,
    urls: urls.length ? urls : await defaultPages(readRoot(ctx)),
    startCommand: optString(input, 'startCommand'),
    waitMs: optNumber(input, 'waitMs'),
  };
}

export const browserInputSchema = {
  urls: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Pages to load: http://localhost URLs served by startCommand, or HTML file paths relative to the repo. Default: top-level and built HTML files',
  },
  startCommand: {
    type: 'string',
    description:
      'Starts the app in the sandbox for the scan, e.g. "npm run build && npx serve -l 4173 dist"',
  },
  waitMs: { type: 'number', description: 'How long to wait for each URL to answer. Default 60000' },
  phase: {
    type: 'string',
    enum: ['before', 'after'],
    description:
      'Call with "before" before editing to record the baseline, then "after". Default: the first call is the baseline',
  },
};

export const accessibilityCheck: ProofCheck = {
  name: 'accessibility',
  description:
    "Run an axe-core accessibility scan of the app's pages in a headless browser in the sandbox, before and after the change, and count only new violations. Skips cleanly when the sandbox has no browser. Returns evidence, never blocks.",
  inputSchema: { type: 'object', properties: browserInputSchema },
  run: async (input, ctx) => {
    const options = await scanOptions(input, ctx, 'axe');
    if (options.urls.length === 0)
      return proofDetail('accessibility', {
        notes: ['no pages to scan: pass urls, with a startCommand for a server'],
        passed: 'unknown',
      });
    const phase = input.phase === 'before' || input.phase === 'after' ? input.phase : undefined;
    let run: Awaited<ReturnType<typeof beforeAndAfter<BrowserScan>>>;
    try {
      run = await beforeAndAfter(ctx, `axe ${options.urls.join(' ')}`, phase, (sandbox) =>
        runBrowserScan(sandbox, options),
      );
    } catch (error) {
      return proofDetail('accessibility', {
        skipped: `no sandbox: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const { before, after } = run;
    const commands = [after.command];
    const skipped = after.skipped ?? before?.value.skipped;
    if (skipped)
      return proofDetail('accessibility', { commands, skipped, logTail: after.log || undefined });

    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    for (const page of after.pages) {
      if (page.error) failedItems.push(`${page.url} did not load: ${page.error}`);
      else notes.push(`${page.url}: ${page.violations?.length ?? 0} axe rules violated`);
    }
    if (before) {
      const added = newViolations(before.value, after);
      for (const { url, key, v } of added)
        failedItems.push(`new on ${url}: ${key} (${v.impact ?? 'n/a'}): ${v.help}`);
      const fixed = newViolations(after, before.value);
      if (fixed.length) passedItems.push(`${fixed.length} violations from before are gone`);
      if (added.length === 0 && after.pages.some((p) => !p.error))
        passedItems.push(`no new axe violations compared with ${before.source}`);
      notes.push(`baseline from ${before.source}`);
    } else {
      const total = after.pages.reduce((n, p) => n + (p.violations?.length ?? 0), 0);
      notes.push(
        run.recordedNow
          ? 'recorded as the baseline; call again after editing to count new violations'
          : 'no baseline, so every violation is listed',
      );
      for (const page of after.pages)
        for (const [key, v] of violationKeys(page.violations ?? []))
          notes.push(`${page.url}: ${key} (${v.impact ?? 'n/a'}): ${v.help}`);
      if (total === 0 && after.pages.some((p) => !p.error)) passedItems.push('no axe violations');
      return proofDetail('accessibility', {
        commands,
        passedItems,
        failedItems,
        notes: [
          ...notes,
          'automated scans find only part of WCAG issues; keyboard, screen reader and content checks need a person',
        ],
        logTail: after.log || undefined,
        ...(total > 0 && failedItems.length === 0 ? { passed: 'unknown' as const } : {}),
      });
    }
    return proofDetail('accessibility', {
      commands,
      passedItems,
      failedItems,
      notes: [
        ...notes,
        'automated scans find only part of WCAG issues; keyboard, screen reader and content checks need a person',
      ],
      logTail: after.log || undefined,
    });
  },
};

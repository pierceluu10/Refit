import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandbox } from '../sandbox.ts';
import { accessibilityCheck, newViolations } from './accessibility.ts';
import { clearProofBaselines } from './baseline.ts';
import { parseScanOutput, scanCommand, type BrowserScan } from './browser.ts';
import { paymentScriptsCheck } from './payment.ts';
import { fakeSandbox, fixture } from './test-helpers.ts';

const MARK = 'REFIT_PROOF_RESULT ';
const answer = (value: unknown) => ({
  code: 0,
  stdout: `noise\n${MARK}${JSON.stringify(value)}\n`,
});

afterEach(() => clearProofBaselines());

describe('browser scan plumbing', () => {
  it('parses the marked result line and ignores the rest', () => {
    expect(parseScanOutput(`x\n${MARK}{"pages":[]}\n`)).toEqual({ pages: [] });
    expect(parseScanOutput('no result')).toBeUndefined();
  });

  it('starts the server in its own process group and stops it', () => {
    const command = scanCommand({
      mode: 'axe',
      urls: ['http://localhost:4173/'],
      startCommand: 'npm run preview',
    });
    expect(command).toContain('set -m; (npm run preview)');
    expect(command).toContain('kill -TERM -$SERVER');
    expect(command).toContain('axe-core@');
  });

  it('counts only violations the change added', () => {
    const v = (id: string, targets: string[]) => ({ id, help: id, targets });
    const before: BrowserScan = {
      pages: [{ url: 'a', violations: [v('image-alt', ['img'])] }],
      command: '',
      log: '',
    };
    const after: BrowserScan = {
      pages: [{ url: 'a', violations: [v('image-alt', ['img']), v('button-name', ['button'])] }],
      command: '',
      log: '',
    };
    expect(newViolations(before, after).map((n) => n.key)).toEqual(['button-name @ button']);
  });
});

describe('accessibility proof with a scripted sandbox', () => {
  it('records the first call as the baseline and compares the second', async () => {
    let violations = [
      {
        id: 'image-alt',
        impact: 'critical',
        help: 'Images must have alternate text',
        targets: ['img'],
      },
    ];
    const sandbox = fakeSandbox(fixture('web'), () =>
      answer({ pages: [{ url: 'index.html', violations }] }),
    );
    const ctx = { repoDir: sandbox.dir, sandbox };
    const first = await accessibilityCheck.run({ urls: ['index.html'] }, ctx);
    expect(first.passed).toBe('unknown');
    expect(first.notes.join('\n')).toContain('recorded as the baseline');
    violations = [
      ...violations,
      {
        id: 'button-name',
        impact: 'critical',
        help: 'Buttons must have discernible text',
        targets: ['button'],
      },
    ];
    const second = await accessibilityCheck.run({ urls: ['index.html'] }, ctx);
    expect(second.passed).toBe(false);
    expect(second.failedItems).toEqual([
      'new on index.html: button-name @ button (critical): Buttons must have discernible text',
    ]);
    expect(second.notes).toContain('baseline from the earlier call made before the edit');
  });

  it('skips cleanly when the sandbox has no browser', async () => {
    const sandbox = fakeSandbox(fixture('web'), () =>
      answer({ skipped: 'Playwright is not installed in the sandbox', pages: [] }),
    );
    const result = await accessibilityCheck.run(
      { urls: ['index.html'] },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.passed).toBe('unknown');
    expect(result.evidence[0]).toBe('skipped: Playwright is not installed in the sandbox');
  });

  it('skips cleanly when there is no Node in the sandbox', async () => {
    const sandbox = fakeSandbox(fixture('web'), () => ({
      code: 127,
      stderr: 'sh: node: not found',
    }));
    const result = await accessibilityCheck.run(
      { urls: ['index.html'] },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.skipped).toBe('Node is not available in the sandbox');
  });

  it('finds the HTML pages itself when none are given', async () => {
    const sandbox = fakeSandbox(fixture('web'), () => answer({ pages: [] }));
    await accessibilityCheck.run({}, { repoDir: sandbox.dir, sandbox });
    const cfg = /node \S+\.mjs (\S+)/.exec(sandbox.commands[0])?.[1] ?? '';
    expect(JSON.parse(Buffer.from(cfg, 'base64').toString()).urls).toEqual(['index.html']);
  });
});

describe('payment scripts proof', () => {
  it('lists checkout scripts from the sources and flags the ones the change added', async () => {
    const result = await paymentScriptsCheck.run(
      {},
      {
        repoDir: fixture('web-new-script'),
        baselineDir: fixture('web'),
        createSandbox: async (dir) => fakeSandbox(dir),
      },
    );
    expect(result.passed).toBe(false);
    expect(result.failedItems).toEqual([
      'new script on a payment page: checkout/index.html: https://cdn.example.test/analytics.js; authorize it and record why it is needed',
    ]);
    expect(result.notes.join('\n')).toContain(
      'checkout/index.html loads https://cdn.example.test/analytics.js, https://js.stripe.com/v3/, inline scripts: 1',
    );
  });

  it('passes when the scripts did not change', async () => {
    const result = await paymentScriptsCheck.run(
      {},
      {
        repoDir: fixture('web'),
        baselineDir: fixture('web'),
        createSandbox: async (dir) => fakeSandbox(dir),
      },
    );
    expect(result.passed).toBe(true);
  });

  it('falls back to the sources when the browser is missing, and says so', async () => {
    const sandbox = fakeSandbox(fixture('web'), () =>
      answer({ skipped: 'no headless browser in the sandbox: launch failed', pages: [] }),
    );
    const result = await paymentScriptsCheck.run(
      { urls: ['checkout/index.html'], pages: ['checkout/index.html'] },
      { repoDir: sandbox.dir, sandbox },
    );
    expect(result.notes.join('\n')).toContain(
      'browser scan skipped (no headless browser in the sandbox: launch failed)',
    );
    expect(result.passed).toBe('unknown');
  });
});

// A real headless-browser run in a local sandbox. Skips when Playwright or its Chromium is missing,
// or when axe-core cannot be installed (no network).
const globalRoot = (() => {
  try {
    return execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
const hasPlaywright = !!globalRoot && fs.existsSync(path.join(globalRoot, 'playwright'));

describe.skipIf(!hasPlaywright)('real headless browser', () => {
  it('counts the new axe violation between two copies', { timeout: 300_000 }, async (t) => {
    const result = await accessibilityCheck.run(
      { urls: ['index.html'] },
      {
        repoDir: fixture('a11y-after'),
        baselineDir: fixture('a11y-before'),
        createSandbox: (dir) => createSandbox(dir, { mode: 'local' }),
      },
    );
    if (result.skipped) t.skip();
    expect(result.passed).toBe(false);
    expect(
      result.failedItems.some((f) => f.startsWith('new on index.html: button-name @ button')),
    ).toBe(true);
    expect(result.failedItems.some((f) => f.includes('image-alt'))).toBe(false);
  });
});

// Helpers every proof check shares: reading the repo, running commands in the sandbox and writing
// evidence for the audit trail. Nothing here decides anything; it only gathers and formats.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSandbox } from '../sandbox.ts';
import { redactSecrets } from '../secrets.ts';
import type { ExecResult, Sandbox } from '../types.ts';
import type { HostExecResult, ProofContext, ProofDetail } from './types.ts';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.gradle',
  'Pods',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.terraform',
  'DerivedData',
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const LOG_TAIL_CHARS = 1500;

// Every file under root, relative and with forward slashes, skipping dependency and build caches.
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return out;
}

export async function readText(root: string, file: string): Promise<string | undefined> {
  try {
    const full = path.join(root, file);
    const stat = await fs.stat(full);
    if (stat.size > MAX_FILE_BYTES) return undefined;
    return await fs.readFile(full, 'utf8');
  } catch {
    return undefined;
  }
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function tail(text: string, chars = LOG_TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed;
}

export function execLog(result: ExecResult | HostExecResult): string {
  return tail([result.stdout, result.stderr].filter(Boolean).join('\n'));
}

// Builds the result: `passed` is false when anything failed, true when something passed and nothing
// failed, and 'unknown' when the check could not look (skipped, or found nothing to judge).
export function proofDetail(
  check: string,
  parts: {
    commands?: string[];
    passedItems?: string[];
    failedItems?: string[];
    notes?: string[];
    logTail?: string;
    skipped?: string;
    passed?: boolean | 'unknown';
  },
): ProofDetail {
  const commands = parts.commands ?? [];
  const passedItems = parts.passedItems ?? [];
  const failedItems = parts.failedItems ?? [];
  const notes = parts.notes ?? [];
  const passed =
    parts.passed ??
    (parts.skipped
      ? 'unknown'
      : failedItems.length > 0
        ? false
        : passedItems.length > 0
          ? true
          : 'unknown');
  const evidence = [
    ...(parts.skipped ? [`skipped: ${parts.skipped}`] : []),
    ...commands.map((c) => `command: ${c}`),
    ...passedItems.map((p) => `passed: ${p}`),
    ...failedItems.map((f) => `failed: ${f}`),
    ...notes.map((n) => `note: ${n}`),
    ...(parts.logTail ? [`log tail: ${parts.logTail}`] : []),
  ].map((line) => redactSecrets(line));
  return {
    check,
    passed,
    evidence,
    commands: commands.map((c) => redactSecrets(c)),
    passedItems: passedItems.map((p) => redactSecrets(p)),
    failedItems: failedItems.map((f) => redactSecrets(f)),
    notes: notes.map((n) => redactSecrets(n)),
    ...(parts.logTail ? { logTail: redactSecrets(parts.logTail) } : {}),
    ...(parts.skipped ? { skipped: parts.skipped } : {}),
  };
}

// Runs fn with the context's sandbox, or with a fresh one made from repoDir and disposed afterwards.
export async function withSandbox<T>(
  ctx: ProofContext,
  fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  if (ctx.sandbox) return fn(ctx.sandbox);
  const sandbox = await (ctx.createSandbox ?? createSandbox)(ctx.repoDir);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose().catch(() => undefined);
  }
}

// The directory the check reads: the sandbox's copy when there is one, so reads see the agent's edits.
export function readRoot(ctx: ProofContext): string {
  return ctx.sandbox?.dir ?? ctx.repoDir;
}

export async function hasCommand(sandbox: Sandbox, name: string): Promise<boolean> {
  const result = await sandbox.exec(`command -v ${shellQuote(name)}`, { timeoutMs: 20_000 });
  return result.code === 0 && result.stdout.trim().length > 0;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hostExec(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<HostExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
        resolve({
          code,
          stdout: redactSecrets(String(stdout)),
          stderr: redactSecrets(String(stderr) || (error && !stderr ? error.message : '')),
        });
      },
    );
  });
}

// Input helpers: tools get untyped JSON from the model, so read it leniently.
export function optString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

export function optStrings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

export function optBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

// '1.25' < '1.29'; '3.10' > '3.9'. Non-numeric parts compare as 0.
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

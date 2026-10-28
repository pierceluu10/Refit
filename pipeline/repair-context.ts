import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TYPE_CHECK_STARTED } from './check-selection.ts';
import { typeErrorKeys } from './type-errors.ts';

const execute = promisify(execFile);
const TYPE_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const SOURCE_LINES = 4;
const MAX_ERRORS = 20;
const MAX_NAMES = 8;
const MAX_DECLARATION_LINES = 80;
const MAX_DECLARATION_CHARACTERS = 4_000;
const MAX_TYPE_CHARACTERS = 16_000;
const STRIPE_VERSION = /\b\d{4}-\d{2}-\d{2}\.[a-z]+\b/;

interface TypeError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

// Founder decision (2026-10-28, docs/AI-REPAIR.md): repair sees only the errors the patch
// introduced. Drops each type error the original code's check already reported, with the
// indented lines tsc prints under it, from the patched check's log.
export function withoutBaselineErrors(
  baseline: { stdout: string; stderr: string },
  output: string,
) {
  const before = typeErrorKeys(baseline);
  if (!before.size) return output;
  const start = output.lastIndexOf(TYPE_CHECK_STARTED);
  let dropping = false;
  let offset = 0;
  return output
    .split('\n')
    .filter((line) => {
      const at = offset;
      offset += line.length + 1;
      // Tests before a chain's type check keep their output unchanged.
      if (at < start) return true;
      const match = TYPE_ERROR.exec(line.trim());
      if (match) dropping = before.has(`${match[1]} ${match[4]} ${match[5]}`);
      else if (!/^\s/.test(line)) dropping = false;
      return !dropping;
    })
    .join('\n');
}

// Each introduced error with the source around it in the failed candidate.
export function errorSources(errors: TypeError[], files: { path: string; content: string }[]) {
  return errors.slice(0, MAX_ERRORS).map((error) => {
    const lines = files.find((file) => file.path === error.file)?.content.split('\n') ?? [];
    const first = Math.max(1, error.line - SOURCE_LINES);
    const source = lines
      .slice(first - 1, error.line + SOURCE_LINES)
      .map((text, index) => `${first + index}${first + index === error.line ? '>' : ' '} ${text}`)
      .join('\n');
    return { ...error, source };
  });
}

// The type names an error quotes ('Stripe.PaymentIntentCreateParams' names
// PaymentIntentCreateParams); a quoted API version names stripe-node's LatestApiVersion.
export function namedTypes(errors: TypeError[]) {
  const names = new Set<string>();
  for (const error of errors) {
    for (const match of error.message.matchAll(/'([A-Za-z_$][\w$.]*)'/g)) {
      const name = match[1].split('.').at(-1)!;
      if (/^[A-Z]/.test(name)) names.add(name);
    }
    if (STRIPE_VERSION.test(error.message)) names.add('LatestApiVersion');
  }
  return [...names].slice(0, MAX_NAMES);
}

// The declarations of `names` in stripe-node's type files: from the declaration's line until its
// braces close, cut at a size limit.
export function typeDeclarations(names: string[], files: { path: string; content: string }[]) {
  const found: { file: string; name: string; declaration: string }[] = [];
  let total = 0;
  for (const name of names)
    for (const file of files) {
      const lines = file.content.split('\n');
      const start = lines.findIndex((line) =>
        new RegExp(`\\b(?:interface|type|class|enum|namespace)\\s+${name}\\b`).test(line),
      );
      if (start < 0) continue;
      let depth = 0;
      let end = start;
      for (; end < lines.length && end - start < MAX_DECLARATION_LINES; end++) {
        depth +=
          (lines[end].match(/[{(]/g)?.length ?? 0) - (lines[end].match(/[})]/g)?.length ?? 0);
        if (depth <= 0 && /[;}]\s*$/.test(lines[end])) break;
      }
      const declaration = lines
        .slice(start, end + 1)
        .join('\n')
        .slice(0, MAX_DECLARATION_CHARACTERS);
      if (total + declaration.length > MAX_TYPE_CHARACTERS) return found;
      total += declaration.length;
      found.push({ file: file.path, name, declaration });
      break;
    }
  return found;
}

// stripe-node's `types/*.d.ts` from a prepared dependency archive: the copy installed for the
// package Refit checks when there is one, else the first one listed.
export async function archivedStripeTypes(archive: string, packageDirectory?: string) {
  const listed = (
    await execute('tar', ['-tf', archive], { maxBuffer: 256 * 1024 * 1024 })
  ).stdout.split('\n');
  const typeFiles = listed.filter((path) =>
    /(?:^|\/)node_modules\/stripe\/types\/.*\.d\.ts$/.test(path),
  );
  const roots = [...new Set(typeFiles.map((path) => path.slice(0, path.indexOf('/types/'))))];
  const preferred = [`${packageDirectory ? `${packageDirectory}/` : ''}node_modules/stripe`];
  const root = roots.find((entry) => preferred.includes(entry)) ?? roots[0];
  if (!root) return [];
  const files = typeFiles.filter((path) => path.startsWith(`${root}/types/`));
  const directory = await mkdtemp(join(tmpdir(), 'refit-stripe-types-'));
  try {
    await execute('tar', ['-xf', archive, '-C', directory, ...files], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return await Promise.all(
      files.map(async (path) => ({
        path: path.slice(root.length + 1),
        content: await readFile(join(directory, path), 'utf8'),
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

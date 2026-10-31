import { TYPE_CHECK_STARTED } from './check-selection.ts';

const TYPE_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// mypy with --show-error-codes: `path.py:12: error: message  [code]`, coded `mypy-<code>`.
const MYPY_ERROR = /^(.+?\.pyi?):(\d+)(?::(\d+))?: error: (.*?)(?:\s+\[([a-z0-9-]+)\])?$/;

function diagnostic(line: string) {
  const ts = TYPE_ERROR.exec(line);
  if (ts) return { file: ts[1], line: ts[2], column: ts[3], code: ts[4], message: ts[5] };
  const mypy = MYPY_ERROR.exec(line);
  if (mypy)
    return {
      file: mypy[1],
      line: mypy[2],
      column: mypy[3] ?? '0',
      code: `mypy-${mypy[5] ?? 'error'}`,
      message: mypy[4],
    };
  return null;
}

// TypeScript (and mypy) diagnostics in a check's output, keyed without positions so moved lines still match.
// After a tests-then-type-check chain's tests, only the type checker's own output counts.
export function typeErrors(check: { stdout: string; stderr: string }) {
  const start = check.stdout.lastIndexOf(TYPE_CHECK_STARTED);
  return (start < 0 ? `${check.stdout}\n${check.stderr}` : check.stdout.slice(start))
    .split('\n')
    .map((line) => diagnostic(line.trim()))
    .filter((match) => match !== null)
    .map((match) => ({
      file: match.file,
      line: Number(match.line),
      column: Number(match.column),
      code: match.code,
      message: match.message,
      key: `${match.file} ${match.code} ${match.message}`,
    }));
}

// The errors a compared type check matches: one per file, code and message.
export function typeErrorKeys(check: { stdout: string; stderr: string }) {
  return new Set(typeErrors(check).map((error) => error.key));
}

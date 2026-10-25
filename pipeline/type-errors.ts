const TYPE_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

// TypeScript diagnostics in a check's output, keyed without positions so moved lines still match.
export function typeErrors(check: { stdout: string; stderr: string }) {
  return `${check.stdout}\n${check.stderr}`
    .split('\n')
    .map((line) => TYPE_ERROR.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5],
      key: `${match[1]} ${match[4]} ${match[5]}`,
    }));
}

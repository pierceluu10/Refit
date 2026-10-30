import { spawn } from 'node:child_process';

// A check's output is judged by its exit code and the result lines it prints (check-failures.ts,
// the type error comparison), so a verbose suite no longer stops at a byte cap. Each stream keeps
// its first and last lines and, from the middle, every line that reports a failure or an error,
// then passing results, each within its limit; the rest is dropped and marked. Memory stays
// bounded however much a check prints (under 1 MiB a stream), and the time limit still ends a
// check that never stops.
const HEAD_CHARACTERS = 64 * 1024;
const TAIL_CHARACTERS = 192 * 1024;
const FAILURE_CHARACTERS = 512 * 1024;
const PASSED_CHARACTERS = 192 * 1024;
// A line without a newline is cut here, so a check printing one endless line stays bounded too.
const LINE_CHARACTERS = 16 * 1024;
// Test runner results (TAP, Jest, Vitest, Mocha, node:test), tsc diagnostics, thrown errors and
// Refit's own chain markers.
const FAILURE_LINE = /error|fail|not ok|[×✗✕]/i;
const PASSED_LINE = /pass|\bok\b|[✓√]|Refit:/i;

export const omittedMarker = (characters: number) =>
  `[Refit omitted ${characters} characters of output here]`;

export class BoundedOutput {
  private head: string[] = [];
  private headCharacters = 0;
  private middle: string[] = [];
  private failureCharacters = 0;
  private passedCharacters = 0;
  private tail: string[] = [];
  private tailCharacters = 0;
  private partial = '';
  private omitted = 0;
  private headFull = false;

  write(chunk: string) {
    this.partial += chunk;
    let newline: number;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      this.line(this.partial.slice(0, newline + 1));
      this.partial = this.partial.slice(newline + 1);
    }
    while (this.partial.length > LINE_CHARACTERS) {
      this.line(this.partial.slice(0, LINE_CHARACTERS));
      this.partial = this.partial.slice(LINE_CHARACTERS);
    }
  }

  private line(line: string) {
    if (!this.headFull && this.headCharacters + line.length <= HEAD_CHARACTERS) {
      this.head.push(line);
      this.headCharacters += line.length;
      return;
    }
    this.headFull = true;
    this.tail.push(line);
    this.tailCharacters += line.length;
    while (this.tailCharacters > TAIL_CHARACTERS) {
      const evicted = this.tail.shift()!;
      this.tailCharacters -= evicted.length;
      const marker = this.omitted ? `${omittedMarker(this.omitted)}\n` : '';
      const size = marker.length + evicted.length;
      if (FAILURE_LINE.test(evicted) && this.failureCharacters + size <= FAILURE_CHARACTERS)
        this.failureCharacters += size;
      else if (PASSED_LINE.test(evicted) && this.passedCharacters + size <= PASSED_CHARACTERS)
        this.passedCharacters += size;
      else {
        this.omitted += evicted.length;
        continue;
      }
      this.middle.push(marker, evicted);
      this.omitted = 0;
    }
  }

  text() {
    if (this.partial) this.line(this.partial);
    this.partial = '';
    const marker = this.omitted ? `${omittedMarker(this.omitted)}\n` : '';
    return [...this.head, ...this.middle, marker, ...this.tail].join('');
  }
}

export interface BoundedRun {
  exitCode: number | null;
  // Stopped at the time limit.
  timedOut: boolean;
  stdout: string;
  stderr: string;
  // The process could not start, or the caller aborted it.
  error?: Error;
}

// Runs a command like execFile, keeping each stream in a BoundedOutput instead of failing at a
// buffer size. SIGKILL at the time limit, as the Docker client ignores SIGTERM in a busy container.
export function runBounded(
  binary: string,
  args: string[],
  options: { timeout: number; signal?: AbortSignal },
) {
  return new Promise<BoundedRun>((resolve) => {
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let timedOut = false;
    let error: Error | undefined;
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      killSignal: 'SIGKILL',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.write(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.write(chunk));
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stdout: stdout.text(), stderr: stderr.text(), error });
    };
    child.on('error', (failure) => {
      error = failure;
      // A process that never started emits no close event.
      if (child.pid === undefined) finish(null);
    });
    child.on('close', finish);
  });
}

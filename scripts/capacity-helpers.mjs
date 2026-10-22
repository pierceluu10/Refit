// Pure helpers for scripts/capacity-inventory.mjs.

const PERCENTILES = [50, 90, 99];

// `/usr/bin/time -o <file>` output: BSD `-l` (macOS, resident size in bytes) or GNU `-v` (Linux,
// in KiB). Returns null for anything else rather than guessing.
export function parseTime(text) {
  const bsd = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(text);
  if (bsd) {
    const resident = /(\d+)\s+maximum resident set size/.exec(text);
    return resident
      ? {
          userSeconds: Number(bsd[2]),
          systemSeconds: Number(bsd[3]),
          maxRssBytes: Number(resident[1]),
        }
      : null;
  }
  const user = /User time \(seconds\): ([\d.]+)/.exec(text);
  const system = /System time \(seconds\): ([\d.]+)/.exec(text);
  const resident = /Maximum resident set size \(kbytes\): (\d+)/.exec(text);
  return user && system && resident
    ? {
        userSeconds: Number(user[1]),
        systemSeconds: Number(system[1]),
        maxRssBytes: Number(resident[1]) * 1024,
      }
    : null;
}

// The install duration a package manager printed last: npm "added 12 packages in 545ms" (ms, s or
// whole minutes, which npm rounds down), pnpm and Yarn "Done in 1m 2.5s". `rounded` marks npm's
// whole minutes, a lower bound.
export function installSeconds(log) {
  const last = [
    ...log.matchAll(/(?:packages? in|Done in) (?:(\d+)m(?!s))?\s*(?:([\d.]+)(ms|s)\b)?/g),
  ].at(-1);
  if (!last || (last[1] === undefined && last[2] === undefined)) return null;
  const minutes = Number(last[1] ?? 0);
  const seconds = last[2] === undefined ? 0 : Number(last[2]) / (last[3] === 'ms' ? 1000 : 1);
  return { seconds: minutes * 60 + seconds, rounded: last[2] === undefined };
}

// Nearest-rank percentiles and the maximum of a list of numbers.
export function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    ...Object.fromEntries(
      PERCENTILES.map((percentile) => [
        `p${percentile}`,
        sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)],
      ]),
    ),
    max: sorted.at(-1),
  };
}

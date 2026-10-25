import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, isObject } from './specifications.ts';
import type { CheckResult } from './validation.ts';

// Operator opt-in for benchmark runners that validate the same commits again: the original code's
// check result is stored under everything that decides it and reused instead of rerun. Unset, the
// default, every validation runs its baseline as before.
export const BASELINE_CHECK_CACHE_SETTING = 'REFIT_BASELINE_CHECK_CACHE_DIRECTORY';

// The code that runs checks is part of the key, so a Refit change there never reuses a result.
let checkCode: Promise<string> | undefined;
const checkCodeDigest = () =>
  (checkCode ??= Promise.all(
    ['validation.ts', 'docker-sandbox.ts'].map((name) =>
      readFile(new URL(name, import.meta.url), 'utf8'),
    ),
  ).then((sources) => digest(sources.join('\0'))));

// Only results the check itself decided are kept; timeouts, Docker errors and skips run again.
function reusable(check: unknown): check is CheckResult {
  return (
    isObject(check) &&
    (check.status === 'passed' || check.status === 'failed') &&
    Number.isInteger(check.exitCode) &&
    typeof check.stdout === 'string' &&
    typeof check.stderr === 'string' &&
    (check.error === undefined || typeof check.error === 'string')
  );
}

// `inputs` must hold everything else the result depends on: the repository revision, the
// command, the image ID, the dependency archive and the sandbox limits.
export async function baselineCheck(
  inputs: Record<string, unknown>,
  run: () => Promise<CheckResult>,
): Promise<{ check: CheckResult; recordedAt?: string }> {
  const directory = process.env[BASELINE_CHECK_CACHE_SETTING]?.trim();
  if (!directory) return { check: await run() };
  const key = { formatVersion: 1, checkCode: await checkCodeDigest(), ...inputs };
  const file = join(directory, `${digest(JSON.stringify(key))}.json`);
  const stored: unknown = await readFile(file, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined);
  if (
    isObject(stored) &&
    JSON.stringify(stored.key) === JSON.stringify(key) &&
    typeof stored.recordedAt === 'string' &&
    reusable(stored.check)
  )
    return { check: stored.check, recordedAt: stored.recordedAt };
  const check = await run();
  if (reusable(check))
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const partial = `${file}.${randomUUID()}`;
      await writeFile(
        partial,
        JSON.stringify({ key, recordedAt: new Date().toISOString(), check }),
        { mode: 0o600 },
      );
      await rename(partial, file);
    } catch {
      // A cache that cannot be written only costs the next run this check again.
    }
  return { check };
}

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYaml, YamlError } from '../providers/toolkit/yaml.ts';
import type { ExternalChange } from '../shared/types.ts';

export const SETTINGS_FILE = '.refit.yml';
const MAX_SETTINGS_BYTES = 64 * 1024;
const KNOWN_KEYS = new Set(['paused', 'ignore']);

// What the customer chose for this repo. `errors` never quotes the file: the repo is untrusted and
// these messages reach the report.
export type RepoSettings = { paused: boolean; ignore: string[]; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fromParsed(parsed: unknown): RepoSettings {
  const settings: RepoSettings = { paused: false, ignore: [], errors: [] };
  if (parsed === null) return settings; // an empty file
  if (!isObject(parsed)) {
    settings.errors.push(`${SETTINGS_FILE} should be a list of settings, so it was not used.`);
    return settings;
  }
  const { paused, ignore } = parsed;
  if (typeof paused === 'boolean') settings.paused = paused;
  else if (paused !== undefined && paused !== null) {
    settings.errors.push(`${SETTINGS_FILE}: paused should be true or false, so it was not used.`);
  }
  if (Array.isArray(ignore)) {
    settings.ignore = ignore.filter((name): name is string => typeof name === 'string');
    if (settings.ignore.length < ignore.length) {
      settings.errors.push(
        `${SETTINGS_FILE}: ignore holds entries that aren't names; they were left out.`,
      );
    }
  } else if (ignore !== undefined && ignore !== null) {
    settings.errors.push(`${SETTINGS_FILE}: ignore should be a list of names, so it was not used.`);
  }
  const unknown = Object.keys(parsed).filter((key) => !KNOWN_KEYS.has(key)).length;
  if (unknown > 0) {
    settings.errors.push(
      `${SETTINGS_FILE} has ${unknown} unknown setting(s), which were left out. It reads paused and ignore.`,
    );
  }
  return settings;
}

// A bad file adds to `errors` and never stops a scan. Only read from a checkout, never run.
export async function readRepoSettings(dir: string): Promise<RepoSettings> {
  const path = join(dir, SETTINGS_FILE);
  const unused = (error: string): RepoSettings => ({ paused: false, ignore: [], errors: [error] });
  try {
    // lstat, so a symlink can't point the app at a file on the host.
    const stats = await lstat(path);
    if (!stats.isFile())
      return unused(`${SETTINGS_FILE} isn't a regular file, so it was not read.`);
    if (stats.size > MAX_SETTINGS_BYTES) {
      return unused(`${SETTINGS_FILE} is over ${MAX_SETTINGS_BYTES} bytes, so it was not read.`);
    }
    return fromParsed(parseYaml(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof YamlError) {
      return unused(`${SETTINGS_FILE} isn't valid YAML (line ${error.line}), so it was not used.`);
    }
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return { paused: false, ignore: [], errors: [] };
    if (code) return unused(`${SETTINGS_FILE} couldn't be read (${code}).`);
    throw error;
  }
}

export function isIgnored(settings: RepoSettings, change: ExternalChange): boolean {
  const names = [change.dependency, change.provider].map((name) => name.toLowerCase());
  return settings.ignore.some((name) => names.includes(name.trim().toLowerCase()));
}

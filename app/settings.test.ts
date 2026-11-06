import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExternalChange } from '../shared/types.ts';
import { isIgnored, readRepoSettings, SETTINGS_FILE } from './settings.ts';

const NO_SETTINGS = { paused: false, ignore: [], errors: [] };

// Illustrative change, not a real provider notice.
const CHANGE: ExternalChange = {
  provider: 'Stripe',
  id: 'illustrative-change',
  kind: 'dependency-major',
  title: 'Illustrative change',
  source: { url: 'https://example.com/changelog', quote: 'Illustrative quote.' },
  affects: {},
  dependencyKind: 'library',
  dependency: 'stripe-node',
};

let dir: string;
const write = (content: string) => writeFile(join(dir, SETTINGS_FILE), content);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-settings-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readRepoSettings', () => {
  it('gives the defaults with no errors when the file is missing', async () => {
    expect(await readRepoSettings(dir)).toEqual(NO_SETTINGS);
  });

  it('gives the defaults with no errors for an empty file', async () => {
    await write('# nothing set yet\n');
    expect(await readRepoSettings(dir)).toEqual(NO_SETTINGS);
  });

  it('reads paused and ignore', async () => {
    await write('paused: true\nignore:\n  - stripe\n  - node\n');
    expect(await readRepoSettings(dir)).toEqual({
      paused: true,
      ignore: ['stripe', 'node'],
      errors: [],
    });
  });

  it('reports bad YAML by line, without quoting the file', async () => {
    await write('paused: true\nignore: [private-api-name\n');
    const settings = await readRepoSettings(dir);
    expect(settings.paused).toBe(false);
    expect(settings.errors).toHaveLength(1);
    expect(settings.errors[0]).toMatch(/line \d+/);
    expect(settings.errors[0]).not.toContain('private-api-name');
  });

  it('reports wrong types and keeps the valid parts', async () => {
    await write('paused: sometimes\nignore:\n  - stripe\n  - 42\n');
    const settings = await readRepoSettings(dir);
    expect(settings.paused).toBe(false);
    expect(settings.ignore).toEqual(['stripe']);
    expect(settings.errors).toHaveLength(2);
    expect(settings.errors.join()).not.toContain('sometimes');
  });

  it('reports an ignore that is not a list and keeps paused', async () => {
    await write('paused: true\nignore: stripe\n');
    const settings = await readRepoSettings(dir);
    expect(settings).toMatchObject({ paused: true, ignore: [] });
    expect(settings.errors).toHaveLength(1);
  });

  it('reports a file that is not a mapping', async () => {
    await write('- stripe\n');
    const settings = await readRepoSettings(dir);
    expect(settings).toMatchObject({ paused: false, ignore: [] });
    expect(settings.errors).toHaveLength(1);
  });

  it('reports unknown keys without naming them and keeps the valid parts', async () => {
    await write('paused: true\nprivate-key-name: 1\n');
    const settings = await readRepoSettings(dir);
    expect(settings.paused).toBe(true);
    expect(settings.errors).toHaveLength(1);
    expect(settings.errors[0]).not.toContain('private-key-name');
  });

  it('does not follow a symlink to a file on the host', async () => {
    const secret = 'paused: true\nignore: [ghs_illustrative_secret_value\n';
    const outside = await mkdtemp(join(tmpdir(), 'refit-settings-outside-'));
    try {
      await writeFile(join(outside, 'secret'), secret);
      await symlink(join(outside, 'secret'), join(dir, SETTINGS_FILE));
      const settings = await readRepoSettings(dir);
      expect(settings).toMatchObject({ paused: false, ignore: [] });
      expect(settings.errors).toHaveLength(1);
      expect(JSON.stringify(settings)).not.toContain('ghs_illustrative_secret_value');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not read an oversize file', async () => {
    await write(`paused: true\n# ${'x'.repeat(70 * 1024)}\n`);
    const settings = await readRepoSettings(dir);
    expect(settings.paused).toBe(false);
    expect(settings.errors).toHaveLength(1);
  });
});

describe('isIgnored', () => {
  const ignoring = (...ignore: string[]) => ({ paused: false, ignore, errors: [] });

  it('matches the dependency or the provider, in any case', () => {
    expect(isIgnored(ignoring('STRIPE-node'), CHANGE)).toBe(true);
    expect(isIgnored(ignoring('stripe'), CHANGE)).toBe(true);
  });

  it('leaves other changes alone', () => {
    expect(isIgnored(ignoring('node'), CHANGE)).toBe(false);
    expect(isIgnored(ignoring(), CHANGE)).toBe(false);
  });
});

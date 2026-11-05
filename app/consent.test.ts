import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInstallationError, createConsentStore } from './consent.ts';

const ID = 70000001;
const CLI = new URL('consent-cli.ts', import.meta.url).pathname;

describe('createConsentStore', () => {
  let dir: string;
  const fileFor = (id: number) => join(dir, 'installations', `${id}.json`);
  const store = () => createConsentStore(join(dir, 'installations'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aptitude-consent-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is no with no record, and no after an install', async () => {
    expect(await store().consented(ID)).toBe(false);
    await store().recordInstall(ID);
    expect(await store().consented(ID)).toBe(false);
  });

  it('records an install once, without undoing an answer', async () => {
    await store().recordInstall(ID);
    await store().set(ID, true);
    await store().recordInstall(ID);
    expect(await store().consented(ID)).toBe(true);
  });

  it('changes both ways, per installation', async () => {
    await store().set(ID, true);
    expect(await store().consented(ID)).toBe(true);
    expect(await store().consented(ID + 1)).toBe(false);
    await store().set(ID, false);
    expect(await store().consented(ID)).toBe(false);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['a truthy string', JSON.stringify({ shareLearning: 'yes' })],
    ['a truthy number', JSON.stringify({ shareLearning: 1 })],
    ['no field', '{}'],
    ['null', 'null'],
  ])('%s reads as no', async (_name, content) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(join(dir, 'installations'), { recursive: true });
    writeFileSync(fileFor(ID), content);
    expect(await store().consented(ID)).toBe(false);
  });

  it('a read error reads as no and says so, without printing the path as a yes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(fileFor(ID), { recursive: true }); // a directory where the file should be: EISDIR
    expect(await store().consented(ID)).toBe(false);
    expect(logged).toHaveBeenCalledOnce();
  });

  it('a bad id reads as no, and is refused on write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store().consented(Number.NaN)).toBe(false);
    await expect(store().set(Number.NaN, true)).rejects.toBeInstanceOf(InvalidInstallationError);
    await expect(store().set(-1, true)).rejects.toBeInstanceOf(InvalidInstallationError);
  });

  it('forget drops the answer, and forgetting twice is fine', async () => {
    await store().set(ID, true);
    await store().forget(ID);
    await store().forget(ID);
    expect(await store().consented(ID)).toBe(false);
  });
});

describe('consent-cli', () => {
  let dir: string;
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, APTITUDE_APP_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const store = () => createConsentStore(join(dir, 'installations'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aptitude-consent-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sets and revokes in the store the server reads', async () => {
    expect(run(String(ID), 'yes')).toContain('shareLearning: true');
    expect(await store().consented(ID)).toBe(true);
    expect(run(String(ID), 'no')).toContain('shareLearning: false');
    expect(await store().consented(ID)).toBe(false);
  });

  it.each([[[]], [[String(ID)]], [[String(ID), 'maybe']], [['not-a-number', 'yes']]])(
    'refuses %j and leaves it at no',
    async (args) => {
      expect(() => run(...args)).toThrow();
      expect(await store().consented(ID)).toBe(false);
    },
  );
});

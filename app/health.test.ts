import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthCheck } from './health.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-health-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('createHealthCheck', () => {
  it('is healthy only after really writing to the store', async () => {
    const health = await createHealthCheck({ stateDir: dir, sandboxRequired: false })();
    expect(health).toEqual({ ok: true, store: true, sandbox: true });
    expect(await readFile(join(dir, '.health-probe.json'), 'utf8')).toContain('checkedAt');
  });

  it('fails when the store cannot be written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = join(dir, 'a-file-not-a-directory');
    await writeFile(file, '');
    const health = await createHealthCheck({ stateDir: file, sandboxRequired: false })();
    expect(health).toEqual({ ok: false, store: false, sandbox: true });
    expect(errors).toHaveBeenCalledOnce();
  });

  it('fails when the sandbox is required and its daemon is down', async () => {
    const sandboxReady = async () => false;
    const health = await createHealthCheck({
      stateDir: dir,
      sandboxRequired: true,
      sandboxReady,
    })();
    expect(health).toEqual({ ok: false, store: true, sandbox: false });
  });

  it('never asks the daemon on a host that does not need it', async () => {
    const sandboxReady = vi.fn(async () => false);
    const health = await createHealthCheck({
      stateDir: dir,
      sandboxRequired: false,
      sandboxReady,
    })();
    expect(health.ok).toBe(true);
    expect(sandboxReady).not.toHaveBeenCalled();
  });

  it('shares one check across a burst, then checks again', async () => {
    let time = 0;
    const sandboxReady = vi.fn(async () => true);
    const check = createHealthCheck({
      stateDir: dir,
      sandboxRequired: true,
      sandboxReady,
      now: () => time,
    });
    await Promise.all([check(), check(), check()]);
    expect(sandboxReady).toHaveBeenCalledTimes(1);
    time = 9_999;
    await check();
    expect(sandboxReady).toHaveBeenCalledTimes(1);
    time = 10_000;
    await check();
    expect(sandboxReady).toHaveBeenCalledTimes(2);
  });
});

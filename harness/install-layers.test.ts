import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installWithLayer, layerKey } from './install-layers.ts';
import { createSandbox } from './sandbox.ts';

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'layer-repo-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
};

const INSTALL =
  'mkdir -p node_modules/dep packages/a/node_modules/x && echo $RANDOM$$ > node_modules/dep/index.js && echo a > packages/a/node_modules/x/a.js && ln -s dep node_modules/link';

async function installOnce(dir: string, root: string, scope = 'acme') {
  const sandbox = await createSandbox(dir, { mode: 'local' });
  const result = await installWithLayer(sandbox, { pm: 'npm', command: INSTALL, scope, root });
  const text = readFileSync(path.join(sandbox.dir, 'node_modules/dep/index.js'), 'utf8');
  const nested = existsSync(path.join(sandbox.dir, 'packages/a/node_modules/x/a.js'));
  await sandbox.dispose();
  return { layer: result.layer, code: result.code, text, nested };
}

describe('installWithLayer', () => {
  it('runs the install once and restores it, nested folders and links too, for the same lockfile', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'layers-'));
    const dir = repo({ 'package.json': '{}', 'package-lock.json': '{"a":1}' });
    const first = await installOnce(dir, root);
    const second = await installOnce(dir, root);
    expect(first.layer).toBe('saved');
    expect(second).toMatchObject({ layer: 'restored', code: 0, nested: true });
    expect(second.text).toBe(first.text);
  });

  it('runs a fresh install for a different lockfile or owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'layers-'));
    const dir = repo({ 'package.json': '{}', 'package-lock.json': '{"a":1}' });
    await installOnce(dir, root);
    expect((await installOnce(dir, root, 'other-owner')).layer).toBe('saved');
    writeFileSync(path.join(dir, 'package-lock.json'), '{"a":2}');
    expect((await installOnce(dir, root)).layer).toBe('saved');
  });

  it('keys on every file that can run or steer an install', async () => {
    const key = (dir: string) => layerKey(dir, 'acme', 'pnpm', '9', 'node:22');
    const dir = repo({ 'package.json': '{}', 'pnpm-lock.yaml': 'a' });
    const before = await key(dir);
    writeFileSync(path.join(dir, '.pnpmfile.cjs'), 'module.exports = {}');
    const hooked = await key(dir);
    expect(hooked).not.toBe(before);
    mkdirSync(path.join(dir, '.yarn/plugins'), { recursive: true });
    writeFileSync(path.join(dir, '.yarn/plugins/p.cjs'), 'evil()');
    expect(await key(dir)).not.toBe(hooked);
    writeFileSync(path.join(dir, 'src.ts'), 'unrelated');
    expect(await layerKey(dir, 'acme', 'pnpm', '9', 'node:22')).toBe(await key(dir));
  });

  it('has no layer for a failed install, for pip or without an owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'layers-'));
    const dir = repo({ 'package.json': '{}' });
    const sandbox = await createSandbox(dir, { mode: 'local' });
    const options = { pm: 'npm' as const, scope: 'acme', root };
    const failed = await installWithLayer(sandbox, { ...options, command: 'exit 3' });
    expect(failed).toMatchObject({ code: 3, layer: 'none' });
    const none = await installWithLayer(sandbox, { ...options, command: 'true', scope: '' });
    expect(none.layer).toBe('none');
    const pip = await installWithLayer(sandbox, { ...options, pm: 'pip', command: 'true' });
    expect(pip.layer).toBe('none');
    await sandbox.dispose();
  });

  it('never follows a symlinked node_modules out of the working copy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'layers-'));
    const outside = repo({ 'secret.txt': 'host file' });
    const dir = repo({ 'package.json': '{}' });
    const sandbox = await createSandbox(dir, { mode: 'local' });
    symlinkSync(outside, path.join(sandbox.dir, 'node_modules'));
    const result = await installWithLayer(sandbox, {
      pm: 'npm',
      command: 'true',
      scope: 'acme',
      root,
    });
    expect(result.layer).toBe('none');
    await sandbox.dispose();
  });
});

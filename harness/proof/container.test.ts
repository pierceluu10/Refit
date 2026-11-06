import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { containerImageCheck, parseFromLines, sameImage } from './container.ts';
import type { HostExecResult } from './types.ts';
import { fakeSandbox, fixture } from './test-helpers.ts';

function scriptedHost(answers: (args: string[]) => Partial<HostExecResult>) {
  const calls: string[][] = [];
  return {
    calls,
    hostExec: async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: '', stderr: '', ...answers(args) };
    },
  };
}

describe('container image proof', () => {
  it('reads FROM lines with stages and platforms', () => {
    expect(
      parseFromLines('Dockerfile', 'FROM --platform=linux/amd64 node:22 AS build\nFROM build\n'),
    ).toEqual([
      { file: 'Dockerfile', line: 1, image: 'node:22', stage: 'build' },
      { file: 'Dockerfile', line: 2, image: 'build', stage: undefined },
    ]);
    expect(sameImage('docker.io/library/node:22-bookworm@sha256:abc123', 'node:22-bookworm')).toBe(
      true,
    );
    expect(sameImage('node:18', 'node:22')).toBe(false);
  });

  it('builds on the target image with docker build in the sandbox copy', async () => {
    const host = scriptedHost((args) =>
      args[0] === 'build' ? { stdout: '#8 DONE 0.4s' } : { stdout: '27.0.0' },
    );
    const sandbox = fakeSandbox(fixture('docker-new'));
    const result = await containerImageCheck.run(
      { image: 'node:22-bookworm' },
      { repoDir: sandbox.dir, sandbox, hostExec: host.hostExec },
    );
    expect(result.passed).toBe(true);
    expect(result.passedItems).toEqual([
      'Dockerfile:1 FROM node:22-bookworm is the target image',
      'Dockerfile builds',
    ]);
    expect(result.commands[0]).toMatch(
      /^docker build --pull --progress=plain -f Dockerfile -t refit-proof-[a-f0-9]+ \.$/,
    );
    expect(host.calls.at(-1)?.slice(0, 4)).toEqual(['docker', 'image', 'rm', '-f']);
    expect(result.logTail).toBe('#8 DONE 0.4s');
  });

  it('fails a Dockerfile still on the old image, and a failing build', async () => {
    const host = scriptedHost((args) =>
      args[0] === 'build' ? { code: 1, stderr: 'npm ERR! engine' } : {},
    );
    const sandbox = fakeSandbox(fixture('docker-old'));
    const result = await containerImageCheck.run(
      { image: 'node:22-bookworm' },
      { repoDir: sandbox.dir, sandbox, hostExec: host.hostExec },
    );
    expect(result.passed).toBe(false);
    expect(result.failedItems).toEqual([
      'no Dockerfile stage is on node:22-bookworm',
      'Dockerfile does not build (exit 1)',
    ]);
  });

  it('skips the build cleanly without a Docker daemon', async () => {
    const host = scriptedHost(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));
    const sandbox = fakeSandbox(fixture('docker-new'));
    const result = await containerImageCheck.run(
      { image: 'node:22-bookworm' },
      { repoDir: sandbox.dir, sandbox, hostExec: host.hostExec },
    );
    expect(result.passed).toBe('unknown');
    expect(result.notes[0]).toBe('no Docker daemon, so the images were not built');
    expect(host.calls).toHaveLength(1);
  });

  it('makes its own copy for the build context when there is no sandbox', async () => {
    const host = scriptedHost(() => ({ code: 1 }));
    const result = await containerImageCheck.run(
      { image: 'node:22-bookworm' },
      { repoDir: fixture('docker-new'), hostExec: host.hostExec },
    );
    expect(result.passedItems).toEqual(['Dockerfile:1 FROM node:22-bookworm is the target image']);
  });
});

const hasDocker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDocker)('real docker build', () => {
  it('builds the fixture on node:22-bookworm', { timeout: 600_000 }, async () => {
    const result = await containerImageCheck.run(
      { image: 'node:22-bookworm' },
      { repoDir: fixture('docker-new') },
    );
    expect(result.passed).toBe(true);
  });
});

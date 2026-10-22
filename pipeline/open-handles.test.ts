import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { openHandleSnapshot, openHandlesSince } from './test/open-handles.ts';

it('reports a child process only while it runs', async () => {
  const snapshot = openHandleSnapshot();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  expect(await openHandlesSince(snapshot)).toEqual([
    expect.stringMatching(/^a running child process \(.*setInterval/),
  ]);
  child.kill();
  await once(child, 'exit');
  expect(await openHandlesSince(snapshot)).toEqual([]);
});

it('reports a server only while it listens', async () => {
  const snapshot = openHandleSnapshot();
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  expect(await openHandlesSince(snapshot)).toEqual([expect.stringMatching(/^a listening server /)]);
  server.close();
  expect(await openHandlesSince(snapshot)).toEqual([]);
});

it('reports pending referenced timers, not fired, cleared, unreferenced or deferred ones', async () => {
  const snapshot = openHandleSnapshot();
  const timeout = setTimeout(() => {}, 60_000);
  const interval = setInterval(() => {}, 60_000);
  setTimeout(() => {}, 60_000).unref();
  await new Promise((resolve) => setTimeout(resolve, 1));
  let deferred = false;
  setTimeout(() => (deferred = true), 0);
  expect(await openHandlesSince(snapshot)).toEqual(['2 pending timers (60000 ms, 60000 ms)']);
  expect(deferred).toBe(true);
  clearTimeout(timeout);
  clearInterval(interval);
  expect(await openHandlesSince(snapshot)).toEqual([]);
});

it('reports process listeners a test added and did not remove', async () => {
  const snapshot = openHandleSnapshot();
  const listener = () => {};
  process.on('SIGUSR2', listener);
  expect(await openHandlesSince(snapshot)).toEqual(["1 process 'SIGUSR2' listener"]);
  process.off('SIGUSR2', listener);
  expect(await openHandlesSince(snapshot)).toEqual([]);
});

import { ChildProcess } from 'node:child_process';
import { Server } from 'node:net';

// What a test may not leave behind: a child process still running, a server still listening, a
// pending referenced timer, or a process listener it added. Each is checked by state, not by
// counting libuv handles, because a closed handle is released a loop turn later.

type Timer = ReturnType<typeof setTimeout> & { _destroyed?: boolean; _idleTimeout?: number };
const created = new Set<Timer>();
const { setTimeout: unrecordedTimeout } = globalThis;
// Deferred work (jsdom's focus handling, a setTimeout(0)) is not a leak: it is due at once.
const DEFERRED_MS = 20;

// Timers are recorded at creation. Vitest's own timers are captured before setup files run, so
// only the code under test and the tests themselves pass through here. node:timers imports
// bypass the record; Refit's code has none.
export function recordTimers() {
  const { setTimeout: timeout, setInterval: interval } = globalThis;
  globalThis.setTimeout = Object.assign(
    (...args: Parameters<typeof timeout>) => track(timeout(...args)),
    timeout,
  ) as typeof setTimeout;
  globalThis.setInterval = Object.assign(
    (...args: Parameters<typeof interval>) => track(interval(...args)),
    interval,
  ) as typeof setInterval;
}

function track<T>(timer: T) {
  created.add(timer as Timer);
  return timer;
}

const activeHandles = () =>
  (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
const listenerCounts = () =>
  new Map(process.eventNames().map((name) => [name, process.listenerCount(name)]));

export function openHandleSnapshot() {
  return {
    handles: new Set(activeHandles()),
    timers: new Set(created),
    listeners: listenerCounts(),
  };
}

export async function openHandlesSince(snapshot: ReturnType<typeof openHandleSnapshot>) {
  const pending = () =>
    [...created].filter(
      (timer) => !snapshot.timers.has(timer) && !timer._destroyed && timer.hasRef(),
    );
  // Node fires timers in order of expiry, so every deferred timer has run once this one fires.
  if (pending().some((timer) => (timer._idleTimeout ?? 0) <= DEFERRED_MS))
    await new Promise((resolve) => unrecordedTimeout(resolve, DEFERRED_MS + 5));
  const left: string[] = [];
  for (const handle of activeHandles()) {
    if (snapshot.handles.has(handle)) continue;
    if (handle instanceof ChildProcess && handle.exitCode === null && handle.signalCode === null)
      left.push(`a running child process (${handle.spawnargs.join(' ').slice(0, 200)})`);
    else if (handle instanceof Server && handle.listening)
      left.push(`a listening server (${JSON.stringify(handle.address())})`);
  }
  // A fired timeout and a cleared timer are destroyed; an unreferenced one cannot hold the
  // process open.
  const timers = pending();
  if (timers.length)
    left.push(
      `${timers.length} pending timer${timers.length === 1 ? '' : 's'} (${timers.map((timer) => `${timer._idleTimeout} ms`).join(', ')})`,
    );
  for (const [name, count] of listenerCounts()) {
    const added = count - (snapshot.listeners.get(name) ?? 0);
    if (added > 0)
      left.push(`${added} process '${String(name)}' listener${added === 1 ? '' : 's'}`);
  }
  return left;
}

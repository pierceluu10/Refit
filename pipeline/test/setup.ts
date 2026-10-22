import { afterAll, afterEach, beforeEach } from 'vitest';
import { openHandleSnapshot, openHandlesSince, recordTimers } from './open-handles.ts';

// Fails a test, or a file's hooks, that leave something running for the next test to trip over.
recordTimers();
const file = openHandleSnapshot();
let test = file;

beforeEach(() => {
  test = openHandleSnapshot();
});

// Setup-file after-hooks run after the test file's own, so its cleanup has already run.
afterEach(() => check(test, 'This test'));
afterAll(() => check(file, 'By its end, this file'));

async function check(snapshot: ReturnType<typeof openHandleSnapshot>, who: string) {
  const left = await openHandlesSince(snapshot);
  if (left.length)
    throw new Error(`${who} left ${left.join(', ')}. Await, close or clear it before finishing.`);
}

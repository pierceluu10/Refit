import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyWebhook } from './github-webhooks.ts';
import { authorized } from './local-service.ts';

const comparisons = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      comparisons.calls += 1;
      return actual.timingSafeEqual(left, right);
    },
  };
});

const TOKEN = 'control-token-for-comparison-tests-0123456789';
const SECRET = 'webhook-secret-for-comparison-tests-0123456789';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const request = (authorization?: string) => ({ headers: { authorization } }) as IncomingMessage;

afterEach(() => {
  comparisons.calls = 0;
});

it('checks the service token in constant time, including tokens of another length', () => {
  expect(authorized(request(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  expect(comparisons.calls).toBe(1);
  for (const supplied of [
    `${TOKEN.slice(0, -1)}x`,
    TOKEN.slice(0, -1),
    `${TOKEN}0`,
    'x',
    '',
    TOKEN.repeat(4),
  ]) {
    comparisons.calls = 0;
    expect(authorized(request(`Bearer ${supplied}`), TOKEN)).toBe(false);
    // A length mismatch must not skip the comparison and return early.
    expect(comparisons.calls).toBe(1);
  }
  for (const header of [undefined, TOKEN, `Basic ${TOKEN}`, `bearer ${TOKEN}`])
    expect(authorized(request(header), TOKEN)).toBe(false);
});

it('checks webhook signatures in constant time and accepts only the fixed-length SHA-256 form', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  const digest = createHmac('sha256', SECRET).update(body).digest('hex');
  expect(verifyWebhook(body, `sha256=${digest}`, DELIVERY, SECRET)).toBe(DELIVERY);
  expect(comparisons.calls).toBe(1);
  comparisons.calls = 0;
  const wrong = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
  expect(() => verifyWebhook(body, `sha256=${wrong}`, DELIVERY, SECRET)).toThrow(/did not match/);
  expect(comparisons.calls).toBe(1);
  // Other lengths and algorithms are refused by format before any comparison of secret material.
  comparisons.calls = 0;
  for (const signature of [`sha256=${digest.slice(1)}`, `sha256=${digest}0`, `sha1=${digest}`])
    expect(() => verifyWebhook(body, signature, DELIVERY, SECRET)).toThrow(/valid SHA-256/);
  expect(comparisons.calls).toBe(0);
});

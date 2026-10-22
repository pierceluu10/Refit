import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  RUN_ID,
  bootScript,
  bucketName,
  fillCommand,
  shardSlices,
} from '../scripts/aws-benchmark-helpers.mjs';

const execute = promisify(execFile);

it('splits a frozen list into contiguous, non-empty shards that cover every repository once', () => {
  const slices = shardSlices(381, 8);
  expect(slices).toHaveLength(8);
  expect(slices.map((slice) => slice.limit)).toEqual([48, 48, 48, 48, 48, 47, 47, 47]);
  expect(slices.reduce((sum, slice) => sum + slice.limit, 0)).toBe(381);
  for (const [index, slice] of slices.entries())
    expect(slice.offset).toBe(index ? slices[index - 1].offset + slices[index - 1].limit : 0);
  expect(shardSlices(3, 3).map((slice) => slice.limit)).toEqual([1, 1, 1]);
  expect(() => shardSlices(2, 3)).toThrow('--shards must be between 1 and --total.');
  expect(() => shardSlices(0, 1)).toThrow('--total must be a positive integer.');
});

it('fills shard placeholders and keeps run ids to safe names', () => {
  expect(
    fillCommand(
      'setup --offset {offset} --limit {limit} --output /work/out/{run}-{shard} {other}',
      {
        shard: 2,
        offset: 96,
        limit: 48,
        run: 'stripe-fresh-1',
      },
    ),
  ).toBe('setup --offset 96 --limit 48 --output /work/out/stripe-fresh-1-2 {other}');
  expect(RUN_ID.test('stripe-fresh-2026-10-22')).toBe(true);
  expect(RUN_ID.test('Stripe Fresh')).toBe(false);
  expect(RUN_ID.test('../escape')).toBe(false);
  expect(bucketName('123456789012', 'us-east-2')).toBe('refit-benchmarks-123456789012-us-east-2');
});

it('prepends shard settings to the boot script as shell-safe variables', async () => {
  const command = `echo "it's" && printf '%s' $HOME`;
  const script = bootScript({ SHARD: 1, COMMAND: command }, '#!/bin/bash\necho "$SHARD"\n');
  expect(script.split('\n')[0]).toBe('#!/bin/bash');
  const { stdout } = await execute('bash', ['-c', `${script}\nprintf '%s' "$COMMAND"`]);
  expect(stdout).toBe(`1\n${command}`);
  expect(bootScript({ SHARD: 0 })).toContain('trap finish EXIT');
});

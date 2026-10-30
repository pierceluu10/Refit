import { afterEach, expect, it, vi } from 'vitest';
import {
  completedYarnLockSnapshot,
  incompleteYarnRecords,
  MAX_COMPLETED_RECORDS,
  RegistryUnreachableError,
} from './lockfile-completion.ts';
import { validateYarnInputs } from './yarn-inputs.ts';

const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const SHASUM = 'bbe617823765ae9c1bc12ff5942370eae7b2ba4e';
const REFUSAL = new Error(
  'Every yarn.lock entry must resolve an exact version to a public registry tarball with SHA-256-or-stronger integrity.',
);
const complete = `# yarn lockfile v1


stripe@^10.17.0:
  version "10.17.0"
  resolved "https://registry.yarnpkg.com/stripe/-/stripe-10.17.0.tgz#${'c'.repeat(40)}"
  integrity ${INTEGRITY}
`;
const lockfile = (record: string) => `${complete}
"@scope/wasm@^1.1.0", "@scope/wasm@^1.0.0":
${record}
`;
const snapshot = (content: string) => ({
  entries: ['100644 blob a\tpackage.json', '100644 blob b\tyarn.lock'],
  replaced: new Map([['yarn.lock', content]]),
});
const published = (overrides: Record<string, unknown> = {}) => ({
  name: '@scope/wasm',
  version: '1.1.0',
  dist: {
    tarball: 'https://registry.npmjs.org/@scope/wasm/-/wasm-1.1.0.tgz',
    shasum: SHASUM,
    integrity: INTEGRITY,
  },
  ...overrides,
});
function registry(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

it('completes a version-only record from the registry for that exact version, keeping every other line', async () => {
  const fetch = registry(published());
  const content = lockfile('  version "1.1.0"');
  const result = await completedYarnLockSnapshot(snapshot(content) as never, REFUSAL);
  expect(fetch).toHaveBeenCalledWith(
    'https://registry.npmjs.org/@scope%2Fwasm/1.1.0',
    expect.objectContaining({ redirect: 'error' }),
  );
  expect(result?.record).toEqual({
    lockfile: 'yarn.lock',
    registry: 'https://registry.npmjs.org',
    records: ['@scope/wasm@1.1.0'],
  });
  const completed = result!.snapshot.replaced.get('yarn.lock')!;
  expect(completed).toBe(
    lockfile(
      `  version "1.1.0"\n  resolved "https://registry.npmjs.org/@scope/wasm/-/wasm-1.1.0.tgz#${SHASUM}"\n  integrity ${INTEGRITY}`,
    ),
  );
  // The completed lockfile passes the unchanged Yarn checks; the committed one still does not.
  const manifest = JSON.stringify({
    dependencies: { stripe: '^10.17.0', '@scope/wasm': '^1.1.0' },
  });
  expect(validateYarnInputs(manifest, completed).packages).toBe(2);
  expect(() => validateYarnInputs(manifest, content)).toThrow(REFUSAL.message);
});

it('replaces a SHA-1-only record only when the registry publishes the same SHA-1', async () => {
  registry(published());
  const sha1 = `  version "1.1.0"\n  resolved "https://registry.yarnpkg.com/@scope/wasm/-/wasm-1.1.0.tgz#${SHASUM}"`;
  const result = await completedYarnLockSnapshot(snapshot(lockfile(sha1)) as never, REFUSAL);
  expect(result!.snapshot.replaced.get('yarn.lock')).toContain(`  integrity ${INTEGRITY}`);
  const integrity = `  version "1.1.0"\n  resolved "https://registry.npmjs.org/@scope/wasm/-/wasm-1.1.0.tgz"\n  integrity sha1-${Buffer.from(SHASUM, 'hex').toString('base64')}`;
  expect(
    (await completedYarnLockSnapshot(
      snapshot(lockfile(integrity)) as never,
      REFUSAL,
    ))!.snapshot.replaced
      .get('yarn.lock')!
      .match(/integrity/g),
  ).toHaveLength(2);
  registry(published({ dist: { ...published().dist, shasum: 'd'.repeat(40) } }));
  await expect(
    completedYarnLockSnapshot(snapshot(lockfile(sha1)) as never, REFUSAL),
  ).rejects.toThrow(
    `yarn.lock records @scope/wasm@1.1.0 with SHA-1 ${SHASUM}, but https://registry.npmjs.org publishes ${'d'.repeat(40)}.`,
  );
});

it('keeps the refusal for records it cannot tie to one registry version', async () => {
  const fetch = registry(published());
  for (const record of [
    '  version "^1.1.0"',
    '  version "1.1.0"\n  resolved "https://example.com/@scope/wasm/-/wasm-1.1.0.tgz"',
    '  version "1.1.0"\n  resolved "https://registry.npmjs.org/@scope/other/-/other-1.1.0.tgz"',
    '  version "1.1.0"\n  resolved "https://registry.npmjs.org/@scope/wasm/-/wasm-1.1.0.tgz?x=1"',
  ])
    await expect(
      completedYarnLockSnapshot(snapshot(lockfile(record)) as never, REFUSAL),
    ).rejects.toThrow('without an exact registry version and URL');
  const aliased = `${complete}\nwasm@npm:@scope/wasm@^1.1.0:\n  version "1.1.0"\n`;
  expect(incompleteYarnRecords(aliased)).toEqual({ refused: 'wasm@npm:@scope/wasm@^1.1.0' });
  expect(fetch).not.toHaveBeenCalled();
  // Other refusals and complete lockfiles are left alone.
  expect(
    await completedYarnLockSnapshot(
      snapshot(lockfile('  version "1.1.0"')) as never,
      new Error('x'),
    ),
  ).toBeUndefined();
  expect(await completedYarnLockSnapshot(snapshot(complete) as never, REFUSAL)).toBeUndefined();
  const many = `${complete}${Array.from({ length: MAX_COMPLETED_RECORDS + 1 }, (_, index) => `\npkg-${index}@^1.0.0:\n  version "1.0.0"\n`).join('')}`;
  await expect(completedYarnLockSnapshot(snapshot(many) as never, REFUSAL)).rejects.toThrow(
    `Refit completes at most ${MAX_COMPLETED_RECORDS}`,
  );
});

it('refuses metadata that does not match the locked version, and retries an unreachable registry', async () => {
  const record = lockfile('  version "1.1.0"');
  for (const body of [
    published({ version: '1.1.1' }),
    published({ name: '@scope/other' }),
    published({ dist: { ...published().dist, integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }),
    published({ dist: { ...published().dist, tarball: 'https://example.com/wasm-1.1.0.tgz' } }),
  ]) {
    registry(body);
    await expect(completedYarnLockSnapshot(snapshot(record) as never, REFUSAL)).rejects.toThrow(
      'does not record a registry tarball and SHA-256-or-stronger integrity for @scope/wasm@1.1.0',
    );
  }
  registry({}, 404);
  await expect(completedYarnLockSnapshot(snapshot(record) as never, REFUSAL)).rejects.toThrow(
    'does not publish @scope/wasm@1.1.0, which yarn.lock locks (HTTP 404)',
  );
  registry({}, 503);
  await expect(
    completedYarnLockSnapshot(snapshot(record) as never, REFUSAL),
  ).rejects.toBeInstanceOf(RegistryUnreachableError);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );
  await expect(
    completedYarnLockSnapshot(snapshot(record) as never, REFUSAL),
  ).rejects.toBeInstanceOf(RegistryUnreachableError);
});

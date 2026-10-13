import { expect, it } from 'vitest';
import { compareApiVersion, validateApiVersion } from './api-version.ts';

const before = { info: { version: '2022-08-01' } };
const after = { info: { version: '2022-11-15' } };

it('marks the configured application version when it exactly matches the before contract', () => {
  expect(compareApiVersion('2022-08-01', before, after)).toMatchObject({
    application: '2022-08-01',
    before: '2022-08-01',
    after: '2022-11-15',
    applicability: 'matches-before',
  });
});

it.each([
  ['the after contract', '2022-11-15', 'matches-after'],
  ['neither contract', '2023-01-01', 'matches-neither'],
] as const)(
  'distinguishes an application version matching %s',
  (_label, version, applicability) => {
    expect(compareApiVersion(version, before, after).applicability).toBe(applicability);
  },
);

it.each([
  [undefined, before, after],
  ['2022-08-01', {}, after],
] as const)('keeps missing version evidence unknown', (version, currentBefore, currentAfter) => {
  expect(compareApiVersion(version, currentBefore, currentAfter).applicability).toBe('unknown');
});

it('trims contract metadata but does not normalize the explicit application pin', () => {
  expect(
    compareApiVersion('2022-08-01', { info: { version: ' 2022-08-01 ' } }, after).applicability,
  ).toBe('matches-before');
});

it.each(['', ' 2022-08-01', '2022-08-01 ', '2022-08-01\n', 'x'.repeat(257)])(
  'rejects malformed explicit API version %j',
  (version) => {
    expect(() => validateApiVersion(version)).toThrow(/trimmed string/);
  },
);

it('allows an omitted API version to remain explicit unknown evidence', () => {
  expect(validateApiVersion(undefined)).toBeUndefined();
});

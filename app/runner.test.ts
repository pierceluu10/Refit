import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '../shared/types.ts';
import { rescanWith } from './runner.ts';
import type { UnderstandJob } from './types.ts';

const JOB: UnderstandJob = {
  kind: 'understand',
  installationId: 70000001,
  repo: 'aptitude-example-org/billing-api',
  reason: 'push',
};
const FINDINGS: Finding[] = [
  { entryId: 'illustrative-entry', file: 'billing.ts', line: 1, matchClass: 'live' },
];
const AT = '2026-11-05T12:00:00.000Z';

describe('rescanWith', () => {
  it('leaves evidence alone for a repo with no merged fix to watch', async () => {
    const rescanFound = vi.fn(async () => {});
    await rescanWith({ hasFixToWatch: async () => false, rescanFound })(JOB, FINDINGS, AT);
    expect(rescanFound).not.toHaveBeenCalled();
  });

  it('passes on the scan it was given for a repo with a merged fix', async () => {
    const rescanFound = vi.fn(async () => {});
    await rescanWith({ hasFixToWatch: async () => true, rescanFound })(JOB, FINDINGS, AT);
    expect(rescanFound).toHaveBeenCalledExactlyOnceWith(JOB.installationId, JOB.repo, FINDINGS, AT);
  });
});

import { expect, it } from 'vitest';
import {
  auditFindings,
  auditGate,
  productionAdvisories,
  validateExceptions,
} from '../scripts/audit-gate-helpers.mjs';

// The shape `npm audit --json` returned for this repository's main on 2026-10-22, trimmed.
const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    vite: {
      name: 'vite',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1,
          name: 'vite',
          dependency: 'vite',
          title: 'launch-editor: `fs.existsSync()` existence check can be bypassed on Windows',
          url: 'https://github.com/advisories/GHSA-587h-7wmj-h5pm',
          severity: 'high',
          range: '>=8.3.0 <=8.3.2',
        },
        {
          source: 2,
          name: 'vite',
          dependency: 'vite',
          title: 'launch-editor: escapeCmdArgs() omits % escaping on Windows',
          url: 'https://github.com/advisories/GHSA-698v-4r3x-3vcv',
          severity: 'moderate',
          range: '>=8.3.0 <=8.3.2',
        },
      ],
    },
    vitest: { name: 'vitest', severity: 'moderate', isDirect: true, via: ['@vitest/mocker'] },
    '@vitest/mocker': {
      name: '@vitest/mocker',
      severity: 'moderate',
      isDirect: false,
      via: [
        {
          source: 3,
          name: '@vitest/mocker',
          dependency: '@vitest/mocker',
          title: 'Vitest: Code injection via unauthenticated manual mock registration',
          url: 'https://github.com/advisories/GHSA-qxg6-89mg-rqv8',
          severity: 'moderate',
          range: '>=2.1.0-beta.7 <4.1.12',
        },
      ],
    },
  },
};
const PRODUCTION = {
  auditReportVersion: 2,
  vulnerabilities: {
    pg: {
      name: 'pg',
      severity: 'critical',
      isDirect: true,
      via: [
        {
          name: 'pg',
          title: 'Hypothetical production advisory',
          url: 'https://github.com/advisories/GHSA-2222-3333-4444',
          severity: 'critical',
          range: '<9.0.0',
        },
      ],
    },
  },
};
const exception = {
  advisory: 'GHSA-587h-7wmj-h5pm',
  package: 'vite',
  reason: 'Windows-only launch-editor path in the vite dev server; CI and the CLI never start it.',
  expires: '2027-01-31',
};

it('reads one finding per advisory and package, following only advisory objects', () => {
  const findings = auditFindings(REPORT);
  expect(findings.map((finding) => [finding.advisory, finding.package, finding.severity])).toEqual([
    ['GHSA-587h-7wmj-h5pm', 'vite', 'high'],
    ['GHSA-698v-4r3x-3vcv', 'vite', 'moderate'],
    ['GHSA-qxg6-89mg-rqv8', '@vitest/mocker', 'moderate'],
  ]);
  expect(findings.every((finding) => !finding.production)).toBe(true);
  expect(auditFindings({ auditReportVersion: 2, vulnerabilities: {} })).toEqual([]);
});

it('marks advisories the production-only audit also reports', () => {
  const combined = {
    vulnerabilities: { ...REPORT.vulnerabilities, ...PRODUCTION.vulnerabilities },
  };
  const findings = auditFindings(combined, productionAdvisories(PRODUCTION));
  expect(
    findings.filter((finding) => finding.production).map((finding) => finding.package),
  ).toEqual(['pg']);
});

it('fails closed when npm audit itself failed or returned something unexpected', () => {
  expect(() =>
    auditFindings({ error: { code: 'ENOTFOUND', summary: 'request to registry failed' } }),
  ).toThrow('npm audit failed: request to registry failed');
  expect(() => auditFindings({})).toThrow('no vulnerability list');
  expect(() =>
    auditFindings({
      vulnerabilities: { x: { via: [{ name: 'x', title: 'No ID', severity: 'high' }] } },
    }),
  ).toThrow('without an ID or severity');
});

it('fails on high and critical advisories unless a reviewed exception covers that exact one', () => {
  const findings = auditFindings(REPORT);
  expect(auditGate(findings, [])).toMatchObject({
    passed: false,
    failing: [{ advisory: 'GHSA-587h-7wmj-h5pm', package: 'vite' }],
  });
  expect(auditGate(findings, [exception])).toEqual({ passed: true, failing: [], unused: [] });
  // An exception names its package: the same advisory elsewhere still fails.
  expect(auditGate(findings, [{ ...exception, package: 'vitest' }]).passed).toBe(false);
  // Moderate advisories are reported but never fail the gate.
  expect(
    auditGate(
      findings.filter((finding) => finding.severity === 'moderate'),
      [],
    ).passed,
  ).toBe(true);
});

it('fails when an exception outlives its advisory, so it cannot hide a later one', () => {
  expect(auditGate([], [exception])).toEqual({ passed: false, failing: [], unused: [exception] });
});

it('accepts only complete, unexpired exceptions with a reason and rejects the whole file otherwise', () => {
  const file = (exceptions: unknown[]) => ({ formatVersion: 1, exceptions });
  expect(validateExceptions(file([exception]), '2026-10-22')).toEqual([exception]);
  expect(validateExceptions(file([]), '2026-10-22')).toEqual([]);
  for (const [value, message] of [
    [{ exceptions: [] }, 'formatVersion'],
    [{ ...file([]), extra: true }, 'formatVersion'],
    [file([{ ...exception, note: 'x' }]), 'exactly advisory'],
    [file([{ ...exception, advisory: 'CVE-2026-0001' }]), 'GHSA advisory ID'],
    [file([{ ...exception, package: ' ' }]), 'package name'],
    [file([{ ...exception, reason: 'not reachable' }]), 'reason of at least'],
    [file([{ ...exception, expires: '2027-02-30' }]), 'YYYY-MM-DD'],
    [file([{ ...exception, expires: '2026-10-21' }]), 'expired on 2026-10-21'],
    [file([{ ...exception, expires: '2027-10-23' }]), 'within 365 days'],
    [file([exception, exception]), 'repeats GHSA-587h-7wmj-h5pm vite'],
  ] as const)
    expect(() => validateExceptions(value, '2026-10-22')).toThrow(message);
});

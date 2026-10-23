// Decides whether `npm audit` results fail CI. High and critical advisories fail unless a reviewed
// exception says why that advisory cannot be reached; any error in the exceptions file fails too.

export const FAILING_SEVERITIES = new Set(['high', 'critical']);
const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const ADVISORY = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXCEPTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_REASON_LENGTH = 20;

// One entry per advisory and package from `npm audit --json`; `production` lists the advisory IDs
// that `npm audit --omit=dev --json` also reports.
export function auditFindings(report, production = new Set()) {
  if (report.error)
    throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code}`);
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null)
    throw new Error('npm audit returned no vulnerability list.');
  const findings = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities))
    for (const via of vulnerability.via ?? []) {
      // String entries point at another vulnerable package, which is listed on its own.
      if (typeof via === 'string') continue;
      const advisory = /GHSA(?:-[a-z0-9]{4}){3}/i.exec(via.url ?? '')?.[0];
      if (!advisory || !SEVERITIES.has(via.severity))
        throw new Error(`npm audit returned an advisory without an ID or severity: ${via.title}`);
      findings.set(`${advisory} ${via.name}`, {
        advisory,
        package: via.name,
        severity: via.severity,
        title: via.title,
        range: via.range,
        production: production.has(advisory),
      });
    }
  return [...findings.values()].sort((left, right) =>
    `${left.advisory} ${left.package}`.localeCompare(`${right.advisory} ${right.package}`),
  );
}

export function productionAdvisories(report) {
  return new Set(auditFindings(report).map((finding) => finding.advisory));
}

// Rejects the whole file on any error, like .refit-deadlines-ignore.json.
export function validateExceptions(value, today) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join(',') !== 'exceptions,formatVersion' ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.exceptions)
  )
    throw new Error('Audit exceptions need exactly formatVersion: 1 and an exceptions list.');
  const seen = new Set();
  return value.exceptions.map((entry, index) => {
    const where = `Audit exception ${index + 1}`;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Object.keys(entry).sort().join(',') !== 'advisory,expires,package,reason'
    )
      throw new Error(`${where} needs exactly advisory, package, reason and expires.`);
    if (typeof entry.advisory !== 'string' || !ADVISORY.test(entry.advisory))
      throw new Error(`${where} needs a GHSA advisory ID.`);
    if (typeof entry.package !== 'string' || !entry.package.trim())
      throw new Error(`${where} needs the affected package name.`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH)
      throw new Error(`${where} needs a reason of at least ${MIN_REASON_LENGTH} characters.`);
    const expires =
      typeof entry.expires === 'string' && ISO_DATE.test(entry.expires)
        ? Date.parse(`${entry.expires}T00:00:00Z`)
        : NaN;
    if (!Number.isFinite(expires) || new Date(expires).toISOString().slice(0, 10) !== entry.expires)
      throw new Error(`${where} needs an expires date as YYYY-MM-DD.`);
    const days = (expires - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
    if (days < 0) throw new Error(`${where} for ${entry.advisory} expired on ${entry.expires}.`);
    if (days > MAX_EXCEPTION_DAYS)
      throw new Error(`${where} must expire within ${MAX_EXCEPTION_DAYS} days.`);
    const key = `${entry.advisory} ${entry.package}`;
    if (seen.has(key)) throw new Error(`${where} repeats ${key}.`);
    seen.add(key);
    return entry;
  });
}

export function auditGate(findings, exceptions) {
  const excepted = new Set(exceptions.map((entry) => `${entry.advisory} ${entry.package}`));
  const failing = findings.filter(
    (finding) =>
      FAILING_SEVERITIES.has(finding.severity) &&
      !excepted.has(`${finding.advisory} ${finding.package}`),
  );
  const current = new Set(findings.map((finding) => `${finding.advisory} ${finding.package}`));
  // An exception for an advisory npm no longer reports should be deleted, so it cannot hide a
  // later, unrelated reappearance.
  const unused = exceptions.filter((entry) => !current.has(`${entry.advisory} ${entry.package}`));
  return { failing, unused, passed: failing.length === 0 && unused.length === 0 };
}

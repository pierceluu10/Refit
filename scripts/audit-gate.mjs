// Fails when npm audit reports a high or critical advisory without a reviewed exception.
// Usage: node scripts/audit-gate.mjs   (reads package-lock.json; nothing is installed)
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  auditFindings,
  auditGate,
  productionAdvisories,
  validateExceptions,
} from './audit-gate-helpers.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const EXCEPTIONS = fileURLToPath(new URL('./audit-exceptions.json', import.meta.url));

async function audit(args) {
  try {
    const { stdout } = await execute('npm', ['audit', '--json', ...args], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // npm audit exits non-zero whenever it reports anything; its JSON is still the result.
    if (
      error instanceof Error &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      error.stdout
    )
      return JSON.parse(error.stdout);
    throw error;
  }
}

const exceptions = validateExceptions(
  JSON.parse(await readFile(EXCEPTIONS, 'utf8')),
  new Date().toISOString().slice(0, 10),
);
const findings = auditFindings(await audit([]), productionAdvisories(await audit(['--omit=dev'])));
const result = auditGate(findings, exceptions);
for (const finding of findings)
  console.log(
    `${finding.severity} ${finding.production ? 'production' : 'development'} ${finding.advisory} ${finding.package} ${finding.range}: ${finding.title}`,
  );
for (const entry of result.unused)
  console.error(
    `Unused exception ${entry.advisory} ${entry.package}: npm no longer reports it; delete it.`,
  );
for (const finding of result.failing)
  console.error(
    `Failing: ${finding.severity} ${finding.advisory} in ${finding.package}. Update the package, or record why it is unreachable in scripts/audit-exceptions.json.`,
  );
if (result.passed)
  console.log(
    `npm audit gate passed: ${findings.length} advisories, ${exceptions.length} exceptions.`,
  );
else process.exitCode = 1;

// Usage: node inventory/dead-scan-cli.ts <dir> <owner/name> [--json] [--store dir] [--check]
// Only --check can spend, and it refuses without APTITUDE_AI_BUDGET_USD.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkUnclear } from './dead-check.ts';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';

const USAGE =
  'Usage: node inventory/dead-scan-cli.ts <dir> <owner/name> [--json] [--store dir] [--check]';

function printReport(report: DeadScanReport): void {
  for (const finding of report.details) {
    const fix = finding.withFix ? ' [with fix]' : '';
    const version = finding.version ? ` @ ${finding.version}` : '';
    console.log(
      `${finding.matchClass}${fix} ${finding.entryId}${version} ${finding.file}:${finding.line}`,
    );
    console.log(`  ${finding.reason}`);
    console.log(`  ${finding.text}`);
  }
  console.log(`quiet below a version gate or with no provider: ${report.quiet.length}`);
  for (const one of report.quiet) {
    console.log(`  ${one.entryId} ${one.file}:${one.line}: ${one.reason}`);
  }
  console.log(`skipped or read in part: ${report.skipped.length}`);
  for (const one of report.skipped) console.log(`  ${one.file}: ${one.reason}`);
  console.log(`unlisted providers: ${report.unlistedProviders.join(', ') || 'none'}`);
  if (report.check) {
    const { outcome, asked, costUsd, error } = report.check;
    console.log(
      `AI check: ${outcome}, ${asked} asked, $${costUsd.toFixed(4)}${error ? `, ${error}` : ''}`,
    );
  }
  console.log(`clean: ${report.clean}`);
  console.log(`${report.seconds.toFixed(1)} s, ${report.filesRead} files read`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    store: { type: 'string' },
  },
});
const [dir, repo] = positionals;
if (!dir || !repo) {
  console.error(USAGE);
  process.exit(2);
}
const repoDir = path.resolve(dir);
const scanned = await scanDeadApis(repoDir, repo, { storeDir: values.store });
const report = values.check ? await checkUnclear(scanned, repoDir) : scanned;
if (values.json) console.log(JSON.stringify(report, null, 2));
else printReport(report);

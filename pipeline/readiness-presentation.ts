import type { ReadinessReport } from './readiness.ts';
import { terminalText } from './workflow-presentation.ts';

const CHECK_LABELS = { passed: 'PASS', review: 'REVIEW', blocked: 'BLOCKED' };
const MAX_VISIBLE_METHODS = 3;

export function renderReadiness(report: ReadinessReport) {
  // The verdict and the first thing to do come first; the per-check detail follows.
  const blocked = report.checks.filter((check) => check.status === 'blocked');
  const lines = [
    report.status === 'ready-for-validation'
      ? 'Refit is ready to attempt validation'
      : `Refit setup needs attention: ${blocked.length} of ${report.checks.length} check${report.checks.length === 1 ? '' : 's'} blocked`,
    // Committing comes last, once the other fixes have written their files.
    ...((next) => (next?.action ? [`Next: ${terminalText(next.action)}`] : []))(
      blocked.find((check) => check.id !== 'repository') ?? blocked[0],
    ),
    '',
    `Configuration  ${terminalText(report.configuration)}`,
    ...(report.integration ? [`Integration    ${terminalText(report.integration)}`] : []),
    ...(report.repository ? [`Repository     ${terminalText(report.repository)}`] : []),
    ...(report.provider ? [`Provider       ${terminalText(report.provider.id)}`] : []),
    '',
  ];
  for (const check of report.checks) {
    lines.push(`${CHECK_LABELS[check.status]}  ${check.title}`, `  ${terminalText(check.detail)}`);
    if (check.action) lines.push(`  Next: ${terminalText(check.action)}`);
  }
  const unmapped = report.sdkCoverage?.unmappedMethods ?? [];
  if (unmapped.length)
    lines.push(
      '',
      `Unmapped SDK methods: ${unmapped.slice(0, MAX_VISIBLE_METHODS).map(terminalText).join(', ')}${unmapped.length > MAX_VISIBLE_METHODS ? `, and ${unmapped.length - MAX_VISIBLE_METHODS} more` : ''}`,
    );
  lines.push(
    '',
    'Doctor only reads files: it runs no code, installs and downloads nothing, and the configuration is not approved or activated. Passing checks permit a validation attempt, not proof the migration is correct.',
  );
  return lines.join('\n');
}

import type { ReadinessReport } from './readiness.ts';
import { terminalText } from './workflow-presentation.ts';

const CHECK_LABELS = { passed: 'PASS', review: 'REVIEW', blocked: 'BLOCKED' };
const MAX_VISIBLE_METHODS = 3;

export function renderReadiness(report: ReadinessReport) {
  const lines = [
    report.status === 'ready-for-validation'
      ? 'Refit is ready to attempt validation'
      : 'Refit setup needs attention',
    '',
    `Configuration  ${terminalText(report.configuration)}`,
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
  lines.push('', ...report.scope);
  return lines.join('\n');
}

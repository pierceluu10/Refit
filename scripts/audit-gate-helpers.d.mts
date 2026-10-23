// Types for the plain-JavaScript npm audit gate helpers, so pipeline tests can import them.

export interface AuditFinding {
  advisory: string;
  package: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  range: string;
  production: boolean;
}
export interface AuditException {
  advisory: string;
  package: string;
  reason: string;
  expires: string;
}

export const FAILING_SEVERITIES: Set<string>;
export function auditFindings(report: unknown, production?: Set<string>): AuditFinding[];
export function productionAdvisories(report: unknown): Set<string>;
export function validateExceptions(value: unknown, today: string): AuditException[];
export function auditGate(
  findings: AuditFinding[],
  exceptions: AuditException[],
): { failing: AuditFinding[]; unused: AuditException[]; passed: boolean };

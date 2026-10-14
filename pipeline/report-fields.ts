export function affectedFields<T extends { id?: unknown }>(
  changes: readonly T[],
  findings: readonly { changeId?: unknown }[],
) {
  const used = new Set(
    findings.map((finding) => finding.changeId).filter((id) => typeof id === 'string'),
  );
  const affected = changes.filter((change) => typeof change.id === 'string' && used.has(change.id));
  return affected.length ? affected : changes;
}

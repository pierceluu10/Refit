// Measures what the agent's reading added: declarations of its findings that no scanner signalled.
// A measure for evaluations; it plays no part in a run and decides nothing.
import type { DependencyFinding } from '../dependency-merge.ts';
import { findDirectDependencies } from '../scanners-libraries.ts';
import { findAiModels } from '../scanners-models.ts';
import { findCiVersions, findContainerImages, findRuntimeVersions } from '../scanners-platform.ts';

export type ScannerGap = {
  // Found by the agent and pointed at by no scanner line at all.
  findings: { kind: string; name: string; version?: string }[];
  // Declarations of any finding that no scanner pointed at.
  declarations: { name: string; file: string; line?: number; text?: string }[];
  // Scanner lines the agent did not use as a declaration, for reading noise or misses by hand.
  unusedSignals: string[];
};

const location = (file: string, line: number | undefined) => `${file}:${line ?? ''}`;

async function scannerLines(repoDir: string): Promise<Map<string, string>> {
  const lines = new Map<string, string>();
  const add = (file: string, line: number, label: string) =>
    lines.set(location(file, line), `${label} at ${file}:${line}`);
  for (const { signals } of [
    await findRuntimeVersions(repoDir),
    await findContainerImages(repoDir),
    await findCiVersions(repoDir),
  ]) {
    for (const signal of signals) add(signal.file, signal.line, signal.name);
  }
  for (const { dependencies } of (await findDirectDependencies(repoDir)).packages) {
    for (const { name, file, line, resolved } of dependencies) {
      add(file, line, name);
      if (resolved) add(resolved.lockfile, resolved.line, name);
    }
  }
  const { models, settings } = await findAiModels(repoDir);
  for (const { model, occurrences } of models) {
    for (const { file, line } of occurrences) add(file, line, model);
  }
  for (const { file, line, text } of settings) add(file, line, text);
  return lines;
}

export async function scannerGap(
  repoDir: string,
  dependencies: DependencyFinding[],
): Promise<ScannerGap> {
  const lines = await scannerLines(repoDir);
  const used = new Set<string>();
  const gap: ScannerGap = { findings: [], declarations: [], unusedSignals: [] };
  for (const { kind, name, version, declaredIn, callSites } of dependencies) {
    const places = [...declaredIn, ...(callSites ?? [])];
    for (const { file, line } of places) used.add(location(file, line));
    if (!places.some(({ file, line }) => lines.has(location(file, line)))) {
      gap.findings.push({ kind, name, ...(version ? { version } : {}) });
    }
    for (const { file, line, text } of declaredIn) {
      if (!lines.has(location(file, line))) {
        gap.declarations.push({ name, file, line, ...(text ? { text } : {}) });
      }
    }
  }
  gap.unusedSignals = [...lines].filter(([key]) => !used.has(key)).map(([, label]) => label);
  return gap;
}

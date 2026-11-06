// Holds the dependencies the agent records. Like UsageCollector, it checks every location against
// the file and merges repeat reports mechanically. It never judges what counts as a dependency.
import path from 'node:path';
import type { DependencyKind, ProviderHints } from '../shared/types.ts';
import { readLineAt } from './collector.ts';
import type { CallSite } from './collector.ts';
import type { DependencyFinding } from './dependency-merge.ts';
import { checkHints, mergeHints } from './hints.ts';
import type { RejectedHint } from './hints.ts';
import { readText } from './repo-files.ts';
import { isEnvFile, isEnvTemplate } from './scanners.ts';

export type Declaration = { file: string; line?: number };

export type DependencyEntry = {
  kind: DependencyKind;
  name: string;
  ecosystem?: string;
  version?: string;
  package?: string;
  declaredIn: Declaration[];
  callSites?: CallSite[];
  notes?: string;
  hints?: ProviderHints;
};

type Rejected = { file: string; line?: number; reason: string };

export type DependencyOutcome = {
  key: string;
  accepted: { file: string; line?: number; text?: string }[];
  rejected: Rejected[];
  hints?: { accepted: ProviderHints; rejected: RejectedHint[] };
};

const ROOT_PACKAGE = '.';

// Different versions are different entries, so each can be watched and upgraded on its own.
export function dependencyKey(
  entry: Pick<DependencyEntry, 'kind' | 'name' | 'ecosystem' | 'version' | 'package'>,
): string {
  return [
    entry.kind,
    entry.ecosystem?.trim().toLowerCase() ?? '',
    entry.name.trim(),
    entry.version?.trim() ?? '',
    packageDir(entry.package) ?? ROOT_PACKAGE,
  ].join('|');
}

function packageDir(value: string | undefined): string | undefined {
  const dir = value && path.posix.normalize(value.trim()).replace(/\/$/, '');
  return dir && dir !== ROOT_PACKAGE ? dir : undefined;
}

// A committed env file's values may be real secrets, so only its key name is kept.
function safeLineText(file: string, text: string): string {
  const name = path.posix.basename(file);
  if (!isEnvFile(name) || isEnvTemplate(name)) return text;
  return text.split('=')[0].trim();
}

export class DependencyCollector {
  readonly repo: string;
  readonly repoDir: string;
  private readonly findings = new Map<string, DependencyFinding>();

  constructor(repoDir: string, repo: string) {
    this.repoDir = repoDir;
    this.repo = repo;
  }

  async record(entry: DependencyEntry): Promise<DependencyOutcome> {
    const key = dependencyKey(entry);
    const outcome: DependencyOutcome = { key, accepted: [], rejected: [] };
    const known = this.findings.get(key);
    const owner = packageDir(entry.package);
    const finding: DependencyFinding = known ?? {
      repo: this.repo,
      kind: entry.kind,
      name: entry.name.trim(),
      ...(entry.ecosystem ? { ecosystem: entry.ecosystem.trim() } : {}),
      ...(entry.version ? { version: entry.version.trim() } : {}),
      ...(owner ? { package: owner } : {}),
      declaredIn: [],
    };
    for (const declaration of entry.declaredIn) {
      const checked = await this.check(declaration);
      if ('reason' in checked) {
        outcome.rejected.push({ ...declaration, reason: checked.reason });
        continue;
      }
      const found = { ...declaration, ...(checked.text ? { text: checked.text } : {}) };
      outcome.accepted.push(found);
      if (
        !finding.declaredIn.some((place) => place.file === found.file && place.line === found.line)
      ) {
        finding.declaredIn.push(found);
      }
    }
    for (const site of entry.callSites ?? []) {
      const checked = await readLineAt(this.repoDir, site.file, site.line);
      if ('reason' in checked) {
        outcome.rejected.push({ file: site.file, line: site.line, reason: checked.reason });
        continue;
      }
      outcome.accepted.push({ file: site.file, line: site.line, text: checked.text });
      const sites = finding.callSites ?? [];
      finding.callSites = [
        ...sites.filter(
          (known) =>
            known.file !== site.file ||
            known.line !== site.line ||
            known.operation !== site.operation,
        ),
        site,
      ];
    }
    if (entry.hints) {
      outcome.hints = checkHints(entry.hints);
      const hints = mergeHints(finding.hints, outcome.hints.accepted);
      if (hints) finding.hints = hints;
    }
    if (entry.notes) finding.notes = entry.notes;
    if (finding.declaredIn.length > 0 || finding.callSites?.length) this.findings.set(key, finding);
    return outcome;
  }

  remove(key: string): boolean {
    return this.findings.delete(key);
  }

  list(): { key: string; dependency: DependencyFinding }[] {
    return [...this.findings.entries()].map(([key, dependency]) => ({ key, dependency }));
  }

  private async check(declaration: Declaration): Promise<{ text?: string } | { reason: string }> {
    if (declaration.line === undefined) return this.checkFile(declaration.file);
    const checked = await readLineAt(this.repoDir, declaration.file, declaration.line);
    return 'reason' in checked ? checked : { text: safeLineText(declaration.file, checked.text) };
  }

  private async checkFile(file: string): Promise<{ text?: string } | { reason: string }> {
    try {
      return (await readText(this.repoDir, file)) === undefined
        ? { reason: `${file} is binary or too large; give a line only if you can read it` }
        : {};
    } catch (error) {
      return { reason: `cannot read ${file}: ${(error as Error).message}` };
    }
  }
}

// Holds the surfaces the agent records. It checks every location against the file so the agent
// learns at once when a line number is wrong, and merges duplicate reports mechanically. It never
// judges whether something is a surface or whether it matters: that is the agent's call.
import type { DependencyKind, DependencyUsage } from '../../shared/types.ts';
import { readText } from '../repo-files.ts';

export const SURFACE_KINDS = [
  'platform',
  'infrastructure',
  'security-standard',
  'regulated-surface',
] as const satisfies readonly DependencyKind[];
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export type SurfaceLocation = { file: string; line: number; text?: string };

export type SurfaceReport = {
  kind: SurfaceKind;
  name: string;
  ecosystem?: string;
  version?: string;
  locations: SurfaceLocation[];
  notes: string;
};

export type SurfaceUsage = DependencyUsage & { kind: SurfaceKind };

export type SurfaceRecordOutcome = {
  key: string;
  accepted: { file: string; line: number; text: string }[];
  rejected: { file: string; line: number; reason: string }[];
  saved: boolean;
};

const LINE_PREVIEW_LENGTH = 160;

export function surfaceKey(report: Pick<SurfaceReport, 'kind' | 'name' | 'ecosystem'>): string {
  return [report.kind, report.name.trim().toLowerCase(), report.ecosystem?.trim() ?? ''].join('|');
}

export class SurfaceCollector {
  readonly repo: string;
  readonly repoDir: string;
  private readonly surfaces = new Map<string, SurfaceUsage>();

  constructor(repoDir: string, repo: string) {
    this.repoDir = repoDir;
    this.repo = repo;
  }

  async record(report: SurfaceReport): Promise<SurfaceRecordOutcome> {
    const key = surfaceKey(report);
    const outcome: SurfaceRecordOutcome = { key, accepted: [], rejected: [], saved: false };
    const existing: SurfaceUsage = this.surfaces.get(key) ?? {
      repo: this.repo,
      kind: report.kind,
      name: report.name.trim(),
      declaredIn: [],
    };
    for (const location of report.locations) {
      const check = await this.lineAt(location.file, location.line);
      if ('reason' in check) {
        outcome.rejected.push({ file: location.file, line: location.line, reason: check.reason });
        continue;
      }
      outcome.accepted.push({ file: location.file, line: location.line, text: check.text });
      const known = existing.declaredIn.findIndex(
        (place) => place.file === location.file && place.line === location.line,
      );
      const place = { file: location.file, line: location.line, text: check.text };
      if (known === -1) existing.declaredIn.push(place);
      else existing.declaredIn[known] = place;
    }
    if (report.ecosystem) existing.ecosystem = report.ecosystem.trim();
    if (report.version) existing.version = report.version.trim();
    existing.notes = mergeNotes(existing.notes, report.notes);
    if (existing.declaredIn.length > 0) {
      this.surfaces.set(key, existing);
      outcome.saved = true;
    }
    return outcome;
  }

  // Removes a whole surface, or only the listed locations of it.
  remove(key: string, locations?: { file: string; line: number }[]): boolean {
    const surface = this.surfaces.get(key);
    if (!surface) return false;
    if (!locations) return this.surfaces.delete(key);
    surface.declaredIn = surface.declaredIn.filter(
      (place) => !locations.some((gone) => gone.file === place.file && gone.line === place.line),
    );
    if (surface.declaredIn.length === 0) this.surfaces.delete(key);
    return true;
  }

  list(): { key: string; surface: SurfaceUsage }[] {
    return [...this.surfaces.entries()].map(([key, surface]) => ({ key, surface }));
  }

  surfacesForOutput(): SurfaceUsage[] {
    return this.list()
      .map(({ surface }) => ({
        ...surface,
        declaredIn: [...surface.declaredIn].sort(
          (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
        ),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  private async lineAt(file: string, line: number): Promise<{ text: string } | { reason: string }> {
    let text: string | undefined;
    try {
      text = await readText(this.repoDir, file);
    } catch (error) {
      return { reason: `cannot read ${file}: ${(error as Error).message}` };
    }
    if (text === undefined) return { reason: `${file} is binary or too large` };
    const lines = text.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      return { reason: `${file} has ${lines.length} lines; line ${line} does not exist` };
    }
    return { text: lines[line - 1].trim().slice(0, LINE_PREVIEW_LENGTH) };
  }
}

function mergeNotes(before: string | undefined, added: string): string {
  const note = added.trim();
  if (!before) return note;
  if (!note || before.includes(note)) return before;
  return `${before}\n${note}`;
}

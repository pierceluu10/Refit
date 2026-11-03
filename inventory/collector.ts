// Holds what the agent and its area readers record. It checks each location against the file so
// the agent learns at once when a line number is wrong, and merges duplicate reports mechanically.
// It never judges whether something is an API: that is the agent's call.
import type { ApiUsage, ProviderHints } from '../shared/types.ts';
import { checkHints, mergeHints } from './hints.ts';
import type { RejectedHint } from './hints.ts';
import { readText } from './repo-files.ts';

export type CallSite = ApiUsage['callSites'][number];
export type Via = ApiUsage['via'];

export type UsageReport = {
  provider: string;
  via: Via;
  purpose?: string;
  sdk?: ApiUsage['sdk'];
  pinnedVersion?: ApiUsage['pinnedVersion'];
  callSites: CallSite[];
  hints?: ProviderHints;
};

export type RecordedUsage = ApiUsage & { purpose?: string };

export type RecordOutcome = {
  key: string;
  accepted: { file: string; line: number; text: string }[];
  rejected: { file: string; line: number; reason: string }[];
  pinnedVersion?: { accepted: boolean; text?: string; reason?: string };
  hints?: { accepted: ProviderHints; rejected: RejectedHint[] };
};

const LINE_PREVIEW_LENGTH = 160;

const PYTHON_FILES =
  /(^|\/)(poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|pyproject\.toml|setup\.py)$/;

// npm and PyPI both have a "stripe" and an "openai": a Python SDK's key says so, so the two stay apart.
export function usageKey(report: Pick<UsageReport, 'provider' | 'via' | 'sdk'>): string {
  const key = [report.provider.trim().toLowerCase(), report.via, report.sdk?.name ?? ''];
  if (report.sdk?.lockfile && PYTHON_FILES.test(report.sdk.lockfile)) key.push('python');
  return key.join('|');
}

export class UsageCollector {
  readonly repo: string;
  readonly repoDir: string;
  private readonly usages = new Map<string, RecordedUsage>();

  constructor(repoDir: string, repo: string) {
    this.repoDir = repoDir;
    this.repo = repo;
  }

  // A report that says less than a usage already recorded (by the code scan, say) is that usage:
  // no sdk for a provider and channel recorded once, or an sdk with no lockfile recorded once.
  private keyFor(report: UsageReport): string {
    const exact = usageKey(report);
    if (this.usages.has(exact) || report.sdk?.lockfile) return exact;
    const [provider, via] = exact.split('|');
    const same = [...this.usages.keys()].filter((key) => {
      const [knownProvider, knownVia, knownSdk] = key.split('|');
      return (
        knownProvider === provider &&
        knownVia === via &&
        (!report.sdk || knownSdk === report.sdk.name)
      );
    });
    return same.length === 1 ? same[0] : exact;
  }

  async record(report: UsageReport, options: { python?: boolean } = {}): Promise<RecordOutcome> {
    const found = this.keyFor(report);
    // The code scan knows a Python SDK even when no manifest declares it.
    const key = options.python && !found.endsWith('|python') ? `${found}|python` : found;
    const outcome: RecordOutcome = { key, accepted: [], rejected: [] };
    const existing = this.usages.get(key) ?? {
      repo: this.repo,
      provider: report.provider.trim(),
      via: report.via,
      callSites: [],
    };
    for (const site of report.callSites) {
      const check = await this.lineAt(site.file, site.line);
      if ('reason' in check) {
        outcome.rejected.push({ file: site.file, line: site.line, reason: check.reason });
        continue;
      }
      outcome.accepted.push({ file: site.file, line: site.line, text: check.text });
      const duplicate = existing.callSites.findIndex(
        (known) =>
          known.file === site.file &&
          known.line === site.line &&
          known.operation === site.operation,
      );
      if (duplicate === -1) existing.callSites.push(site);
      else existing.callSites[duplicate] = site;
    }
    if (report.pinnedVersion) {
      const check = await this.lineAt(report.pinnedVersion.file, report.pinnedVersion.line);
      if ('reason' in check) {
        outcome.pinnedVersion = { accepted: false, reason: check.reason };
      } else {
        existing.pinnedVersion = report.pinnedVersion;
        outcome.pinnedVersion = { accepted: true, text: check.text };
      }
    }
    if (report.hints) {
      outcome.hints = checkHints(report.hints);
      const hints = mergeHints(existing.hints, outcome.hints.accepted);
      if (hints) existing.hints = hints;
    }
    if (report.sdk) existing.sdk = report.sdk;
    if (report.purpose) existing.purpose = report.purpose;
    if (existing.callSites.length > 0 || existing.sdk || existing.pinnedVersion) {
      this.usages.set(key, existing);
    }
    return outcome;
  }

  // Removes a whole usage, or only the listed call sites of it.
  remove(key: string, sites?: { file: string; line: number }[]): boolean {
    const usage = this.usages.get(key);
    if (!usage) return false;
    if (!sites) return this.usages.delete(key);
    usage.callSites = usage.callSites.filter(
      (known) => !sites.some((site) => site.file === known.file && site.line === known.line),
    );
    return true;
  }

  list(): { key: string; usage: RecordedUsage }[] {
    return [...this.usages.entries()].map(([key, usage]) => ({ key, usage }));
  }

  usagesForOutput(): ApiUsage[] {
    return this.list().map(({ usage }) => {
      const { purpose: _purpose, ...apiUsage } = usage;
      return {
        ...apiUsage,
        callSites: [...apiUsage.callSites].sort(
          (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
        ),
      };
    });
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

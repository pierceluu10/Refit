// An AI second opinion on each PR. Advisory only: it is stored next to the grade and never
// changes it. Scoring reads RunRecord.outcome and nothing here.
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import type { Meter } from '../runner/types.ts';
import type { ModelClient } from './model.ts';

export type AdvisoryReview = {
  /** The reviewer's overall read. 'unavailable' when the reviewer itself failed. */
  opinion: 'looks-right' | 'has-concerns' | 'unsure' | 'unavailable';
  summary: string;
  concerns: { file?: string; issue: string; severity: 'high' | 'medium' | 'low' }[];
  /** What a human hand-checker should look at first. */
  checkFirst?: string[];
  costUsd: number;
  model: string;
};

export const REVIEWER_PROMPT_VERSION = 'reviewer-v1';

export const REVIEWER_SYSTEM = `You are a senior engineer giving a second opinion on a pull request that Aptitude, an AI migration agent, opened after an external API changed.

Read the change, the quoted source, the diff and the checks. Think about:
- whether the diff actually handles the API change at every affected call site;
- behaviour the diff changes beyond what the API change forces;
- anything the checks do not prove (untested paths, live calls, webhooks, types that only look right);
- whether the PR's grade (verified or needs-review) matches what the checks show.

Your review is advisory. It never changes the grade; a human reads it next to the PR. Be concrete: name files and lines. If you are unsure, say what you'd need to know.

Reply with one JSON object and nothing else:
{"opinion": "looks-right" | "has-concerns" | "unsure", "summary": string, "concerns": [{"file": string, "issue": string, "severity": "high" | "medium" | "low"}], "checkFirst": [string]}`;

const MAX_DIFF_CHARS = 60_000;
// The repo files the reviewer reads next to the diff: each one capped, and all of them together.
const MAX_FILE_CHARS = 15_000;
export const MAX_CONTEXT_CHARS = 40_000;
// Room for adaptive thinking plus the JSON reply; a review that runs out keeps its words as unsure.
export const REVIEW_MAX_TOKENS = 6000;

/** The reply's shape, so a real model returns parseable JSON (structured outputs). */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['opinion', 'summary', 'concerns', 'checkFirst'],
  properties: {
    opinion: { type: 'string', enum: ['looks-right', 'has-concerns', 'unsure'] },
    summary: { type: 'string' },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'issue', 'severity'],
        properties: {
          file: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    checkFirst: { type: 'array', items: { type: 'string' } },
  },
};

/** A repo file as it was before the change, for the reviewer to read next to the diff. */
export type ContextFile = { path: string; content: string };

// Real env files are never read (hard limit 4); templates are fine. Lockfiles are noise.
const SKIPPED =
  /^(?:\.env(?!\.(?:example|sample|template|dist)$).*|\.envrc|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|bun\.lockb?)$/;

/** Files the diff touches, then the call-site files the match agent named, without repeats. */
export function contextPaths(task: MigrationTask, record: RunRecord): string[] {
  const touched = [...record.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]?.trim());
  const sites = task.usages.flatMap((usage) => usage.callSites.map((site) => site.file));
  return [...new Set([...touched, ...sites])].filter(
    (path): path is string =>
      typeof path === 'string' && path !== '' && !SKIPPED.test(basename(path)),
  );
}

/**
 * Reads the context files from the untouched checkout, on the host and read-only: nothing in the
 * repo runs. A path that leaves the checkout (through .. or a symlink) is skipped, as is a file
 * that is missing, too big, or not text.
 */
export async function readContextFiles(repoDir: string, paths: string[]): Promise<ContextFile[]> {
  const root = await realpath(repoDir);
  const files: ContextFile[] = [];
  let total = 0;
  for (const path of paths) {
    if (total >= MAX_CONTEXT_CHARS) break;
    if (SKIPPED.test(basename(path))) continue;
    try {
      const full = await realpath(join(root, path));
      if (!full.startsWith(root + sep)) continue;
      if ((await stat(full)).size > 4 * MAX_FILE_CHARS) continue;
      const text = await readFile(full, 'utf8');
      if (text.includes('\u0000')) continue;
      const room = Math.min(MAX_FILE_CHARS, MAX_CONTEXT_CHARS - total);
      const content =
        text.length > room ? `${text.slice(0, room)}\n... (truncated at ${room} characters)` : text;
      files.push({ path, content });
      total += content.length;
    } catch {
      continue;
    }
  }
  return files;
}

export function buildReviewPrompt(
  task: MigrationTask,
  record: RunRecord,
  files: ContextFile[] = [],
): string {
  const diff =
    record.diff.length > MAX_DIFF_CHARS
      ? `${record.diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated at ${MAX_DIFF_CHARS} characters)`
      : record.diff;
  const sites = task.usages
    .flatMap((usage) =>
      usage.callSites.map((site) => `- ${site.file}:${site.line} ${site.operation} (${usage.via})`),
    )
    .join('\n');
  const checks = record.checks
    .map((check) => `- ${check.name}: before ${check.before}; after ${check.after}`)
    .join('\n');
  return [
    `Repository: ${task.repo}`,
    `Task: ${task.id}`,
    `Change: ${task.change.title} (${task.change.provider}, ${task.change.kind})`,
    task.change.effectiveDate ? `Effective: ${task.change.effectiveDate}` : '',
    `Source: ${task.change.source.url}`,
    `Quote: "${task.change.source.quote}"`,
    '',
    'Affected call sites the match agent named:',
    sites || '- (none listed)',
    '',
    `Grade the agent gave: ${record.outcome}`,
    record.pr ? `PR: ${record.pr}` : '',
    '',
    'Checks (before and after):',
    checks || '- (none recorded)',
    '',
    'Diff:',
    diff,
    ...(files.length > 0
      ? [
          '',
          'Repository files before the change (the files the diff touches and the named call sites; read them before you raise a concern about code the diff does not show):',
          ...files.flatMap((file) => ['', `--- ${file.path}`, file.content]),
        ]
      : []),
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

const OPINIONS = new Set(['looks-right', 'has-concerns', 'unsure']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

export function parseReview(text: string): Omit<AdvisoryReview, 'costUsd' | 'model'> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    if (start < 0 || end < start) throw new Error('no JSON object');
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const opinion =
      typeof raw.opinion === 'string' && OPINIONS.has(raw.opinion) ? raw.opinion : 'unsure';
    const concerns = Array.isArray(raw.concerns)
      ? raw.concerns.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return [];
          const concern = item as Record<string, unknown>;
          if (typeof concern.issue !== 'string') return [];
          return [
            {
              ...(typeof concern.file === 'string' ? { file: concern.file } : {}),
              issue: concern.issue,
              severity: (typeof concern.severity === 'string' && SEVERITIES.has(concern.severity)
                ? concern.severity
                : 'medium') as 'high' | 'medium' | 'low',
            },
          ];
        })
      : [];
    const checkFirst = Array.isArray(raw.checkFirst)
      ? raw.checkFirst.filter((item): item is string => typeof item === 'string')
      : undefined;
    return {
      opinion: opinion as AdvisoryReview['opinion'],
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      concerns,
      ...(checkFirst ? { checkFirst } : {}),
    };
  } catch {
    // Keep the reviewer's words even when they aren't JSON; a human can still read them.
    return { opinion: 'unsure', summary: text.trim().slice(0, 4000), concerns: [] };
  }
}

/**
 * Builds the advisory reviewer the runner calls for each PR. Given the untouched checkout, it also
 * shows the model the files the diff touches and the named call sites, so its concerns rest on the
 * code rather than guesses about it.
 */
export function createReviewer(client: ModelClient) {
  return async ({
    task,
    record,
    meter,
    repoDir,
  }: {
    task: MigrationTask;
    record: RunRecord;
    meter: Meter;
    repoDir?: string;
  }): Promise<AdvisoryReview> => {
    const files = repoDir ? await readContextFiles(repoDir, contextPaths(task, record)) : [];
    const response = await client.complete({
      system: REVIEWER_SYSTEM,
      prompt: buildReviewPrompt(task, record, files),
      maxTokens: REVIEW_MAX_TOKENS,
      jsonSchema: REVIEW_SCHEMA,
    });
    meter.charge(response.costUsd, `review ${task.id}`);
    return { ...parseReview(response.text), costUsd: response.costUsd, model: response.model };
  };
}

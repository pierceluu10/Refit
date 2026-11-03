// The provider contract. A provider is a folder with provider.json (this
// ProviderSpec: a name and hints, optionally starting pages) and prompt.md (a
// short note for the agent), and optionally knowledge.json. No code is needed
// to add one, and a provider with no folder is watched from its hints alone.

import type { MigrationKind, ProviderChange, ProviderHints } from '../../shared/types.ts';
import type { TurnLog } from './agent.ts';

export type SourceKind =
  | 'changelog'
  | 'release-notes'
  | 'sdk-releases'
  | 'deprecations'
  | 'versioning'
  | 'openapi'
  | 'graphql-schema'
  | 'other';

export type ProviderSource = {
  /** Stable id, used for fixture file names. Lowercase, digits and dashes. */
  id: string;
  kind: SourceKind;
  url: string;
  /** How to turn the response into text. Detected from the response when omitted. */
  format?: 'html' | 'rss' | 'markdown' | 'github-releases' | 'json' | 'text';
  note?: string;
};

export type ProviderSpec = {
  /** Folder name and ProviderChange.provider value, e.g. 'stripe'. */
  id: string;
  name: string;
  /** Pages the agent starts from. Optional: the discovery step finds pages from the hints. */
  sources?: ProviderSource[];
  /** Packages, API hosts and docs URLs to start discovery from, as an inventory would give them. */
  hints?: ProviderHints;
};

export type LoadedProvider = Omit<ProviderSpec, 'sources'> & {
  sources: ProviderSource[];
  dir: string;
  /** Contents of prompt.md. */
  prompt: string;
  knowledge?: ProviderKnowledge;
};

export type SourceRef = {
  url: string;
  /** ISO date (YYYY-MM-DD) the page was read. */
  retrievedAt: string;
  /** Exact words from the page that back the entry, when there is a short one. */
  quote?: string;
};

export type Sourced = { source: SourceRef };

export type ProviderKnowledge = {
  provider: string;
  updatedAt: string;
  /** Who drafted it and how, e.g. "agent read of the docs via web fetch". */
  draftedBy: string;
  versioning: { scheme: string } & Sourced;
  versions: ({
    value: string;
    status: 'preview' | 'current' | 'supported' | 'deprecated' | 'retired';
    releasedAt?: string;
    retiresAt?: string;
    notes?: string;
  } & Sourced)[];
  retirements: ({
    subject: string;
    kind: MigrationKind;
    date?: string;
    replacement?: string;
    notes?: string;
  } & Sourced)[];
  docs: ({ label: string; url: string } & Sourced)[];
  sdks: ({
    ecosystem: string;
    package: string;
    latest?: string;
    repo?: string;
    notes?: string;
  } & Sourced)[];
};

export type WatchIssue = { changeId?: string; message: string };

export type WatchReport = {
  provider: string;
  changes: ProviderChange[];
  /** Problems the checks found and the agent did not fix. Never used to drop a change. */
  issues: WatchIssue[];
  /** Ids of changes whose quote was not found verbatim in a page the agent read. */
  unverifiedQuotes: string[];
  sourcesRead: string[];
  model: string;
  costUsd: number;
  turns: number;
  /** What the agent said at the end, for the run log. */
  summary: string;
  /** Per-turn stop reason, tokens and tool calls. */
  log: TurnLog[];
};

/**
 * A recorded live run: the real model classifying a saved snapshot. Saved as
 * <provider>/fixtures/live-run.json so tests can re-check it offline.
 */
export type LiveRunRecord = {
  note: string;
  runAt: string;
  model: string;
  promptVersion: string;
  input: {
    /** Snapshot directory, relative to the provider folder. */
    snapshot: string;
    /** Each page was cut to this many characters before the model saw it. */
    maxCharsPerPage: number;
    /** Whether links outside the snapshot were fetched live. */
    liveFallback: boolean;
    since?: string;
    maxTokens: number;
    maxTurns: number;
  };
  report: WatchReport;
};

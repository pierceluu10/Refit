// A fake pipeline for the smoke test: every stage stands in for an AI agent and is driven by a
// FakeModelClient, so the run spends $0 and touches no network. Nothing in the fixtures runs.
//
// The fakes are deliberately simple. They exist to exercise the runner, scoring, the hand-check
// log and the reviewer end to end, not to model how the real agents decide anything.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ApiUsage, MigrationTask, ProviderChange, RunRecord } from '../../shared/types.ts';
import { FakeModelClient } from '../reviewer/model.ts';
import { createReviewer } from '../reviewer/reviewer.ts';
import { fixtureCheckout } from '../runner/checkout.ts';
import type { MatchChanges, PipelineFactory } from '../runner/types.ts';

/** Simulated per-call cost, so cost accounting has numbers to add up. No real money moves. */
export const SIMULATED_COST_USD = { inventory: 0.002, match: 0.001, task: 0.01, review: 0.003 };

/** Illustrative provider changes for the smoke run. Example data, not real watcher output. */
export const FAKE_CHANGES: Record<string, ProviderChange[]> = {
  stripe: [
    {
      provider: 'stripe',
      id: 'example-stripe-api-version',
      kind: 'api-version',
      title: 'Example: pinned API version 2023-10-16 is old; move to 2024-06-20',
      source: {
        url: 'https://docs.stripe.com/upgrades',
        quote: 'Example quote for the smoke test.',
      },
      affects: { versions: ['2023-10-16'] },
    },
  ],
  shopify: [
    {
      provider: 'shopify',
      id: 'example-shopify-2024-01-unsupported',
      kind: 'api-version',
      title: 'Example: Admin API 2024-01 is no longer supported',
      effectiveDate: '2025-01-01',
      source: {
        url: 'https://shopify.dev/docs/api/usage/versioning',
        quote: 'Example quote for the smoke test.',
      },
      affects: { versions: ['2024-01'] },
    },
  ],
  'meta-graph': [
    {
      provider: 'meta-graph',
      id: 'example-graph-v21-retiring',
      kind: 'api-version',
      title: 'Example: Graph API v21.0 is retiring',
      source: {
        url: 'https://developers.facebook.com/docs/graph-api/changelog',
        quote: 'Example quote for the smoke test.',
      },
      affects: { versions: ['v21.0'] },
    },
  ],
};

const HINTS: Record<string, RegExp> = {
  stripe: /apiVersion:\s*'([^']+)'|stripe\.(\w+)\.(\w+)\(/,
  shopify: /API_VERSION = '([^']+)'|\/admin\/api\//,
  'meta-graph': /GRAPH_VERSION = '([^']+)'|graph\.facebook\.com/,
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

function fakeInventory(provider: string, charge: (usd: number) => void) {
  return async (repoDir: string, repo: string): Promise<ApiUsage[]> => {
    charge(SIMULATED_COST_USD.inventory);
    const pattern = HINTS[provider];
    if (!pattern) return [];
    const callSites: ApiUsage['callSites'] = [];
    let pinned: ApiUsage['pinnedVersion'];
    for (const file of files(repoDir).filter((name) => name.endsWith('.js'))) {
      const rel = relative(repoDir, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const found = pattern.exec(text);
          if (!found) return;
          if (found[1] && !pinned) pinned = { value: found[1], file: rel, line: index + 1 };
          callSites.push({ file: rel, line: index + 1, operation: text.trim().slice(0, 80) });
        });
    }
    if (callSites.length === 0) return [];
    return [
      {
        repo,
        provider,
        via: provider === 'stripe' ? 'sdk' : 'http',
        ...(pinned ? { pinnedVersion: pinned } : {}),
        callSites,
      },
    ];
  };
}

/** Stands in for the match agent: a change applies when the pinned version is one it affects. */
function fakeMatch(charge: (usd: number) => void): MatchChanges {
  return async (changes, usages) => {
    charge(SIMULATED_COST_USD.match);
    const tasks: MigrationTask[] = [];
    for (const change of changes) {
      const hit = usages.filter((usage) =>
        change.affects.versions?.includes(usage.pinnedVersion?.value ?? ''),
      );
      if (hit.length === 0) continue;
      tasks.push({
        id: `${hit[0]?.repo}#${change.id}`,
        repo: hit[0]?.repo ?? '',
        change,
        usages: hit,
        priority: 1,
        ...(change.effectiveDate ? { deadline: change.effectiveDate } : {}),
      });
    }
    const reasoning =
      tasks.length > 0
        ? `Example reasoning: ${tasks.length} change(s) touch the pinned version.`
        : `Example reasoning: the pinned version (${usages[0]?.pinnedVersion?.value ?? 'none'}) is not one any change affects.`;
    return { tasks, reasoning };
  };
}

type EditPlan = {
  outcome: RunRecord['outcome'];
  edits: { file: string; find: string; replace: string }[];
  checks: RunRecord['checks'];
  pr?: string;
};

/** Stands in for the harness agent: asks the fake model for an edit plan and applies it. */
function fakeRunTask(model: FakeModelClient) {
  return async (task: MigrationTask, repoDir: string): Promise<RunRecord> => {
    const response = await model.complete({
      system: 'fake harness',
      prompt: JSON.stringify({ task: task.id }),
      maxTokens: 1000,
    });
    const plan = JSON.parse(response.text) as EditPlan;
    const diff: string[] = [];
    for (const edit of plan.edits) {
      const path = join(repoDir, edit.file);
      const before = readFileSync(path, 'utf8');
      const after = before.replace(edit.find, edit.replace);
      writeFileSync(path, after);
      const oldLines = before.split('\n');
      const newLines = after.split('\n');
      diff.push(`--- a/${edit.file}`, `+++ b/${edit.file}`);
      oldLines.forEach((line, index) => {
        if (line !== newLines[index]) {
          diff.push(`@@ -${index + 1} +${index + 1} @@`, `-${line}`, `+${newLines[index] ?? ''}`);
        }
      });
    }
    return {
      taskId: task.id,
      outcome: plan.outcome,
      diff: diff.join('\n'),
      checks: plan.checks,
      costUsd: response.costUsd,
      transcriptPath: `smoke://${task.id}`,
      ...(plan.pr ? { pr: plan.pr } : {}),
    };
  };
}

/** Scripted harness replies, keyed by change id. */
const HARNESS_SCRIPT: Record<string, EditPlan> = {
  'example-stripe-api-version': {
    outcome: 'verified',
    edits: [
      {
        file: 'src/billing.js',
        find: "apiVersion: '2023-10-16'",
        replace: "apiVersion: '2024-06-20'",
      },
    ],
    checks: [
      { name: 'typecheck', before: 'pass', after: 'pass' },
      { name: 'stripe-params-at-version', before: 'n/a', after: 'pass' },
    ],
    pr: 'https://github.com/example/stripe-billing/pull/1',
  },
  'example-shopify-2024-01-unsupported': {
    outcome: 'needs-review',
    edits: [
      {
        file: 'src/products.js',
        find: "API_VERSION = '2024-01'",
        replace: "API_VERSION = '2025-10'",
      },
    ],
    checks: [{ name: 'tests', before: 'none found', after: 'none found' }],
    pr: 'https://github.com/example/shopify-admin/pull/1',
  },
};

const REVIEW_SCRIPT: Record<string, string> = {
  'example-stripe-api-version': JSON.stringify({
    opinion: 'has-concerns',
    summary: 'Example: version bump looks right, but payment_method_types behaviour is unproven.',
    concerns: [
      {
        file: 'src/billing.js',
        issue: 'Example: no test reaches paymentIntents.create',
        severity: 'medium',
      },
    ],
    checkFirst: ['src/billing.js:6'],
  }),
  'example-shopify-2024-01-unsupported': JSON.stringify({
    opinion: 'looks-right',
    summary: 'Example: version string updated; products.json is still REST, which the PR notes.',
    concerns: [],
  }),
};

const changeIdOf = (text: string) =>
  Object.keys(HARNESS_SCRIPT).find((id) => text.includes(id)) ?? '';

export function createFakePipeline(fixturesDir: string, dirFor: (repo: string) => string) {
  const harnessModel = new FakeModelClient(
    (request) => JSON.stringify(HARNESS_SCRIPT[changeIdOf(request.prompt)]),
    SIMULATED_COST_USD.task,
  );
  const reviewModel = new FakeModelClient(
    (request) => REVIEW_SCRIPT[changeIdOf(request.prompt)] ?? 'not json at all',
    SIMULATED_COST_USD.review,
  );
  const factory: PipelineFactory = ({ provider, meter }) => {
    const charge = (label: string) => (usd: number) => meter.charge(usd, label);
    return {
      checkout: fixtureCheckout(fixturesDir, dirFor),
      inventory: fakeInventory(provider, charge('inventory')),
      watch: async () => FAKE_CHANGES[provider] ?? [],
      match: fakeMatch(charge('match')),
      runTask: fakeRunTask(harnessModel),
      review: createReviewer(reviewModel),
    };
  };
  return { factory, harnessModel, reviewModel };
}

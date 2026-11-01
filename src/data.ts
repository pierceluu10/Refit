export const PROJECT_URL = 'https://github.com/pierceluu10/Refit';
export const STEP_DURATION = 2200;

export const stages = [
  {
    id: 'understand',
    title: 'Read your code',
    short: 'Understand',
    description:
      'Install the GitHub App. An agent reads each repository and maps every external API it uses.',
    artifact: 'acme / api / API usage map',
    detail:
      'Provider, SDK or raw HTTP, pinned version and every call site. It re-reads on every push.',
  },
  {
    id: 'watch',
    title: 'Watch what you use',
    short: 'Watch',
    description:
      'Agents read each provider’s changelogs and SDK releases, then match changes to your call sites.',
    artifact: 'stripe / changelog',
    detail:
      'Each change is recorded with a quote from its source. Specs help when they exist; they are not required.',
  },
  {
    id: 'migrate',
    title: 'Migrate and prove',
    short: 'Migrate',
    description:
      'The agent edits the code in a sandbox and runs your type check, build and tests before and after.',
    artifact: 'sandbox / checks',
    detail:
      'Only new failures count. It keeps iterating until the checks pass or it can explain why they don’t.',
  },
  {
    id: 'review',
    title: 'Your review. Your merge.',
    short: 'Review',
    description:
      'Get a pull request marked verified or needs-review, with the proof and what is still unproven.',
    artifact: 'GitHub / pull request',
    detail: 'Aptitude never merges and never pushes to your default branch.',
  },
] as const;

export type Scenario = 'affected' | 'unaffected' | 'failed';
export const scenarios: Record<Scenario, { label: string; summary: string }> = {
  affected: {
    label: 'Affected code',
    summary: 'An illustrative migration from an expanded charge list to a latest-charge reference.',
  },
  unaffected: {
    label: 'Unaffected code',
    summary:
      'This repository uses Stripe, but never reads the changed field. The verdict is “not affected”, with no patch.',
  },
  failed: {
    label: 'Checks fail',
    summary:
      'One example test still fails after the edit. The pull request is marked needs-review and says what is unproven.',
  },
};

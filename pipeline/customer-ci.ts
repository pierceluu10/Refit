// The customer's own CI as the validation fallback (founder decision, 2026-10-28; see
// docs/CUSTOMER-ENVIRONMENT.md). Off by default (`--customer-ci`). Refit opens one pull request
// that adds a workflow; once the customer merges it, every push to a refit/** branch runs the
// repository's own install and checks with the customer's secrets in their Actions, on the base
// and on the patch. Refit reads only the two jobs' conclusions and log tails through the App, and
// applies the offline gates: a patch that fails where the base passed is a regression, and a
// failing base is no evidence. No secret ever reaches Refit.

import { parse, stringify } from 'yaml';
import { GitHubRequestError } from './github.ts';
import { INSTALL_FILES, installCommand, installPlan } from './repository-install.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const CUSTOMER_CI_WORKFLOW = '.github/workflows/refit-validation.yml';
export const CUSTOMER_CI_BRANCH = 'refit/validation-workflow';
export const CUSTOMER_CI_MARKER = '<!-- refit-customer-ci -->';
const LOG_CHARACTERS = 2000;

export type GitHubRequest = (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<unknown>;

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// Actions that set up a runtime or package manager (actions/setup-node, pnpm/action-setup,
// oven-sh/setup-bun, ...).
const SETUP_ACTION = /^[\w.-]+\/(?:setup-[\w.-]+|action-setup)@/;

// The steps of the repository's own CI job up to and including its install, verbatim (their
// `env` keeps the customer's `${{ secrets.* }}` references), without its checkout.
function ciSetup(content: string) {
  const value = parse(content);
  if (!isObject(value) || !isObject(value.jobs)) return undefined;
  for (const job of Object.values(value.jobs)) {
    if (!isObject(job) || !Array.isArray(job.steps)) continue;
    const index = job.steps.findIndex(
      (step) =>
        isObject(step) &&
        typeof step.run === 'string' &&
        step['working-directory'] === undefined &&
        step.run.split(/&&|;|\n/).some((part: string) => installCommand(part)),
    );
    if (index < 0) continue;
    return {
      runsOn: typeof job['runs-on'] === 'string' ? job['runs-on'] : 'ubuntu-latest',
      env: isObject(job.env) ? job.env : undefined,
      // Only the setup actions before the install, and the install itself, without their `if`:
      // a condition can name a step this workflow leaves out.
      steps: job.steps
        .slice(0, index + 1)
        .filter(
          (step, position) =>
            isObject(step) && (position === index || SETUP_ACTION.test(String(step.uses ?? ''))),
        )
        .map((step) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'if'))),
    };
  }
  return undefined;
}

// The checks the workflow runs: the repository's test script, else its type check.
export function customerCiChecks(files: ReadonlyMap<string, string>, manager: string) {
  let scripts: Record<string, unknown> = {};
  try {
    const value = JSON.parse(files.get('package.json') ?? '{}');
    scripts = isObject(value.scripts) ? value.scripts : {};
  } catch {
    scripts = {};
  }
  // A test script in watch mode never exits in CI; its CI script is the one CI runs.
  if (typeof scripts.test === 'string' && /--watch\b(?!All=false)/.test(scripts.test))
    if (typeof scripts['test:ci'] === 'string') return [manager, 'run', 'test:ci'];
  if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test))
    return [manager, 'test'];
  return ['npx', '--no-install', 'tsc', '--noEmit'];
}

export function customerCiWorkflow(files: ReadonlyMap<string, string>, check?: string[]) {
  const plan = installPlan(files);
  if (!plan) return undefined;
  const own = plan.source === 'ci' ? ciSetup(files.get(plan.file)!) : undefined;
  const setup = own?.steps ?? [
    { uses: 'actions/setup-node@v4', with: { 'node-version': 22 } },
    ...(plan.tool ? [{ run: `npm install --global ${quote(plan.tool)}` }] : []),
    { run: plan.command.map(quote).join(' ') },
  ];
  const checks = {
    name: 'Refit checks',
    run: (check ?? customerCiChecks(files, plan.manager)).map(quote).join(' '),
    env: { CI: 'true' },
  };
  const job = (baseline: boolean) => ({
    'runs-on': own?.runsOn ?? 'ubuntu-latest',
    'timeout-minutes': 30,
    ...(own?.env ? { env: own.env } : {}),
    steps: [
      {
        uses: 'actions/checkout@v4',
        with: { 'fetch-depth': baseline ? 0 : 1, 'persist-credentials': false },
      },
      ...(baseline
        ? [
            {
              name: 'Check out the base commit',
              run: 'git checkout --detach "$(git merge-base "origin/$DEFAULT_BRANCH" HEAD)"',
              env: { DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}' },
            },
          ]
        : []),
      ...setup,
      checks,
    ],
  });
  const workflow = {
    name: 'Refit validation',
    on: { push: { branches: ['refit/**'] } },
    permissions: { contents: 'read' },
    concurrency: { group: 'refit-validation-${{ github.ref }}', 'cancel-in-progress': true },
    jobs: { baseline: job(true), patched: job(false) },
  };
  return {
    plan,
    content: `# Added by Refit. It runs only on Refit's refit/** branches, with read-only access, and Refit\n# reads only each job's result and the end of its log. Delete this file to stop it.\n${stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false })}`,
  };
}

export function customerCiPullRequest(source: string, check: string) {
  return {
    title: 'Add the Refit validation workflow',
    body: [
      CUSTOMER_CI_MARKER,
      "Refit validates its migration drafts in an offline sandbox. Some repositories install from a private registry or with credentials only you have, so Refit cannot install them itself and never asks for those secrets. This workflow runs Refit's checks in your own CI instead.",
      '',
      '**What it runs.** On every push to a `refit/**` branch (only Refit pushes there), two jobs:',
      `- \`baseline\`: your base commit, with your own install steps (from \`${source}\`) and \`${check}\`;`,
      "- `patched`: the same on Refit's patch.",
      '',
      '**What it can do.** `permissions: contents: read`. It uses your repository secrets the way your own CI does, runs no `pull_request_target`, deploys nothing and writes nothing.',
      '',
      "**What Refit sees.** Only each job's result and the last lines of its log, read through the Refit GitHub App. GitHub masks secret values in logs. A draft whose `patched` job fails where `baseline` passes is closed as a regression; a failing `baseline` is not counted.",
      '',
      'Merge this pull request to turn it on, or close it to keep Refit to its own sandbox. Refit never merges it.',
    ].join('\n'),
  };
}

function notFound(error: unknown) {
  return error instanceof GitHubRequestError && error.status === 404;
}

async function installFiles(request: GitHubRequest, repository: string, revision: string) {
  const tree = await request('GET', `/repos/${repository}/git/trees/${revision}?recursive=1`);
  if (!isObject(tree) || !Array.isArray(tree.tree))
    throw new PipelineInputError('GitHub did not return the repository tree.');
  const files = new Map<string, string>();
  for (const entry of tree.tree)
    if (
      isObject(entry) &&
      entry.type === 'blob' &&
      typeof entry.path === 'string' &&
      INSTALL_FILES.test(entry.path)
    ) {
      const blob = await request('GET', `/repos/${repository}/git/blobs/${entry.sha}`);
      if (isObject(blob) && typeof blob.content === 'string')
        files.set(entry.path, Buffer.from(blob.content, 'base64').toString('utf8'));
    }
  return files;
}

// Opens the workflow pull request once. A pull request from the branch in any state (a customer
// who closed it opted out) or a workflow already on the base branch leaves everything as it is.
export async function proposeCustomerCi(options: {
  request: GitHubRequest;
  repository: string;
  check?: string[];
}) {
  const { request, repository } = options;
  const owner = repository.split('/')[0];
  const metadata = await request('GET', `/repos/${repository}`);
  if (!isObject(metadata) || typeof metadata.default_branch !== 'string')
    throw new PipelineInputError('GitHub did not return the default branch.');
  const base = metadata.default_branch;
  const pulls = await request(
    'GET',
    `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${CUSTOMER_CI_BRANCH}`)}`,
  );
  if (Array.isArray(pulls) && pulls.length && isObject(pulls[0]))
    return { status: 'existing' as const, url: String(pulls[0].html_url) };
  const exists = await request(
    'GET',
    `/repos/${repository}/contents/${CUSTOMER_CI_WORKFLOW}?ref=${encodeURIComponent(base)}`,
  ).then(
    () => true,
    (error) => (notFound(error) ? false : Promise.reject(error)),
  );
  if (exists) return { status: 'present' as const };
  const reference = await request(
    'GET',
    `/repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`,
  );
  if (
    !isObject(reference) ||
    !isObject(reference.object) ||
    typeof reference.object.sha !== 'string'
  )
    throw new PipelineInputError('GitHub did not return the base branch commit.');
  const parent = reference.object.sha;
  const workflow = customerCiWorkflow(
    await installFiles(request, repository, parent),
    options.check,
  );
  if (!workflow) return { status: 'no-install' as const };
  const commit = await request('GET', `/repos/${repository}/git/commits/${parent}`);
  if (!isObject(commit) || !isObject(commit.tree))
    throw new PipelineInputError('GitHub did not return the base commit.');
  const tree = await request('POST', `/repos/${repository}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: [{ path: CUSTOMER_CI_WORKFLOW, mode: '100644', type: 'blob', content: workflow.content }],
  });
  const created = await request('POST', `/repos/${repository}/git/commits`, {
    message: 'ci: add the Refit validation workflow',
    tree: isObject(tree) ? tree.sha : undefined,
    parents: [parent],
  });
  await request('POST', `/repos/${repository}/git/refs`, {
    ref: `refs/heads/${CUSTOMER_CI_BRANCH}`,
    sha: isObject(created) ? created.sha : undefined,
  });
  const text = customerCiPullRequest(
    workflow.plan.file,
    String(parse(workflow.content).jobs.patched.steps.at(-1).run),
  );
  const pull = await request('POST', `/repos/${repository}/pulls`, {
    ...text,
    head: CUSTOMER_CI_BRANCH,
    base,
  });
  return { status: 'opened' as const, url: isObject(pull) ? String(pull.html_url) : '' };
}

export type CustomerCiOutcome = 'passed' | 'regression' | 'baseline-failed' | 'pending' | 'missing';

// The offline gates applied to the two jobs: evidence only when the base passed.
export function customerCiOutcome(
  baseline: string | null | undefined,
  patched: string | null | undefined,
): CustomerCiOutcome {
  if (baseline === undefined || patched === undefined) return 'missing';
  if (baseline === null || patched === null) return 'pending';
  if (baseline !== 'success') return 'baseline-failed';
  return patched === 'success' ? 'passed' : 'regression';
}

// The newest workflow run for this commit, its jobs and their log tails.
export async function readCustomerCiEvidence(options: {
  request: GitHubRequest;
  log: (job: number) => Promise<string>;
  repository: string;
  head: string;
}) {
  const runs = await options
    .request(
      'GET',
      `/repos/${options.repository}/actions/workflows/refit-validation.yml/runs?head_sha=${options.head}&per_page=1`,
    )
    .catch((error) => (notFound(error) ? undefined : Promise.reject(error)));
  const run =
    isObject(runs) && Array.isArray(runs.workflow_runs) ? runs.workflow_runs[0] : undefined;
  if (!isObject(run)) return { outcome: 'missing' as CustomerCiOutcome, jobs: [] };
  const listed = await options.request(
    'GET',
    `/repos/${options.repository}/actions/runs/${run.id}/jobs`,
  );
  const jobs = (isObject(listed) && Array.isArray(listed.jobs) ? listed.jobs : []).filter(isObject);
  const find = (name: string) => jobs.find((job) => job.name === name);
  const conclusion = (name: string) => {
    const job = find(name);
    if (!job) return run.status === 'completed' ? 'missing' : null;
    return job.status === 'completed' ? String(job.conclusion) : null;
  };
  const outcome = customerCiOutcome(conclusion('baseline'), conclusion('patched'));
  const details = [];
  if (outcome !== 'pending')
    for (const name of ['baseline', 'patched']) {
      const job = find(name);
      if (job)
        details.push({
          name,
          conclusion: String(job.conclusion),
          url: String(job.html_url),
          log: (await options.log(Number(job.id)).catch(() => '')).slice(-LOG_CHARACTERS),
        });
    }
  return { outcome, run: String(run.html_url), jobs: details };
}

// Job logs are served from a redirect to storage; the token goes only to api.github.com, since
// fetch drops Authorization on a cross-origin redirect.
export function jobLogReader(token: string, repository: string) {
  return async (job: number) => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/jobs/${job}/logs`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return '';
    return (await response.text()).slice(-LOG_CHARACTERS);
  };
}

export function customerCiComment(evidence: Awaited<ReturnType<typeof readCustomerCiEvidence>>) {
  const verdict = {
    passed:
      'Your CI ran this patch with your own install and checks: the base and the patch both passed.',
    regression:
      'Your CI failed on this patch and passed on the base commit, so Refit closed this draft as a regression. Do not merge it.',
    'baseline-failed':
      'Your CI failed on the base commit too, so its result on this patch is not evidence either way.',
    pending: 'Your CI is still running.',
    missing: 'Your CI did not run the Refit validation workflow on this commit.',
  }[evidence.outcome];
  return [
    CUSTOMER_CI_MARKER,
    `**Refit validation in your CI: ${evidence.outcome}.** ${verdict}`,
    ...(evidence.run ? [`Run: ${evidence.run}`] : []),
    ...evidence.jobs.flatMap((job) => [
      '',
      `<details><summary>${job.name}: ${job.conclusion}</summary>`,
      '',
      '```',
      job.log.trim(),
      '```',
      '</details>',
    ]),
  ].join('\n');
}

// Reads the evidence for one Refit draft and records it on the draft: one comment, kept current.
// A regression closes the draft only while its head is still the commit Refit pushed.
export async function applyCustomerCiEvidence(options: {
  request: GitHubRequest;
  log: (job: number) => Promise<string>;
  repository: string;
  pull: number;
  login: string;
}) {
  const pull = await options.request('GET', `/repos/${options.repository}/pulls/${options.pull}`);
  if (
    !isObject(pull) ||
    !isObject(pull.head) ||
    typeof pull.head.sha !== 'string' ||
    typeof pull.head.ref !== 'string'
  )
    throw new PipelineInputError('GitHub did not return the pull request.');
  if (!pull.head.ref.startsWith('refit/') || pull.head.ref === CUSTOMER_CI_BRANCH)
    throw new PipelineInputError('Only Refit migration drafts carry customer CI evidence.');
  const evidence = await readCustomerCiEvidence({ ...options, head: pull.head.sha });
  if (evidence.outcome === 'pending' || evidence.outcome === 'missing') return evidence;
  const comments = await options.request(
    'GET',
    `/repos/${options.repository}/issues/${options.pull}/comments?per_page=100`,
  );
  const existing = (Array.isArray(comments) ? comments : []).find(
    (comment) =>
      isObject(comment) &&
      isObject(comment.user) &&
      comment.user.login === options.login &&
      String(comment.body).startsWith(CUSTOMER_CI_MARKER),
  );
  const body = customerCiComment(evidence);
  if (isObject(existing)) {
    if (existing.body !== body)
      await options.request(
        'PATCH',
        `/repos/${options.repository}/issues/comments/${existing.id}`,
        { body },
      );
  } else
    await options.request('POST', `/repos/${options.repository}/issues/${options.pull}/comments`, {
      body,
    });
  const pushed = /<!-- refit-pushed: ([a-f0-9]{40}) -->/.exec(String(pull.body ?? ''))?.[1];
  if (evidence.outcome === 'regression' && pull.state === 'open' && pushed === pull.head.sha)
    await options.request('PATCH', `/repos/${options.repository}/pulls/${options.pull}`, {
      state: 'closed',
    });
  return evidence;
}

// Example data for the dashboard preview. Nothing here comes from a real organization or run:
// the repositories, pull requests, scan times and costs are invented. The change dates and source
// links are real, public facts, checked against each source on 2026-11-06.
import type {
  BehindItem,
  DependencyUsage,
  ExternalChange,
  RunRecord,
  RunView,
  ScanReport,
} from '../shared/types.ts';

export type RepoPullRequest = {
  repo: string;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  number: number;
  draft: boolean;
  updatedAt: string;
  dependency?: string;
  target?: string;
};

export const outcomeLabels: Record<RunRecord['outcome'], string> = {
  verified: 'Verified',
  'needs-review': 'Needs review',
  'not-affected': 'Not affected',
  failed: 'Failed',
  'waiting-budget': 'Waiting on budget',
};

const providerNames: Record<string, string> = {
  debian: 'Debian',
  'github-actions': 'GitHub Actions',
  nextjs: 'Next.js',
  nodejs: 'Node.js',
  openai: 'OpenAI',
  pallets: 'Flask',
  python: 'Python',
  react: 'React',
  shopify: 'Shopify',
  sqlalchemy: 'SQLAlchemy',
  stripe: 'Stripe',
};

export function providerName(provider: string) {
  return providerNames[provider] ?? provider;
}

const NODE_API = 'example-org/node-api';
const PYTHON_APP = 'example-org/python-app';
const NEXT_WEB = 'example-org/next-web';

export const exampleRepos: string[] = [NODE_API, PYTHON_APP, NEXT_WEB];

const NODE_RELEASES_URL = 'https://github.com/nodejs/Release#release-schedule';
const NODE_RELEASES_QUOTE =
  'Production applications should only use Active LTS or Maintenance LTS releases.';
const OPENAI_DEPRECATIONS_URL = 'https://developers.openai.com/api/docs/deprecations';

function pullRequestUrl(repo: string, number: number) {
  return `https://example.com/${repo}/pull/${number}`;
}

function usage(
  repo: string,
  kind: DependencyUsage['kind'],
  name: string,
  ecosystem: string,
  version: string,
  ...declaredIn: [file: string, line: number][]
): DependencyUsage {
  return {
    repo,
    kind,
    name,
    ecosystem,
    version,
    declaredIn: declaredIn.map(([file, line]) => ({ file, line })),
  };
}

// The deadline follows the change's own date, as the scanner's does.
function behind(
  dependency: DependencyUsage,
  change: Omit<ExternalChange, 'dependency' | 'dependencyKind' | 'affects'>,
  status: BehindItem['status'],
  pullRequest?: number,
): BehindItem {
  return {
    repo: dependency.repo,
    dependency,
    change: {
      ...change,
      dependency: dependency.name,
      dependencyKind: dependency.kind,
      affects: { versions: change.fromVersions },
    },
    deadline: change.effectiveDate,
    status,
    pr: pullRequest ? pullRequestUrl(dependency.repo, pullRequest) : undefined,
  };
}

const nextWebFramework = usage(NEXT_WEB, 'framework', 'next', 'npm', '15.1.0', [
  'package.json',
  18,
]);

export const exampleReports: ScanReport[] = [
  {
    repo: NODE_API,
    scannedAt: '2026-11-05T09:12:00Z',
    costUsd: 0.31,
    errors: [],
    items: [
      behind(
        usage(NODE_API, 'runtime', 'node', 'nodejs', '18.20.4', ['.nvmrc', 1], ['package.json', 6]),
        {
          provider: 'nodejs',
          id: 'node-18-eol',
          kind: 'runtime-eol',
          title: 'Node.js 18 reached end of life',
          effectiveDate: '2025-04-30',
          source: { url: NODE_RELEASES_URL, quote: NODE_RELEASES_QUOTE },
          fromVersions: ['18'],
          toVersion: '24',
          severity: 'deadline',
        },
        'pr-open',
        12,
      ),
      behind(
        usage(NODE_API, 'framework', 'express', 'npm', '4.19.2', ['package.json', 14]),
        {
          provider: 'expressjs',
          id: 'express-5',
          kind: 'framework-major',
          title: 'Express 5 removes old APIs and changes route path syntax',
          source: {
            url: 'https://expressjs.com/en/guide/migrating-5.html',
            quote: 'Upgrade to Express v5',
          },
          fromVersions: ['4'],
          toVersion: '5',
          severity: 'breaking',
        },
        'open',
      ),
      behind(
        usage(NODE_API, 'container-image', 'node:18-bullseye', 'docker', '18-bullseye', [
          'Dockerfile',
          1,
        ]),
        {
          provider: 'debian',
          id: 'debian-11-lts-end',
          kind: 'container-image-eol',
          title: 'Debian 11 (bullseye) long-term support ended',
          effectiveDate: '2026-08-31',
          source: { url: 'https://wiki.debian.org/LTS', quote: 'bullseye 2026-08-31' },
          fromVersions: ['bullseye'],
          toVersion: 'node:24-bookworm',
          severity: 'deadline',
        },
        'open',
      ),
      behind(
        usage(NODE_API, 'ci', 'actions/upload-artifact', 'github-actions', 'v3', [
          '.github/workflows/ci.yml',
          31,
        ]),
        {
          provider: 'github-actions',
          id: 'artifact-actions-v3',
          kind: 'ci-deprecation',
          title: 'Version 3 of the artifact actions stopped working',
          effectiveDate: '2025-01-30',
          source: {
            url: 'https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/',
            quote: 'January 30th, 2025',
          },
          fromVersions: ['v3'],
          toVersion: 'v4',
          severity: 'deadline',
        },
        'merged',
        38,
      ),
    ],
  },
  {
    repo: PYTHON_APP,
    scannedAt: '2026-11-05T09:20:00Z',
    costUsd: 0.27,
    errors: ['Couldn’t read .github/workflows/release.yml: the file isn’t valid YAML.'],
    items: [
      behind(
        usage(
          PYTHON_APP,
          'runtime',
          'python',
          'python',
          '3.9.19',
          ['.python-version', 1],
          ['pyproject.toml', 8],
        ),
        {
          provider: 'python',
          id: 'python-3.9-eol',
          kind: 'runtime-eol',
          title: 'Python 3.9 reached end of life',
          effectiveDate: '2025-10-31',
          source: {
            url: 'https://devguide.python.org/versions/',
            quote: '3.9 end-of-life 2025-10-31',
          },
          fromVersions: ['3.9'],
          toVersion: '3.14',
          severity: 'deadline',
        },
        'open',
      ),
      behind(
        usage(PYTHON_APP, 'ai-model', 'gpt-4.5-preview', 'openai', 'gpt-4.5-preview', [
          'app/settings.py',
          12,
        ]),
        {
          provider: 'openai',
          id: 'gpt-4.5-preview-shutdown',
          kind: 'model-retirement',
          title: 'OpenAI shut down gpt-4.5-preview',
          effectiveDate: '2025-07-14',
          source: { url: OPENAI_DEPRECATIONS_URL, quote: '2025-07-14 | gpt-4.5-preview | gpt-4.1' },
          fromVersions: ['gpt-4.5-preview'],
          toVersion: 'gpt-4.1',
          severity: 'deadline',
        },
        'pr-open',
        17,
      ),
      behind(
        usage(PYTHON_APP, 'framework', 'flask', 'pypi', '2.2.5', ['requirements.txt', 3]),
        {
          provider: 'pallets',
          id: 'flask-3',
          kind: 'framework-major',
          title: 'Flask 3 removes code deprecated in the 2.x releases',
          source: {
            url: 'https://flask.palletsprojects.com/en/stable/changes/',
            quote: 'Version 3.0.0',
          },
          fromVersions: ['2'],
          toVersion: '3.1',
          severity: 'breaking',
        },
        'merged',
        15,
      ),
      behind(
        usage(PYTHON_APP, 'library', 'sqlalchemy', 'pypi', '1.4.52', ['requirements.txt', 4]),
        {
          provider: 'sqlalchemy',
          id: 'sqlalchemy-2',
          kind: 'dependency-major',
          title: 'SQLAlchemy 2.0 changes the core, engine and ORM APIs',
          source: {
            url: 'https://docs.sqlalchemy.org/en/20/changelog/migration_20.html',
            quote: 'SQLAlchemy 2.0 - Major Migration Guide',
          },
          fromVersions: ['1.4'],
          toVersion: '2.0',
          severity: 'breaking',
        },
        'open',
      ),
      behind(
        usage(PYTHON_APP, 'sdk', 'openai', 'pypi', '1.30.1', ['requirements.txt', 5]),
        {
          provider: 'openai',
          id: 'assistants-api-shutdown',
          kind: 'endpoint-removed',
          title: 'OpenAI shut down the Assistants API',
          effectiveDate: '2026-08-26',
          source: {
            url: OPENAI_DEPRECATIONS_URL,
            quote: '2026-08-26 | Assistants API | Responses API and Conversations API',
          },
          toVersion: 'Responses API',
          severity: 'deadline',
        },
        'not-affected',
      ),
    ],
  },
  {
    repo: NEXT_WEB,
    scannedAt: '2026-11-05T09:31:00Z',
    costUsd: 0.34,
    errors: [],
    items: [
      behind(
        nextWebFramework,
        {
          provider: 'nextjs',
          id: 'next-15-support-end',
          kind: 'framework-major',
          title: 'Next.js 15 security support ends. Next.js 16 makes request APIs async',
          effectiveDate: '2027-01-31',
          source: { url: 'https://nextjs.org/support-policy', quote: 'Jan. 31, 2027' },
          fromVersions: ['15'],
          toVersion: '16',
          severity: 'deadline',
        },
        'open',
      ),
      behind(
        nextWebFramework,
        {
          provider: 'nextjs',
          id: 'CVE-2025-29927',
          kind: 'security-fix',
          title: 'Authorization bypass in Next.js middleware (CVE-2025-29927)',
          source: {
            url: 'https://github.com/advisories/GHSA-f82v-jwr5-mffw',
            quote: 'Authorization Bypass in Next.js Middleware',
          },
          fromVersions: ['15.0.0 to 15.2.2'],
          toVersion: '15.2.3',
          severity: 'security',
        },
        'pr-open',
        52,
      ),
      behind(
        usage(NEXT_WEB, 'library', 'react', 'npm', '18.3.1', ['package.json', 20]),
        {
          provider: 'react',
          id: 'react-19',
          kind: 'dependency-major',
          title: 'React 19 removes legacy APIs such as string refs and ReactDOM.render',
          source: {
            url: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
            quote: 'Removed: string refs',
          },
          fromVersions: ['18'],
          toVersion: '19',
          severity: 'breaking',
        },
        'open',
      ),
      behind(
        usage(NEXT_WEB, 'ci', 'actions/cache', 'github-actions', 'v2', [
          '.github/workflows/ci.yml',
          18,
        ]),
        {
          provider: 'github-actions',
          id: 'actions-cache-v2',
          kind: 'ci-deprecation',
          title: 'actions/cache v1 and v2 were retired',
          effectiveDate: '2025-03-01',
          source: {
            url: 'https://github.blog/changelog/2024-12-05-notice-of-upcoming-releases-and-breaking-changes-for-github-actions/',
            quote: 'The action and cache package will be fully retired on March 1st.',
          },
          fromVersions: ['v1', 'v2'],
          toVersion: 'v4',
          severity: 'deadline',
        },
        'open',
      ),
      behind(
        usage(NEXT_WEB, 'runtime', 'node', 'nodejs', '22.11.0', ['.nvmrc', 1]),
        {
          provider: 'nodejs',
          id: 'node-22-eol',
          kind: 'runtime-eol',
          title: 'Node.js 22 reaches end of life',
          effectiveDate: '2027-04-30',
          source: { url: NODE_RELEASES_URL, quote: NODE_RELEASES_QUOTE },
          fromVersions: ['22'],
          toVersion: '24',
          severity: 'deadline',
        },
        'open',
      ),
    ],
  },
];

export const examplePullRequests: RepoPullRequest[] = [
  {
    repo: NEXT_WEB,
    title: 'Upgrade next to 15.2.3 for CVE-2025-29927',
    url: pullRequestUrl(NEXT_WEB, 52),
    state: 'open',
    number: 52,
    draft: false,
    updatedAt: '2026-11-04T16:40:00Z',
    dependency: 'next',
    target: '15.2.3',
  },
  {
    repo: PYTHON_APP,
    title: 'Move from gpt-4.5-preview to gpt-4.1',
    url: pullRequestUrl(PYTHON_APP, 17),
    state: 'open',
    number: 17,
    draft: true,
    updatedAt: '2026-11-03T11:05:00Z',
    dependency: 'gpt-4.5-preview',
    target: 'gpt-4.1',
  },
  {
    repo: NODE_API,
    title: 'Upgrade Node.js 18 to 24',
    url: pullRequestUrl(NODE_API, 12),
    state: 'open',
    number: 12,
    draft: false,
    updatedAt: '2026-11-02T14:22:00Z',
    dependency: 'node',
    target: '24',
  },
  {
    repo: NEXT_WEB,
    title: 'Upgrade Next.js 15 to 16',
    url: pullRequestUrl(NEXT_WEB, 49),
    state: 'closed',
    number: 49,
    draft: false,
    updatedAt: '2026-10-30T10:15:00Z',
    dependency: 'next',
    target: '16',
  },
  {
    repo: NODE_API,
    title: 'Move actions/upload-artifact to v4',
    url: pullRequestUrl(NODE_API, 38),
    state: 'merged',
    number: 38,
    draft: false,
    updatedAt: '2026-10-28T09:48:00Z',
    dependency: 'actions/upload-artifact',
    target: 'v4',
  },
  {
    repo: PYTHON_APP,
    title: 'Upgrade Flask 2 to 3.1',
    url: pullRequestUrl(PYTHON_APP, 15),
    state: 'merged',
    number: 15,
    draft: false,
    updatedAt: '2026-10-27T13:30:00Z',
    dependency: 'flask',
    target: '3.1',
  },
];

export const runs: RunView[] = [
  {
    id: 'run-next-web-cve',
    repo: NEXT_WEB,
    taskId: 'task-next-web-cve',
    provider: 'nextjs',
    changeId: 'CVE-2025-29927',
    outcome: 'verified',
    pr: pullRequestUrl(NEXT_WEB, 52),
    costUsd: 0.64,
    summary: 'Moved next to 15.2.3. Build and tests passed before and after.',
    finishedAt: '2026-11-04T16:38:00Z',
  },
  {
    id: 'run-python-app-model',
    repo: PYTHON_APP,
    taskId: 'task-python-app-model',
    provider: 'openai',
    changeId: 'gpt-4.5-preview-shutdown',
    outcome: 'needs-review',
    pr: pullRequestUrl(PYTHON_APP, 17),
    costUsd: 1.12,
    summary: 'Switched the pinned model to gpt-4.1. Reply quality wasn’t compared.',
    finishedAt: '2026-11-03T11:02:00Z',
  },
  {
    id: 'run-python-app-assistants',
    repo: PYTHON_APP,
    taskId: 'task-python-app-assistants',
    provider: 'openai',
    changeId: 'assistants-api-shutdown',
    outcome: 'not-affected',
    costUsd: 0.09,
    summary: 'The code only calls chat completions. It never touches the Assistants API.',
    finishedAt: '2026-11-03T10:21:00Z',
  },
  {
    id: 'run-node-api-runtime',
    repo: NODE_API,
    taskId: 'task-node-api-runtime',
    provider: 'nodejs',
    changeId: 'node-18-eol',
    outcome: 'needs-review',
    pr: pullRequestUrl(NODE_API, 12),
    costUsd: 1.47,
    summary: 'Moved Node.js 18 to 24 in .nvmrc and package.json. No test covers the Docker build.',
    finishedAt: '2026-11-02T14:19:00Z',
  },
  {
    id: 'run-next-web-major',
    repo: NEXT_WEB,
    taskId: 'task-next-web-major',
    provider: 'nextjs',
    changeId: 'next-15-support-end',
    outcome: 'failed',
    costUsd: 2.38,
    summary: 'Tried Next.js 16. The build still failed on async params in three pages.',
    finishedAt: '2026-10-30T10:12:00Z',
  },
  {
    id: 'run-next-web-cache',
    repo: NEXT_WEB,
    taskId: 'task-next-web-cache',
    provider: 'github-actions',
    changeId: 'actions-cache-v2',
    outcome: 'waiting-budget',
    costUsd: 0,
    summary: 'Not attempted: $0.80 of the run cap left, below the $2 a task needs.',
    finishedAt: '2026-10-29T16:05:00Z',
  },
  {
    id: 'run-node-api-artifact',
    repo: NODE_API,
    taskId: 'task-node-api-artifact',
    provider: 'github-actions',
    changeId: 'artifact-actions-v3',
    outcome: 'verified',
    pr: pullRequestUrl(NODE_API, 38),
    costUsd: 0.42,
    summary: 'Moved actions/upload-artifact to v4. The workflow passed before and after.',
    finishedAt: '2026-10-28T09:41:00Z',
  },
];

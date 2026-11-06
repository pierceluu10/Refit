// Illustrative upgrade fixtures for unit tests. Not real customers, repos or runs.
import type { ExternalTask, ScanReport } from '../../shared/types.ts';

export function makeExternalTask(
  overrides: Partial<ExternalTask> & { version?: string; toVersion?: string } = {},
): ExternalTask {
  const { version = '18', toVersion = '22', ...rest } = overrides;
  const repo = rest.repo ?? 'example-org/api';
  return {
    id: `task-node-eol-${repo}`,
    repo,
    priority: 1,
    change: {
      provider: 'nodejs',
      id: `node-${version}-eol`,
      kind: 'runtime-eol',
      dependencyKind: 'runtime',
      dependency: 'node',
      title: `Example: Node.js ${version} is end of life`,
      effectiveDate: '2025-04-30',
      fromVersions: [version],
      toVersion,
      severity: 'deadline',
      source: {
        url: 'https://nodejs.org/en/about/previous-releases',
        quote: 'Example quote for a unit test.',
      },
      affects: { versions: [version] },
    },
    usages: [],
    dependencies: [
      {
        repo,
        kind: 'runtime',
        name: 'node',
        ecosystem: 'npm',
        version,
        declaredIn: [
          { file: '.nvmrc', line: 1, text: version },
          { file: 'package.json', line: 6, text: `"node": ">=${version}"` },
          { file: 'Dockerfile', line: 1, text: `FROM node:${version}-bookworm` },
        ],
      },
    ],
    ...rest,
  };
}

export function makeModelTask(): ExternalTask {
  const repo = 'example-org/bot';
  return {
    id: 'task-gpt-4o-retired',
    repo,
    priority: 1,
    change: {
      provider: 'openai',
      id: 'example-gpt-4o-retirement',
      kind: 'model-retirement',
      dependencyKind: 'ai-model',
      dependency: 'gpt-4o',
      title: 'Example: gpt-4o is retiring',
      source: { url: 'https://platform.openai.com/docs/deprecations', quote: 'Example quote.' },
      affects: {},
    },
    usages: [],
    dependencies: [
      {
        repo,
        kind: 'ai-model',
        name: 'gpt-4o',
        ecosystem: 'openai',
        declaredIn: [{ file: 'src/chat.js', line: 3, text: "model: 'gpt-4o'" }],
      },
    ],
  };
}

export function makeScanReport(repo: string, scannedAt: string): ScanReport {
  const task = makeExternalTask({ repo });
  return {
    repo,
    scannedAt,
    costUsd: 0.01,
    errors: [],
    items: [
      {
        repo,
        dependency: task.dependencies[0],
        change: task.change,
        deadline: task.change.effectiveDate,
        status: 'open',
      },
    ],
  };
}

import { parseArgs } from 'node:util';
import { prepareDependencies } from './dependency-preparation.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE =
  'Usage: refit prepare --repository <clean-git-directory> --image <existing-local-node-image> [--cache <directory-outside-git>] [--json]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      image: { type: 'string' },
      cache: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\nInstalls committed npm or pinned pnpm lockfile dependencies in restricted Docker with network access and lifecycle scripts disabled. No application source, credentials, .npmrc or repository commands are used during installation. Validation stays offline. Requires an already-installed image with Node, npm, sh and tar. Verified dependency bundles are cached outside Git repositories.`,
    );
  else {
    if (!values.repository || !values.image) throw new PipelineInputError(USAGE);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const prepared = await prepareDependencies({
        repository: values.repository,
        image: values.image,
        cacheDirectory: values.cache,
        signal: controller.signal,
        onProgress: (message) => console.error(`[refit] ${terminalText(message)}`),
      });
      if (values.json) console.log(JSON.stringify(prepared));
      else
        console.log(
          [
            prepared.reused ? 'Verified dependencies reused' : 'Dependencies prepared',
            '',
            `Runtime   ${prepared.environment.nodeVersion}; ${prepared.environment.pnpmVersion ? `pnpm ${prepared.environment.pnpmVersion}` : `npm ${prepared.environment.npmVersion}`}`,
            `Packages  ${prepared.environment.packages} locked records`,
            ...(prepared.environment.workspaceHashes
              ? [
                  `Workspaces ${Object.keys(prepared.environment.workspaceHashes).length} committed manifests`,
                ]
              : []),
            'Install   Public npm registry; lifecycle scripts disabled',
            'Checks    Network disabled when used for validation',
            `Evidence  ${terminalText(prepared.directory)}`,
          ].join('\n'),
        );
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

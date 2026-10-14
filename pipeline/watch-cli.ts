import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { watchOnce } from './watch.ts';
import { readWorkflowConfiguration } from './workflow-configuration.ts';
import { assessmentConfiguration } from './assessment.ts';
import { publicationConfiguration } from './publication.ts';
import { githubAppConfiguration } from './github-app.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';
import { PipelineInputError } from './types.ts';
import { SpecificationUnavailableError } from './network.ts';
import { validateRepairAttempts } from './validation-options.ts';
import { normalizeDocumentationSource } from './documentation-sources.ts';

const DEFAULT_INTERVAL_SECONDS = 300;
const MINIMUM_INTERVAL_SECONDS = 30;
const MAXIMUM_INTERVAL_SECONDS = 86400;
const MILLISECONDS_PER_SECOND = 1000;
const MAXIMUM_SOURCE_FAILURES = 3;
const FAILED_STATUSES = new Set([
  'needs-review',
  'validation-failed',
  'error',
  'interrupted',
  'documentation-changed',
]);
const USAGE =
  'Usage: refit watch --config <run.json> --state <directory-outside-repository> [--repository <local-git-root>] [--once] [--sync-github --github owner/repo --base main --github-app] [--source-url <public-https-openapi> | --source-file <openapi> | --latest-stripe] [--documentation-source <label=https-url> ...] [--interval <seconds>] [--retry --once] [--ai-patch --repair-attempts 0|1|2] [--publish-draft --github owner/repo --base main --github-app] [--json]';

try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      state: { type: 'string' },
      repository: { type: 'string' },
      once: { type: 'boolean' },
      retry: { type: 'boolean' },
      interval: { type: 'string' },
      'source-url': { type: 'string' },
      'source-file': { type: 'string' },
      'documentation-source': { type: 'string', multiple: true },
      'latest-stripe': { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'prepare-dependencies': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      'sync-github': { type: 'boolean' },
      'github-app': { type: 'boolean' },
      github: { type: 'string' },
      base: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\n--documentation-source accepts up to eight public HTML, Markdown, plain-text, RSS 2.0 or Atom changelog URLs. Refit saves a unified text diff and reports it for review; documentation changes alone never start AI generation or PR publication. --prepare-dependencies installs locked public npm packages with scripts disabled before offline checks. The default API source is the run configuration's after file or latestStripe setting. oasdiff is required unless fullDiff is false in that configuration. State deduplicates jobs across restarts. Retry is explicit and limited to one poll.`,
    );
  else {
    if (!values.config || !values.state) throw new PipelineInputError(USAGE);
    if (values.retry && !values.once)
      throw new PipelineInputError('--retry requires --once to avoid repeated paid retries.');
    if (values.repository !== undefined && values['sync-github'])
      throw new PipelineInputError('Choose a local --repository or --sync-github, not both.');
    if (
      !values['publish-draft'] &&
      !values['sync-github'] &&
      (values.github || values.base || values['github-app'])
    )
      throw new PipelineInputError('GitHub options require --publish-draft or --sync-github.');
    if (values['sync-github'] && !values['github-app'])
      throw new PipelineInputError(
        '--sync-github requires --github-app and an installed App on the target repository.',
      );
    const app = values['github-app'] ? githubAppConfiguration(process.env) : undefined;
    const github =
      values['publish-draft'] || values['sync-github']
        ? publicationConfiguration(values.github, values.base, process.env.GITHUB_TOKEN, app)
        : undefined;
    const aiPatch = assessmentConfiguration(values['ai-patch'], process.env);
    const repairAttempts = validateRepairAttempts(
      Number(values['repair-attempts'] ?? 0),
      Boolean(aiPatch),
    );
    const interval = Number(values.interval ?? DEFAULT_INTERVAL_SECONDS);
    if (
      !Number.isInteger(interval) ||
      interval < MINIMUM_INTERVAL_SECONDS ||
      interval > MAXIMUM_INTERVAL_SECONDS
    )
      throw new PipelineInputError(
        `Watch interval must be ${MINIMUM_INTERVAL_SECONDS}–${MAXIMUM_INTERVAL_SECONDS} seconds.`,
      );
    if (
      [values['source-url'], values['source-file'], values['latest-stripe']].filter(Boolean)
        .length > 1
    )
      throw new PipelineInputError('Choose one specification source.');
    const configuration = await readWorkflowConfiguration(values.config);
    const documentationSources = (values['documentation-source'] ?? []).map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1)
        throw new PipelineInputError('--documentation-source must use <label=https-url>.');
      return normalizeDocumentationSource({
        label: entry.slice(0, separator),
        url: entry.slice(separator + 1),
      });
    });
    const source = values['source-url']
      ? { kind: 'https' as const, url: values['source-url'] }
      : values['source-file']
        ? { kind: 'file' as const, path: resolve(values['source-file']) }
        : values['latest-stripe'] || configuration.latestStripe
          ? { kind: 'stripe-latest' as const }
          : { kind: 'file' as const, path: configuration.after! };
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let sourceFailures = 0;
    try {
      do {
        let result;
        try {
          result = await watchOnce({
            configuration: {
              ...configuration,
              repository: values.repository ?? configuration.repository,
              prepareDependencies:
                values['prepare-dependencies'] ?? configuration.prepareDependencies,
              aiPatch,
              repairAttempts,
              signal: controller.signal,
              publication: values['publish-draft'] ? github : undefined,
            },
            source,
            documentationSources,
            stateDirectory: values.state,
            retry: values.retry,
            onProgress: (message) => console.error(`[refit] ${message}`),
            syncGitHub:
              values['sync-github'] && app && github
                ? { repository: github.repository, base: github.base, app }
                : undefined,
          });
          sourceFailures = 0;
        } catch (error) {
          if (!(error instanceof SpecificationUnavailableError) || values.once) throw error;
          sourceFailures += 1;
          if (sourceFailures >= MAXIMUM_SOURCE_FAILURES) throw error;
          console.error(
            `[refit] ${error.message} Retrying the source in ${interval} seconds (${sourceFailures}/${MAXIMUM_SOURCE_FAILURES}). No AI job was started.`,
          );
          await setTimeout(interval * MILLISECONDS_PER_SECOND, undefined, {
            signal: controller.signal,
          });
          continue;
        }
        if (values.json) console.log(JSON.stringify(result));
        else if (result.status === 'processed') {
          console.log(await renderWorkflowResult(result.result));
          if (result.documentationBaselines?.length)
            console.log(renderDocumentationBaselines(result.documentationBaselines));
          if (result.documentationChanges?.length)
            console.log(renderDocumentationChanges(result.documentationChanges));
        } else if (result.status === 'documentation-changed')
          console.log(
            renderDocumentationChanges(result.documentationChanges, result.previousStatus),
          );
        else
          console.log(
            `Already processed ${result.provider} change (${result.previousStatus}).\nEvidence: ${result.output ?? 'See watch state.'}`,
          );
        if (values.once) {
          const status =
            result.status === 'processed'
              ? result.result.manifest.status
              : result.status === 'documentation-changed'
                ? result.status
                : result.previousStatus;
          process.exitCode = status === 'error' ? 1 : FAILED_STATUSES.has(status) ? 2 : 0;
          break;
        }
        if (!controller.signal.aborted)
          await setTimeout(interval * MILLISECONDS_PER_SECOND, undefined, {
            signal: controller.signal,
          });
      } while (!controller.signal.aborted);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError' && controller.signal.aborted))
        throw error;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

function renderDocumentationBaselines(baselines: Array<{ label: string; url: string }>) {
  const entries = baselines.map((source) => `- ${source.label}: ${source.url}`);
  return `Now monitoring ${baselines.length} documentation source${baselines.length === 1 ? '' : 's'} from this baseline:\n${entries.join('\n')}`;
}

function renderDocumentationChanges(
  changes: Array<{
    label: string;
    url: string;
    addedLines: number;
    removedLines: number;
    patch: string;
    evidence: string;
  }>,
  previousStatus?: string,
) {
  const entries = changes.map(
    (change) =>
      `- ${change.label}: ${change.addedLines} added, ${change.removedLines} removed\n  ${change.url}\n  Diff: ${change.patch}\n  Evidence: ${change.evidence}`,
  );
  const prior = previousStatus
    ? `\nThe previous API workflow status remains ${previousStatus}; it was not rerun.`
    : '';
  return `Documentation changed. Refit saved a text diff for review and did not start a migration.${prior}\n${entries.join('\n')}`;
}

import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { DEFAULT_LEAD_DAYS, parseLeadDays } from './deadline-alerts.ts';
import { githubAppConfiguration } from './github-app.ts';
import { runLocalService, validateServiceSecret } from './local-service.ts';
import { readServiceConfiguration } from './service-configuration.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const REVIEW_STATUSES = new Set([
  'needs-review',
  'validation-failed',
  'interrupted',
  'not-run',
  'documentation-changed',
]);
const USAGE =
  'Usage: refit serve --config <service.json> --state <directory-outside-repository> [--port <number>] [--interval <seconds>] [--once] [--retry-target <id> ... --once] [--ai-patch --repair-attempts 0|1|2] [--publish-draft] [--deadline-alerts [--deadline-lead-days 90,30,7]] [--json]';

try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      state: { type: 'string' },
      port: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      'retry-target': { type: 'string', multiple: true },
      'ai-patch': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      'deadline-alerts': { type: 'boolean' },
      'deadline-lead-days': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\nRuns on 127.0.0.1:8787 by default; signed webhooks use /github/webhook and authenticated status uses /status. Requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, REFIT_WEBHOOK_SECRET and a different REFIT_SERVICE_TOKEN. Configured targets are confirmed through GitHub before execution. Installation webhooks wake or cancel their workers; other installed repositories are recorded without execution. --once polls all targets and closes the HTTP listener. --retry-target requires --once and polls only the named targets, permitting failed jobs one fresh attempt; successful jobs remain cached. Approval and access gates still apply. AI and draft PR publication require explicit opt-in. --deadline-alerts opens or updates one GitHub issue per enrolled repository and registry deadline at the lead times (default 90,30,7 days); it needs the App's Issues write permission.`,
    );
  else {
    if (!values.config || !values.state) throw new PipelineInputError(USAGE);
    if (values['retry-target']?.length && !values.once)
      throw new PipelineInputError(
        '--retry-target requires --once to avoid repeated paid retries.',
      );
    if (values['deadline-lead-days'] !== undefined && !values['deadline-alerts'])
      throw new PipelineInputError('--deadline-lead-days requires --deadline-alerts.');
    const deadlineAlerts = values['deadline-alerts']
      ? {
          leadDays:
            values['deadline-lead-days'] === undefined
              ? DEFAULT_LEAD_DAYS
              : parseLeadDays(values['deadline-lead-days']),
        }
      : undefined;
    const app = githubAppConfiguration(process.env);
    const webhookSecret = validateServiceSecret(
      process.env.REFIT_WEBHOOK_SECRET,
      'REFIT_WEBHOOK_SECRET',
    );
    const controlToken = validateServiceSecret(
      process.env.REFIT_SERVICE_TOKEN,
      'REFIT_SERVICE_TOKEN',
    );
    const targets = await readServiceConfiguration(values.config, app);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const result = await runLocalService({
        targets,
        app,
        directory: values.state,
        webhookSecret,
        controlToken,
        port: values.port === undefined ? undefined : Number(values.port),
        intervalSeconds: values.interval === undefined ? undefined : Number(values.interval),
        once: values.once,
        retryTargets: values['retry-target'],
        aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
        repairAttempts: Number(values['repair-attempts'] ?? 0),
        publishDraft: values['publish-draft'],
        deadlineAlerts,
        signal: controller.signal,
        onReady: (url) => console.error(`[refit] Listening at ${url}; webhook: /github/webhook`),
        onProgress: (message) => console.error(`[refit] ${terminalText(message)}`),
      });
      const selected = Object.entries(result.registry.targets).filter(
        ([id]) => !values['retry-target']?.length || values['retry-target'].includes(id),
      );
      if (values.json) console.log(JSON.stringify(result));
      else {
        console.log(values.once ? 'Refit service poll complete' : 'Refit service stopped');
        for (const [id, target] of selected) {
          console.log(
            `\n${id}  ${target.repository}\nStatus    ${terminalText(target.status)}\nAccess    ${target.access}`,
          );
          if (target.message) console.log(terminalText(target.message));
          if (target.output) console.log(`Evidence  ${terminalText(target.output)}`);
        }
        console.log(`\nService state  ${terminalText(result.directory)}`);
      }
      if (values.once) {
        const records = selected.map(([, target]) => target);
        process.exitCode = records.some((target) => target.status === 'error')
          ? 1
          : records.some(
                (target) => target.access !== 'active' || REVIEW_STATUSES.has(target.status),
              )
            ? 2
            : 0;
      }
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
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

import { parseArgs } from 'node:util';
import { slackNotifier } from './slack.ts';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assessmentConfiguration } from './assessment.ts';
import { publicationConfiguration, publishUnresolved } from './publication.ts';
import { PipelineInputError } from './types.ts';
import { runWorkflow } from './workflow.ts';
import { parseCheckCommand, HOSTED_REPAIR_ATTEMPTS } from './validation-options.ts';
import { readWorkflowConfiguration, REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';
import { githubAppConfiguration } from './github-app.ts';
import { renderWorkflowResult } from './workflow-presentation.ts';
import { validateApiVersionPolicy } from './api-version.ts';
import { hasErrorCode } from './state-files.ts';
import { cliErrorMessage } from './cli-errors.ts';
import { DRY_RUN_MODEL } from './behaviour-test-writer.ts';
import { stripeTestMode } from './stripe-test-mode.ts';

const RUN_DIRECTORY_PREFIX = 'refit-run-';

const USAGE =
  'Usage: refit run [--integration <id>] [--output <new-directory-outside-repository>]\n   or: refit run --config <run.json> [--repository <git-root>] [--output <new-directory>]\n   or: refit run --repository <clean-git-directory> --before <spec.json-or-yaml> (--after <spec.json-or-yaml> | --latest-stripe) --image <local-image> --command \'["npm","test"]\'\nOptional: [--env <.env>] [--quiet] [--human | --json] [--api-version <current-api-version>] [--api-version-policy operator-pin|source-verified] [--full-diff (requires oasdiff)] [--provider-config <adapter.json>] [--assess] [--ai-patch [--documentation-snapshot <saved-note.json> ...]] [--repair-attempts 0-4 (sends failed check output to OpenAI)] [--write-behaviour-tests (sends the original Stripe modules to OpenAI; the default with --ai-patch where stripe-mock is configured) | --write-behaviour-tests-dry-run | --no-behaviour-tests] [--publish-unresolved | --publish-validated-only] [--shopify-sdk-upgrade] [--publish-draft --github owner/repository --base main [--github-app] [--supersede-drafts]]';

try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      integration: { type: 'string' },
      quiet: { type: 'boolean' },
      json: { type: 'boolean' },
      human: { type: 'boolean' },
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      'latest-stripe': { type: 'boolean' },
      'full-diff': { type: 'boolean' },
      output: { type: 'string' },
      image: { type: 'string' },
      'prepare-dependencies': { type: 'boolean' },
      command: { type: 'string' },
      'baseline-command': { type: 'string' },
      'provider-config': { type: 'string' },
      'api-version': { type: 'string' },
      'api-version-policy': { type: 'string' },
      assess: { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'write-behaviour-tests': { type: 'boolean' },
      'write-behaviour-tests-dry-run': { type: 'boolean' },
      // --ai-patch writes behaviour tests by default where stripe-mock settings exist.
      'no-behaviour-tests': { type: 'boolean' },
      'webhook-checks': { type: 'boolean' },
      'stripe-test-mode': { type: 'boolean' },
      'documentation-snapshot': { type: 'string', multiple: true },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      'github-app': { type: 'boolean' },
      'publish-unresolved': { type: 'boolean' },
      'publish-validated-only': { type: 'boolean' },
      'supersede-drafts': { type: 'boolean' },
      'shopify-sdk-upgrade': { type: 'boolean' },
      github: { type: 'string' },
      base: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\nFrom a repository root, run refit doctor, then refit run to use .refit.json. --repository selects another root. Evidence defaults to a new private directory in the operating system's temporary directory; use --output to retain it elsewhere.\nUse --human for a readable summary or --json for machine output. Terminals default to human output; redirected output defaults to JSON.\n--prepare-dependencies installs locked public npm/pnpm packages with scripts disabled before offline checks. Optional --baseline-command '<JSON array>' overrides only the baseline check. Both commands are recorded; review their contract differences. AI and publication stay explicit opt-ins. Refit turns its stops into [Needs review] drafts by default (docs/CLI.md); --publish-validated-only publishes validated drafts only. --supersede-drafts closes Refit's older open drafts for the same provider and integration, with a comment linking the new one; it needs --github-app.`,
    );
  else {
    if (values.json && values.human)
      throw new PipelineInputError('Choose either --json or --human.');
    const implicitConfiguration = values.config === undefined && values.before === undefined;
    const root = resolve(values.repository ?? process.cwd());
    const configurationPath =
      values.config ?? (implicitConfiguration ? join(root, REPOSITORY_CONFIGURATION) : undefined);
    const configuration = configurationPath
      ? await readWorkflowConfiguration(configurationPath, values.integration).catch(
          (error: unknown) => {
            if (implicitConfiguration && hasErrorCode(error, 'ENOENT'))
              throw new PipelineInputError(
                `No ${REPOSITORY_CONFIGURATION} at ${root}. Run refit agents to see which provider agents apply and refit agents --add <id> to write one, or supply --config with an existing workflow.`,
                { cause: error },
              );
            throw error;
          },
        )
      : undefined;
    if (values.integration && !configurationPath)
      throw new PipelineInputError('--integration requires --config.');
    if (implicitConfiguration && configuration?.repository && configuration.repository !== root)
      throw new PipelineInputError(
        'A root .refit.json cannot redirect the run to another repository. Remove repository from that file, or select the operator workflow explicitly with --config.',
      );
    const repository =
      values.repository ??
      configuration?.repository ??
      (configurationPath && basename(configurationPath) === REPOSITORY_CONFIGURATION
        ? dirname(resolve(configurationPath))
        : undefined);
    const before = values.before ?? configuration?.before;
    const image = values.image ?? configuration?.image;
    const command =
      values.command === undefined ? configuration?.command : parseCheckCommand(values.command);
    if (!repository || !before || !image || !command)
      throw new PipelineInputError(`Missing run inputs.\n${USAGE}`);
    if (
      !values['publish-draft'] &&
      (values.github || values.base || values['github-app'] || values['supersede-drafts'])
    )
      throw new PipelineInputError(
        '--github, --base, --github-app and --supersede-drafts require --publish-draft.',
      );
    // A token cannot tell Refit's drafts from a person's, so it never closes one.
    if (values['supersede-drafts'] && !values['github-app'])
      throw new PipelineInputError('--supersede-drafts requires --github-app.');
    const specificationOverride =
      values.after !== undefined || values['latest-stripe'] !== undefined;
    const allowUnresolved = publishUnresolved(values);
    const slack = slackNotifier(process.env);
    const result = await runWorkflow({
      repository,
      integration: configuration?.integration,
      before,
      after: specificationOverride ? values.after : configuration?.after,
      latestStripe: specificationOverride ? values['latest-stripe'] : configuration?.latestStripe,
      output: values.output ?? join(tmpdir(), `${RUN_DIRECTORY_PREFIX}${randomUUID()}`),
      image,
      prepareDependencies: values['prepare-dependencies'] ?? configuration?.prepareDependencies,
      generatedChecks: configuration?.generatedChecks,
      compareTypeErrors: configuration?.compareTypeErrors,
      keepListedPaymentMethods: configuration?.keepListedPaymentMethods,
      shopifySdkUpgrade: values['shopify-sdk-upgrade'],
      command,
      baselineCommand:
        values['baseline-command'] !== undefined
          ? parseCheckCommand(values['baseline-command'], '--baseline-command')
          : configuration?.baselineCommand,
      checkTimeoutSeconds: configuration?.checkTimeoutSeconds,
      providerConfig: values['provider-config'] ?? configuration?.providerConfig,
      apiVersion: values['api-version'] ?? configuration?.apiVersion,
      apiVersionPolicy: validateApiVersionPolicy(
        values['api-version-policy'] ?? configuration?.apiVersionPolicy,
      ),
      fullDiff: values['full-diff'] ?? configuration?.fullDiff,
      assessment: assessmentConfiguration(values.assess, process.env),
      aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
      behaviourTestWriter: values['no-behaviour-tests']
        ? false
        : values['write-behaviour-tests-dry-run']
          ? { model: process.env.OPENAI_MODEL?.trim() || DRY_RUN_MODEL, dryRun: true }
          : assessmentConfiguration(values['write-behaviour-tests'], process.env),
      signedEventChecks: values['webhook-checks'],
      providerSandbox: stripeTestMode(values['stripe-test-mode'], values['write-behaviour-tests']),
      documentationSnapshots: values['documentation-snapshot'],
      repairAttempts: Number(
        values['repair-attempts'] ?? (values['ai-patch'] ? HOSTED_REPAIR_ATTEMPTS : 0),
      ),
      publication: values['publish-draft']
        ? {
            ...publicationConfiguration(
              values.github,
              values.base,
              process.env.GITHUB_TOKEN,
              values['github-app'] ? githubAppConfiguration(process.env) : undefined,
            ),
            ...(allowUnresolved ? { allowUnresolved: true } : {}),
            ...(values['supersede-drafts'] ? { supersedeDrafts: true } : {}),
          }
        : undefined,
      // Alone, it saves [Needs review] artifacts that a later publication can use.
      ...(allowUnresolved ? { allowUnresolved: true } : {}),
      ...(slack ? { notify: { send: slack } } : {}),
      onProgress: values.quiet ? undefined : (message) => console.error(`[refit] ${message}`),
    });
    console.log(
      values.json || (!values.human && !process.stdout.isTTY)
        ? JSON.stringify(result, null, 2)
        : await renderWorkflowResult(result),
    );
    process.exitCode =
      result.manifest.status === 'error'
        ? 1
        : ['needs-review', 'validation-failed'].includes(result.manifest.status)
          ? 2
          : 0;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'run'));
  process.exitCode = 1;
}

import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { publicationConfiguration } from './publication.ts';
import { PipelineInputError } from './types.ts';
import { runWorkflow } from './workflow.ts';
import { parseCheckCommand } from './validation-options.ts';
import { readWorkflowConfiguration } from './workflow-configuration.ts';
import { githubAppConfiguration } from './github-app.ts';

const USAGE =
  'Usage: refit run --config <run.json> --output <new-directory-outside-repository>\n   or: refit run --repository <clean-git-directory> --before <spec.json> (--after <spec.json> | --latest-stripe) --output <new-directory-outside-repository> --image <local-image> --command \'["npm","test"]\'\nOptional: [--env <.env>] [--quiet] [--provider-config <adapter.json>] [--assess] [--ai-patch] [--repair-attempts 0|1|2 (sends failed check output to OpenAI)] [--publish-draft --github owner/repository --base main [--github-app]]';

try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      quiet: { type: 'boolean' },
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      'latest-stripe': { type: 'boolean' },
      output: { type: 'string' },
      image: { type: 'string' },
      command: { type: 'string' },
      'baseline-command': { type: 'string' },
      'provider-config': { type: 'string' },
      assess: { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      'github-app': { type: 'boolean' },
      github: { type: 'string' },
      base: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\nOptional --baseline-command '<JSON array>' overrides only the baseline check. Both commands are recorded; review their contract differences.`,
    );
  else {
    const configuration = values.config
      ? await readWorkflowConfiguration(values.config)
      : undefined;
    const repository = values.repository ?? configuration?.repository;
    const before = values.before ?? configuration?.before;
    const image = values.image ?? configuration?.image;
    const command =
      values.command === undefined ? configuration?.command : parseCheckCommand(values.command);
    if (!repository || !before || !values.output || !image || !command)
      throw new PipelineInputError(`Missing run inputs.\n${USAGE}`);
    if (!values['publish-draft'] && (values.github || values.base || values['github-app']))
      throw new PipelineInputError('--github, --base and --github-app require --publish-draft.');
    const specificationOverride =
      values.after !== undefined || values['latest-stripe'] !== undefined;
    const result = await runWorkflow({
      repository,
      before,
      after: specificationOverride ? values.after : configuration?.after,
      latestStripe: specificationOverride ? values['latest-stripe'] : configuration?.latestStripe,
      output: values.output,
      image,
      command,
      baselineCommand:
        values['baseline-command'] !== undefined
          ? parseCheckCommand(values['baseline-command'], '--baseline-command')
          : configuration?.baselineCommand,
      providerConfig: values['provider-config'] ?? configuration?.providerConfig,
      assessment: assessmentConfiguration(values.assess, process.env),
      aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
      repairAttempts: Number(values['repair-attempts'] ?? 0),
      publication: values['publish-draft']
        ? publicationConfiguration(
            values.github,
            values.base,
            process.env.GITHUB_TOKEN,
            values['github-app'] ? githubAppConfiguration(process.env) : undefined,
          )
        : undefined,
      onProgress: values.quiet ? undefined : (message) => console.error(`[refit] ${message}`),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode =
      result.manifest.status === 'error'
        ? 1
        : ['needs-review', 'validation-failed'].includes(result.manifest.status)
          ? 2
          : 0;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

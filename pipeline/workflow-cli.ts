import { parseArgs } from 'node:util';
import { assessmentConfiguration } from './assessment.ts';
import { publicationConfiguration } from './publication.ts';
import { PipelineInputError } from './types.ts';
import { runWorkflow } from './workflow.ts';
import { parseCheckCommand } from './validation-options.ts';

const USAGE =
  'Usage: npm run api:run -- --repository <clean-git-directory> --before <spec.json> (--after <spec.json> | --latest-stripe) --output <new-directory-outside-repository> --image <local-image> --command \'["npm","test"]\' [--provider-config <adapter.json>] [--assess] [--ai-patch] [--repair-attempts 0|1|2 (sends failed check output to OpenAI)] [--publish-draft --github owner/repository --base main]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      'latest-stripe': { type: 'boolean' },
      output: { type: 'string' },
      image: { type: 'string' },
      command: { type: 'string' },
      'provider-config': { type: 'string' },
      assess: { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'publish-draft': { type: 'boolean' },
      github: { type: 'string' },
      base: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (
    !values.repository ||
    !values.before ||
    !values.output ||
    !values.image ||
    !values.command
  ) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    if (!values['publish-draft'] && (values.github || values.base))
      throw new PipelineInputError('--github and --base require --publish-draft.');
    const command = parseCheckCommand(values.command);
    const result = await runWorkflow({
      repository: values.repository,
      before: values.before,
      after: values.after,
      latestStripe: values['latest-stripe'],
      output: values.output,
      image: values.image,
      command,
      providerConfig: values['provider-config'],
      assessment: assessmentConfiguration(values.assess, process.env),
      aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
      repairAttempts: Number(values['repair-attempts'] ?? 0),
      publication: values['publish-draft']
        ? publicationConfiguration(values.github, values.base, process.env.GITHUB_TOKEN)
        : undefined,
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

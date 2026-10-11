import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validateMigration } from './validation.ts';
import { PipelineInputError } from './types.ts';
import { writeReviewBundle } from './review.ts';
import { assessmentConfiguration } from './assessment.ts';
import { publicationConfiguration, publishDraft } from './publication.ts';
import { parseCheckCommand } from './validation-options.ts';
import { githubAppConfiguration } from './github-app.ts';

const USAGE =
  'Usage: refit validate --repository <clean-git-directory> --before <spec.json> --after <spec.json> [--provider-config <adapter.json>] --image <local-image> --command \'["npm","test"]\' [--output <new-report.json> | --bundle <new-directory>] [--assess (sends selected source context to OpenAI)] [--ai-patch (sends affected source files to OpenAI)] [--repair-attempts 0|1|2 (sends failed check output to OpenAI)] [--publish-draft --github owner/repository --base main (uses GITHUB_TOKEN or --github-app)]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      image: { type: 'string' },
      command: { type: 'string' },
      'baseline-command': { type: 'string' },
      output: { type: 'string' },
      bundle: { type: 'string' },
      assess: { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'provider-config': { type: 'string' },
      help: { type: 'boolean' },
      'publish-draft': { type: 'boolean' },
      'github-app': { type: 'boolean' },
      github: { type: 'string' },
      base: { type: 'string' },
    },
  });
  if (values.help)
    console.log(
      `${USAGE}\nOptional --baseline-command '<JSON array>' overrides only the baseline check. Both commands are recorded; review their contract differences.`,
    );
  else if (
    !values.repository ||
    !values.before ||
    !values.after ||
    !values.image ||
    !values.command
  ) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    if (values.output && values.bundle)
      throw new PipelineInputError('Choose either --output or --bundle, not both.');
    if (!values['publish-draft'] && (values.github || values.base || values['github-app']))
      throw new PipelineInputError('--github, --base and --github-app require --publish-draft.');
    const publication = values['publish-draft']
      ? publicationConfiguration(
          values.github,
          values.base,
          process.env.GITHUB_TOKEN,
          values['github-app'] ? githubAppConfiguration(process.env) : undefined,
        )
      : undefined;
    const command = parseCheckCommand(values.command);
    const report = await validateMigration({
      repository: values.repository,
      before: values.before,
      after: values.after,
      image: values.image,
      command,
      baselineCommand:
        values['baseline-command'] !== undefined
          ? parseCheckCommand(values['baseline-command'], '--baseline-command')
          : undefined,
      assessment: assessmentConfiguration(values.assess, process.env),
      aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
      repairAttempts: Number(values['repair-attempts'] ?? 0),
      providerConfig: values['provider-config'],
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.bundle)
      console.log(JSON.stringify(await writeReviewBundle(values.bundle, report), null, 2));
    else if (values.output) await writeFile(values.output, json, { flag: 'wx' });
    else process.stdout.write(json);
    if (publication) console.log(JSON.stringify(await publishDraft(report, publication), null, 2));
    if (report.validation.status !== 'passed') process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

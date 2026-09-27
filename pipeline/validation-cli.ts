import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validateMigration } from './validation.ts';
import { PipelineInputError } from './types.ts';

const USAGE =
  'Usage: npm run stripe:validate -- --repository <clean-git-directory> --before <spec.json> --after <spec.json> --image <local-image> --command \'["npm","test"]\' [--output <new-report.json>]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      image: { type: 'string' },
      command: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
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
    let command: unknown;
    try {
      command = JSON.parse(values.command);
    } catch (cause) {
      throw new PipelineInputError('--command must be a JSON array.', { cause });
    }
    if (!Array.isArray(command)) throw new PipelineInputError('--command must be a JSON array.');
    const report = await validateMigration({
      repository: values.repository,
      before: values.before,
      after: values.after,
      image: values.image,
      command,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(values.output, json, { flag: 'wx' });
    else process.stdout.write(json);
    if (report.validation.status !== 'passed') process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

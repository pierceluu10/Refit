import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runPipeline } from './run.ts';

const USAGE =
  'Usage: npm run stripe:scan -- --repository <directory> --before <openapi.json> --after <openapi.json> [--output <new-report.json>]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
  } else if (!values.repository || !values.before || !values.after) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const report = await runPipeline({
      repository: values.repository,
      before: values.before,
      after: values.after,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(values.output, json, { flag: 'wx' });
    else process.stdout.write(json);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

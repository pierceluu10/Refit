import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runPipeline } from './run.ts';
import { assessmentConfiguration } from './assessment.ts';
import { validateApiVersionPolicy } from './api-version.ts';
import { PipelineInputError } from './types.ts';
import { renderScanResult } from './workflow-presentation.ts';

const USAGE =
  'Usage: refit scan --repository <directory> --before <openapi.json-or-yaml> --after <openapi.json-or-yaml> [--human | --json] [--api-version <current-api-version>] [--api-version-policy operator-pin|source-verified] [--full-diff (requires oasdiff)] [--provider-config <adapter.json>] [--output <new-report.json>] [--propose-patch] [--assess (sends selected source context to OpenAI)] [--ai-patch (sends affected source files to OpenAI)]';

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      output: { type: 'string' },
      human: { type: 'boolean' },
      json: { type: 'boolean' },
      'propose-patch': { type: 'boolean' },
      assess: { type: 'boolean' },
      'ai-patch': { type: 'boolean' },
      'provider-config': { type: 'string' },
      'api-version': { type: 'string' },
      'api-version-policy': { type: 'string' },
      'full-diff': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.human && values.json) throw new PipelineInputError('Choose either --json or --human.');
  if (values.help) {
    console.log(
      `${USAGE}\nTerminals default to a readable summary; redirected output defaults to JSON. --output always saves the complete JSON report. Scanning does not run checks or modify repository files.`,
    );
  } else if (!values.repository || !values.before || !values.after) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const report = await runPipeline({
      repository: values.repository,
      before: values.before,
      after: values.after,
      proposePatch: values['propose-patch'],
      assessment: assessmentConfiguration(values.assess, process.env),
      aiPatch: assessmentConfiguration(values['ai-patch'], process.env),
      providerConfig: values['provider-config'],
      apiVersion: values['api-version'],
      apiVersionPolicy: validateApiVersionPolicy(values['api-version-policy']),
      fullDiff: values['full-diff'],
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(values.output, json, { flag: 'wx' });
    if (!values.output || values.human)
      process.stdout.write(
        values.json || (!values.human && !process.stdout.isTTY)
          ? json
          : `${renderScanResult(report)}\n`,
      );
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

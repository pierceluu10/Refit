import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAiReplay } from './ai-replay.ts';

const USAGE = 'Usage: refit ai-replay [--propose-patch] [--output <new-report.json>]';

try {
  const { values } = parseArgs({
    options: {
      'propose-patch': { type: 'boolean' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const report = await runAiReplay({ proposePatch: values['propose-patch'] });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(values.output, json, { flag: 'wx' });
    else process.stdout.write(json);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}

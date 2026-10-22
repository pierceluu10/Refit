import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { detectApiHosts } from './api-hosts.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit api-hosts [--repository <root>] [--json]
Lists the external HTTP API hosts a JS/TS repository calls through fetch, axios, got, ky, undici, node:http(s) and superagent, with file:line and path prefix. A host that data/api-hosts.json or the agent catalog names shows its provider; any other is untracked. Test, fixture, documentation, localhost, private-range, image/CDN asset and schema URLs are left out and counted.
Review only: nothing is changed, installed, run or sent to any host.`;

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const root = resolve(values.repository ?? '.');
    const scan = await detectApiHosts(root);
    if (values.json) console.log(JSON.stringify({ repository: root, ...scan }));
    else {
      console.log(`Refit API hosts  ${terminalText(root)}`);
      if (!scan.hosts.length) console.log('\nNo external API host was found.');
      for (const host of scan.hosts) {
        console.log(
          `\n${terminalText(host.host)}  ${host.provider ? terminalText(host.provider.name) : 'untracked'}  (${host.count} ${host.count === 1 ? 'call' : 'calls'})`,
        );
        for (const call of host.calls)
          console.log(
            `  ${terminalText(`${call.file}:${call.line}`)}  ${call.client}${call.pathPrefix ? ` ${terminalText(call.pathPrefix)}` : ''}`,
          );
      }
      const left = Object.entries(scan.excluded).map(([name, count]) => `${name} ${count}`);
      if (left.length) console.log(`\nLeft out: ${left.join(', ')}`);
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

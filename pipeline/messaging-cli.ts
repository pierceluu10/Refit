import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanMessagingCalls, type MessagingScan } from './messaging-calls.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit messaging [--repository <root>] [--json]
Lists the messaging APIs a repository uses (Twilio, SendGrid, Resend, Postmark, Mailgun) and, with file:line: SDK members the SDK's own type declarations mark deprecated (twilio's version-less accessors such as client.verify.services, mailgun.js domain methods such as mg.domains.getTracking) with the replacement the SDK names; raw calls to endpoints a provider's changelog lists as removed; and declared packages that are retired on npm (sendgrid, mailgun-js) or out of support (twilio below 6.0.0).
Review only: nothing is changed, installed, run or sent to any provider.`;

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
    const scan = await scanMessagingCalls(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, checkedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function print(root: string, scan: MessagingScan) {
  console.log(`Refit messaging APIs  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to any provider.');
  if (!scan.providers.length) {
    console.log('\nNo messaging provider was found.');
    return;
  }
  console.log(`\nProviders    ${scan.providers.map((item) => item.agent.name).join(', ')}`);
  for (const item of scan.packages) {
    const notes = [
      item.deprecated ? `retired on npm: ${item.deprecated}` : '',
      item.deadline
        ? item.deadline.estimate
          ? `unsupported since about ${item.deadline.date}, Refit's estimate: the provider has not announced a date (${item.deadline.id}, report only)`
          : `unsupported since ${item.deadline.date} (${item.deadline.id})`
        : '',
    ].filter(Boolean);
    console.log(
      `SDK          ${terminalText(`${item.name} ${item.locked ?? item.declared} in ${item.file}`)}${notes.length ? `  ${terminalText(notes.join('; '))}` : ''}`,
    );
  }
  const live = scan.calls.filter((call) => call.use === 'live');
  console.log(
    `\n${live.length} deprecated or removed ${live.length === 1 ? 'call' : 'calls'} in live code.`,
  );
  for (const call of live) {
    console.log(`\n${terminalText(`${call.file}:${call.line}`)}  ${terminalText(call.call)}`);
    console.log(`  ${terminalText(call.message)}`);
    if (call.replacement) console.log(`  Use        ${terminalText(call.replacement)}`);
    console.log(
      `  Deadline   ${call.date ? `removed ${call.date}` : 'none announced'}  (${terminalText(call.source)})`,
    );
  }
  const tests = scan.calls.length - live.length;
  if (tests) console.log(`\n${tests} more in tests, examples and fixtures.`);
}

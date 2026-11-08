import { format } from 'node:util';
import { redactSecrets } from '../harness/secrets.ts';

const METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const;

// Hard limit 4: a host keeps whatever the process prints, so redact in the one place all output passes.
export function redactLogs(env: NodeJS.ProcessEnv = process.env): void {
  for (const method of METHODS) {
    const write = console[method].bind(console);
    console[method] = (...args: unknown[]) => write(redactSecrets(format(...args), env));
  }
  // Node prints an uncaught error itself, past console, so route it through the redaction.
  process.on('uncaughtException', (error) => {
    console.error(error);
    process.exit(1);
  });
}

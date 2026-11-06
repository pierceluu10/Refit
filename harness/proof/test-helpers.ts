// Test helpers: a fake sandbox whose commands are answered by a handler, so tests never run repo code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecResult, Sandbox } from '../types.ts';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name: string) => path.join(FIXTURES, name);

export function fakeSandbox(
  dir: string,
  handler: (command: string) => Partial<ExecResult> | undefined = () => undefined,
): Sandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    dir,
    mode: 'local',
    commands,
    exec: async (command) => {
      commands.push(command);
      const answer = handler(command);
      return { code: 1, stdout: '', stderr: 'not found', timedOut: false, ...answer };
    },
    diff: async () => '',
    dispose: async () => undefined,
  };
}

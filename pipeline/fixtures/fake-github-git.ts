import type * as ChildProcess from 'node:child_process';
import { promisify } from 'node:util';

// The header Refit's managed checkouts configure for github.com (pipeline/git-environment.ts).
const EXTRA_HEADER = 'http.https://github.com/.extraHeader';
const REMOTE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/;

let gitRoot: string | undefined;

// Set by the fake GitHub while it runs; fetches pass through unchanged when it is unset.
export function routeGitTo(url: string | undefined) {
  gitRoot = url;
}

// For vi.mock('node:child_process'): a managed checkout's `git fetch … origin …` goes to the fake
// GitHub over HTTP with the same App token header git would send to github.com. The checkout keeps
// its https://github.com remote, so Refit's own remote checks still run. This module must not
// import node:child_process itself, or the mock factory would load the mock it is building.
export function throughFakeGitHub(actual: typeof ChildProcess): typeof ChildProcess {
  const execute = promisify(actual.execFile);
  const execFile = ((...args: Parameters<typeof actual.execFile>) =>
    actual.execFile(...args)) as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: ChildProcess.ExecFileOptions = {}) => {
      const origin = args.indexOf('origin');
      if (binary !== 'git' || !gitRoot || !args.includes('fetch') || origin < 0)
        return execute(binary, args, options);
      const directory = args[args.indexOf('-C') + 1];
      const remote = (
        await execute('git', ['-C', directory, 'remote', 'get-url', 'origin'], options)
      ).stdout
        .toString()
        .trim();
      const repository = REMOTE.exec(remote)?.[1];
      if (!repository) throw new Error(`Managed checkout remote is not on github.com: ${remote}`);
      const environment = { ...options.env };
      const count = Number(environment.GIT_CONFIG_COUNT ?? 0);
      const header = Object.keys(environment).find(
        (key) => key.startsWith('GIT_CONFIG_KEY_') && environment[key] === EXTRA_HEADER,
      );
      const added: [string, string][] = [['protocol.http.allow', 'always']];
      if (header)
        added.push([
          `http.${gitRoot}/.extraHeader`,
          environment[header.replace('_KEY_', '_VALUE_')] ?? '',
        ]);
      added.forEach(([name, value], index) => {
        environment[`GIT_CONFIG_KEY_${count + index}`] = name;
        environment[`GIT_CONFIG_VALUE_${count + index}`] = value;
      });
      environment.GIT_CONFIG_COUNT = String(count + added.length);
      const routed = [...args];
      routed[origin] = `${gitRoot}/${repository}.git`;
      return execute(binary, routed, { ...options, env: environment });
    },
  });
  return { ...actual, execFile };
}

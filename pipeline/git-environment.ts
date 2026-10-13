import { devNull } from 'node:os';

const GIT_CONFIGURATION: [string, string][] = [
  ['core.hooksPath', devNull],
  ['core.fsmonitor', 'false'],
  ['core.attributesFile', devNull],
  ['credential.helper', ''],
  ['http.followRedirects', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.https.allow', 'always'],
  ['fetch.recurseSubmodules', 'false'],
  ['submodule.recurse', 'false'],
];

export function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  const configuration = [...GIT_CONFIGURATION];
  if (token)
    configuration.push([
      'http.https://github.com/.extraHeader',
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ]);
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(configuration.length),
  };
  configuration.forEach(([name, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = name;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

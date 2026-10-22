import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

// What `refit <command>` prints for an error: a plain sentence for input the person can fix, and
// the error's class name for anything else, which is a bug or an environment failure to report.
export function cliErrorMessage(error: Error, command: string) {
  const message = terminalText(error.message);
  const { code, path } = error as { code?: unknown; path?: unknown };
  if (String(code ?? '').startsWith('ERR_PARSE_ARGS_'))
    return `refit ${command}: ${message.split('. ')[0]}. Run refit ${command} --help for its options.`;
  if ((code === 'ENOENT' || code === 'ENOTDIR') && typeof path === 'string')
    return `refit ${command}: ${terminalText(path)} does not exist.`;
  return error instanceof PipelineInputError
    ? `refit ${command}: ${message}`
    : `${error.name}: ${message}`;
}

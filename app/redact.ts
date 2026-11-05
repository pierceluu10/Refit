import { redactSecrets } from '../harness/secrets.ts';

// Hard limit 4: an error's text can carry a token, so this is the only way one reaches a log or a record.
export const messageOf = (error: unknown) =>
  redactSecrets(error instanceof Error ? error.message : String(error));

const MAX_PORT = 65535;
export const REQUEST_TIMEOUT_MS = 5000;
export const port = Number(process.env.REFIT_SIMULATOR_PORT);
if (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
  throw new TypeError('The offline fixture requires its simulator port.');

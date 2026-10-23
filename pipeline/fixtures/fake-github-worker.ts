// A hosted worker in its own process, so a test can kill it mid-job. It reaches the fake GitHub at
// argv[2] the way the in-process tests do; argv[3] holds its runHostedService options as JSON, with
// `database` as a connection string and `owner` for the tenancy. It prints `ready <url>`, then each
// progress message, on stdout. Run it with `node --import tsx`.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import pg from 'pg';
import { routeGitTo, throughFakeGitHub } from './fake-github-git.ts';
import { throughFakeApi } from './fake-github.ts';

const [fake, serialized] = process.argv.slice(2);
const { database, owner, ...options } = JSON.parse(serialized);
// Patched before Refit's modules load, because they promisify execFile when they are imported.
const processes = createRequire(import.meta.url)('node:child_process');
processes.execFile = throughFakeGitHub({ ...processes }).execFile;
syncBuiltinESMExports();
routeGitTo(`${fake}/git`);
globalThis.fetch = throughFakeApi(fake);
const { runHostedService } = await import('../hosted-service.ts');
const { hostedTenancy } = await import('../hosted-tenancy.ts');
await runHostedService({
  ...options,
  database: new pg.Pool({ connectionString: database }),
  tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: owner }),
  host: '127.0.0.1',
  port: 0,
  signal: new AbortController().signal,
  onReady: (url) => console.log(`ready ${url}`),
  onProgress: (message) => console.log(message),
});

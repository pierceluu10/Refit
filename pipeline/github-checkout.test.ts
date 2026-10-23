import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withGitHubCheckout } from './github-checkout.ts';
import { gitEnvironment } from './git-environment.ts';

const transport = vi.hoisted(() => ({
  source: '',
  head: '',
  calls: [] as { args: string[]; env: NodeJS.ProcessEnv }[],
  native: undefined as
    undefined | ((args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(actual.execFile);
  transport.native = (args, cwd) => execute('git', args, { cwd, env: gitEnvironment() });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      transport.calls.push({ args, env: options.env });
      if (!args.includes('fetch')) return execute(binary, args, options);
      const local = [...args];
      local[local.indexOf('origin')] = transport.source;
      return execute(binary, ['-c', 'protocol.file.allow=always', ...local], options);
    },
  });
  return { ...actual, execFile };
});
vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'private-read-test-token',
    appId: 123,
    installationId: 456,
  })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn(async (_token: string, method: string, path: string) => {
    expect(method).toBe('GET');
    expect(path).toBe('/repos/example/application/git/ref/heads/main');
    return { object: { type: 'commit', sha: transport.head } };
  }),
}));

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-github-checkout-'));
  roots.push(root);
  const source = join(root, 'source');
  await transport.native!(['init', '--quiet', '--initial-branch=main', source], root);
  await transport.native!(['config', 'user.name', 'Checkout test'], source);
  await transport.native!(['config', 'user.email', 'checkout@example.test'], source);
  await writeFile(join(source, 'billing.ts'), 'export const version = 1;\n');
  await writeFile(join(source, '.gitignore'), 'ignored.txt\n');
  await transport.native!(['add', '.'], source);
  await transport.native!(['commit', '--quiet', '-m', 'test: original application'], source);
  transport.source = source;
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], source)).stdout.trim();
  return {
    directory: join(root, 'state'),
    target: {
      repository: 'example/application',
      base: 'main',
      app: { appId: '123', privateKeyFile: 'unused-test-key' },
    },
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  transport.calls = [];
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('fetches an immutable base through native Git and isolates credentials from arguments, disk and other commands', async () => {
  const input = await setup();
  vi.stubEnv('OPENAI_API_KEY', 'unrelated-private-key');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '!untrusted-command');
  const checkout = await withGitHubCheckout(input, async (checkout) => checkout);
  expect(checkout.revision).toBe(transport.head);
  expect(await readFile(join(checkout.directory, 'billing.ts'), 'utf8')).toContain('version = 1');
  expect(await readFile(join(checkout.directory, '.git/config'), 'utf8')).not.toContain(
    'private-read-test-token',
  );
  expect(await readFile(join(input.directory, 'managed-checkout.json'), 'utf8')).not.toContain(
    'token',
  );
  expect(
    transport.calls.every((call) => !call.args.join(' ').includes('private-read-test-token')),
  ).toBe(true);
  expect(
    transport.calls.every(
      (call) => call.env.OPENAI_API_KEY === undefined && call.env.GIT_CONFIG_GLOBAL,
    ),
  ).toBe(true);
  const header = Buffer.from('x-access-token:private-read-test-token').toString('base64');
  for (const call of transport.calls)
    expect(JSON.stringify(call.env).includes(header)).toBe(call.args.includes('fetch'));
  const fetches = transport.calls.filter((call) => call.args.includes('fetch')).length;
  await withGitHubCheckout(input, async () => undefined);
  expect(transport.calls.filter((call) => call.args.includes('fetch'))).toHaveLength(fetches);
  expect((await transport.native!(['status', '--porcelain'], transport.source)).stdout).toBe('');
});

it('advances a clean managed checkout when the remote base changes and holds ownership through validation', async () => {
  const input = await setup();
  await withGitHubCheckout(input, async () => undefined);
  await writeFile(join(transport.source, 'billing.ts'), 'export const version = 2;\n');
  await transport.native!(['add', '.'], transport.source);
  await transport.native!(
    ['commit', '--quiet', '-m', 'test: changed application'],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
  await withGitHubCheckout(input, async (checkout) => {
    expect(await readFile(join(checkout.directory, 'billing.ts'), 'utf8')).toContain('version = 2');
    expect(checkout.revision).toBe(transport.head);
    await expect(withGitHubCheckout(input, async () => undefined)).rejects.toThrow(
      /active process/,
    );
  });
});

it.each(['tracked', 'untracked', 'ignored', 'configuration'] as const)(
  'refuses to overwrite or execute changed managed state: %s',
  async (kind) => {
    const input = await setup();
    const checkout = await withGitHubCheckout(input, async (checkout) => checkout);
    const path = join(
      checkout.directory,
      kind === 'tracked'
        ? 'billing.ts'
        : kind === 'ignored'
          ? 'ignored.txt'
          : kind === 'configuration'
            ? '.git/config'
            : 'extra.ts',
    );
    await writeFile(path, 'local change that must survive');
    await expect(withGitHubCheckout(input, async () => undefined)).rejects.toThrow(
      /changed|changes/,
    );
    expect(await readFile(path, 'utf8')).toBe('local change that must survive');
  },
);

it('reconciles a prepared checkout after interruption without fetching again', async () => {
  const input = await setup();
  const checkout = await withGitHubCheckout(input, async (checkout) => checkout);
  const path = join(input.directory, 'managed-checkout.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...state, phase: 'prepared' }));
  const resumed = await withGitHubCheckout(input, async (checkout) => checkout);
  expect(resumed).toEqual(checkout);
  expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('ready');
  expect(transport.calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
});

it('refuses a different target before accessing a managed repository', async () => {
  const input = await setup();
  await withGitHubCheckout(input, async () => undefined);
  await expect(
    withGitHubCheckout(
      { ...input, target: { ...input.target, base: 'other' } },
      async () => undefined,
    ),
  ).rejects.toThrow(/another GitHub target/);
});

it('refuses a state directory inside a working copy before creating it', async () => {
  const input = await setup();
  const directory = join(transport.source, 'worker-state');
  await expect(withGitHubCheckout({ ...input, directory }, async () => undefined)).rejects.toThrow(
    /outside any existing Git/,
  );
  await expect(readFile(join(directory, 'managed-checkout.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('recovers a prepared staging directory when interrupted before its final rename', async () => {
  const input = await setup();
  const checkout = await withGitHubCheckout(input, async (checkout) => checkout);
  const path = join(input.directory, 'managed-checkout.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  await rename(checkout.directory, join(input.directory, state.stagingName));
  await writeFile(path, JSON.stringify({ ...state, phase: 'prepared' }));
  expect(await withGitHubCheckout(input, async (checkout) => checkout)).toEqual(checkout);
  expect(transport.calls.filter((call) => call.args.includes('fetch'))).toHaveLength(1);
});

it('reconciles an interrupted update only when its recorded new HEAD and clean files agree', async () => {
  const input = await setup();
  const checkout = await withGitHubCheckout(input, async (checkout) => checkout);
  const path = join(input.directory, 'managed-checkout.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(join(transport.source, 'billing.ts'), 'export const version = 2;\n');
  await transport.native!(['add', '.'], transport.source);
  await transport.native!(
    ['commit', '--quiet', '-m', 'test: later remote revision'],
    transport.source,
  );
  transport.head = (await transport.native!(['rev-parse', 'HEAD'], transport.source)).stdout.trim();
  await transport.native!(
    [
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '--quiet',
      '--depth=1',
      transport.source,
      transport.head,
    ],
    checkout.directory,
  );
  await writeFile(
    path,
    JSON.stringify({ ...state, phase: 'updating', pendingRevision: transport.head }),
  );
  await transport.native!(['checkout', '--quiet', '--detach', transport.head], checkout.directory);
  const resumed = await withGitHubCheckout(input, async (checkout) => checkout);
  expect(resumed.revision).toBe(transport.head);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    phase: 'ready',
    revision: transport.head,
    pendingRevision: null,
  });
});

it('redacts the installation token and its Basic credential from Git failure messages', async () => {
  const input = await setup();
  const basic = Buffer.from('x-access-token:private-read-test-token').toString('base64');
  // Git echoes the remote it could not read, so a remote naming both forms puts them on stderr.
  transport.source = join(transport.source, `private-read-test-token-${basic}`);
  const failure = withGitHubCheckout(input, async () => undefined);
  await expect(failure).rejects.toThrow(/^Managed Git fetch failed: .*\[redacted\]-\[redacted\]/);
  const message = await failure.catch((error: Error) => error.message);
  expect(message).not.toContain('private-read-test-token');
  expect(message).not.toContain(basic);
});

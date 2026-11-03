import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTool, MigrationTask, Recipe } from '../shared/types.ts';
import { buildTools, finishProblems, gitignoreProblems, privateHost } from './tools.ts';
import type { ExecResult, FinishReport, Sandbox, ToolContext } from './types.ts';

const task = { id: 't1', repo: 'acme/app' } as MigrationTask;
let dir: string;
let outside: string;

function fakeSandbox(root: string): Sandbox {
  return {
    dir: root,
    mode: 'local',
    exec: (command, options) =>
      new Promise<ExecResult>((resolve) => {
        exec(command, { cwd: root, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ code, stdout, stderr, timedOut: Boolean(error?.killed) });
        });
      }),
    diff: async () => '',
    dispose: async () => {},
  };
}

function setup(overrides: Partial<ToolContext> = {}) {
  const finished: FinishReport[] = [];
  const tools = buildTools({
    sandbox: fakeSandbox(dir),
    task,
    toolPack: { provider: 'stripe', tools: [], playbooks: {} },
    retrieveRecipes: async () => [],
    checks: [],
    onFinish: (report) => finished.push(report),
    ...overrides,
  });
  const call = (name: string, input: unknown = {}) => {
    const found = tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found.run(input, { repoDir: dir });
  };
  return { tools, call, finished };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aptitude-tools-'));
  outside = await mkdtemp(path.join(tmpdir(), 'aptitude-outside-'));
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true });
  await writeFile(
    path.join(dir, 'src/pay.ts'),
    "const a = 1;\nstripe.charges.create();\nconst b = 'x';\n",
  );
  await writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'stripe.charges.create();\n');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('file tools', () => {
  it('lists files without node_modules', async () => {
    const { call } = setup();
    expect(await call('list_files')).toBe('src/\n  pay.ts');
  });

  it('reads numbered lines with offset and limit', async () => {
    const { call } = setup();
    expect(await call('read_file', { path: 'src/pay.ts', offset: 2, limit: 1 })).toBe(
      '2\tstripe.charges.create();\n[lines 2-2 of 4]',
    );
  });

  it('writes and edits files', async () => {
    const { call } = setup();
    expect(await call('write_file', { path: 'lib/new.ts', content: 'x x' })).toBe(
      'wrote lib/new.ts (3 bytes)',
    );
    expect(await call('edit_file', { path: 'lib/new.ts', old: 'x', new: 'y' })).toMatch(
      /appears 2 times/,
    );
    expect(await call('edit_file', { path: 'lib/new.ts', old: 'z', new: 'y' })).toMatch(
      /not found/,
    );
    expect(
      await call('edit_file', { path: 'lib/new.ts', old: 'x', new: '$&y', replaceAll: true }),
    ).toBe('edited lib/new.ts (2 replacements)');
    expect(await readFile(path.join(dir, 'lib/new.ts'), 'utf8')).toBe('$&y $&y');
  });

  it('searches with a regex and glob, skipping node_modules', async () => {
    const { call } = setup();
    expect(await call('search', { pattern: 'charges\\.create' })).toBe(
      'src/pay.ts:2: stripe.charges.create();',
    );
    expect(await call('search', { pattern: 'charges', glob: '*.js' })).toBe('no matches');
    expect(await call('search', { pattern: '(' })).toMatch(/^error: Invalid regular expression/);
  });

  it('refuses paths outside the sandbox', async () => {
    const { call } = setup();
    await symlink(outside, path.join(dir, 'escape'));
    await symlink(path.join(outside, 'missing'), path.join(dir, 'dangling'));
    const attempts: [string, unknown][] = [
      ['read_file', { path: '../secret.txt' }],
      ['read_file', { path: path.join(outside, 'secret.txt') }],
      ['read_file', { path: 'escape/secret.txt' }],
      ['write_file', { path: 'escape/new.txt', content: 'x' }],
      ['write_file', { path: 'dangling', content: 'x' }],
      ['list_files', { path: '..' }],
      ['search', { pattern: 'x', path: 'escape' }],
    ];
    for (const [name, input] of attempts) {
      expect(await call(name, input), name).toBe('error: path is outside the sandbox');
    }
    expect(await call('read_file', { path: path.join(dir, 'src/pay.ts') })).toMatch(/^1\t/);
  });

  it('turns bad input and filesystem errors into text', async () => {
    const { call } = setup();
    expect(await call('read_file', {})).toBe('error: "path" must be a string');
    expect(await call('read_file', null)).toBe('error: "path" must be a string');
    expect(await call('read_file', { path: 'nope.ts' })).toMatch(/^error: ENOENT/);
  });
});

describe('shell, install and checks', () => {
  it('runs shell commands in the sandbox and redacts secrets', async () => {
    const { call } = setup();
    const out = await call('shell', { command: 'pwd; echo sk_live_abcdefghijklmnop1234; exit 3' });
    expect(out).toMatch(/^exit code: 3\n/);
    expect(out).toContain('aptitude-tools-');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('sk_live_');
  });

  it('truncates long output and says how much was cut', async () => {
    const { call } = setup();
    const out = await call('shell', {
      command: 'node -e "process.stdout.write(\'a\'.repeat(50000))"',
    });
    expect(out).toMatch(/\[\.\.\. \d+ characters cut \.\.\.\]/);
    expect(out.length).toBeLessThan(20_100);
  });

  it('diff summarises the change per file and shows one file in full', async () => {
    const lockfile = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,2 +1,3 @@',
      ' {',
      '-  "a": 1',
      '+  "a": 2,',
      '+  "b": 3',
      '',
    ].join('\n');
    const source =
      'diff --git a/src/pay.ts b/src/pay.ts\n--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const { call } = setup({
      sandbox: { ...fakeSandbox(dir), diff: async () => lockfile + source },
    });
    expect(await call('diff')).toBe('package-lock.json: +2 -1\nsrc/pay.ts: +1 -1');
    expect(await call('diff', { path: 'src/pay.ts' })).toBe(source);
    expect(await call('diff', { path: 'README.md' })).toBe('no change to README.md');
    expect(await setup().call('diff')).toBe('no changes yet');
  });

  it('install reports when there is no package manager', async () => {
    const { call } = setup();
    expect(await call('install')).toMatch(/no lockfile or manifest/);
  });

  it('run_checks explains when nothing was detected, and reports failures', async () => {
    expect(await setup().call('run_checks')).toMatch(/no checks were detected/);
    const { call } = setup({
      checks: [
        { name: 'build', command: 'true' },
        { name: 'test', command: "echo 'FAIL src/a.test.ts > adds'; exit 1" },
      ],
    });
    const out = await call('run_checks');
    expect(out).toContain('## build: pass');
    expect(out).toContain('## test: fail');
    expect(out).toContain('- FAIL src/a.test.ts > adds');
    expect(await call('run_checks', { names: ['lint'] })).toMatch(/Available: build, test/);
  });
});

describe('web, memory, tool pack and finish', () => {
  it('fetches a URL and strips HTML', async () => {
    const fakeFetch = (async () =>
      new Response(
        '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Changelog</h1><p>Use &lt;v2&gt;</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      )) as typeof fetch;
    const { call } = setup({ fetch: fakeFetch });
    expect(await call('fetch_url', { url: 'https://docs.example.com/x' })).toBe(
      'status 200 https://docs.example.com/x\n\nChangelog\nUse <v2>',
    );
    expect(await call('fetch_url', { url: 'file:///etc/passwd' })).toMatch(/only http and https/);
  });

  it('formats recipes', async () => {
    expect(await setup().call('retrieve_recipes')).toBe('no recipes yet');
    const recipe: Recipe = {
      id: 'r1',
      provider: 'stripe',
      kind: 'sdk-major',
      preconditions: 'stripe-node 12',
      steps: '1. bump',
      pitfalls: 'none',
      sourceRuns: [],
      verifiedRepos: 2,
    };
    const out = await setup({ retrieveRecipes: async () => [recipe] }).call('retrieve_recipes');
    expect(out).toContain('#### r1 (stripe / sdk-major, verified on 2 repos)');
    expect(out).toContain('Steps: 1. bump');
  });

  it('exposes tool pack tools with safe names and catches their errors', async () => {
    const packTools: AgentTool[] = [
      {
        name: 'lookup version!',
        description: 'Look up an API version',
        inputSchema: { type: 'object', properties: {} },
        run: async (_input, context) => `repo at ${context.repoDir}`,
      },
      {
        name: 'broken',
        description: 'Always throws',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          throw new Error('boom');
        },
      },
    ];
    const { tools, call } = setup({
      toolPack: { provider: 'stripe', tools: packTools, playbooks: {} },
    });
    expect(tools.map((tool) => tool.name)).toContain('stripe__lookup_version_');
    expect(await call('stripe__lookup_version_')).toBe(`repo at ${dir}`);
    expect(await call('stripe__broken')).toBe('error: boom');
  });

  it('finish records a leniently parsed report', async () => {
    const { call, finished } = setup();
    const out = await call('finish', {
      verdict: 'not-affected',
      summary: 'Moved to PaymentIntents',
      why: 'Charges API removed',
      validators: [{ name: 'tsc', passed: true, detail: 'clean' }, 'junk'],
    });
    expect(out).toMatch(/re-run the checks/);
    expect(finished).toEqual([
      {
        verdict: 'not-affected',
        summary: 'Moved to PaymentIntents',
        why: 'Charges API removed',
        validators: [
          { name: 'tsc', passed: true, detail: 'clean' },
          { name: '', passed: false, detail: '' },
        ],
        unproven: [],
        behaviourChanges: [],
      },
    ]);
  });

  it('finish refuses, at most twice, a report that would quietly miss verified', async () => {
    const { call, finished } = setup();
    const report = {
      verdict: 'migrated',
      summary: 'Moved to PaymentIntents',
      why: 'Charges API removed',
      validators: [{ name: 'stripe__stripe_check_params', passed: true, detail: 'clean' }],
      proofTest: 'change-tset',
    };
    const first = await call('finish', report);
    expect(first).toMatch(/^Not recorded yet/);
    expect(first).toContain('proofTest "change-tset" is not a registered check');
    expect(first).toContain('no call of it was recorded');
    expect(finished).toEqual([]);
    await call('finish', report);
    expect(await call('finish', report)).toMatch(/re-run the checks/);
    expect(finished).toHaveLength(1);
  });

  it('finishProblems names a checker whose latest call failed, and clears once it is re-run', () => {
    const report = {
      verdict: 'migrated' as const,
      summary: 's',
      why: 'w',
      validators: [],
      unproven: [],
      behaviourChanges: [],
      proofTest: 'change-test',
    };
    const checks = [{ name: 'change-test', command: 'node t.mjs' }];
    const old = {
      tool: 'openai__openai_check_request',
      output: 'Status: deprecated',
      passed: false,
    };
    const fixed = { ...old, output: 'Supported.', passed: true };
    expect(finishProblems(report, checks, [old])).toEqual([
      expect.stringContaining('latest openai__openai_check_request call reported problems'),
    ]);
    expect(finishProblems(report, checks, [old, fixed])).toEqual([]);
  });

  it('finishProblems names a claimed validator whose latest call did not pass', () => {
    const lookup = {
      tool: 'openai__openai_model_lookup',
      output: '## gpt-4.1\nStatus: deprecated',
      passed: false,
    };
    const report = {
      verdict: 'migrated' as const,
      summary: 's',
      why: 'w',
      validators: [{ name: 'openai__openai_model_lookup', passed: true, detail: 'checked' }],
      unproven: [],
      behaviourChanges: [],
      proofTest: 'change-test',
    };
    expect(finishProblems(report, [{ name: 'change-test', command: 'true' }], [lookup])).toEqual([
      expect.stringContaining("its latest call didn't pass"),
    ]);
  });

  it('gitignoreProblems catches a secret ignore line the change drops', () => {
    const joined = [
      'diff --git a/.gitignore b/.gitignore',
      '--- a/.gitignore',
      '+++ b/.gitignore',
      '@@ -1,2 +1,2 @@',
      ' node_modules',
      '-.env',
      '\\ No newline at end of file',
      '+.envdist',
    ].join('\n');
    expect(gitignoreProblems(joined)).toEqual([expect.stringContaining('drops `.env`')]);
    const kept = joined.replace('+.envdist', '+.env\n+dist');
    expect(gitignoreProblems(kept)).toEqual([]);
  });

  it('privateHost keeps fetch_url to the public web', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      'host.docker.internal',
      '10.0.0.5',
      '172.20.1.1',
      '192.168.1.2',
      '169.254.169.254',
      '[::1]',
      'api.localhost',
    ]) {
      expect(privateHost(host), host).toBe(true);
    }
    for (const host of ['docs.stripe.com', '8.8.8.8', '172.32.0.1', 'platform.openai.com']) {
      expect(privateHost(host), host).toBe(false);
    }
  });

  it('every tool has an object input schema and never throws', async () => {
    const { tools } = setup();
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      if (tool.name === 'finish' || tool.name === 'install' || tool.name === 'shell') continue;
      await expect(tool.run(undefined, { repoDir: dir })).resolves.toBeTypeOf('string');
    }
  });
});
